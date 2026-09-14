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
