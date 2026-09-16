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

    $sites += @(Find-InputOutputReferenceSite -ProcessObject $ProcessObject -TargetUniqueIds $TargetUniqueIds)

    return $sites
}

function Find-InputOutputReferenceSite {
    <#
    .SYNOPSIS
        Input and Output references only, without walking the activity tree.

    .DESCRIPTION
        Split out of Find-ProcessReferenceSite, which calls it, so that the
        archived blind-spot sweep can ask for exactly what it wants.

        That sweep only ever cares about Input and Output rows, but it used to
        call the full walk and throw the rest away: every procedure bucket, every
        node, and the child recursion underneath each one, discarded. Across a
        479-process archive that is 479 whole activity trees walked for nothing.
        Inputs and Outputs are two flat collections hanging off the root.

        Pure: no network, no mutation of the input object.
    #>
    param(
        $ProcessObject,
        [string[]]$TargetUniqueIds
    )

    $sites = @()
    if ($null -eq $ProcessObject) { return $sites }

    $holder = [string](Get-NodeValue -Node $ProcessObject -Name 'UniqueId')

    # Live payloads use null, not [], when unused.
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

    .PARAMETER BothSidesDeleted
        Set when the queried process and the related process are BOTH in the
        delete set. Whatever references the pair holds to each other cease to
        exist when both are deleted, so there is nothing to remove, nothing to
        get wrong, and nothing for an operator to adjudicate.

        Entries are still emitted, with Status 'NotApplicable', because the plan
        file is the audit record of what the run considered. They are simply not
        gated on. On the tenant this was measured against, 114 of 120 Link
        mismatches were pairs of this kind: the operator was being asked to
        review 120 lines to protect the 6 that could matter.
    #>
    param(
        [string]$QueriedUniqueId,
        [string]$RelatedUniqueId,
        $Claims,
        $Sites,
        [bool]$RelatedIsArchived = $false,
        [bool]$BothSidesDeleted = $false
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

        if ($BothSidesDeleted) {
            # Both ends of this pair are being deleted. The references between
            # them are going away with them, whatever the counts say.
            $status = 'NotApplicable'
            $note = 'Both processes are delete targets; references between them disappear with them'
        }
        elseif ($claimed -ne $expected) {
            $status = 'Mismatch'

            $childCount = @($categorySites | Where-Object {
                $_.IsChild -and $_.HolderUniqueId -eq $QueriedUniqueId
            }).Count

            # The asymmetry runs in both directions. The measured tenant shows
            # the API over-claiming (claimed 2, located 1) far more often than
            # the JSON holding more than the API reports, and the delta is the
            # holder's child-procedure count in both cases. Neither direction is
            # evidence of drift on its own; see the open question in
            # API_ARCHITECTURE.md, which a fixture still has to settle.
            $delta = [Math]::Abs($claimed - $expected)

            if ($category -eq 'Link' -and $childCount -gt 0 -and $delta -eq $childCount) {
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

    .OUTPUTS
        A result object, never a bare array:

            Success - $true when the endpoint answered, whatever it answered
            Claims  - the parsed claims, empty when there are no dependencies
            Status  - HTTP status code
            Error   - failure message, $null on success

        Success is carried in a field rather than encoded in the return value on
        purpose. Returning $null for failure and an array for success cannot
        work in PowerShell: an empty array unrolls to $null on return, so a
        process with no dependencies is indistinguishable at the call site from
        a check that never ran. That collapse blocked a 497-target run where 392
        targets were simply dependency-free. A field cannot unroll.
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
        return [PSCustomObject]@{
            Success = $false
            Claims  = @()
            Status  = $result.StatusCode
            Error   = $result.Error
        }
    }

    return [PSCustomObject]@{
        Success = $true
        Claims  = @(ConvertFrom-DependencyResponse -Response $result.Response -QueriedUniqueId $ProcessUniqueId)
        Status  = $result.StatusCode
        Error   = $null
    }
}

# ----------------------------------------------------------------------------
# Process model cache
# ----------------------------------------------------------------------------
# Planning walks the same processes several times: once per discovery pass, then
# again in the archived Input/Output sweep, then again when the ledger is built.
# On a 497-target run that was hundreds of redundant fetches and most of the
# eleven minutes a single pass took.
#
# The cache is OFF by default and only switched on for the planning phase, which
# is read-only. It is invalidated on every write, because a cached copy that
# outlives a save or an archive-state change is worse than no cache at all: the
# whole point of re-reading after a save is to verify what actually landed.

$script:NpmModelCache = @{}
$script:NpmModelCacheEnabled = $false
$script:NpmModelCacheHits = 0

function Enable-NpmModelCache {
    $script:NpmModelCache = @{}
    $script:NpmModelCacheEnabled = $true
    $script:NpmModelCacheHits = 0
}

function Disable-NpmModelCache {
    $script:NpmModelCache = @{}
    $script:NpmModelCacheEnabled = $false
}

function Get-NpmModelCacheHitCount { return $script:NpmModelCacheHits }

function Get-NpmCachedModel {
    param([string]$UniqueId)
    if (-not $script:NpmModelCacheEnabled -or -not $UniqueId) { return $null }
    $key = $UniqueId.ToLowerInvariant()
    if ($script:NpmModelCache.ContainsKey($key)) {
        $script:NpmModelCacheHits++
        return $script:NpmModelCache[$key]
    }
    return $null
}

function Set-NpmCachedModel {
    param([string]$UniqueId, $Model)
    if (-not $script:NpmModelCacheEnabled -or -not $UniqueId -or $null -eq $Model) { return }
    $script:NpmModelCache[$UniqueId.ToLowerInvariant()] = $Model
}

function Clear-NpmCachedModel {
    # Called on every mutation. A stale model is a corrupted save waiting to
    # happen, so eviction is unconditional and does not check the enabled flag.
    param([string]$UniqueId)
    if (-not $UniqueId) { return }
    $script:NpmModelCache.Remove($UniqueId.ToLowerInvariant())
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

    Clear-NpmCachedModel -UniqueId $ProcessUniqueId
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
        Deleted               = $false
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

function New-ProcessStateSnapshot {
    <#
    .SYNOPSIS
        Captures archive state and home group for a set of processes, before the
        run mutates anything.

    .DESCRIPTION
        The Hold phase un-archives every archived target and moves it into a
        temporary group. Any index read after that reports the moved state, so a
        ledger built from it says the targets were never archived and names the
        temp group as their home. That ledger is not a crash-safety net: on a
        resume it would re-archive nothing and point at a group cleanup may
        already have deleted.

        This snapshot is taken first and is the authority for WasArchived and
        OriginalGroup* from then on.

    .PARAMETER GroupUniqueIdMap
        Optional numeric-group-id to group-UniqueId map. The process list gives
        a numeric groupId only, but deletion wants the group's UniqueId, and
        resolving it per process would be one fetch each.
    #>
    param(
        $Index,
        [string[]]$UniqueIds,
        $GroupUniqueIdMap = $null
    )

    $snapshot = @{}

    foreach ($id in @($UniqueIds)) {
        if (-not $id) { continue }
        $entry = Get-NpmIndexEntry -Index $Index -UniqueId $id
        if ($null -eq $entry) { continue }

        $groupUniqueId = ''
        if ($null -ne $GroupUniqueIdMap -and $null -ne $entry.GroupId) {
            $key = "$($entry.GroupId)"
            if ($GroupUniqueIdMap.ContainsKey($key)) { $groupUniqueId = [string]$GroupUniqueIdMap[$key] }
        }

        $snapshot[$entry.UniqueId.ToLowerInvariant()] = [PSCustomObject]@{
            UniqueId              = $entry.UniqueId
            Name                  = $entry.Name
            NumericId             = $entry.NumericId
            WasArchived           = $entry.IsArchived
            IsArchivedNow         = $entry.IsArchived
            OriginalGroupId       = $entry.GroupId
            OriginalGroupUniqueId = $groupUniqueId
            RestoredByThisRun     = $false
        }
    }

    return $snapshot
}

function New-TenantStateSnapshot {
    <#
    .SYNOPSIS
        Archive state and group for EVERY process in the tenant, before the run
        changes anything.

    .DESCRIPTION
        The per-target snapshot records what the run means to touch. This one
        records everything, so that what the run touched can be compared against
        what it meant to touch.

        That comparison is the only handle available on process variations.
        Nintex PM stores a variation as its own record, in its own group, and the
        link to its master appears nowhere in the process model or in a list
        entry: not in any of the 46 keys of the model, not in the 5 fields of an
        index entry. So a bulk operation on a variation silently acts on its
        master as well, and no amount of reading a target tells you it will.

        What you can do is take the tenant's state before and after, and look at
        what moved that was not asked to move.

        It is built from the index that has already been fetched, so it costs a
        walk over a hashtable, not a single extra API call.
    #>
    param($Index)

    $baseline = @{}
    if ($null -eq $Index) { return $baseline }

    foreach ($entry in $Index.Values) {
        if (-not $entry.UniqueId) { continue }
        $baseline[$entry.UniqueId.ToLowerInvariant()] = [PSCustomObject]@{
            UniqueId   = $entry.UniqueId
            Name       = $entry.Name
            NumericId  = $entry.NumericId
            IsArchived = $entry.IsArchived
            GroupId    = $entry.GroupId
        }
    }

    return $baseline
}

function Find-VariationMaster {
    <#
    .SYNOPSIS
        Targets that look like variations, whose master is not also a target.

    .DESCRIPTION
        The only thing that prevents collateral damage is knowing about the
        coupling BEFORE anything mutates, and no field in the API exposes it.
        The name does, imperfectly.

        On this tenant a variation is named "<master name>::<variant>". 62
        processes carry the separator and 43 of those have a process with the
        matching base name. So: a target whose name contains the separator is
        treated as a variation, and if a process with its base name exists and
        is NOT itself a target, the run is about to touch something nobody
        listed.

        This is a heuristic and is documented as one. It selected all five
        targets of the run that produced collateral, and all five produced it,
        so it has no false negatives on the only sample available. That is a
        sample of five. It can miss a variation whose master was renamed, and it
        can flag two unrelated processes that happen to share a prefix.

        Being a heuristic is why it warns rather than blocks an attended run.
        Being the only warning available before the damage is why an unattended
        run stops on it.

    .PARAMETER Separator
        Default '::'. Configurable because it is a naming convention, not an API
        contract, and another tenant may not use it.
    #>
    param(
        $Index,
        [string[]]$TargetUniqueIds,
        [string]$Separator = '::'
    )

    $found = @()
    if ($null -eq $Index) { return $found }

    $targetLookup = @{}
    foreach ($id in @($TargetUniqueIds)) {
        if ($id) { $targetLookup[$id.ToLowerInvariant()] = $true }
    }

    # Name to entries. Names are not unique, so every match is reported.
    $byName = @{}
    foreach ($entry in $Index.Values) {
        if (-not $entry.Name) { continue }
        $nameKey = ([string]$entry.Name).Trim().ToLowerInvariant()
        if (-not $byName.ContainsKey($nameKey)) { $byName[$nameKey] = @() }
        $byName[$nameKey] += $entry
    }

    foreach ($id in @($TargetUniqueIds)) {
        if (-not $id) { continue }
        $entry = Get-NpmIndexEntry -Index $Index -UniqueId $id
        if ($null -eq $entry -or -not $entry.Name) { continue }

        $name = [string]$entry.Name
        $at = $name.IndexOf($Separator)
        if ($at -lt 1) { continue }

        $baseName = $name.Substring(0, $at).Trim()
        if (-not $baseName) { continue }

        $baseKey = $baseName.ToLowerInvariant()
        if (-not $byName.ContainsKey($baseKey)) { continue }

        foreach ($master in $byName[$baseKey]) {
            # A master that is itself being deleted is not a surprise.
            if ($targetLookup.ContainsKey($master.UniqueId.ToLowerInvariant())) { continue }

            $found += [PSCustomObject]@{
                TargetUniqueId  = $entry.UniqueId
                TargetName      = $name
                TargetGroupId   = $entry.GroupId
                BaseName        = $baseName
                MasterUniqueId  = $master.UniqueId
                MasterName      = $master.Name
                MasterGroupId   = $master.GroupId
                MasterIsArchived = $master.IsArchived
            }
        }
    }

    return $found
}

function Show-VariationWarning {
    param($Matches, [string]$Separator = '::')

    $items = @($Matches)
    if ($items.Count -eq 0) { return }

    # One row per (target, candidate master) pair, so the row count is not the
    # target count. Reporting 13 "targets" for 3 targets is how a warning stops
    # being read.
    $byTarget = @($items | Group-Object TargetUniqueId)
    $masterCount = @($items | ForEach-Object { $_.MasterUniqueId } | Select-Object -Unique).Count

    Write-Host "`n========================================" -ForegroundColor Yellow
    Write-Host "  VARIATION TARGETS DETECTED" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "$($byTarget.Count) target(s) are named like variations, with $masterCount candidate master(s)" -ForegroundColor Yellow
    Write-Host "not in the target set. Acting on a variation acts on its master too." -ForegroundColor Yellow
    Write-Host ""

    foreach ($group in $byTarget) {
        $first = $group.Group[0]
        Write-Host "  $($first.TargetName)" -ForegroundColor Yellow
        Write-Host "      ($($first.TargetUniqueId))" -ForegroundColor DarkGray

        # W5: the row that carries the risk goes first. Only an ACTIVE master can
        # be collaterally archived, and a master in the target's own group is a
        # likelier relative than one elsewhere. Name breaks the remaining ties so
        # the order is stable rather than whatever the hashtable happened to give.
        $ordered = @($group.Group | Sort-Object `
            @{ Expression = { if ($_.MasterIsArchived) { 1 } else { 0 } } }, `
            @{ Expression = { if ("$($_.MasterGroupId)" -eq "$($_.TargetGroupId)") { 0 } else { 1 } } }, `
            @{ Expression = { [string]$_.MasterName } })

        foreach ($m in $ordered) {
            $state = if ($m.MasterIsArchived) { 'archived' } else { 'active' }
            $risk = if ($m.MasterIsArchived) { '' } else { '  <-- can be archived by this run' }
            $colour = if ($m.MasterIsArchived) { 'DarkGray' } else { 'Red' }
            Write-Host "      master: $($m.MasterName)  ($($m.MasterUniqueId)) - $state, group $($m.MasterGroupId)$risk" -ForegroundColor $colour
        }
    }

    Write-Host ""
    Write-Host "This is a NAME heuristic, matching on '$Separator', not an API guarantee. It can" -ForegroundColor Yellow
    Write-Host "miss a variation whose master was renamed, and it can flag two unrelated" -ForegroundColor Yellow
    Write-Host "processes that share a prefix. Nothing in the API exposes the real link." -ForegroundColor Yellow
}

function Compare-TenantState {
    <#
    .SYNOPSIS
        Processes that changed state without being asked to.

    .DESCRIPTION
        Diffs a fresh index against a baseline and returns everything that moved
        which is not in ExpectedUniqueIds. Each result names what changed, so the
        caller can both report it and decide what is reversible.

        Change is one of:

          Archived           active before, archived now
          Unarchived         archived before, active now
          Moved              same archive state, different group
          ArchivedAndMoved   both
          Disappeared        in the baseline, absent from the fresh index

        Disappeared is the one that matters most and the one a naive diff misses.
        If deleting a variation also deleted its master, this is where it shows.

    .PARAMETER ExpectedUniqueIds
        Everything the run deliberately changed: the targets, plus any holder it
        restored on purpose. Those are not collateral and must be passed in, or
        every run reports its own work as damage.

    .PARAMETER ObservedUniqueIds
        Processes the run actually came across, whatever the lists said. Any of
        them that is absent from the baseline is reported as NotInBaseline.

        The baseline is built from the two list sweeps, and those sweeps are not
        complete: processes exist that neither returns. One such process turned
        up stranded in a holding group after a run, having never appeared in any
        before-state, so no placement of any checkpoint could have classified it.
        It cannot be said whether it changed, only that the run touched it and
        its prior state is unknown. That is worth reporting as its own category
        rather than passing over in silence.
    #>
    param(
        $Baseline,
        $Index,
        [string[]]$ExpectedUniqueIds = @(),
        [string[]]$ObservedUniqueIds = @()
    )

    $collateral = @()
    if ($null -eq $Baseline -or $null -eq $Index) { return $collateral }

    $expected = @{}
    foreach ($id in @($ExpectedUniqueIds)) {
        if ($id) { $expected[$id.ToLowerInvariant()] = $true }
    }

    foreach ($key in $Baseline.Keys) {
        if ($expected.ContainsKey($key)) { continue }

        $before = $Baseline[$key]
        $after = $null
        if ($Index.ContainsKey($key)) { $after = $Index[$key] }

        if ($null -eq $after) {
            $collateral += [PSCustomObject]@{
                UniqueId        = $before.UniqueId
                Name            = $before.Name
                Change          = 'Disappeared'
                WasArchived     = $before.IsArchived
                IsArchivedNow   = $null
                OriginalGroupId = $before.GroupId
                CurrentGroupId  = $null
            }
            continue
        }

        $archiveChanged = ([bool]$before.IsArchived -ne [bool]$after.IsArchived)
        $groupChanged = ("$($before.GroupId)" -ne "$($after.GroupId)")

        if (-not $archiveChanged -and -not $groupChanged) { continue }

        $change = 'Moved'
        if ($archiveChanged -and $groupChanged) {
            $change = 'ArchivedAndMoved'
        } elseif ($archiveChanged) {
            $change = if ($after.IsArchived) { 'Archived' } else { 'Unarchived' }
        }

        $collateral += [PSCustomObject]@{
            UniqueId        = $before.UniqueId
            Name            = $before.Name
            Change          = $change
            WasArchived     = $before.IsArchived
            IsArchivedNow   = $after.IsArchived
            OriginalGroupId = $before.GroupId
            CurrentGroupId  = $after.GroupId
        }
    }

    # Anything the run met that the baseline never knew about. No before-state
    # exists for these, so no comparison is possible; they are flagged on the
    # strength of having been encountered at all.
    $alreadyReported = @{}
    foreach ($c in $collateral) { $alreadyReported[$c.UniqueId.ToLowerInvariant()] = $true }

    foreach ($id in @($ObservedUniqueIds)) {
        if (-not $id) { continue }
        $key = $id.ToLowerInvariant()
        if ($expected.ContainsKey($key)) { continue }
        if ($Baseline.ContainsKey($key)) { continue }
        if ($alreadyReported.ContainsKey($key)) { continue }
        $alreadyReported[$key] = $true

        $name = ''
        $groupId = $null
        if ($Index.ContainsKey($key)) {
            $name = $Index[$key].Name
            $groupId = $Index[$key].GroupId
        }

        $collateral += [PSCustomObject]@{
            UniqueId        = $id
            Name            = $name
            Change          = 'NotInBaseline'
            WasArchived     = $null
            IsArchivedNow   = $(if ($Index.ContainsKey($key)) { $Index[$key].IsArchived } else { $null })
            OriginalGroupId = $null
            CurrentGroupId  = $groupId
        }
    }

    return $collateral
}

function Show-CollateralDamage {
    <#
    .SYNOPSIS
        Names every process the run changed that it was not asked to change.
    #>
    param($Collateral, [string]$Phase = '')

    $items = @($Collateral)
    if ($items.Count -eq 0) { return }

    Write-Host "`n========================================" -ForegroundColor Red
    Write-Host "  COLLATERAL CHANGES DETECTED" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    if ($Phase) { Write-Host "Phase: $Phase" -ForegroundColor Red }
    Write-Host "$($items.Count) process(es) changed state without being targets of this run." -ForegroundColor Red
    Write-Host ""

    foreach ($item in $items) {
        $name = if ($item.Name) { $item.Name } else { $item.UniqueId }
        Write-Host "  $name  ($($item.UniqueId))" -ForegroundColor Red

        switch ($item.Change) {
            'Disappeared' {
                Write-Host "      DISAPPEARED from the tenant. It was $(if ($item.WasArchived) { 'archived' } else { 'active' }) in group $($item.OriginalGroupId)." -ForegroundColor Red
            }
            'Archived' {
                Write-Host "      was ACTIVE, is now ARCHIVED (group $($item.OriginalGroupId))" -ForegroundColor Red
            }
            'Unarchived' {
                Write-Host "      was ARCHIVED, is now ACTIVE (group $($item.OriginalGroupId))" -ForegroundColor Red
            }
            'Moved' {
                Write-Host "      moved from group $($item.OriginalGroupId) to group $($item.CurrentGroupId)" -ForegroundColor Red
            }
            'ArchivedAndMoved' {
                $state = if ($item.IsArchivedNow) { 'ARCHIVED' } else { 'ACTIVE' }
                Write-Host "      now $state in group $($item.CurrentGroupId); was $(if ($item.WasArchived) { 'archived' } else { 'active' }) in group $($item.OriginalGroupId)" -ForegroundColor Red
            }
            'NotInBaseline' {
                Write-Host "      NOT IN THE BEFORE-STATE. The run encountered it, but neither process" -ForegroundColor Red
                Write-Host "      list returned it beforehand, so what it looked like before is unknown." -ForegroundColor Red
                if ($null -ne $item.CurrentGroupId) {
                    Write-Host "      It is now in group $($item.CurrentGroupId)." -ForegroundColor Red
                }
            }
        }
    }

    Write-Host ""
    Write-Host "The usual cause is a process VARIATION. Nintex PM stores a variation as its" -ForegroundColor Yellow
    Write-Host "own record in its own group, and acting on one acts on its master too. The" -ForegroundColor Yellow
    Write-Host "coupling is not visible in the process model or the process lists, so it can" -ForegroundColor Yellow
    Write-Host "only be caught by comparing tenant state before and after, which is what this" -ForegroundColor Yellow
    Write-Host "check does." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Another user editing the tenant during the run produces the same signal." -ForegroundColor Yellow
}

function Resolve-CollateralOutcome {
    <#
    .SYNOPSIS
        Re-checks collateral after the unwind and clears anything already fine.

    .DESCRIPTION
        The manual-attention list is built from the checkpoint diff, which is
        taken BEFORE the targets are returned to their groups. Returning a target
        appears to bring its sibling variations with it, the same coupling
        running in reverse, so by the time the run ends some of what the diff
        recorded has undone itself.

        On the measured run that meant six entries telling an operator to go and
        move five processes that were already sitting in their original groups.
        The sixth was real.

        So the list is regenerated from a fresh read at the moment the run ends,
        rather than from a snapshot taken before the last thing the run did.

        Note this does NOT establish that returning a target always recovers its
        siblings. It was observed once. What it establishes is that the report
        must describe the tenant as it is, not as it was mid-run.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        $Collateral,
        $Results
    )

    $rows = @($Results)
    $items = @($Collateral)
    if ($items.Count -eq 0) { return $rows }

    $outstanding = @($rows | Where-Object {
        $_.Operation -eq 'ReverseCollateral' -and $_.Status -ne 'Success'
    })
    if ($outstanding.Count -eq 0) { return $rows }

    Write-Host "`n=== RE-CHECKING WHAT STILL NEEDS ATTENTION ===" -ForegroundColor Cyan
    $freshIndex = Get-NpmProcessIndex -SiteURL $SiteURL -Token $Token

    # Latest record per id, so a process reported at more than one checkpoint is
    # checked against one expectation rather than several.
    $expected = @{}
    foreach ($item in $items) {
        if (-not $item.UniqueId) { continue }
        $expected[$item.UniqueId.ToLowerInvariant()] = $item
    }

    $cleared = 0
    $updated = @()

    foreach ($row in $rows) {
        if ($row.Operation -ne 'ReverseCollateral' -or $row.Status -eq 'Success') {
            $updated += $row
            continue
        }

        $key = ([string]$row.ObjectID).ToLowerInvariant()
        if (-not $expected.ContainsKey($key)) { $updated += $row; continue }

        $want = $expected[$key]
        $now = $null
        if ($freshIndex.ContainsKey($key)) { $now = $freshIndex[$key] }

        # No before-state recorded means nothing to compare against.
        if ($null -eq $now -or $null -eq $want.OriginalGroupId -or $want.Change -eq 'NotInBaseline') {
            $updated += $row
            continue
        }

        $backInGroup = ("$($now.GroupId)" -eq "$($want.OriginalGroupId)")
        $backInState = ([bool]$now.IsArchived -eq [bool]$want.WasArchived)

        if ($backInGroup -and $backInState) {
            $cleared++
            Write-Host "  $($row.Name) is back in group $($want.OriginalGroupId); nothing to do." -ForegroundColor Green
            $updated += [PSCustomObject]@{
                ObjectType = $row.ObjectType; ObjectID = $row.ObjectID; Name = $row.Name
                Operation = 'ReverseCollateral'; Status = 'Success'
                Message = "Back in group $($want.OriginalGroupId) by the end of the run; no action needed"
            }
        } else {
            $updated += $row
        }
    }

    if ($cleared -gt 0) {
        Write-Host "  $cleared item(s) resolved themselves and have been dropped from the manual list." -ForegroundColor Green
    }
    $stillOpen = @($updated | Where-Object { $_.Operation -eq 'ReverseCollateral' -and $_.Status -ne 'Success' })
    Write-Host "  $($stillOpen.Count) item(s) genuinely outstanding." -ForegroundColor $(if ($stillOpen.Count -gt 0) { 'Yellow' } else { 'Green' })

    return $updated
}

function Restore-CollateralState {
    <#
    .SYNOPSIS
        Puts back what the run changed without being asked to.

    .DESCRIPTION
        Only reverses what it can prove and what the endpoints this codebase
        trusts can actually do:

          Archived    -> restore into the original group
          Unarchived  -> re-archive

        A pure group move on a still-active process is NOT reversed. The only
        move endpoint available here is the one Mode 3 uses, which is documented
        as broken (it sends the wrapper object rather than the ProcessJson string
        and never publishes). Guessing with a broken endpoint on a process the
        operator never meant to touch would turn one problem into two, so those
        are reported for manual correction instead.

        Disappeared is not reversible by anything. It is reported.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        $Collateral,
        [bool]$ApprovalsEnabled = $false
    )

    $results = @()
    $items = @($Collateral)
    if ($items.Count -eq 0) { return $results }

    Write-Host "`n=== REVERSING COLLATERAL CHANGES ===" -ForegroundColor Cyan

    foreach ($item in $items) {
        $name = if ($item.Name) { $item.Name } else { $item.UniqueId }

        if ($item.Change -eq 'NotInBaseline') {
            Write-Host "  $name has no recorded before-state; not guessing at one." -ForegroundColor Yellow
            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $item.UniqueId; Name = $name
                Operation = 'ReverseCollateral'; Status = 'Skipped'
                Message = 'No before-state was captured for this process; check it manually'
            }
            continue
        }

        if ($item.Change -eq 'Disappeared') {
            Write-Host "  $name is GONE. Nothing can restore it from here." -ForegroundColor Red
            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $item.UniqueId; Name = $name
                Operation = 'ReverseCollateral'; Status = 'Failed'
                Message = 'Process disappeared during the run and cannot be restored automatically'
            }
            continue
        }

        # Active before, archived now: un-archive it back into its own group.
        if (-not $item.WasArchived -and $item.IsArchivedNow) {
            Write-Host "  Restoring $name to group $($item.OriginalGroupId)..." -ForegroundColor Yellow
            $ok = Restore-NpmProcess -SiteURL $SiteURL -Token $Token `
                -ProcessUniqueId $item.UniqueId -ProcessGroupId $item.OriginalGroupId

            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $item.UniqueId; Name = $name
                Operation = 'ReverseCollateral'
                Status = $(if ($ok) { 'Success' } else { 'Failed' })
                Message = $(if ($ok) { "Restored to group $($item.OriginalGroupId)" }
                            else { "Restore FAILED; still archived. Restore it manually to group $($item.OriginalGroupId)" })
            }
            if (-not $ok) { Write-Host "    Failed. Restore $name manually to group $($item.OriginalGroupId)." -ForegroundColor Red }
            continue
        }

        # Archived before, active now: put it back in the archive.
        if ($item.WasArchived -and -not $item.IsArchivedNow) {
            Write-Host "  Re-archiving $name..." -ForegroundColor Yellow
            $ok = Set-NpmProcessArchived -SiteURL $SiteURL -Token $Token `
                -ProcessUniqueId $item.UniqueId -Comment 'Reversing collateral change from bulk operation' `
                -ApprovalsEnabled $ApprovalsEnabled

            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $item.UniqueId; Name = $name
                Operation = 'ReverseCollateral'
                Status = $(if ($ok) { 'Success' } else { 'Failed' })
                Message = $(if ($ok) { 'Re-archived' } else { 'Re-archive FAILED; this process is still ACTIVE' })
            }
            if (-not $ok) { Write-Host "    Failed. $name is still active and must be archived manually." -ForegroundColor Red }
            continue
        }

        # Same archive state, different group.
        Write-Host "  $name moved from group $($item.OriginalGroupId) to $($item.CurrentGroupId); NOT moving it back automatically." -ForegroundColor Yellow
        $results += [PSCustomObject]@{
            ObjectType = 'Process'; ObjectID = $item.UniqueId; Name = $name
            Operation = 'ReverseCollateral'; Status = 'Skipped'
            Message = "Moved from group $($item.OriginalGroupId) to $($item.CurrentGroupId). Move it back manually; no trustworthy move endpoint is available here."
        }
    }

    return $results
}

function Set-ProcessSnapshotRestored {
    # Records that the Hold phase pulled this process out of the archive. The
    # flag is what Restore-ProcessPlanState keys off to put it back.
    param($Snapshot, [string]$UniqueId, $HoldingGroupId = $null)

    if ($null -eq $Snapshot -or -not $UniqueId) { return }
    $key = $UniqueId.ToLowerInvariant()
    if (-not $Snapshot.ContainsKey($key)) { return }

    $Snapshot[$key].RestoredByThisRun = $true
    $Snapshot[$key].IsArchivedNow = $false
}

function ConvertTo-PlanLedgerEntry {
    # Snapshot rows in the shape the plan ledger uses, so a plan can be written
    # to disk before the first mutation and still be readable by the resume path.
    param($Snapshot)

    if ($null -eq $Snapshot) { return @() }

    return @($Snapshot.Values | ForEach-Object {
        [PSCustomObject]@{
            UniqueId              = $_.UniqueId
            Name                  = $_.Name
            NumericId             = $_.NumericId
            WasArchived           = $_.WasArchived
            OriginalGroupUniqueId = $_.OriginalGroupUniqueId
            OriginalGroupId       = $_.OriginalGroupId
            RestoredByThisRun     = $_.RestoredByThisRun
            Denormalized          = $false
            Deleted               = $false
        }
    })
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
        FailedTargets  = @()
        Unresolved     = @()
        Collateral     = @()
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

# ----------------------------------------------------------------------------
# Progress reporting
# ----------------------------------------------------------------------------
# Long phases used to emit one line and then nothing for eleven minutes, which
# is indistinguishable from a hang. Write-Progress gives a live bar; the callers
# also print a periodic counter so a redirected transcript still shows movement.

function Write-NpmProgress {
    param(
        [string]$Activity,
        [string]$Status,
        [int]$Done,
        [int]$Total,
        [int]$Id = 1,
        [int]$Every = 10
    )

    if ($Total -le 0) { return }

    $percent = [Math]::Min(100, [int](($Done / $Total) * 100))
    Write-Progress -Id $Id -Activity $Activity -Status "$Status - $Done of $Total" -PercentComplete $percent

    # A console counter as well: Write-Progress renders nothing in a transcript
    # or a redirected host, which is exactly where a long run is watched from.
    if ($Every -gt 0 -and ($Done % $Every) -eq 0) {
        Write-Host "`r    $Status`: $Done of $Total..." -NoNewline -ForegroundColor Gray
    }
}

function Complete-NpmProgress {
    param([string]$Activity, [int]$Id = 1)
    Write-Progress -Id $Id -Activity $Activity -Completed
}

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

    $cached = Get-NpmCachedModel -UniqueId $UniqueId
    if ($null -ne $cached) { return $cached }

    if ($IsArchived) {
        $models = @(Get-NpmArchivedProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueIds @($UniqueId))
        if ($models.Count -gt 0) {
            Set-NpmCachedModel -UniqueId $UniqueId -Model $models[0]
            return $models[0]
        }
        return $null
    }

    $model = Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $UniqueId
    Set-NpmCachedModel -UniqueId $UniqueId -Model $model
    return $model
}

function Restore-NpmProcess {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        $ProcessGroupId,
        [int]$MaxRetries = $script:NpmMaxRetries
    )

    Clear-NpmCachedModel -UniqueId $ProcessUniqueId
    Start-NpmThrottle
    $result = Invoke-NpmApi -Url "$SiteURL/Process/Edit/RestoreProcess" -Token $Token -Method Post -MaxRetries $MaxRetries -Body @{
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

    Clear-NpmCachedModel -UniqueId $ProcessUniqueId
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

    Clear-NpmCachedModel -UniqueId $ProcessUniqueId
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

    # The targets are excluded outright. A reference a target holds to another
    # target dies with both of them, and a target is never edited anyway, so
    # fetching one here buys nothing.
    $targetLookup = @{}
    foreach ($t in @($TargetUniqueIds)) { if ($t) { $targetLookup[$t.ToLowerInvariant()] = $true } }

    foreach ($entry in $Index.Values) {
        if ($targetLookup.ContainsKey($entry.UniqueId.ToLowerInvariant())) { continue }
        if ($entry.IsArchived) { $archivedIds += $entry.UniqueId }
        elseif ($IncludeActive) { $activeIds += $entry.UniqueId }
    }

    # Say the size up front. This is the phase that makes a ten-item job take
    # three minutes, and an operator should know that before it starts.
    $totalToScan = $activeIds.Count + $archivedIds.Count
    if ($totalToScan -eq 0) { return $sites }

    $excludedCount = @($Index.Values).Count - $totalToScan
    Write-Host "  Input/Output blind-spot scan: $totalToScan process(es) to read" -ForegroundColor Gray
    Write-Host "    ($($archivedIds.Count) archived, $($activeIds.Count) active, $excludedCount excluded as targets or not in scope)" -ForegroundColor Gray

    if ($activeIds.Count -gt 0) {
        Write-Host "  Scanning $($activeIds.Count) ACTIVE process(es) for Input/Output references (slow)..." -ForegroundColor Gray
        $done = 0
        foreach ($id in $activeIds) {
            $done++
            Write-NpmProgress -Activity 'Input/Output blind-spot scan' -Status 'Active processes' `
                -Done $done -Total $activeIds.Count -Id 2 -Every 25

            # Served from the planning cache when an earlier phase already read
            # this process; otherwise fetched and cached for the phases after.
            # Active processes must use the individual endpoint; the mobile API
            # is for archived processes and returns nothing useful here.
            $model = Get-NpmCachedModel -UniqueId $id
            if ($null -eq $model) {
                $model = Get-NpmProcessModel -SiteURL $SiteURL -Token $Token -ProcessUniqueId $id
            }
            if ($null -eq $model) { continue }

            $found = @(Find-InputOutputReferenceSite -ProcessObject $model -TargetUniqueIds $TargetUniqueIds)
            $sites += $found

            # Cached only on a hit. A holder found here is added to the ledger
            # next, which re-reads it; everything else is read once and never
            # again, and keeping the whole sweep in memory would mean holding
            # hundreds of full process models to serve no reads at all.
            if ($found.Count -gt 0) { Set-NpmCachedModel -UniqueId $id -Model $model }
        }
        Complete-NpmProgress -Activity 'Input/Output blind-spot scan' -Id 2
        Write-Host ""
    }

    if ($archivedIds.Count -eq 0) {
        if ($sites.Count -gt 0) {
            Write-Host "  Found $($sites.Count) Input/Output reference(s) invisible to the dependency API" -ForegroundColor Yellow
        }
        return $sites
    }

    # Anything already in the cache is walked without a fetch; only the rest
    # goes to the batch endpoint.
    $toFetch = @()
    foreach ($id in $archivedIds) {
        $cached = Get-NpmCachedModel -UniqueId $id
        if ($null -ne $cached) {
            $sites += @(Find-InputOutputReferenceSite -ProcessObject $cached -TargetUniqueIds $TargetUniqueIds)
        } else {
            $toFetch += $id
        }
    }

    $cachedCount = $archivedIds.Count - $toFetch.Count
    if ($cachedCount -gt 0) {
        Write-Host "  $cachedCount archived model(s) served from cache; fetching $($toFetch.Count)..." -ForegroundColor Gray
    } else {
        Write-Host "  Scanning $($toFetch.Count) archived process(es) for Input/Output references..." -ForegroundColor Gray
    }

    for ($i = 0; $i -lt $toFetch.Count; $i += $BatchSize) {
        $end = [Math]::Min($i + $BatchSize - 1, $toFetch.Count - 1)
        $models = @(Get-NpmArchivedProcessModel -SiteURL $SiteURL -Token $Token `
            -ProcessUniqueIds $toFetch[$i..$end] -BatchSize $BatchSize)

        foreach ($model in $models) {
            $found = @(Find-InputOutputReferenceSite -ProcessObject $model -TargetUniqueIds $TargetUniqueIds)
            $sites += $found

            # See above: cache the hits, drop the rest on the floor.
            if ($found.Count -gt 0) {
                Set-NpmCachedModel -UniqueId ([string](Get-NodeValue -Node $model -Name 'UniqueId')) -Model $model
            }
        }

        Write-NpmProgress -Activity 'Input/Output blind-spot scan' -Status 'Archived processes' `
            -Done ([Math]::Min($end + 1, $toFetch.Count)) -Total $toFetch.Count -Id 2 -Every 1
    }
    Complete-NpmProgress -Activity 'Input/Output blind-spot scan' -Id 2
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
        [int]$MaxPasses = 3,
        [scriptblock]$OnFailedTargets = $null,
        $PreHoldSnapshot = $null
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

        if ($null -eq $entry) {
            # Neither list sweep returned this process, yet the dependency API
            # named it. Both can be true at once: processes have been observed
            # that are absent from ListType=7 and ListType=0 but still fetchable
            # through the mobile batch endpoint.
            #
            # Returning $null here dropped it silently, and a holder that is
            # never fetched is a holder whose reference is never removed. So try
            # both endpoints before giving up, and if it is genuinely
            # unreachable, say so loudly rather than continuing as though the
            # participant did not exist.
            $recovered = Get-NpmProcessModelAnyState -SiteURL $SiteURL -Token $Token `
                -UniqueId $UniqueId -IsArchived $true
            $recoveredArchived = $true

            if ($null -eq $recovered) {
                $recovered = Get-NpmProcessModelAnyState -SiteURL $SiteURL -Token $Token `
                    -UniqueId $UniqueId -IsArchived $false
                $recoveredArchived = $false
            }

            if ($null -eq $recovered) {
                $label = Resolve-ClaimName -Claims $allClaims -UniqueId $UniqueId
                $plan.Unresolved += [PSCustomObject]@{
                    UniqueId = $UniqueId
                    Name     = $label
                    Reason   = 'Absent from both process lists and not fetchable by either endpoint'
                }
                $plan.Log += "UNRESOLVED participant $UniqueId ($label): not in the index and not fetchable; any reference it holds will NOT be removed"
                Write-Host "    Could not resolve participant $label ($UniqueId). Its references cannot be examined." -ForegroundColor Red
                return $null
            }

            $stateId = Get-NodeValue -Node $recovered -Name 'StateId'
            if ($null -ne $stateId) { $recoveredArchived = ([int]$stateId -ne 1) }

            $entry = [PSCustomObject]@{
                UniqueId   = $UniqueId
                NumericId  = Get-NodeValue -Node $recovered -Name 'Id'
                Name       = [string](Get-NodeValue -Node $recovered -Name 'Name')
                IsArchived = $recoveredArchived
                GroupId    = Get-NodeValue -Node $recovered -Name 'GroupId'
            }

            $plan.Log += "Recovered participant $UniqueId ($($entry.Name)) by direct fetch; it is missing from both process list sweeps"
            Write-Host "    Recovered $($entry.Name) by direct fetch (missing from the process lists)" -ForegroundColor Yellow
        }

        # The index passed in here was refreshed AFTER the Hold phase moved the
        # archived targets into the temp group, so for those targets it reports
        # post-mutation state: not archived, living in a group that cleanup is
        # about to delete. A ledger built from that cannot unwind anything.
        #
        # PreHoldSnapshot is the state captured before the first mutation and
        # wins wherever it has an entry. Without it this falls back to the index,
        # which is correct for every process the run has not touched.
        $snap = $null
        if ($null -ne $PreHoldSnapshot -and $PreHoldSnapshot.ContainsKey($key)) {
            $snap = $PreHoldSnapshot[$key]
        }

        $isArchivedNow = $entry.IsArchived
        if ($null -ne $snap) { $isArchivedNow = [bool]$snap.IsArchivedNow }

        $model = Get-NpmProcessModelAnyState -SiteURL $SiteURL -Token $Token `
            -UniqueId $UniqueId -IsArchived $isArchivedNow

        $groupUniqueId = [string](Get-NodeValue -Node $model -Name 'GroupUniqueId')
        $groupId = Get-NodeValue -Node $model -Name 'GroupId'
        if ($null -eq $groupId) { $groupId = $entry.GroupId }

        $wasArchived = $entry.IsArchived
        $restoredByThisRun = $false

        if ($null -ne $snap) {
            $wasArchived = [bool]$snap.WasArchived
            $restoredByThisRun = [bool]$snap.RestoredByThisRun
            if ($null -ne $snap.OriginalGroupId) { $groupId = $snap.OriginalGroupId }
            if ($snap.OriginalGroupUniqueId) { $groupUniqueId = [string]$snap.OriginalGroupUniqueId }
        }

        $record = [PSCustomObject]@{
            UniqueId              = $entry.UniqueId
            Name                  = $entry.Name
            NumericId             = $entry.NumericId
            WasArchived           = $wasArchived
            OriginalGroupUniqueId = $groupUniqueId
            OriginalGroupId       = $groupId
            RestoredByThisRun     = $restoredByThisRun
            Denormalized          = $false
            Deleted               = $false
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
        $done = 0
        $total = @($TargetUniqueIds).Count

        foreach ($target in $TargetUniqueIds) {
            $done++
            Write-NpmProgress -Activity "Discovery pass $pass" -Status 'Checking dependencies' `
                -Done $done -Total $total -Id 1

            $check = Get-ProcessDependencyClaim -SiteURL $SiteURL -Token $Token -ProcessUniqueId $target

            # Success is read off the field. An empty Claims array means the
            # process genuinely has no dependencies, which is not a failure.
            if (-not $check.Success) {
                $failedTargets += $target
                continue
            }
            $allClaims += @($check.Claims)
        }
        Complete-NpmProgress -Activity "Discovery pass $pass" -Id 1
        Write-Host "`r    Checked $total of $total.                    " -ForegroundColor Gray

        # One retry for the failures before giving up on the batch. A single
        # transient 5xx should not discard the twenty minutes of discovery that
        # a large run has already paid for.
        if ($failedTargets.Count -gt 0) {
            Write-Host "  $($failedTargets.Count) dependency check(s) failed. Retrying them once..." -ForegroundColor Yellow
            $stillFailed = @()
            $done = 0

            foreach ($target in $failedTargets) {
                $done++
                Write-NpmProgress -Activity "Discovery pass $pass" -Status 'Retrying failed checks' `
                    -Done $done -Total $failedTargets.Count -Id 1

                $check = Get-ProcessDependencyClaim -SiteURL $SiteURL -Token $Token -ProcessUniqueId $target
                if (-not $check.Success) {
                    $stillFailed += [PSCustomObject]@{
                        UniqueId = $target
                        Status   = $check.Status
                        Error    = $check.Error
                    }
                    continue
                }
                $allClaims += @($check.Claims)
            }
            Complete-NpmProgress -Activity "Discovery pass $pass" -Id 1
            $failedTargets = $stillFailed
        }

        if ($failedTargets.Count -gt 0) {
            $names = @($failedTargets | ForEach-Object {
                $e = Get-NpmIndexEntry -Index $Index -UniqueId $_.UniqueId
                $label = if ($e) { $e.Name } else { $_.UniqueId }
                "$label ($($_.UniqueId)): HTTP $($_.Status) $($_.Error)"
            })

            Write-Host "  Dependency check still failing for $($failedTargets.Count) target(s) after retry:" -ForegroundColor Red
            foreach ($n in $names) { Write-Host "    $n" -ForegroundColor Red }

            $proceed = $false
            if ($null -ne $OnFailedTargets) {
                $proceed = [bool](& $OnFailedTargets $failedTargets)
            }

            if (-not $proceed) {
                # A failed check is NOT an empty dependency list. Proceeding would
                # delete a process whose references were never examined.
                $plan.Status = 'Blocked'
                $plan.FailedTargets = @($failedTargets)
                $plan.Log += "Dependency check failed for $($failedTargets.Count) target(s) after retry: $($names -join '; ')"
                Write-Host "  Cannot plan safely." -ForegroundColor Red
                return $plan
            }

            # Proceeding with the subset that checked cleanly. The failures are
            # dropped from the target set entirely, not merely skipped later, so
            # nothing downstream can delete one of them by accident.
            $excluded = @{}
            foreach ($f in $failedTargets) { $excluded[$f.UniqueId.ToLowerInvariant()] = $true }

            $TargetUniqueIds = @($TargetUniqueIds | Where-Object { -not $excluded.ContainsKey($_.ToLowerInvariant()) })
            $plan.TargetUniqueIds = @($TargetUniqueIds)
            $plan.FailedTargets = @($failedTargets)
            $plan.Log += "Excluded $($failedTargets.Count) target(s) whose dependency check failed: $($names -join '; ')"
            Write-Host "  Continuing with $($TargetUniqueIds.Count) target(s); the failures are excluded." -ForegroundColor Yellow

            if ($TargetUniqueIds.Count -eq 0) {
                $plan.Status = 'Blocked'
                $plan.Log += 'Every target failed its dependency check; nothing is left to plan'
                return $plan
            }
        }

        $candidates = @(Get-DependencyCandidate -Claims $allClaims -TargetUniqueIds $TargetUniqueIds)
        Write-Host "  $($allClaims.Count) claim(s) across $($candidates.Count) process(es)" -ForegroundColor Gray

        Write-Host "  Building ledger for $($candidates.Count) process(es)..." -ForegroundColor Gray
        $done = 0
        foreach ($candidate in $candidates) {
            $done++
            Write-NpmProgress -Activity "Discovery pass $pass" -Status 'Fetching process models' `
                -Done $done -Total $candidates.Count -Id 1
            [void](Add-LedgerEntry -UniqueId $candidate)
        }
        Complete-NpmProgress -Activity "Discovery pass $pass" -Id 1
        Write-Host "`r    Fetched $($candidates.Count) of $($candidates.Count).                    " -ForegroundColor Gray

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

            # Both ends in the delete set means the pair is not work and not a
            # decision; reconciling it only produces lines to wave through.
            $bothDeleted = $targetLookup.ContainsKey($relatedId.ToLowerInvariant())

            $reconciliation += @(Test-DependencyReconciliation -QueriedUniqueId $target -RelatedUniqueId $relatedId `
                -Claims $allClaims -Sites $allSites -RelatedIsArchived $isArchived `
                -BothSidesDeleted $bothDeleted)
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
            Deleted               = $_.Deleted
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

function Resolve-ClaimName {
    # The dependency payload carries a name alongside every id it reports, which
    # is the only name available for a process that no list sweep returned.
    param($Claims, [string]$UniqueId)

    $named = @($Claims | Where-Object { $_.RelatedUniqueId -eq $UniqueId -and $_.RelatedName })
    if ($named.Count -gt 0) { return ([string]$named[0].RelatedName).Trim() }
    return $UniqueId
}

function Resolve-PlanProcessName {
    <#
    .SYNOPSIS
        Best available human-readable name for a process id.

    .DESCRIPTION
        Three sources, in descending order of trust:

          1. the plan ledger, captured at plan time from the index
          2. the live index
          3. RelatedName on the dependency claims

        The third matters more than it looks. A process the dependency API
        reports but which is missing from both list sweeps has no ledger entry
        and no index entry, so it used to print as a bare GUID; that is exactly
        the process an operator most needs to identify, because it is the one
        the run could not classify. The API already sent its name in the same
        payload that raised it.
    #>
    param($Plan, $Index, [string]$UniqueId)

    if (-not $UniqueId) { return '(unknown)' }

    $record = @($Plan.Ledger | Where-Object { $_.UniqueId -eq $UniqueId })
    if ($record.Count -gt 0 -and $record[0].Name) { return $record[0].Name }

    if ($null -ne $Index) {
        $entry = Get-NpmIndexEntry -Index $Index -UniqueId $UniqueId
        if ($null -ne $entry -and $entry.Name) { return $entry.Name }
    }

    $named = @($Plan.Claims | Where-Object { $_.RelatedUniqueId -eq $UniqueId -and $_.RelatedName })
    if ($named.Count -gt 0) { return ([string]$named[0].RelatedName).Trim() }

    return $UniqueId
}

function Show-ProcessDeletePlan {
    param($Plan, $Index)

    Write-Host "`n=== PLAN SUMMARY ===" -ForegroundColor Cyan
    Write-Host "Targets to delete : $(@($Plan.TargetUniqueIds).Count)" -ForegroundColor White
    Write-Host "Processes to edit : $(@($Plan.WorkItems).Count)" -ForegroundColor White
    Write-Host "Reference sites   : $(@($Plan.Sites).Count)" -ForegroundColor White

    $archived = @($Plan.Ledger | Where-Object { $_.WasArchived })
    if ($archived.Count -gt 0) {
        # A preview mutates nothing, so it must not describe restores it did not
        # perform. The count is reported either way; only the claim changes.
        $restored = @($Plan.Ledger | Where-Object { $_.RestoredByThisRun })
        if ($restored.Count -gt 0) {
            Write-Host "Archived involved : $($archived.Count) ($($restored.Count) restored for the run, re-archived afterwards)" -ForegroundColor Yellow
        } else {
            Write-Host "Archived involved : $($archived.Count) (none restored; a real run would restore them)" -ForegroundColor Yellow
        }
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

    $unresolved = @($Plan.Unresolved)
    if ($unresolved.Count -gt 0) {
        Write-Host "`nUNRESOLVED PARTICIPANTS ($($unresolved.Count)):" -ForegroundColor Red
        Write-Host "The dependency API named these processes but neither process list nor either" -ForegroundColor Red
        Write-Host "fetch endpoint returned them. Any reference they hold will NOT be removed." -ForegroundColor Red
        foreach ($u in $unresolved) {
            Write-Host "  $($u.Name)  ($($u.UniqueId))" -ForegroundColor Red
            Write-Host "      $($u.Reason)" -ForegroundColor DarkGray
        }
    }

    $notApplicable = @($Plan.Reconciliation | Where-Object { $_.Status -eq 'NotApplicable' })
    if ($notApplicable.Count -gt 0) {
        Write-Host "`n$($notApplicable.Count) reconciliation entr(ies) skipped: both sides of the pair are being deleted." -ForegroundColor Gray
        Write-Host "They are recorded in the plan file for audit but need no decision." -ForegroundColor Gray
    }

    $known = @($Plan.Reconciliation | Where-Object { $_.Status -eq 'MatchWithKnownAsymmetry' })
    if ($known.Count -gt 0) {
        Write-Host "`n$($known.Count) entr(ies) differ by the known child-reference asymmetry (warning, not a gate)." -ForegroundColor Yellow
        Write-Host "See the open question in API_ARCHITECTURE.md." -ForegroundColor Yellow
    }

    $problems = @($Plan.Reconciliation | Where-Object { $_.Status -eq 'Mismatch' })
    if ($problems.Count -gt 0) {
        Write-Host "`nRECONCILIATION MISMATCHES ($($problems.Count)):" -ForegroundColor Red
        Write-Host "The dependency API and the process JSON disagree. Investigate before deleting." -ForegroundColor Red

        $targetLookup = @{}
        foreach ($t in @($Plan.TargetUniqueIds)) { $targetLookup[$t.ToLowerInvariant()] = $true }

        # Grouped by the queried process so an operator scans by process rather
        # than down 120 undifferentiated rows.
        foreach ($group in ($problems | Group-Object QueriedUniqueId)) {
            $queriedName = Resolve-PlanProcessName -Plan $Plan -Index $Index -UniqueId $group.Name
            Write-Host "`n  $queriedName" -ForegroundColor Red

            foreach ($p in $group.Group) {
                $relatedName = Resolve-PlanProcessName -Plan $Plan -Index $Index -UniqueId $p.RelatedUniqueId
                $survives = if ($targetLookup.ContainsKey($p.RelatedUniqueId.ToLowerInvariant())) { 'also a target' } else { 'survives' }

                Write-Host ("    {0,-6} -> {1}   claimed {2}, located {3}   [{4}]" -f `
                    $p.Category, $relatedName, $p.Claimed, $p.Located, $survives) -ForegroundColor Red

                # Name the sites the run would actually edit for this pair, so
                # the operator can go and look at them.
                $pairSites = @($Plan.Sites | Where-Object {
                    $_.Category -eq $p.Category -and (
                        ($_.HolderUniqueId -eq $p.QueriedUniqueId -and $_.TargetUniqueId -eq $p.RelatedUniqueId) -or
                        ($_.HolderUniqueId -eq $p.RelatedUniqueId -and $_.TargetUniqueId -eq $p.QueriedUniqueId)
                    )
                })
                foreach ($site in $pairSites) {
                    Write-Host "           $($site.Path)" -ForegroundColor DarkGray
                }
            }
        }
        Write-Host ""
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
    <#
    .SYNOPSIS
        Archives then deletes the targets, with a collateral check in between.

    .DESCRIPTION
        Split from reference removal so a caller can stop between verification
        and the irreversible step.

        The archive pass is itself a mutation, and archiving a process variation
        archives its master too. So the tenant is re-read between archiving and
        deleting, and anything that moved which was not a target stops the run
        right there. That gap is the last point where stopping still costs
        nothing: an unwanted archive can be undone, an unwanted delete cannot.

        A third check runs AFTER the deletes, because measurement showed the
        variation coupling actually fires on delete rather than on restore or
        archive. It cannot stop anything. It exists so that the run reports what
        it did instead of finishing with "0 failed" over five processes it never
        named, and so that the reversible part is reversed.

    .PARAMETER TenantBaseline
        Full tenant state from before the run. Omit it and the check is skipped,
        which is the old behaviour.

    .PARAMETER OnCollateral
        Called with the collateral records when the check finds something.
        Returns $true to continue to deletion, $false to stop. Omitted means
        stop, because deleting after unexplained changes is the one outcome
        nobody can undo.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        $Plan,
        [bool]$ApprovalsEnabled = $false,
        $TenantBaseline = $null,
        [scriptblock]$OnCollateral = $null,
        [string[]]$ObservedUniqueIds = @(),
        [scriptblock]$GetObservedUniqueIds = $null
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

    # ---- Collateral check, between archive and delete ---------------------
    if ($null -ne $TenantBaseline) {
        Write-Host "`n=== CHECKING FOR COLLATERAL CHANGES ===" -ForegroundColor Cyan
        Write-Host "  Re-reading the tenant to see what the archive pass actually changed..." -ForegroundColor Gray

        $freshIndex = Get-NpmProcessIndex -SiteURL $SiteURL -Token $Token

        # Everything this run legitimately changed: the targets, plus any holder
        # it restored on purpose during planning.
        $expected = @($targets)
        $expected += @($Plan.Ledger | Where-Object { $_.RestoredByThisRun } | ForEach-Object { $_.UniqueId })

        $observedNow = @($ObservedUniqueIds)
        if ($null -ne $GetObservedUniqueIds) {
            try { $observedNow += @(& $GetObservedUniqueIds) } catch { }
        }

        $collateral = @(Compare-TenantState -Baseline $TenantBaseline -Index $freshIndex `
            -ExpectedUniqueIds $expected -ObservedUniqueIds $observedNow)

        if ($collateral.Count -gt 0) {
            $Plan.Collateral = @($Plan.Collateral) + $collateral
            foreach ($c in $collateral) {
                $Plan.Log += "COLLATERAL after archive phase: $($c.UniqueId) ($($c.Name)) - $($c.Change)"
            }

            Show-CollateralDamage -Collateral $collateral -Phase 'after archiving targets, before deleting'

            $proceed = $false
            if ($null -ne $OnCollateral) { $proceed = [bool](& $OnCollateral $collateral) }

            if (-not $proceed) {
                Write-Host "`nStopping before deletion. Nothing has been deleted." -ForegroundColor Red
                foreach ($c in $collateral) {
                    $name = if ($c.Name) { $c.Name } else { $c.UniqueId }
                    $results += [PSCustomObject]@{
                        ObjectType = 'Process'; ObjectID = $c.UniqueId; Name = $name
                        Operation = 'Collateral'; Status = 'Failed'
                        Message = "Changed without being a target ($($c.Change)); run stopped before deletion"
                    }
                }
                return $results
            }
        } else {
            Write-Host "  No collateral changes. Only the targets moved." -ForegroundColor Green
        }
    }

    Write-Host "`n=== DELETING TARGETS ===" -ForegroundColor Red
    $i = 0
    foreach ($target in $targets) {
        $i++
        $record = @($Plan.Ledger | Where-Object { $_.UniqueId -eq $target })
        $name = if ($record.Count -gt 0) { $record[0].Name } else { $target }
        $groupUniqueId = if ($record.Count -gt 0) { [string]$record[0].OriginalGroupUniqueId } else { '' }

        Write-Host "`r  Deleting $i of $($targets.Count)..." -NoNewline -ForegroundColor Red

        $ok = Remove-NpmProcess -SiteURL $SiteURL -Token $Token -ProcessUniqueId $target -ProcessGroupUniqueId $groupUniqueId

        # Marked on the ledger so the unwind pass below does not try to
        # re-archive something that no longer exists. Before the Hold phase runs
        # a target IS an archived process this run restored, so it matches the
        # re-archive filter on every count except that it is gone.
        if ($ok -and $record.Count -gt 0) {
            if ($record[0].PSObject.Properties['Deleted']) { $record[0].Deleted = $true }
            else { $record[0] | Add-Member -NotePropertyName Deleted -NotePropertyValue $true -Force }
        }

        $results += [PSCustomObject]@{
            ObjectType = 'Process'; ObjectID = $target; Name = $name
            Operation = 'Delete'
            Status = $(if ($ok) { 'Success' } else { 'Failed' })
            Message = $(if ($ok) { 'Deleted' } else { 'Delete failed' })
        }
    }
    Write-Host ""

    # ---- Third checkpoint, after the deletes ------------------------------
    # The variation coupling fires on DELETE, not on restore or archive. That
    # was established by measurement: a lone archived process with no variation
    # relatives was restored, polled, re-archived and polled again, and each
    # poll showed the new state immediately. The index does not lag, so the two
    # earlier checkpoints report clean because at that point nothing has
    # happened yet.
    #
    # This one cannot prevent anything, which is exactly why the earlier two
    # exist. What it can do is turn a silent failure into a reported one and
    # recover the part that is still recoverable: an unwanted archive can be
    # undone even after the delete that caused it.
    if ($null -ne $TenantBaseline) {
        Write-Host "`n=== CHECKING FOR COLLATERAL CHANGES (POST-DELETE) ===" -ForegroundColor Cyan
        Write-Host "  Re-reading the tenant to see what the delete pass actually changed..." -ForegroundColor Gray

        $postIndex = Get-NpmProcessIndex -SiteURL $SiteURL -Token $Token

        $expectedAfter = @($targets)
        $expectedAfter += @($Plan.Ledger | Where-Object { $_.RestoredByThisRun } | ForEach-Object { $_.UniqueId })

        # Collected HERE, not handed in from before the deletes. A process the
        # delete strands in the holding group is not there yet when the caller
        # is assembling arguments, so a list gathered earlier contains only the
        # targets, every one of which is expected and therefore skipped. That is
        # why NotInBaseline never fired on a real run despite being wired up.
        $observed = @($ObservedUniqueIds)
        if ($null -ne $GetObservedUniqueIds) {
            try { $observed += @(& $GetObservedUniqueIds) }
            catch { Write-Host "  Could not list what the run left behind: $($_.Exception.Message)" -ForegroundColor Yellow }
        }

        $postCollateral = @(Compare-TenantState -Baseline $TenantBaseline -Index $postIndex `
            -ExpectedUniqueIds $expectedAfter -ObservedUniqueIds $observed)

        # Anything already reported at an earlier checkpoint is not news.
        $seen = @{}
        foreach ($c in @($Plan.Collateral)) { $seen[$c.UniqueId.ToLowerInvariant()] = $true }
        $newCollateral = @($postCollateral | Where-Object { -not $seen.ContainsKey($_.UniqueId.ToLowerInvariant()) })

        if ($newCollateral.Count -gt 0) {
            $Plan.Collateral = @($Plan.Collateral) + $newCollateral
            foreach ($c in $newCollateral) {
                $Plan.Log += "COLLATERAL after delete phase: $($c.UniqueId) ($($c.Name)) - $($c.Change)"
            }

            Show-CollateralDamage -Collateral $newCollateral -Phase 'after deleting targets'

            Write-Host "The deletes have already happened and cannot be undone. What follows puts" -ForegroundColor Yellow
            Write-Host "back the changes that are still reversible." -ForegroundColor Yellow

            foreach ($c in $newCollateral) {
                $cname = if ($c.Name) { $c.Name } else { $c.UniqueId }
                $results += [PSCustomObject]@{
                    ObjectType = 'Process'; ObjectID = $c.UniqueId; Name = $cname
                    Operation = 'Collateral'; Status = 'Failed'
                    Message = "Changed without being a target ($($c.Change)); detected after deletion"
                }
            }

            $results += @(Restore-CollateralState -SiteURL $SiteURL -Token $Token `
                -Collateral $newCollateral -ApprovalsEnabled $ApprovalsEnabled)
        } else {
            Write-Host "  No collateral changes from the delete pass." -ForegroundColor Green
        }
    }

    return $results
}

function Get-NpmProcessGroupId {
    # Current numeric group of a process, or $null if it cannot be read.
    param([string]$SiteURL, [string]$Token, [string]$ProcessUniqueId, [bool]$IsArchived = $false)

    $model = Get-NpmProcessModelAnyState -SiteURL $SiteURL -Token $Token `
        -UniqueId $ProcessUniqueId -IsArchived $IsArchived
    if ($null -eq $model) { return $null }
    return (Get-NodeValue -Node $model -Name 'GroupId')
}

# Whether RestoreProcess also relocates a process that is already ACTIVE.
# 'Unknown' until tried, then 'Yes' or 'No' for the rest of the run.
$script:NpmRestoreRelocatesActive = 'Unknown'

function Reset-NpmRelocationProbe { $script:NpmRestoreRelocatesActive = 'Unknown' }
function Get-NpmRelocationProbeState { return $script:NpmRestoreRelocatesActive }

function Move-NpmProcessToGroup {
    <#
    .SYNOPSIS
        Puts an ACTIVE process back into a named group, and verifies it landed.

    .DESCRIPTION
        RestoreProcess takes a group id and is the only endpoint here that does.
        Its documented job is un-archiving, and whether it also relocates a
        process that is already active is not documented, so this tries it and
        then checks, rather than assuming either way.

        If the optimistic call does not move it, the fallback uses only
        documented behaviour: archive it, restore it into the target group, and
        leave it active there. That costs an extra archive event in the
        process's history, which is worth it to land in the right place.

        Returns the group the process is actually in afterwards, which the
        caller reports rather than reporting the group it hoped for.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        $TargetGroupId,
        [bool]$ApprovalsEnabled = $false
    )

    if ($null -eq $TargetGroupId) {
        return [PSCustomObject]@{ Moved = $false; ActualGroupId = $null; Verified = $false }
    }

    # The probe runs with NO retries. On the measured tenant RestoreProcess
    # answers HTTP 500 for an already-active process every single time, and the
    # standard ladder spent 2 + 4 + 8 seconds establishing that before falling
    # back: 14 seconds per process, which on a 479-target run is close to two
    # hours of pure backoff. A 500 here is not a transient fault, it is the
    # endpoint declining to do something it never claimed to do.
    #
    # And the answer is the same for every process, so it is asked once per run.
    if ($script:NpmRestoreRelocatesActive -ne 'No') {
        [void](Restore-NpmProcess -SiteURL $SiteURL -Token $Token `
            -ProcessUniqueId $ProcessUniqueId -ProcessGroupId $TargetGroupId -MaxRetries 0)

        $actual = Get-NpmProcessGroupId -SiteURL $SiteURL -Token $Token -ProcessUniqueId $ProcessUniqueId -IsArchived $false
        if ($null -ne $actual -and "$actual" -eq "$TargetGroupId") {
            $script:NpmRestoreRelocatesActive = 'Yes'
            return [PSCustomObject]@{ Moved = $true; ActualGroupId = $actual; Verified = $true }
        }

        if ($script:NpmRestoreRelocatesActive -eq 'Unknown') {
            $script:NpmRestoreRelocatesActive = 'No'
            Write-Host "    RestoreProcess does not relocate an active process on this tenant;" -ForegroundColor Gray
            Write-Host "    using archive-then-restore for the rest of this run." -ForegroundColor Gray
        }
    }

    # Fallback: archive, then restore into the group we want.
    [void](Set-NpmProcessArchived -SiteURL $SiteURL -Token $Token -ProcessUniqueId $ProcessUniqueId `
        -Comment 'Relocating to original group' -ApprovalsEnabled $ApprovalsEnabled)
    [void](Restore-NpmProcess -SiteURL $SiteURL -Token $Token `
        -ProcessUniqueId $ProcessUniqueId -ProcessGroupId $TargetGroupId)

    $actual = Get-NpmProcessGroupId -SiteURL $SiteURL -Token $Token -ProcessUniqueId $ProcessUniqueId -IsArchived $false
    if ($null -eq $actual) {
        return [PSCustomObject]@{ Moved = $false; ActualGroupId = $null; Verified = $false }
    }
    return [PSCustomObject]@{
        Moved = ("$actual" -eq "$TargetGroupId"); ActualGroupId = $actual; Verified = $true
    }
}

function Restore-ProcessPlanState {
    <#
    .SYNOPSIS
        Puts back everything this run restored: into its original group, then
        archived.

    .DESCRIPTION
        Idempotent and resumable. The plan is re-written after each entry, so a
        run interrupted here can be finished by re-importing the plan and calling
        this again: entries already marked Denormalized are skipped.

        The group move is not optional. ArchiveProcess archives a process WHERE
        IT CURRENTLY SITS, and at this point the targets sit in the temporary
        holding group. Archiving without moving them first leaves them archived
        under a group that cleanup is about to delete: three targets ended up
        under group 834 instead of 134, 649 and 493.

        The result row reports the group the process is VERIFIABLY in afterwards.
        It used to report OriginalGroupUniqueId unconditionally, so the results
        CSV asserted a placement that had never happened, in the one file
        operators are told to check.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        $Plan,
        [string]$PlanPath,
        [bool]$ApprovalsEnabled = $false
    )

    $results = @()
    $toRestore = @($Plan.Ledger | Where-Object {
        $_.WasArchived -and $_.RestoredByThisRun -and -not $_.Denormalized -and -not $_.Deleted
    })

    if ($toRestore.Count -eq 0) { return $results }

    Write-Host "`n=== RETURNING PROCESSES TO THEIR GROUPS AND RE-ARCHIVING ===" -ForegroundColor Cyan

    foreach ($entry in $toRestore) {
        $homeGroupId = $entry.OriginalGroupId
        $placement = ''
        $movedOk = $true

        if ($null -eq $homeGroupId) {
            # Nothing recorded to move it back to. Archive in place and say so,
            # rather than implying a placement that was never attempted.
            Write-Host "  $($entry.Name): no original group recorded; archiving where it sits." -ForegroundColor Yellow
            $placement = 'no original group was recorded, so it was archived where it sat'
            $movedOk = $false
        }
        else {
            $current = Get-NpmProcessGroupId -SiteURL $SiteURL -Token $Token `
                -ProcessUniqueId $entry.UniqueId -IsArchived $false

            if ($null -ne $current -and "$current" -eq "$homeGroupId") {
                Write-Host "  $($entry.Name) is already in group $homeGroupId." -ForegroundColor Gray
                $placement = "group $homeGroupId"
            }
            else {
                Write-Host "  Returning $($entry.Name) to group $homeGroupId..." -ForegroundColor Gray
                $move = Move-NpmProcessToGroup -SiteURL $SiteURL -Token $Token `
                    -ProcessUniqueId $entry.UniqueId -TargetGroupId $homeGroupId -ApprovalsEnabled $ApprovalsEnabled

                $movedOk = [bool]$move.Moved
                if ($move.Moved) {
                    $placement = "group $homeGroupId"
                } elseif ($move.Verified) {
                    $placement = "group $($move.ActualGroupId), NOT the original group $homeGroupId"
                    Write-Host "    Could not move it; it is in group $($move.ActualGroupId)." -ForegroundColor Red
                } else {
                    $placement = "an UNVERIFIED group; the move to $homeGroupId could not be confirmed"
                    Write-Host "    Could not confirm where it ended up." -ForegroundColor Red
                }
            }
        }

        Write-Host "  Re-archiving $($entry.Name)..." -ForegroundColor Gray
        $ok = Set-NpmProcessArchived -SiteURL $SiteURL -Token $Token -ProcessUniqueId $entry.UniqueId `
            -Comment 'Re-archiving after dependency cleanup' -ApprovalsEnabled $ApprovalsEnabled

        $entry.Denormalized = $ok

        $status = 'Success'
        if (-not $ok) { $status = 'Failed' }
        elseif (-not $movedOk) { $status = 'Skipped' }

        $results += [PSCustomObject]@{
            ObjectType = 'Process'; ObjectID = $entry.UniqueId; Name = $entry.Name
            Operation = 'ReArchive'
            Status = $status
            Message = $(if ($ok) { "Re-archived in $placement" }
                        else { "Re-archive failed; this process is still ACTIVE in $placement" })
        }

        if (-not $ok) {
            Write-Host "    Failed. $($entry.Name) is still active and must be archived manually." -ForegroundColor Red
        }

        if ($PlanPath) { [void](Export-DependencyPlan -Plan $Plan -Path $PlanPath) }
    }

    return $results
}
