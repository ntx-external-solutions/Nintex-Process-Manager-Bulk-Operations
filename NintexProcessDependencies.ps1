<#
.SYNOPSIS
    Dependency discovery, location and removal for Nintex Process Manager processes.

.DESCRIPTION
    Implements the corrected dependency model documented in API_ARCHITECTURE.md.

    The CheckProcessDependencies endpoint is a CANDIDATE INDEX, not a location index:

      - It returns a bidirectional union of outgoing and incoming references with
        nothing in the payload distinguishing the two, so it cannot tell you which
        process holds a reference. Both sides must be fetched and walked.
      - Its counts are per-occurrence and summed across both directions. They must
        never be deduplicated by Type|UniqueId.
      - It suppresses Process Input and Process Output rows naming an archived
        process, while the references themselves remain in that process's JSON.

    This file therefore splits cleanly in two:

      PURE functions (Find-, Remove-, ConvertFrom-, Group-, Test-) operate on process
      objects in memory, make no network calls, and are covered by Tests/.

      API functions (Get-*Claim, Save-/Import-) touch the tenant or the filesystem.

    Dot-source it:  . .\NintexProcessDependencies.ps1

.NOTES
    Targets Windows PowerShell 5.1. Avoid PS7-only syntax when editing.
#>

#Requires -Version 5.1

# ============================================================================
# REFERENCE LOCATION MAP
# ============================================================================
# Every place a process can hold a reference to another process, and what
# removes it. See API_ARCHITECTURE.md "Complete list of reference-bearing
# locations". A bucket missing from this table is a reference that survives
# removal while the run reports success.

$script:ProcedureBuckets = @(
    @{ Bucket = 'Activity';                  Field = 'LinkedProcessUniqueId';      Action = 'Orphan' },
    @{ Bucket = 'Decision';                  Field = 'LinkedProcessUniqueId';      Action = 'Orphan' },
    @{ Bucket = 'ProcessLink';               Field = 'LinkedProcessUniqueId';      Action = 'Remove' },
    @{ Bucket = 'OrphanProcessLink';         Field = 'LinkedProcessUniqueId';      Action = 'Remove' },
    @{ Bucket = 'EmbeddedProcessLink';       Field = 'LinkedProcessUniqueId';      Action = 'Remove' },
    @{ Bucket = 'OrphanEmbeddedProcessLink'; Field = 'LinkedProcessUniqueId';      Action = 'Remove' },
    @{ Bucket = 'ProcessGroupLink';          Field = 'LinkedProcessGroupUniqueId'; Action = 'Report' },
    @{ Bucket = 'OrphanProcessGroupLink';    Field = 'LinkedProcessGroupUniqueId'; Action = 'Report' }
)

# Typed arrays inside any procedure node's ChildProcessProcedures. Child nodes
# carry their own ChildProcessProcedures, so the walk must recurse rather than
# stop one level below Activity.
$script:ChildProcedureTypes = @(
    'Task', 'Note', 'Information', 'Form', 'Guide',
    'Image', 'Policy', 'Training', 'Video', 'WebLink'
)

# Link fields cleared when a node is orphaned. LinkedProcessDisplayName is
# deliberately absent: it is preserved so the UI still shows what was linked.
$script:OrphanClearFields = @(
    'LinkedProcessId',
    'LinkedProcessUniqueId',
    'LinkedProcessName',
    'LinkedProcessStateId',
    'EmbeddedLinkedProcessId',
    'LinkedProcessGroupId',
    'LinkedProcessGroupName',
    'LinkedProcessGroupUniqueId'
)

# Claim types returned by CheckProcessDependencies, mapped to the site category
# they reconcile against.
$script:ClaimTypeMap = @{
    'Linked Process'       = 'Link'
    'Process Input'        = 'Input'
    'Process Output'       = 'Output'
    'Linked Process Group' = 'Group'
}

# ============================================================================
# SAFE PROPERTY ACCESS
# ============================================================================
# ConvertFrom-Json yields PSCustomObjects whose properties may be absent, null,
# a scalar, or an array. Live payloads use null rather than [] for unused
# collections ("Outputs": null). These helpers keep the walk total.

function Get-NodeValue {
    param($Node, [string]$Name)

    if ($null -eq $Node) { return $null }
    $prop = $Node.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Set-NodeValue {
    # Only assigns to properties that already exist. Never invents schema.
    param($Node, [string]$Name, $Value)

    if ($null -eq $Node) { return $false }
    $prop = $Node.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $false }
    $prop.Value = $Value
    return $true
}

function Get-NodeArray {
    # Always returns an array. PowerShell unrolls single-element collections on
    # property read, so every collection access in this file goes through here.
    param($Node, [string]$Name)

    $value = Get-NodeValue -Node $Node -Name $Name
    if ($null -eq $value) { return @() }
    return @($value)
}

function Copy-ProcessObject {
    # Deep clone via JSON round-trip so the caller's object is never mutated.
    # Depth 100 because process trees nest arbitrarily through
    # ChildProcessProcedures.
    param($ProcessObject)

    if ($null -eq $ProcessObject) { return $null }
    return ($ProcessObject | ConvertTo-Json -Depth 100 -Compress | ConvertFrom-Json)
}

# ============================================================================
# SITE LOCATION (PURE)
# ============================================================================

function New-ReferenceSite {
    param(
        [string]$HolderUniqueId,
        [string]$TargetUniqueId,
        [string]$Path,
        [string]$Bucket,
        [string]$Category,
        [string]$Action,
        [string]$MatchedField,
        $ElementId,
        [bool]$IsChild
    )

    return [PSCustomObject]@{
        HolderUniqueId = $HolderUniqueId
        TargetUniqueId = $TargetUniqueId
        Path           = $Path
        Bucket         = $Bucket
        Category       = $Category      # Link | Input | Output | Group
        Action         = $Action        # Remove | Orphan | Report
        MatchedField   = $MatchedField
        ElementId      = $ElementId
        IsChild        = $IsChild
    }
}

function Test-TargetMatch {
    param($Node, [string]$Field, [string[]]$TargetUniqueIds)

    $value = Get-NodeValue -Node $Node -Name $Field
    if ([string]::IsNullOrWhiteSpace([string]$value)) { return $null }

    foreach ($target in $TargetUniqueIds) {
        # Tenant payloads are inconsistent about GUID casing.
        if ([string]$value -eq $target) { return $target }
        if ([string]::Equals([string]$value, $target, 'OrdinalIgnoreCase')) { return $target }
    }
    return $null
}

function Find-ChildReferenceSite {
    # Recursively walks a procedure node's ChildProcessProcedures. Child nodes are
    # always orphaned rather than removed: they carry their own text, so deleting
    # the element would destroy process content that has nothing to do with the
    # link being cleared.
    param(
        $Node,
        [string]$ParentPath,
        [string]$HolderUniqueId,
        [string[]]$TargetUniqueIds
    )

    $sites = @()
    $children = Get-NodeValue -Node $Node -Name 'ChildProcessProcedures'
    if ($null -eq $children) { return $sites }

    foreach ($childType in $script:ChildProcedureTypes) {
        $items = Get-NodeArray -Node $children -Name $childType
        for ($i = 0; $i -lt $items.Count; $i++) {
            $child = $items[$i]
            if ($null -eq $child) { continue }

            $path = "$ParentPath.ChildProcessProcedures.$childType[$i]"

            $matched = Test-TargetMatch -Node $child -Field 'LinkedProcessUniqueId' -TargetUniqueIds $TargetUniqueIds
            if ($matched) {
                $sites += New-ReferenceSite `
                    -HolderUniqueId $HolderUniqueId -TargetUniqueId $matched `
                    -Path $path -Bucket $childType -Category 'Link' -Action 'Orphan' `
                    -MatchedField 'LinkedProcessUniqueId' `
                    -ElementId (Get-NodeValue -Node $child -Name 'Id') -IsChild $true
            }

            # Children nest further.
            $sites += Find-ChildReferenceSite -Node $child -ParentPath $path `
                -HolderUniqueId $HolderUniqueId -TargetUniqueIds $TargetUniqueIds
        }
    }

    return $sites
}

function Find-ProcessReferenceSite {
    <#
    .SYNOPSIS
        Finds every physical location in one process where it references any of
        the target processes.

    .DESCRIPTION
        This is the ground truth the dependency API cannot provide. It answers
        "where exactly, and what removes it" for a single holder process.

        Pure: no network, no mutation of the input object.

    .PARAMETER ProcessObject
        The unwrapped process model (the processJson value, not the wrapper).

    .PARAMETER TargetUniqueIds
        Process UniqueIds being searched for.

    .PARAMETER TargetGroupUniqueIds
        Optional group UniqueIds, matched against the ProcessGroupLink buckets.
        Reported only; group links are never removed automatically.
    #>
    param(
        $ProcessObject,
        [string[]]$TargetUniqueIds,
        [string[]]$TargetGroupUniqueIds = @()
    )

    $sites = @()
    if ($null -eq $ProcessObject) { return $sites }

    $holder = [string](Get-NodeValue -Node $ProcessObject -Name 'UniqueId')
    $procedures = Get-NodeValue -Node $ProcessObject -Name 'ProcessProcedures'

    if ($null -ne $procedures) {
        foreach ($spec in $script:ProcedureBuckets) {
            $bucket = $spec.Bucket
            $items = Get-NodeArray -Node $procedures -Name $bucket

            for ($i = 0; $i -lt $items.Count; $i++) {
                $node = $items[$i]
                if ($null -eq $node) { continue }

                $path = "ProcessProcedures.$bucket[$i]"

                if ($spec.Action -eq 'Report') {
                    # Group link buckets match against group ids, not process ids.
                    $matched = Test-TargetMatch -Node $node -Field $spec.Field -TargetUniqueIds $TargetGroupUniqueIds
                    if ($matched) {
                        $sites += New-ReferenceSite `
                            -HolderUniqueId $holder -TargetUniqueId $matched `
                            -Path $path -Bucket $bucket -Category 'Group' -Action 'Report' `
                            -MatchedField $spec.Field `
                            -ElementId (Get-NodeValue -Node $node -Name 'Id') -IsChild $false
                    }
                }
                else {
                    $matched = Test-TargetMatch -Node $node -Field $spec.Field -TargetUniqueIds $TargetUniqueIds
                    if ($matched) {
                        $sites += New-ReferenceSite `
                            -HolderUniqueId $holder -TargetUniqueId $matched `
                            -Path $path -Bucket $bucket -Category 'Link' -Action $spec.Action `
                            -MatchedField $spec.Field `
                            -ElementId (Get-NodeValue -Node $node -Name 'Id') -IsChild $false
                    }
                }

                # Every procedure node can carry children, not just Activity.
                $sites += Find-ChildReferenceSite -Node $node -ParentPath $path `
                    -HolderUniqueId $holder -TargetUniqueIds $TargetUniqueIds
            }
        }
    }

    # Inputs / Outputs. Live payloads use null, not [], when unused.
    $ioSpecs = @(
        @{ Container = 'Inputs';  Bucket = 'Input';  Field = 'FromProcessUniqueId'; Category = 'Input' },
        @{ Container = 'Outputs'; Bucket = 'Output'; Field = 'ToProcessUniqueId';   Category = 'Output' }
    )

    foreach ($spec in $ioSpecs) {
        $container = Get-NodeValue -Node $ProcessObject -Name $spec.Container
        if ($null -eq $container) { continue }

        $items = Get-NodeArray -Node $container -Name $spec.Bucket
        for ($i = 0; $i -lt $items.Count; $i++) {
            $node = $items[$i]
            if ($null -eq $node) { continue }

            $matched = Test-TargetMatch -Node $node -Field $spec.Field -TargetUniqueIds $TargetUniqueIds
            if ($matched) {
                $sites += New-ReferenceSite `
                    -HolderUniqueId $holder -TargetUniqueId $matched `
                    -Path "$($spec.Container).$($spec.Bucket)[$i]" -Bucket $spec.Bucket `
                    -Category $spec.Category -Action 'Remove' -MatchedField $spec.Field `
                    -ElementId (Get-NodeValue -Node $node -Name 'Id') -IsChild $false
            }
        }
    }

    return $sites
}

# ============================================================================
# SITE REMOVAL (PURE)
# ============================================================================

function Clear-NodeLink {
    # Orphans a link in place: clears the reference fields, preserves
    # LinkedProcessDisplayName so the UI keeps showing what was linked, and
    # flips a live Decision link (4) to orphaned (7).
    param($Node, [string]$Bucket)

    foreach ($field in $script:OrphanClearFields) {
        [void](Set-NodeValue -Node $Node -Name $field -Value $null)
    }

    if ($Bucket -eq 'Decision') {
        $linkType = Get-NodeValue -Node $Node -Name 'DecisionLinkType'
        if ($null -ne $linkType -and [int]$linkType -eq 4) {
            [void](Set-NodeValue -Node $Node -Name 'DecisionLinkType' -Value 7)
        }
    }
}

function Remove-ChildReference {
    param($Node, [string[]]$TargetUniqueIds)

    $count = 0
    $children = Get-NodeValue -Node $Node -Name 'ChildProcessProcedures'
    if ($null -eq $children) { return 0 }

    foreach ($childType in $script:ChildProcedureTypes) {
        $items = Get-NodeArray -Node $children -Name $childType
        foreach ($child in $items) {
            if ($null -eq $child) { continue }

            if (Test-TargetMatch -Node $child -Field 'LinkedProcessUniqueId' -TargetUniqueIds $TargetUniqueIds) {
                Clear-NodeLink -Node $child -Bucket $childType
                $count++
            }
            $count += Remove-ChildReference -Node $child -TargetUniqueIds $TargetUniqueIds
        }
    }

    return $count
}

function Remove-ProcessReference {
    <#
    .SYNOPSIS
        Removes every reference to the target processes from one holder process.

    .DESCRIPTION
        Pure. Operates on a deep clone, so the caller's object is untouched.

        Removal verb per location comes from the reference location map:
          Remove  - drop the element from its array (ProcessLink, Input, Output, ...)
          Orphan  - clear the link fields in place, keep the element and its text
          Report  - never mutated (group links)

        LinkedStakeholders is never touched. It is derived state that Process
        Manager rebuilds, and editing it corrupts the relationship cache.

        Removal filters by value rather than replaying the paths from
        Find-ProcessReferenceSite, because deleting an element shifts the indices
        of everything after it.

    .OUTPUTS
        PSCustomObject with CleanedObject, ReferencesRemoved, and Sites (the
        sites found before cleaning, for reconciliation).
    #>
    param(
        $ProcessObject,
        [string[]]$TargetUniqueIds
    )

    $sitesBefore = @(Find-ProcessReferenceSite -ProcessObject $ProcessObject -TargetUniqueIds $TargetUniqueIds)
    $clone = Copy-ProcessObject -ProcessObject $ProcessObject
    $removed = 0

    if ($null -eq $clone) {
        return [PSCustomObject]@{ CleanedObject = $null; ReferencesRemoved = 0; Sites = $sitesBefore }
    }

    $procedures = Get-NodeValue -Node $clone -Name 'ProcessProcedures'

    if ($null -ne $procedures) {
        foreach ($spec in $script:ProcedureBuckets) {
            $bucket = $spec.Bucket
            $items = Get-NodeArray -Node $procedures -Name $bucket
            if ($items.Count -eq 0) { continue }

            if ($spec.Action -eq 'Remove') {
                $kept = @()
                foreach ($node in $items) {
                    if ($null -eq $node) { continue }
                    if (Test-TargetMatch -Node $node -Field $spec.Field -TargetUniqueIds $TargetUniqueIds) {
                        $removed++
                        continue    # element dropped
                    }
                    $removed += Remove-ChildReference -Node $node -TargetUniqueIds $TargetUniqueIds
                    $kept += $node
                }
                [void](Set-NodeValue -Node $procedures -Name $bucket -Value ([object[]]$kept))
            }
            else {
                # Orphan and Report buckets keep every element.
                foreach ($node in $items) {
                    if ($null -eq $node) { continue }

                    if ($spec.Action -eq 'Orphan') {
                        if (Test-TargetMatch -Node $node -Field $spec.Field -TargetUniqueIds $TargetUniqueIds) {
                            Clear-NodeLink -Node $node -Bucket $bucket
                            $removed++
                        }
                    }
                    $removed += Remove-ChildReference -Node $node -TargetUniqueIds $TargetUniqueIds
                }
            }
        }
    }

    $ioSpecs = @(
        @{ Container = 'Inputs';  Bucket = 'Input';  Field = 'FromProcessUniqueId' },
        @{ Container = 'Outputs'; Bucket = 'Output'; Field = 'ToProcessUniqueId' }
    )

    foreach ($spec in $ioSpecs) {
        $container = Get-NodeValue -Node $clone -Name $spec.Container
        if ($null -eq $container) { continue }

        $items = Get-NodeArray -Node $container -Name $spec.Bucket
        if ($items.Count -eq 0) { continue }

        $kept = @()
        foreach ($node in $items) {
            if ($null -eq $node) { continue }
            if (Test-TargetMatch -Node $node -Field $spec.Field -TargetUniqueIds $TargetUniqueIds) {
                $removed++
                continue
            }
            $kept += $node
        }
        [void](Set-NodeValue -Node $container -Name $spec.Bucket -Value ([object[]]$kept))
    }

    return [PSCustomObject]@{
        CleanedObject     = $clone
        ReferencesRemoved = $removed
        Sites             = $sitesBefore
    }
}

# ============================================================================
# CLAIMS (PURE PARSING)
# ============================================================================

function ConvertFrom-DependencyResponse {
    <#
    .SYNOPSIS
        Parses a CheckProcessDependencies response into one claim per occurrence.

    .DESCRIPTION
        Deliberately does NOT deduplicate. The same UniqueId appearing three
        times means three physical references exist, and collapsing them to one
        is how references survive a removal that reports success.

        Each claim records only that the queried process and the related process
        are connected somehow. It does NOT say which of the two holds the
        reference: the endpoint returns both directions undifferentiated.
    #>
    param(
        $Response,
        [string]$QueriedUniqueId
    )

    $claims = @()
    if ($null -eq $Response) { return $claims }

    # ConvertFrom-Json collapses a single-element array to a bare object.
    foreach ($entry in @($Response)) {
        if ($null -eq $entry) { continue }

        $type = [string](Get-NodeValue -Node $entry -Name 'Type')
        $category = $script:ClaimTypeMap[$type]
        if (-not $category) { $category = 'Unknown' }

        foreach ($dep in (Get-NodeArray -Node $entry -Name 'Dependencies')) {
            if ($null -eq $dep) { continue }

            $claims += [PSCustomObject]@{
                QueriedUniqueId = $QueriedUniqueId
                RelatedUniqueId = [string](Get-NodeValue -Node $dep -Name 'UniqueId')
                RelatedName     = [string](Get-NodeValue -Node $dep -Name 'Name')
                Type            = $type
                Category        = $category
            }
        }
    }

    return $claims
}

function Get-DependencyCandidate {
    # The set of processes that must be fetched and walked. Both sides of every
    # claim qualify, because the payload never says which side holds the
    # reference. Group claims are excluded: they name groups, not processes.
    param(
        $Claims,
        [string[]]$TargetUniqueIds
    )

    $seen = @{}
    foreach ($id in $TargetUniqueIds) {
        if ($id) { $seen[$id.ToLowerInvariant()] = $id }
    }
    foreach ($claim in @($Claims)) {
        if ($claim.Category -eq 'Group') { continue }
        $id = $claim.RelatedUniqueId
        if ($id) { $seen[$id.ToLowerInvariant()] = $id }
    }

    return @($seen.Values)
}

# ============================================================================
# INVERSION AND RECONCILIATION (PURE)
# ============================================================================

function Group-ReferenceSiteByHolder {
    <#
    .SYNOPSIS
        Inverts sites into one work item per HOLDER process.

    .DESCRIPTION
        Discovery is target-centric (one API call per process being deleted) but
        the edit is holder-centric: one fetch, one PUT and one publish per holder,
        carrying the removals for every target at once.

        Saving a holder once per target instead produces redundant published
        versions and opens a window where a holder is re-archived while later
        edits are still pending.
    #>
    param($Sites)

    $byHolder = @{}

    foreach ($site in @($Sites)) {
        if ($null -eq $site) { continue }
        if ($site.Action -eq 'Report') { continue }

        $key = [string]$site.HolderUniqueId
        if (-not $key) { continue }

        if (-not $byHolder.ContainsKey($key)) {
            $byHolder[$key] = [PSCustomObject]@{
                HolderUniqueId  = $key
                Sites           = @()
                TargetsAffected = @()
            }
        }

        $byHolder[$key].Sites += $site
        if ($byHolder[$key].TargetsAffected -notcontains $site.TargetUniqueId) {
            $byHolder[$key].TargetsAffected += $site.TargetUniqueId
        }
    }

    return @($byHolder.Values)
}

function Test-DependencyReconciliation {
    <#
    .SYNOPSIS
        Checks the claim count for a pair against the sites actually found.

    .DESCRIPTION
        Link and Input/Output claims are scoped differently, which was measured
        rather than assumed:

          Link   - a non-deduplicated union of both directions, so the expected
                   count is (sites X holds to Y) + (sites Y holds to X).
          Input  - NOT a union. The ACR/DT pair holds one Input each way (ids
          Output   1220 and 1221), yet each query reports exactly one. Expected
                   is therefore scoped to the QUERIED process's own sites.

        That single sample cannot distinguish "the queried process's own
        Inputs/Outputs only" from "a union deduplicated per related process";
        both predict one. Scoping to the queried process is the safe reading: it
        is exactly right under the first, and under the second it reports a
        mismatch for investigation rather than silently under-removing. See the
        open question in API_ARCHITECTURE.md.

        Input and Output claims are suppressed when the process they NAME is
        archived, so an expected count of zero is correct in that case even
        though the references still exist in the archived JSON.

        A Link mismatch of exactly the number of child-procedure sites on the
        holder side is the known child-reference asymmetry documented in
        API_ARCHITECTURE.md, not necessarily a defect. It is surfaced rather
        than silently tolerated.
    #>
    param(
        [string]$QueriedUniqueId,
        [string]$RelatedUniqueId,
        $Claims,
        $Sites,
        [bool]$RelatedIsArchived = $false
    )

    $results = @()

    $pairClaims = @($Claims | Where-Object {
        $_.QueriedUniqueId -eq $QueriedUniqueId -and $_.RelatedUniqueId -eq $RelatedUniqueId
    })

    $pairSites = @($Sites | Where-Object {
        ($_.HolderUniqueId -eq $QueriedUniqueId -and $_.TargetUniqueId -eq $RelatedUniqueId) -or
        ($_.HolderUniqueId -eq $RelatedUniqueId -and $_.TargetUniqueId -eq $QueriedUniqueId)
    })

    foreach ($category in @('Link', 'Input', 'Output')) {
        $claimed = @($pairClaims | Where-Object { $_.Category -eq $category }).Count

        if ($category -eq 'Link') {
            # Union of both directions.
            $categorySites = @($pairSites | Where-Object { $_.Category -eq $category })
        } else {
            # Scoped to the queried process's own Inputs/Outputs. See above.
            $categorySites = @($pairSites | Where-Object {
                $_.Category -eq $category -and $_.HolderUniqueId -eq $QueriedUniqueId
            })
        }
        $found = $categorySites.Count

        $suppressed = ($RelatedIsArchived -and $category -in @('Input', 'Output'))
        $expected = $found
        if ($suppressed) { $expected = 0 }

        $status = 'Match'
        $note = ''

        if ($claimed -ne $expected) {
            $status = 'Mismatch'

            $childCount = @($categorySites | Where-Object {
                $_.IsChild -and $_.HolderUniqueId -eq $QueriedUniqueId
            }).Count

            if ($category -eq 'Link' -and $childCount -gt 0 -and ($expected - $claimed) -eq $childCount) {
                $status = 'MatchWithKnownAsymmetry'
                $note = "Differs by $childCount child-procedure site(s); see API_ARCHITECTURE.md child-reference asymmetry"
            }
            else {
                $note = "Claimed $claimed, located $expected. Investigate before removing."
            }
        }
        elseif ($suppressed -and $found -gt 0) {
            $note = "$found reference(s) exist but are suppressed because the related process is archived"
        }

        $results += [PSCustomObject]@{
            QueriedUniqueId = $QueriedUniqueId
            RelatedUniqueId = $RelatedUniqueId
            Category        = $category
            Claimed         = $claimed
            Located         = $found
            Expected        = $expected
            Suppressed      = $suppressed
            Status          = $status
            Note            = $note
        }
    }

    return $results
}

# ============================================================================
# API LAYER
# ============================================================================
# Named Npm* so this file can be dot-sourced alongside Nintex-BulkOperations.ps1
# without colliding with its Invoke-Api* helpers.

$script:NpmMaxRetries = 3

function Get-NpmErrorStatus {
    param($ErrorRecord)

    if ($ErrorRecord.Exception.PSObject.Properties['Response'] -and $ErrorRecord.Exception.Response) {
        try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return 0 }
    }
    return 0
}

function Test-NpmTransient {
    # Retry server faults and transport failures. Never retry 4xx: the request
    # itself is wrong and repeating it just burns the token's rate budget.
    param([int]$StatusCode)
    return ($StatusCode -eq 0 -or ($StatusCode -ge 500 -and $StatusCode -le 599))
}

function Invoke-NpmApi {
    param(
        [string]$Url,
        [string]$Token,
        [string]$Method = 'Get',
        $Body = $null,
        [int]$MaxRetries = $script:NpmMaxRetries
    )

    $headers = @{
        'Authorization'    = "Bearer $Token"
        'Accept'           = 'application/json'
        'Content-Type'     = 'application/json'
        'X-Requested-With' = 'XMLHttpRequest'
    }

    $jsonBody = $null
    if ($null -ne $Body) { $jsonBody = $Body | ConvertTo-Json -Depth 100 }

    for ($attempt = 0; $attempt -le $MaxRetries; $attempt++) {
        try {
            if ($null -ne $jsonBody) {
                $response = Invoke-RestMethod -Uri $Url -Method $Method -Headers $headers -Body $jsonBody -ErrorAction Stop
            } else {
                $response = Invoke-RestMethod -Uri $Url -Method $Method -Headers $headers -ErrorAction Stop
            }
            return [PSCustomObject]@{ Success = $true; StatusCode = 200; Response = $response; Error = $null }
        }
        catch {
            $status = Get-NpmErrorStatus -ErrorRecord $_
            $message = $_.Exception.Message

            if ($attempt -lt $MaxRetries -and (Test-NpmTransient -StatusCode $status)) {
                $wait = [Math]::Pow(2, $attempt + 1)
                Write-Host "  $Method $Url failed (HTTP $status). Retry $($attempt + 1)/$MaxRetries in ${wait}s..." -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
                continue
            }

            return [PSCustomObject]@{ Success = $false; StatusCode = $status; Response = $null; Error = $message }
        }
    }

    return [PSCustomObject]@{ Success = $false; StatusCode = 0; Response = $null; Error = 'Retries exhausted' }
}

function Get-ProcessDependencyClaim {
    <#
    .SYNOPSIS
        Queries CheckProcessDependencies for one process and returns per-occurrence claims.

    .DESCRIPTION
        searchBehavior=31. See API_ARCHITECTURE.md for why the result is a
        bidirectional union and must not be deduplicated.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        [int]$SearchBehavior = 31
    )

    $url = "$SiteURL/Api/v1/Processes/$ProcessUniqueId/CheckProcessDependencies?searchBehavior=$SearchBehavior"
    $result = Invoke-NpmApi -Url $url -Token $Token -Method Get

    if (-not $result.Success) {
        Write-Host "  Dependency check failed for $ProcessUniqueId : HTTP $($result.StatusCode) $($result.Error)" -ForegroundColor Red
        return $null    # distinct from "no dependencies"; the caller must not treat it as clean
    }

    return @(ConvertFrom-DependencyResponse -Response $result.Response -QueriedUniqueId $ProcessUniqueId)
}

function Get-NpmProcessModel {
    # Active processes only. Archived processes are fetched in batch via
    # /mobile/api/v1/processes; see Get-NpmArchivedProcessModel.
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId
    )

    $result = Invoke-NpmApi -Url "$SiteURL/Api/v1/Processes/$ProcessUniqueId" -Token $Token -Method Get
    if (-not $result.Success) { return $null }

    $wrapper = $result.Response
    $model = Get-NodeValue -Node $wrapper -Name 'processJson'
    if ($null -eq $model) { $model = $wrapper }
    return $model
}

function Get-NpmArchivedProcessModel {
    # Batch fetch for archived processes. Chunked because the query string grows
    # with every id and long URLs are rejected.
    param(
        [string]$SiteURL,
        [string]$Token,
        [string[]]$ProcessUniqueIds,
        [int]$BatchSize = 25
    )

    $models = @()
    $ids = @($ProcessUniqueIds | Where-Object { $_ })

    for ($i = 0; $i -lt $ids.Count; $i += $BatchSize) {
        $end = [Math]::Min($i + $BatchSize - 1, $ids.Count - 1)
        $chunk = $ids[$i..$end]
        $query = ($chunk | ForEach-Object { "processUniqueIds=$_" }) -join '&'

        $result = Invoke-NpmApi -Url "$SiteURL/mobile/api/v1/processes?$query" -Token $Token -Method Get
        if (-not $result.Success) { continue }

        foreach ($item in (Get-NodeArray -Node $result.Response -Name 'data')) {
            $model = Get-NodeValue -Node $item -Name 'ProcessModel'
            if ($null -ne $model) { $models += $model }
        }
    }

    return $models
}

function Save-NpmProcessModel {
    <#
    .SYNOPSIS
        Writes a modified process back and publishes it.

    .DESCRIPTION
        ProcessJson must be a JSON STRING, not an object. Sending an object
        returns 200 and silently discards the edit. See API_ARCHITECTURE.md
        "Update Active Process".

        Change notification is suppressed by default: these edits publish a new
        version of a process whose owner did not ask for one, and on a bulk
        cleanup that is a mailbox full of noise.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        $ProcessObject,
        [string]$ChangeDescription = 'Automated dependency removal',
        [bool]$ApprovalsEnabled = $false,
        [bool]$SuppressChangeNotification = $true
    )

    # Depth 100: process trees nest arbitrarily and a truncated tree saves as
    # a silently corrupted process.
    $processJsonString = $ProcessObject | ConvertTo-Json -Depth 100 -Compress

    $body = @{
        ProcessJson                       = $processJsonString
        ChangeDescription                 = $ChangeDescription
        DoSubmitForApproval               = $ApprovalsEnabled
        DoPublish                         = $false
        SuppressChangeNotification        = $SuppressChangeNotification
        SharedActivityCollectionEditModel = @{
            ActivitiesToDelete = @()
            ActivitiesToShare  = @()
            ActivitiesToUnlink = @()
        }
        VariantConnectionChangeStates     = @()
    }

    $url = "$SiteURL/Api/v1/Processes/$ProcessUniqueId"
    $save = Invoke-NpmApi -Url $url -Token $Token -Method Put -Body $body
    if (-not $save.Success) {
        return [PSCustomObject]@{ Success = $false; Stage = 'Save'; Error = $save.Error; StatusCode = $save.StatusCode }
    }

    # Re-read to get the revision id the save produced.
    Start-Sleep -Seconds 1
    $updated = Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $ProcessUniqueId
    $revisionId = Get-NodeValue -Node $updated -Name 'ProcessRevisionEditId'
    $version = [string](Get-NodeValue -Node $updated -Name 'Version')

    # Version "0.x" means never published; there is nothing to re-publish.
    $wasPublished = $false
    if ($version -and $version.Contains('.')) {
        $wasPublished = ([int]($version.Split('.')[0]) -gt 0)
    }
    if (-not $wasPublished) {
        return [PSCustomObject]@{ Success = $true; Stage = 'SavedUnpublished'; Error = $null; StatusCode = 200 }
    }

    if ($ApprovalsEnabled) {
        $publish = Invoke-NpmApi -Url "$url/Publish" -Token $Token -Method Post -Body @{
            ProcessRevisionEditId = [string]$revisionId
            IsPublishNow          = $true
        }
    } else {
        $publish = Invoke-NpmApi -Url "$SiteURL/Process/Edit/PublishProcessRevisionEdit" -Token $Token -Method Post -Body @{
            publishMessage        = $ChangeDescription
            processUniqueId       = $ProcessUniqueId
            processRevisionEditId = [int]$revisionId
        }
    }

    if (-not $publish.Success) {
        return [PSCustomObject]@{ Success = $false; Stage = 'Publish'; Error = $publish.Error; StatusCode = $publish.StatusCode }
    }

    return [PSCustomObject]@{ Success = $true; Stage = 'Published'; Error = $null; StatusCode = 200 }
}

# ============================================================================
# LEDGER AND PLAN PERSISTENCE
# ============================================================================
# The ledger records the state every participant was in BEFORE the run touched
# it, and must reach disk before the first mutation. Without it, a run that dies
# between restoring processes and re-archiving them leaves them active, in the
# wrong group, with no record of where they belong.

function New-ProcessLedgerEntry {
    param(
        [string]$UniqueId,
        [string]$Name,
        [bool]$WasArchived,
        [string]$OriginalGroupUniqueId,
        $OriginalGroupId
    )

    return [PSCustomObject]@{
        UniqueId              = $UniqueId
        Name                  = $Name
        WasArchived           = $WasArchived
        OriginalGroupUniqueId = $OriginalGroupUniqueId
        OriginalGroupId       = $OriginalGroupId
        RestoredByThisRun     = $false
        RestoredToGroupId     = $null
        Denormalized          = $false
    }
}

function New-ProcessLedgerEntryFromModel {
    param($ProcessModel)

    $state = [string](Get-NodeValue -Node $ProcessModel -Name 'State')
    $stateId = Get-NodeValue -Node $ProcessModel -Name 'StateId'

    # StateId 1 = Active. Trust the numeric id and fall back to the label.
    $archived = $false
    if ($null -ne $stateId) {
        $archived = ([int]$stateId -ne 1)
    } elseif ($state) {
        $archived = ($state -eq 'Archived')
    }

    return New-ProcessLedgerEntry `
        -UniqueId ([string](Get-NodeValue -Node $ProcessModel -Name 'UniqueId')) `
        -Name ([string](Get-NodeValue -Node $ProcessModel -Name 'Name')) `
        -WasArchived $archived `
        -OriginalGroupUniqueId ([string](Get-NodeValue -Node $ProcessModel -Name 'GroupUniqueId')) `
        -OriginalGroupId (Get-NodeValue -Node $ProcessModel -Name 'GroupId')
}

function New-DependencyPlan {
    param(
        [string]$SiteURL,
        [string[]]$TargetUniqueIds
    )

    return [PSCustomObject]@{
        SchemaVersion  = 1
        CreatedUtc     = (Get-Date).ToUniversalTime().ToString('o')
        SiteURL        = $SiteURL
        Status         = 'Draft'
        TargetUniqueIds = @($TargetUniqueIds)
        Ledger         = @()
        Claims         = @()
        Sites          = @()
        WorkItems      = @()
        Reconciliation = @()
        Log            = @()
    }
}

function Export-DependencyPlan {
    param($Plan, [string]$Path)

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    # Write to a temp file and move into place, so a crash mid-write cannot
    # leave a truncated ledger that the resume path would then trust.
    $temp = "$Path.tmp"
    $Plan | ConvertTo-Json -Depth 100 | Set-Content -Path $temp -Encoding UTF8
    Move-Item -Path $temp -Destination $Path -Force
    return $Path
}

function Import-DependencyPlan {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Host "Plan not found: $Path" -ForegroundColor Red
        return $null
    }
    return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

# ============================================================================
# PROCESS STATE AND LIFECYCLE
# ============================================================================

$script:NpmThrottleMs = 0

function Start-NpmThrottle {
    if ($script:NpmThrottleMs -gt 0) { Start-Sleep -Milliseconds $script:NpmThrottleMs }
}

function Get-NpmProcessIndex {
    <#
    .SYNOPSIS
        One pass over the active and archived process lists, keyed by UniqueId.

    .DESCRIPTION
        Archive state has to be known before discovery can be trusted, and
        resolving it per process would be one call each. ListType 0 is active,
        7 is archived, so two paged sweeps classify the whole tenant.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$PageSize = 200
    )

    $index = @{}

    foreach ($listType in @(0, 7)) {
        $isArchived = ($listType -eq 7)
        $page = 1

        do {
            $url = "$SiteURL/Bff/Process/api/v1/processes?Page=$page&PageSize=$PageSize&ListType=$listType"
            $result = Invoke-NpmApi -Url $url -Token $Token -Method Get
            if (-not $result.Success) { break }

            $items = Get-NodeArray -Node $result.Response -Name 'items'
            foreach ($item in $items) {
                $uniqueId = [string](Get-NodeValue -Node $item -Name 'processUniqueId')
                if (-not $uniqueId) { continue }

                $index[$uniqueId.ToLowerInvariant()] = [PSCustomObject]@{
                    UniqueId    = $uniqueId
                    NumericId   = Get-NodeValue -Node $item -Name 'id'
                    Name        = [string](Get-NodeValue -Node $item -Name 'processName')
                    IsArchived  = $isArchived
                    GroupId     = Get-NodeValue -Node $item -Name 'groupId'
                }
            }

            $page++
        } while ($result.Success -and $items.Count -eq $PageSize)
    }

    return $index
}

function Get-NpmIndexEntry {
    param($Index, [string]$UniqueId)

    if (-not $UniqueId) { return $null }
    $key = $UniqueId.ToLowerInvariant()
    if ($Index.ContainsKey($key)) { return $Index[$key] }
    return $null
}

function Get-NpmProcessModelAnyState {
    # Picks the endpoint that matches the process's state. Using the wrong one
    # returns nothing, which a caller would otherwise read as "no references".
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$UniqueId,
        [bool]$IsArchived
    )

    if ($IsArchived) {
        $models = @(Get-NpmArchivedProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueIds @($UniqueId))
        if ($models.Count -gt 0) { return $models[0] }
        return $null
    }

    return (Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $UniqueId)
}

function Restore-NpmProcess {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        $ProcessGroupId
    )

    Start-NpmThrottle
    $result = Invoke-NpmApi -Url "$SiteURL/Process/Edit/RestoreProcess" -Token $Token -Method Post -Body @{
        processUniqueId = $ProcessUniqueId
        processGroupId  = [string]$ProcessGroupId
    }
    return $result.Success
}

function Set-NpmProcessArchived {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        [string]$Comment = 'Bulk operation',
        [bool]$ApprovalsEnabled = $false
    )

    Start-NpmThrottle
    $result = Invoke-NpmApi -Url "$SiteURL/Process/Edit/ArchiveProcess" -Token $Token -Method Post -Body @{
        processUniqueId = $ProcessUniqueId
        comment         = $Comment
    }
    if (-not $result.Success) { return $false }

    # With approvals on, archiving lands in a pending state and needs an explicit
    # publish to take effect.
    if ($ApprovalsEnabled) {
        $model = Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $ProcessUniqueId
        $revisionId = Get-NodeValue -Node $model -Name 'ProcessRevisionEditId'
        if ($revisionId) {
            [void](Invoke-NpmApi -Url "$SiteURL/Api/v1/Processes/$ProcessUniqueId/Publish" -Token $Token -Method Post -Body @{
                ProcessRevisionEditId = [string]$revisionId
                IsPublishNow          = $true
            })
        }
    }

    return $true
}

function Remove-NpmProcess {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        [string]$ProcessGroupUniqueId = ''
    )

    $body = @{ processUniqueId = $ProcessUniqueId }
    if ($ProcessGroupUniqueId) { $body.processGroupUniqueId = $ProcessGroupUniqueId }

    Start-NpmThrottle
    $result = Invoke-NpmApi -Url "$SiteURL/Process/Edit/DeleteProcess" -Token $Token -Method Post -Body $body
    return $result.Success
}

function Find-HiddenInputOutputReference {
    <#
    .SYNOPSIS
        Scans archived processes for Input/Output references to the targets.

    .DESCRIPTION
        Covers the one blind spot the dependency API cannot: an archived process
        whose ONLY reference to a target is an Input or Output is absent from
        every response, so it can never be discovered by querying. Discovering it
        would require restoring it, and knowing to restore it would require
        discovering it.

        Narrowed to Input and Output deliberately. Linked Process edges are
        reported by the API regardless of archive state, so re-scanning for them
        would be redundant work over the whole archive.

    .PARAMETER IncludeActive
        Also scan ACTIVE processes. Off by default because it costs one fetch per
        active process, which is 700+ calls on a typical tenant.

        It is not merely thoroughness. If Input/Output rows report only the
        queried process's own collections (reading (a) of the open question in
        API_ARCHITECTURE.md), then an ACTIVE process whose only reference to a
        target is an Input is invisible to the API too, exactly like an archived
        one. Under reading (b) it would be reported and this scan is redundant.

        Until that question is settled, leaving this off risks leaving a dangling
        input on a surviving process. Turning it on is slow but complete.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        [string[]]$TargetUniqueIds,
        $Index,
        [bool]$IncludeActive = $false,
        [int]$BatchSize = 25
    )

    $sites = @()
    $archivedIds = @()
    $activeIds = @()

    foreach ($entry in $Index.Values) {
        if ($entry.IsArchived) { $archivedIds += $entry.UniqueId }
        elseif ($IncludeActive) { $activeIds += $entry.UniqueId }
    }

    if ($activeIds.Count -gt 0) {
        Write-Host "  Scanning $($activeIds.Count) ACTIVE process(es) for Input/Output references (slow)..." -ForegroundColor Gray
        $done = 0
        foreach ($id in $activeIds) {
            $done++
            if ($done % 25 -eq 0) {
                Write-Host "`r    Scanned $done of $($activeIds.Count)..." -NoNewline -ForegroundColor Gray
            }
            # Active processes must use the individual endpoint; the mobile API
            # is for archived processes and returns nothing useful here.
            $model = Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $id
            if ($null -eq $model) { continue }
            $found = @(Find-ProcessReferenceSite -ProcessObject $model -TargetUniqueIds $TargetUniqueIds)
            $sites += @($found | Where-Object { $_.Category -eq 'Input' -or $_.Category -eq 'Output' })
        }
        Write-Host ""
    }

    if ($archivedIds.Count -eq 0) { return $sites }
    Write-Host "  Scanning $($archivedIds.Count) archived process(es) for Input/Output references..." -ForegroundColor Gray

    for ($i = 0; $i -lt $archivedIds.Count; $i += $BatchSize) {
        $end = [Math]::Min($i + $BatchSize - 1, $archivedIds.Count - 1)
        $models = @(Get-NpmArchivedProcessModel -SiteURL $SiteURL -Token $Token `
            -ProcessUniqueIds $archivedIds[$i..$end] -BatchSize $BatchSize)

        foreach ($model in $models) {
            $found = @(Find-ProcessReferenceSite -ProcessObject $model -TargetUniqueIds $TargetUniqueIds)
            $sites += @($found | Where-Object { $_.Category -eq 'Input' -or $_.Category -eq 'Output' })
        }

        Write-Host "`r    Scanned $([Math]::Min($end + 1, $archivedIds.Count)) of $($archivedIds.Count)..." -NoNewline -ForegroundColor Gray
    }
    Write-Host ""

    if ($sites.Count -gt 0) {
        Write-Host "  Found $($sites.Count) Input/Output reference(s) invisible to the dependency API" -ForegroundColor Yellow
    }
    return $sites
}

# ============================================================================
# PLAN CONSTRUCTION
# ============================================================================

function New-ProcessDeletePlan {
    <#
    .SYNOPSIS
        Discovers, locates and reconciles everything that references the targets.

    .DESCRIPTION
        Ordering here is not cosmetic. Archiving suppresses Input and Output rows
        naming the archived process, so discovery run against an archived
        participant silently under-reports. Participants are therefore restored
        BEFORE discovery is trusted, and discovery is re-run afterwards.

        AllowRestore is false in preview mode, because a preview must not mutate
        the tenant. The resulting plan is then explicitly marked incomplete
        rather than being passed off as a full picture.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        [string[]]$TargetUniqueIds,
        $Index,
        $HoldingGroupId = $null,
        [bool]$AllowRestore = $true,
        [bool]$ScanActiveForInputOutput = $false,
        [int]$MaxPasses = 3
    )

    $plan = New-DependencyPlan -SiteURL $SiteURL -TargetUniqueIds $TargetUniqueIds
    $ledger = @{}
    $allClaims = @()
    $restoredTotal = 0

    function Add-LedgerEntry {
        param($UniqueId)
        $key = $UniqueId.ToLowerInvariant()
        if ($ledger.ContainsKey($key)) { return $ledger[$key] }

        $entry = Get-NpmIndexEntry -Index $Index -UniqueId $UniqueId
        if ($null -eq $entry) { return $null }

        $model = Get-NpmProcessModelAnyState -SiteURL $SiteURL -Token $Token `
            -UniqueId $UniqueId -IsArchived $entry.IsArchived

        $groupUniqueId = [string](Get-NodeValue -Node $model -Name 'GroupUniqueId')
        $groupId = Get-NodeValue -Node $model -Name 'GroupId'
        if ($null -eq $groupId) { $groupId = $entry.GroupId }

        $record = [PSCustomObject]@{
            UniqueId              = $entry.UniqueId
            Name                  = $entry.Name
            NumericId             = $entry.NumericId
            WasArchived           = $entry.IsArchived
            OriginalGroupUniqueId = $groupUniqueId
            OriginalGroupId       = $groupId
            RestoredByThisRun     = $false
            Denormalized          = $false
            Model                 = $model
        }
        $ledger[$key] = $record
        return $record
    }

    # ---- Pass loop: discover, restore, re-discover until the set is stable ----
    for ($pass = 1; $pass -le $MaxPasses; $pass++) {
        Write-Host "`n  Discovery pass $pass..." -ForegroundColor Cyan

        $allClaims = @()
        $failedTargets = @()

        foreach ($target in $TargetUniqueIds) {
            $claims = Get-ProcessDependencyClaim -SiteURL $SiteURL -Token $Token -ProcessUniqueId $target
            if ($null -eq $claims) {
                # A failed check is NOT an empty dependency list. Treating it as
                # one would delete a process whose references were never examined.
                $failedTargets += $target
                continue
            }
            $allClaims += $claims
        }

        if ($failedTargets.Count -gt 0) {
            $plan.Status = 'Blocked'
            $plan.Log += "Dependency check failed for $($failedTargets.Count) target(s): $($failedTargets -join ', ')"
            Write-Host "  Dependency check failed for $($failedTargets.Count) target(s). Cannot plan safely." -ForegroundColor Red
            return $plan
        }

        $candidates = @(Get-DependencyCandidate -Claims $allClaims -TargetUniqueIds $TargetUniqueIds)
        Write-Host "  $($allClaims.Count) claim(s) across $($candidates.Count) process(es)" -ForegroundColor Gray

        foreach ($candidate in $candidates) { [void](Add-LedgerEntry -UniqueId $candidate) }

        # Restore archived participants so their suppressed Input/Output edges
        # become visible to the next pass.
        $restoredThisPass = 0
        if ($AllowRestore -and $null -ne $HoldingGroupId) {
            foreach ($candidate in $candidates) {
                $record = $ledger[$candidate.ToLowerInvariant()]
                if ($null -eq $record -or -not $record.WasArchived -or $record.RestoredByThisRun) { continue }

                # Restore in place. Dependency holders are not being deleted, so
                # parking them in the temp group would strand them there.
                $groupId = $record.OriginalGroupId
                if ($null -eq $groupId) { $groupId = $HoldingGroupId }

                Write-Host "    Restoring archived process: $($record.Name)" -ForegroundColor Yellow
                if (Restore-NpmProcess -SiteURL $SiteURL -Token $Token -ProcessUniqueId $record.UniqueId -ProcessGroupId $groupId) {
                    $record.RestoredByThisRun = $true
                    $restoredThisPass++
                    $restoredTotal++
                    $plan.Log += "Restored $($record.UniqueId) ($($record.Name)) to group $groupId for discovery"
                } else {
                    $plan.Log += "FAILED to restore $($record.UniqueId) ($($record.Name)); its Input/Output edges stay hidden"
                    Write-Host "    Failed to restore $($record.Name)" -ForegroundColor Red
                }
            }
        }

        if ($restoredThisPass -eq 0) {
            Write-Host "  Claim set stable after pass $pass" -ForegroundColor Gray
            break
        }
        Write-Host "  Restored $restoredThisPass process(es); re-running discovery" -ForegroundColor Gray
    }

    # ---- The API blind spot: archived Input/Output holders ----
    $freshIndex = $Index
    if ($restoredTotal -gt 0) {
        $freshIndex = Get-NpmProcessIndex -SiteURL $SiteURL -Token $Token
    }
    $blindSites = @(Find-HiddenInputOutputReference -SiteURL $SiteURL -Token $Token `
        -TargetUniqueIds $TargetUniqueIds -Index $freshIndex -IncludeActive $ScanActiveForInputOutput)

    foreach ($site in $blindSites) {
        if (-not $ledger.ContainsKey($site.HolderUniqueId.ToLowerInvariant())) {
            [void](Add-LedgerEntry -UniqueId $site.HolderUniqueId)
            $plan.Log += "Archive scan found holder $($site.HolderUniqueId) that the dependency API never reported"
        }
    }

    # ---- Locate: walk every participant, both directions ----
    $participants = @($ledger.Values)
    foreach ($target in $TargetUniqueIds) { [void](Add-LedgerEntry -UniqueId $target) }
    $participants = @($ledger.Values)

    $targetLookup = @{}
    foreach ($t in $TargetUniqueIds) { $targetLookup[$t.ToLowerInvariant()] = $true }

    $allSites = @()
    foreach ($record in $participants) {
        if ($null -eq $record.Model) {
            $plan.Log += "Could not fetch model for $($record.UniqueId) ($($record.Name)); its references were not examined"
            continue
        }

        $isTarget = $targetLookup.ContainsKey($record.UniqueId.ToLowerInvariant())

        if ($isTarget) {
            # Sites inside a target are located for reconciliation only. The
            # target is about to be deleted, so editing it is wasted work.
            $others = @($participants | Where-Object { $_.UniqueId -ne $record.UniqueId } | ForEach-Object { $_.UniqueId })
            $allSites += @(Find-ProcessReferenceSite -ProcessObject $record.Model -TargetUniqueIds $others)
        } else {
            $allSites += @(Find-ProcessReferenceSite -ProcessObject $record.Model -TargetUniqueIds $TargetUniqueIds)
        }
    }

    # ---- Filter: self-references and target-held sites are not work ----
    $workSites = @($allSites | Where-Object {
        $_.HolderUniqueId -ne $_.TargetUniqueId -and
        -not $targetLookup.ContainsKey($_.HolderUniqueId.ToLowerInvariant()) -and
        $targetLookup.ContainsKey($_.TargetUniqueId.ToLowerInvariant())
    })

    $workItems = @(Group-ReferenceSiteByHolder -Sites $workSites)

    # ---- Reconcile per pair ----
    $reconciliation = @()
    foreach ($target in $TargetUniqueIds) {
        $related = @($allClaims | Where-Object { $_.QueriedUniqueId -eq $target } |
            ForEach-Object { $_.RelatedUniqueId } | Select-Object -Unique)

        foreach ($relatedId in $related) {
            $record = $ledger[$relatedId.ToLowerInvariant()]
            $isArchived = $false
            if ($null -ne $record) { $isArchived = ($record.WasArchived -and -not $record.RestoredByThisRun) }

            $reconciliation += @(Test-DependencyReconciliation -QueriedUniqueId $target -RelatedUniqueId $relatedId `
                -Claims $allClaims -Sites $allSites -RelatedIsArchived $isArchived)
        }
    }

    $plan.Ledger = @($ledger.Values | ForEach-Object {
        # The model is dropped from the persisted ledger: it is large, it is
        # re-fetchable, and a stale copy is worse than none on resume.
        [PSCustomObject]@{
            UniqueId              = $_.UniqueId
            Name                  = $_.Name
            NumericId             = $_.NumericId
            WasArchived           = $_.WasArchived
            OriginalGroupUniqueId = $_.OriginalGroupUniqueId
            OriginalGroupId       = $_.OriginalGroupId
            RestoredByThisRun     = $_.RestoredByThisRun
            Denormalized          = $_.Denormalized
        }
    })
    $plan.Claims = $allClaims
    $plan.Sites = $workSites
    $plan.WorkItems = $workItems
    $plan.Reconciliation = $reconciliation
    $plan.Status = 'Planned'

    if (-not $AllowRestore) {
        $archivedCount = @($ledger.Values | Where-Object { $_.WasArchived }).Count
        if ($archivedCount -gt 0) {
            $plan.Status = 'PlannedIncomplete'
            $plan.Log += "Preview did not restore $archivedCount archived participant(s); their Input/Output references are hidden and this plan understates the work"
        }
    }

    return $plan
}

# ============================================================================
# PLAN PREVIEW
# ============================================================================

function Show-ProcessDeletePlan {
    param($Plan, $Index)

    Write-Host "`n=== PLAN SUMMARY ===" -ForegroundColor Cyan
    Write-Host "Targets to delete : $(@($Plan.TargetUniqueIds).Count)" -ForegroundColor White
    Write-Host "Processes to edit : $(@($Plan.WorkItems).Count)" -ForegroundColor White
    Write-Host "Reference sites   : $(@($Plan.Sites).Count)" -ForegroundColor White

    $archived = @($Plan.Ledger | Where-Object { $_.WasArchived })
    if ($archived.Count -gt 0) {
        Write-Host "Archived involved : $($archived.Count) (restored for the run, re-archived afterwards)" -ForegroundColor Yellow
    }

    if (@($Plan.WorkItems).Count -gt 0) {
        Write-Host "`nReferences to remove, by holding process:" -ForegroundColor Yellow
        foreach ($item in @($Plan.WorkItems)) {
            $record = @($Plan.Ledger | Where-Object { $_.UniqueId -eq $item.HolderUniqueId })
            $name = if ($record.Count -gt 0) { $record[0].Name } else { $item.HolderUniqueId }
            $state = if ($record.Count -gt 0 -and $record[0].WasArchived) { ' [archived]' } else { '' }

            Write-Host "  $name$state" -ForegroundColor White
            foreach ($site in @($item.Sites)) {
                Write-Host "      $($site.Action.PadRight(7)) $($site.Path)" -ForegroundColor Gray
            }
        }
    }

    $groupSites = @($Plan.Sites | Where-Object { $_.Action -eq 'Report' })
    if ($groupSites.Count -gt 0) {
        Write-Host "`nGroup links (reported, never removed automatically):" -ForegroundColor Yellow
        foreach ($site in $groupSites) {
            Write-Host "  $($site.HolderUniqueId) -> $($site.TargetUniqueId)" -ForegroundColor Gray
        }
    }

    $problems = @($Plan.Reconciliation | Where-Object { $_.Status -eq 'Mismatch' })
    if ($problems.Count -gt 0) {
        Write-Host "`nRECONCILIATION MISMATCHES:" -ForegroundColor Red
        Write-Host "The dependency API and the process JSON disagree. Investigate before deleting." -ForegroundColor Red
        foreach ($p in $problems) {
            Write-Host "  $($p.Category): claimed $($p.Claimed), located $($p.Located) - $($p.Note)" -ForegroundColor Red
        }
    }

    $suppressed = @($Plan.Reconciliation | Where-Object { $_.Suppressed -and $_.Located -gt 0 })
    if ($suppressed.Count -gt 0) {
        Write-Host "`nSuppressed by archiving (found in JSON, hidden from the API):" -ForegroundColor Yellow
        foreach ($s in $suppressed) {
            Write-Host "  $($s.Category): $($s.Located) reference(s) on $($s.RelatedUniqueId)" -ForegroundColor Yellow
        }
    }

    if (@($Plan.Log).Count -gt 0) {
        Write-Host "`nPlan log:" -ForegroundColor Cyan
        foreach ($line in @($Plan.Log)) { Write-Host "  $line" -ForegroundColor Gray }
    }

    if ($Plan.Status -eq 'PlannedIncomplete') {
        Write-Host "`n*** THIS PLAN IS INCOMPLETE ***" -ForegroundColor Yellow
        Write-Host "Preview mode does not restore archived processes, so their Input and Output" -ForegroundColor Yellow
        Write-Host "references are hidden. A real run will find more than this preview shows." -ForegroundColor Yellow
    }
}

# ============================================================================
# EXECUTION
# ============================================================================

function Invoke-ProcessDeletePlan {
    <#
    .SYNOPSIS
        Executes a plan: removes references, verifies, deletes targets, restores state.

    .DESCRIPTION
        Phase order is load-bearing:

          Remove   one fetch, one save, one publish per HOLDER, carrying every
                   target at once. Saving per target would publish a holder
                   repeatedly and leave a window where it is re-archived while
                   later edits are still pending.

          Verify   BEFORE re-archiving, and by re-walking each holder's JSON
                   rather than re-querying the API. Archiving suppresses the
                   very rows that would reveal a missed reference, so a check
                   run afterwards reports success either way.

          Delete   targets only, after verification passes.

          Restore  re-archive everything the ledger says was archived, back to
                   its ORIGINAL group. The plan is written to disk after each
                   one so an interrupted run can be finished from the file.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        $Plan,
        [string]$PlanPath,
        [bool]$ApprovalsEnabled = $false,
        [bool]$SkipVerification = $false
    )

    $results = @()

    # ---- Remove references, one save per holder ----
    Write-Host "`n=== REMOVING REFERENCES ===" -ForegroundColor Cyan
    $workItems = @($Plan.WorkItems)

    if ($workItems.Count -eq 0) {
        Write-Host "  No references to remove." -ForegroundColor Gray
    }

    $index = 0
    foreach ($item in $workItems) {
        $index++
        $holderId = $item.HolderUniqueId
        $record = @($Plan.Ledger | Where-Object { $_.UniqueId -eq $holderId })
        $name = if ($record.Count -gt 0) { $record[0].Name } else { $holderId }

        Write-Host "  [$index/$($workItems.Count)] $name ($(@($item.Sites).Count) site(s))..." -ForegroundColor Gray

        $model = Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $holderId
        if ($null -eq $model) {
            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $holderId; Name = $name
                Operation = 'RemoveReferences'; Status = 'Failed'
                Message = 'Could not fetch process for editing'
            }
            continue
        }

        $removal = Remove-ProcessReference -ProcessObject $model -TargetUniqueIds @($item.TargetsAffected)

        if ($removal.ReferencesRemoved -eq 0) {
            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $holderId; Name = $name
                Operation = 'RemoveReferences'; Status = 'Skipped'
                Message = 'No references found at edit time (already removed?)'
            }
            continue
        }

        $save = Save-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $holderId `
            -ProcessObject $removal.CleanedObject -ChangeDescription 'Automated dependency removal' `
            -ApprovalsEnabled $ApprovalsEnabled -SuppressChangeNotification $true

        $results += [PSCustomObject]@{
            ObjectType = 'Process'; ObjectID = $holderId; Name = $name
            Operation = 'RemoveReferences'
            Status = $(if ($save.Success) { 'Success' } else { 'Failed' })
            Message = $(if ($save.Success) { "Removed $($removal.ReferencesRemoved) reference(s), $($save.Stage)" }
                        else { "$($save.Stage) failed: $($save.Error)" })
        }

        if (-not $save.Success) {
            Write-Host "      Save failed: $($save.Error)" -ForegroundColor Red
        }
    }

    # ---- Verify, while everything is still active ----
    $verificationFailed = @()
    if (-not $SkipVerification) {
        Write-Host "`n=== VERIFYING (all participants still active) ===" -ForegroundColor Cyan

        foreach ($item in $workItems) {
            $model = Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $item.HolderUniqueId
            if ($null -eq $model) { continue }

            $remaining = @(Find-ProcessReferenceSite -ProcessObject $model -TargetUniqueIds @($item.TargetsAffected))
            $remaining = @($remaining | Where-Object { $_.Action -ne 'Report' })

            if ($remaining.Count -gt 0) {
                $verificationFailed += [PSCustomObject]@{
                    HolderUniqueId = $item.HolderUniqueId
                    Remaining      = $remaining
                }
                Write-Host "  $($item.HolderUniqueId): $($remaining.Count) reference(s) still present" -ForegroundColor Red
                foreach ($site in $remaining) {
                    Write-Host "      $($site.Path)" -ForegroundColor Red
                }
            }
        }

        if ($verificationFailed.Count -eq 0) {
            Write-Host "  All references removed." -ForegroundColor Green
        }
    }

    return [PSCustomObject]@{
        Results            = $results
        VerificationFailed = $verificationFailed
    }
}

function Invoke-ProcessTargetDeletion {
    # Archives then deletes the targets. Split from reference removal so a caller
    # can stop between verification and the irreversible step.
    param(
        [string]$SiteURL,
        [string]$Token,
        $Plan,
        [bool]$ApprovalsEnabled = $false
    )

    $results = @()
    $targets = @($Plan.TargetUniqueIds)

    Write-Host "`n=== ARCHIVING TARGETS ===" -ForegroundColor Cyan
    $i = 0
    foreach ($target in $targets) {
        $i++
        $record = @($Plan.Ledger | Where-Object { $_.UniqueId -eq $target })
        $name = if ($record.Count -gt 0) { $record[0].Name } else { $target }
        Write-Host "`r  Archiving $i of $($targets.Count)..." -NoNewline -ForegroundColor Gray

        if ($record.Count -gt 0 -and $record[0].WasArchived -and -not $record[0].RestoredByThisRun) { continue }
        [void](Set-NpmProcessArchived -SiteURL $SiteURL -Token $Token -ProcessUniqueId $target `
            -Comment 'Pre-delete archive' -ApprovalsEnabled $ApprovalsEnabled)
    }
    Write-Host ""

    Write-Host "`n=== DELETING TARGETS ===" -ForegroundColor Red
    $i = 0
    foreach ($target in $targets) {
        $i++
        $record = @($Plan.Ledger | Where-Object { $_.UniqueId -eq $target })
        $name = if ($record.Count -gt 0) { $record[0].Name } else { $target }
        $groupUniqueId = if ($record.Count -gt 0) { [string]$record[0].OriginalGroupUniqueId } else { '' }

        Write-Host "`r  Deleting $i of $($targets.Count)..." -NoNewline -ForegroundColor Red

        $ok = Remove-NpmProcess -SiteURL $SiteURL -Token $Token -ProcessUniqueId $target -ProcessGroupUniqueId $groupUniqueId
        $results += [PSCustomObject]@{
            ObjectType = 'Process'; ObjectID = $target; Name = $name
            Operation = 'Delete'
            Status = $(if ($ok) { 'Success' } else { 'Failed' })
            Message = $(if ($ok) { 'Deleted' } else { 'Delete failed' })
        }
    }
    Write-Host ""

    return $results
}

function Restore-ProcessPlanState {
    <#
    .SYNOPSIS
        Re-archives everything this run restored, back to its original group.

    .DESCRIPTION
        Idempotent and resumable. The plan is re-written after each entry, so a
        run interrupted here can be finished by re-importing the plan and calling
        this again: entries already marked Denormalized are skipped.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        $Plan,
        [string]$PlanPath,
        [bool]$ApprovalsEnabled = $false
    )

    $results = @()
    $toRestore = @($Plan.Ledger | Where-Object { $_.WasArchived -and $_.RestoredByThisRun -and -not $_.Denormalized })

    if ($toRestore.Count -eq 0) { return $results }

    Write-Host "`n=== RE-ARCHIVING RESTORED PROCESSES ===" -ForegroundColor Cyan

    foreach ($entry in $toRestore) {
        Write-Host "  Re-archiving $($entry.Name)..." -ForegroundColor Gray

        $ok = Set-NpmProcessArchived -SiteURL $SiteURL -Token $Token -ProcessUniqueId $entry.UniqueId `
            -Comment 'Re-archiving after dependency cleanup' -ApprovalsEnabled $ApprovalsEnabled

        $entry.Denormalized = $ok
        $results += [PSCustomObject]@{
            ObjectType = 'Process'; ObjectID = $entry.UniqueId; Name = $entry.Name
            Operation = 'ReArchive'
            Status = $(if ($ok) { 'Success' } else { 'Failed' })
            Message = $(if ($ok) { "Re-archived to group $($entry.OriginalGroupUniqueId)" }
                        else { 'Re-archive failed; this process is still ACTIVE' })
        }

        if (-not $ok) {
            Write-Host "    Failed. $($entry.Name) is still active and must be archived manually." -ForegroundColor Red
        }

        if ($PlanPath) { [void](Export-DependencyPlan -Plan $Plan -Path $PlanPath) }
    }

    return $results
}
