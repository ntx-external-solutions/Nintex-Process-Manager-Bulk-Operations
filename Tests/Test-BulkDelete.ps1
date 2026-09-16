<#
.SYNOPSIS
    Mode 5 orchestration tests: the Hold phase, the plan ledger, and holding
    group cleanup, against a mocked tenant.

.DESCRIPTION
    Covers the defects a pure engine test cannot reach, because they live in the
    order Invoke-BulkDeleteProcesses does things rather than in any one function:

      - the plan ledger must record the state the targets were in BEFORE the
        Hold phase un-archived them and moved them to a temporary group
      - the plan must be on disk before the first mutation, not after it
      - the temporary group must never be deleted while it still holds processes

    This file dot-sources Nintex-BulkOperations.ps1, which is only possible
    because the menu no longer runs at load.

    Run:  pwsh -NoProfile -File Tests/Test-BulkDelete.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $root 'Nintex-BulkOperations.ps1')

$script:Pass = 0
$script:Fail = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Because)
    if ($Expected -eq $Actual) { $script:Pass++; Write-Host "  PASS  $Because" -ForegroundColor Green }
    else {
        $script:Fail++
        Write-Host "  FAIL  $Because" -ForegroundColor Red
        Write-Host "        expected [$Expected] got [$Actual]" -ForegroundColor Red
    }
}
function Assert-True { param([bool]$C,[string]$B) Assert-Equal -Expected $true -Actual $C -Because $B }

# ---------------------------------------------------------------------------
# Mock tenant: three archived processes in group 100, nothing depends on them.
# ---------------------------------------------------------------------------
$T1 = '11111111-1111-1111-1111-111111111111'
$T2 = '22222222-2222-2222-2222-222222222222'
$T3 = '33333333-3333-3333-3333-333333333333'

$script:HomeGroupId       = 100
$script:HomeGroupUniqueId = 'group-100-home'
$script:TempGroupId       = 830
$script:TempGroupUniqueId = 'group-830-temp'

function Reset-MockTenant {
    $script:Archived = @{ $T1 = $true; $T2 = $true; $T3 = $true }
    $script:GroupOf  = @{ $T1 = 100;   $T2 = 100;   $T3 = 100 }
    $script:Deleted  = @()
    $script:RestoreCalls = @()
    $script:PlanPathAtFirstRestore = $null
    $script:PlanAtFirstRestore = $null
    $script:TempGroupDeleted = $false
    $script:TempGroupContents = @()
    $script:ArchiveCalls = @()
    # groupExists per process; absent means the listing reported it as present.
    $script:GroupExistsFor = @{}
}
Reset-MockTenant

$script:Names = @{ $T1 = 'Alpha'; $T2 = 'Bravo'; $T3 = 'Charlie' }

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)

    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        $items = @()
        foreach ($id in @($T1,$T2,$T3)) {
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $exists = $true
            if ($script:GroupExistsFor.ContainsKey($id)) { $exists = $script:GroupExistsFor[$id] }
            $items += [PSCustomObject]@{
                processUniqueId = $id
                id              = 1000 + [int]($id.Substring(0,1))
                processName     = $script:Names[$id]
                groupId         = $script:GroupOf[$id]
                groupName       = 'Promapp Demo Ltd.'
                groupExists     = $exists
            }
        }
        return Ok ([PSCustomObject]@{ items = $items })
    }

    # No dependencies anywhere: an empty body, exactly as the tenant sends it.
    if ($Url -match 'CheckProcessDependencies') { return Ok $null }

    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId

        # Snapshot the plan file as it stood at the moment of the very first
        # mutation. That file is what a crashed run would be recovered from.
        if ($script:RestoreCalls.Count -eq 0) {
            $found = @(Get-ChildItem -Path . -Filter 'Delete_Plan_*.json' -ErrorAction SilentlyContinue)
            if ($found.Count -gt 0) {
                $script:PlanPathAtFirstRestore = $found[0].FullName
                $script:PlanAtFirstRestore = Get-Content $found[0].FullName -Raw | ConvertFrom-Json
            }
        }

        $script:RestoreCalls += $id
        $script:Archived[$id] = $false
        $script:GroupOf[$id]  = [int]$Body.processGroupId
        return Ok ([PSCustomObject]@{ ok = $true })
    }

    if ($Url -match 'ArchiveProcess') {
        $script:ArchiveCalls += $Body.processUniqueId
        $script:Archived[$Body.processUniqueId] = $true
        return Ok ([PSCustomObject]@{ ok = $true })
    }

    if ($Url -match 'DeleteProcess') {
        $script:Deleted += $Body.processUniqueId
        return Ok ([PSCustomObject]@{ ok = $true })
    }

    if ($Url -match 'mobile/api/v1/processes') {
        $data = @()
        foreach ($m in ($Url -split '&')) {
            if ($m -match 'processUniqueIds=([0-9a-fA-F\-]+)') {
                $id = $Matches[1]
                $data += [PSCustomObject]@{ ProcessModel = [PSCustomObject]@{
                    UniqueId = $id; Name = $script:Names[$id]
                    GroupId = $script:GroupOf[$id]; GroupUniqueId = 'from-model'; StateId = 2 } }
            }
        }
        return Ok ([PSCustomObject]@{ data = $data })
    }

    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId = $id; Name = $script:Names[$id]
            GroupId = $script:GroupOf[$id]; GroupUniqueId = 'from-model'; StateId = 1 } })
    }

    return Ok $null
}

# The target-gathering path uses the main script's own HTTP helper, not the
# engine's, so it needs mocking too.
function Invoke-ApiGet {
    param([string]$Url,[string]$Token)

    if ($Url -match 'ListType=7') {
        $page = 1
        if ($Url -match 'Page=(\d+)') { $page = [int]$Matches[1] }
        if ($page -gt 1) { return [PSCustomObject]@{ items = @() } }

        $items = @()
        foreach ($id in @($T1,$T2,$T3)) {
            if (-not $script:Archived[$id]) { continue }
            $items += [PSCustomObject]@{
                processUniqueId = $id; processName = $script:Names[$id]; groupId = $script:GroupOf[$id]
            }
        }
        return [PSCustomObject]@{ items = $items }
    }

    return [PSCustomObject]@{ items = @() }
}

# Group helpers from the main script.
function Get-ProcessGroups {
    param([string]$SiteURL,[string]$Token)
    return @(
        @{ id = $script:HomeGroupId; uniqueId = $script:HomeGroupUniqueId; name = 'Home' },
        @{ id = $script:TempGroupId; uniqueId = $script:TempGroupUniqueId; name = 'Bulk Delete Temporary Group' }
    )
}
function New-ProcessGroup {
    param([string]$SiteURL,[string]$Token,[string]$GroupName)
    return @{ id = $script:TempGroupId; uniqueId = $script:TempGroupUniqueId; name = $GroupName }
}
function Delete-ProcessGroup {
    param([string]$SiteURL,[string]$Token,[string]$GroupUniqueId,[switch]$Silent)
    $script:TempGroupDeleted = $true
    return $true
}
function Get-ProcessesFromGroup {
    param([string]$SiteURL,[string]$Token,$GroupID,[string]$GroupUniqueId,$IncludeSubgroups)
    return @($script:TempGroupContents)
}
function Save-DeleteResults { param($Results,[string]$Timestamp) $script:LastResults = @($Results) }

# ---------------------------------------------------------------------------
Write-Host "`nScenario: archived targets are held, deleted, and the ledger tells the truth" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$work = Join-Path ([System.IO.Path]::GetTempPath()) "bulkdelete-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work -Force | Out-Null
Push-Location $work
try {
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force

    $planFile = @(Get-ChildItem -Path . -Filter 'Delete_Plan_*.json')[0]
    $plan = Get-Content $planFile.FullName -Raw | ConvertFrom-Json

    Assert-Equal 3 $script:RestoreCalls.Count 'all three archived targets are held'
    Assert-Equal 3 $script:Deleted.Count 'all three targets are deleted'

    # B4: the plan must exist before the first thing the run changes.
    Assert-True ($null -ne $script:PlanAtFirstRestore) 'a plan file is on disk BEFORE the first restore'
    Assert-Equal 3 @($script:PlanAtFirstRestore.Ledger).Count 'the pre-mutation plan already carries every target'
    Assert-Equal $true @($script:PlanAtFirstRestore.Ledger)[0].WasArchived `
        'the pre-mutation ledger records the targets as archived'

    foreach ($entry in @($plan.Ledger)) {
        Assert-Equal $true $entry.WasArchived "$($entry.Name): the ledger says it WAS archived"
        Assert-Equal $script:HomeGroupId $entry.OriginalGroupId `
            "$($entry.Name): OriginalGroupId is the home group, not the temp group"
        Assert-Equal $script:HomeGroupUniqueId $entry.OriginalGroupUniqueId `
            "$($entry.Name): OriginalGroupUniqueId is the home group, not the temp group"
        Assert-Equal $true $entry.RestoredByThisRun `
            "$($entry.Name): RestoredByThisRun is set so the unwind path can put it back"
    }

    Assert-Equal 0 @($plan.Ledger | Where-Object { $_.OriginalGroupId -eq $script:TempGroupId }).Count `
        'no ledger entry names the temporary group as its origin'

    Assert-Equal $true $script:TempGroupDeleted 'the empty holding group is cleaned up'

    # A target is, by the time it is deleted, an archived process that this run
    # restored, so it matches the re-archive filter on every count except that
    # it no longer exists. One archive each (the pre-delete archive), not two.
    Assert-Equal 3 $script:ArchiveCalls.Count 'deleted targets are archived once, not re-archived afterwards'
    foreach ($entry in @($plan.Ledger)) {
        Assert-Equal $true $entry.Deleted "$($entry.Name): the ledger records that it was deleted"
    }
    Assert-Equal 0 @($script:LastResults | Where-Object { $_.Operation -eq 'ReArchive' }).Count `
        'no re-archive is attempted against a deleted process'
}
finally {
    Pop-Location
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a target whose group is gone is named before the run starts" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# It is a warning, not a gate. These targets can be held and deleted normally;
# what they cannot do is go home if the run stops short, and the operator wants
# that before the first mutation rather than out of the results file afterwards.

Reset-MockTenant
$script:GroupOf[$T3] = 1
$script:GroupExistsFor = @{ $T3 = $false }

$work = Join-Path ([System.IO.Path]::GetTempPath()) "bulkdelete-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work -Force | Out-Null
Push-Location $work
try {
    $out = (Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force) 6>&1 | Out-String

    Assert-True ($out -match 'TARGETS WHOSE GROUP NO LONGER EXISTS') 'the run says so up front'
    Assert-True ($out -match '1 of 3 target\(s\) belong to a group that no longer exists') `
        'and counts targets, not rows'
    Assert-True ($out -match 'Charlie') 'and names the one it means'

    $warnAt = $out.IndexOf('TARGETS WHOSE GROUP NO LONGER EXISTS')
    $holdAt = $out.IndexOf('=== HOLDING GROUP ===')
    Assert-True ($warnAt -ge 0 -and $holdAt -gt $warnAt) 'before the first mutation, not after it'

    Assert-Equal 3 $script:Deleted.Count 'it is a warning: all three targets are still deleted'
    Assert-Equal $true $script:TempGroupDeleted 'and the holding group is still cleaned up'
}
finally {
    Pop-Location
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# A run with no orphaned target says nothing about orphans at all.
Reset-MockTenant
$work = Join-Path ([System.IO.Path]::GetTempPath()) "bulkdelete-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work -Force | Out-Null
Push-Location $work
try {
    $cleanOut = (Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force) 6>&1 | Out-String

    Assert-True ($cleanOut -notmatch 'TARGETS WHOSE GROUP NO LONGER EXISTS') `
        'a tenant with no orphaned targets gets no orphan warning'
    Assert-Equal 3 $script:Deleted.Count 'and the ordinary run is untouched'
}
finally {
    Pop-Location
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a holding group that still holds processes is NOT deleted" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

Reset-MockTenant
$script:TempGroupContents = @(
    [PSCustomObject]@{ processUniqueId = $T2; processName = 'Bravo' }
)

$tempGroup = @{ id = $script:TempGroupId; uniqueId = $script:TempGroupUniqueId }
$cleanup = @(Remove-HoldingGroup -SiteURL 'https://mock' -Token 't' -TempGroup $tempGroup -GroupName 'Bulk Delete Temporary Group')

Assert-Equal $false $script:TempGroupDeleted 'a non-empty holding group is left in place'
Assert-Equal 'Skipped' $cleanup[0].Status 'the skip is reported rather than passing silently'
Assert-True ($cleanup[0].Message -like "*$T2*") 'the leftover process is named so it can be found'

$script:TempGroupContents = @()
$cleanup2 = @(Remove-HoldingGroup -SiteURL 'https://mock' -Token 't' -TempGroup $tempGroup -GroupName 'Bulk Delete Temporary Group')
Assert-Equal $true $script:TempGroupDeleted 'an empty holding group is deleted'
Assert-Equal 'Success' $cleanup2[0].Status 'the successful cleanup is reported'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a variation drags its master, and the run stops" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# T1 is a variation. Restoring it out of the archive also archives its master,
# M1, which is not a target and is not in the ledger. Nothing in the process
# model says the two are linked, so the only way to see it is the before/after
# diff of tenant state. The run must stop and put M1 back.

$M1 = '99999999-9999-9999-9999-999999999999'

function Reset-VariationTenant {
    $script:Archived = @{ $T1 = $true;  $M1 = $false }
    $script:GroupOf  = @{ $T1 = 100;    $M1 = 100 }
    $script:Names    = @{ $T1 = 'Order Handling (AU)'; $M1 = 'Order Handling' }
    $script:Deleted  = @()
    $script:RestoreCalls = @()
    $script:ArchiveCalls = @()
    $script:TempGroupDeleted = $false
    $script:TempGroupContents = @()
    $script:PlanAtFirstRestore = $null
}
Reset-VariationTenant

function Invoke-ApiGet {
    param([string]$Url,[string]$Token)
    if ($Url -match 'ListType=7') {
        $page = 1
        if ($Url -match 'Page=(\d+)') { $page = [int]$Matches[1] }
        if ($page -gt 1) { return [PSCustomObject]@{ items = @() } }
        $items = @()
        foreach ($id in @($T1,$M1)) {
            if (-not $script:Archived[$id]) { continue }
            $items += [PSCustomObject]@{ processUniqueId=$id; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return [PSCustomObject]@{ items = $items }
    }
    return [PSCustomObject]@{ items = @() }
}

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        $items = @()
        foreach ($id in @($T1,$M1)) {
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $items += [PSCustomObject]@{
                processUniqueId=$id; id=1; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return Ok ([PSCustomObject]@{ items = $items })
    }
    if ($Url -match 'CheckProcessDependencies') { return Ok $null }

    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId
        $script:RestoreCalls += $id
        $script:Archived[$id] = $false
        $script:GroupOf[$id]  = [int]$Body.processGroupId

        # The coupling under test: acting on the variation acts on the master.
        if ($id -eq $T1) { $script:Archived[$M1] = $true }
        return Ok @{}
    }
    if ($Url -match 'ArchiveProcess') {
        $script:ArchiveCalls += $Body.processUniqueId
        $script:Archived[$Body.processUniqueId] = $true
        return Ok @{}
    }
    if ($Url -match 'DeleteProcess') { $script:Deleted += $Body.processUniqueId; return Ok @{} }

    if ($Url -match 'mobile/api/v1/processes') {
        $data = @()
        foreach ($m in ($Url -split '&')) {
            if ($m -match 'processUniqueIds=([0-9a-fA-F\-]+)') {
                $id = $Matches[1]
                $data += [PSCustomObject]@{ ProcessModel = [PSCustomObject]@{
                    UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=2 } }
            }
        }
        return Ok ([PSCustomObject]@{ data = $data })
    }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=1 } })
    }
    return Ok $null
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) "variation-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work -Force | Out-Null
Push-Location $work
try {
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force

    Assert-Equal 0 $script:Deleted.Count 'NOTHING is deleted once collateral is detected'
    Assert-Equal $false $script:Archived[$M1] 'the master is put back to active'
    Assert-Equal 100 $script:GroupOf[$M1] 'the master is returned to its own group'
    Assert-Equal $true $script:Archived[$T1] 'the target is re-archived on the way out'

    $planFile = @(Get-ChildItem -Path . -Filter 'Delete_Plan_*.json')[0]
    $plan = Get-Content $planFile.FullName -Raw | ConvertFrom-Json
    Assert-Equal 'AbortedCollateral' $plan.Status 'the plan records why the run stopped'
    Assert-Equal 1 @($plan.Collateral).Count 'the collateral is recorded in the plan for audit'
    Assert-Equal $M1 @($plan.Collateral)[0].UniqueId 'the master is named in the plan'
    Assert-Equal 'Archived' @($plan.Collateral)[0].Change 'the plan says what happened to it'

    # Save-DeleteResults is stubbed at the top of this file; it captures the rows
    # rather than writing a CSV.
    $rows = @($script:LastResults)
    Assert-True ($rows.Count -gt 0) 'results are still reported when the run stops'
    Assert-True (@($rows | Where-Object { $_.Operation -eq 'Collateral' }).Count -gt 0) `
        'the results name the collateral'
    Assert-True (@($rows | Where-Object { $_.Operation -eq 'ReverseCollateral' -and $_.Status -eq 'Success' }).Count -gt 0) `
        'the reversal is recorded as done'
}
finally {
    Pop-Location
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: collateral during the ARCHIVE phase stops before deletion" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The targets are active, so there is no Hold phase and no first checkpoint.
# The pre-delete archive is itself a mutation, and it is the last point at which
# stopping still costs nothing: an unwanted archive can be undone, a delete cannot.

Reset-VariationTenant
$script:Archived = @{ $T1 = $false; $M1 = $false }   # both active now

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        $items = @()
        foreach ($id in @($T1,$M1)) {
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $items += [PSCustomObject]@{
                processUniqueId=$id; id=1; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return Ok ([PSCustomObject]@{ items = $items })
    }
    if ($Url -match 'CheckProcessDependencies') { return Ok $null }
    if ($Url -match 'ArchiveProcess') {
        $id = $Body.processUniqueId
        $script:ArchiveCalls += $id
        $script:Archived[$id] = $true
        if ($id -eq $T1) { $script:Archived[$M1] = $true }   # the coupling
        return Ok @{}
    }
    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId
        $script:RestoreCalls += $id
        $script:Archived[$id] = $false
        $script:GroupOf[$id] = [int]$Body.processGroupId
        return Ok @{}
    }
    if ($Url -match 'DeleteProcess') { $script:Deleted += $Body.processUniqueId; return Ok @{} }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=1 } })
    }
    if ($Url -match 'mobile/api/v1/processes') { return Ok ([PSCustomObject]@{ data = @() }) }
    return Ok $null
}

$work2 = Join-Path ([System.IO.Path]::GetTempPath()) "variation2-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work2 -Force | Out-Null
$csvPath = Join-Path $work2 'targets.csv'
"ProcessID`n$T1" | Set-Content -Path $csvPath -Encoding UTF8

Push-Location $work2
try {
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'CSV' -CsvPath $csvPath `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force

    Assert-Equal 0 $script:Deleted.Count 'the run stops between archiving and deleting'
    Assert-True ($script:ArchiveCalls -contains $T1) 'the target was archived, which is what exposed the coupling'
    Assert-Equal $false $script:Archived[$M1] 'the master is un-archived again'
}
finally {
    Pop-Location
    Remove-Item $work2 -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the coupling fires on DELETE, and the run says so" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# Measurement settled where the damage lands: restoring and archiving a process
# leave the tenant exactly as found, and the index shows each change on the
# first read afterwards. So the two earlier checkpoints report clean because
# nothing has happened yet. The master moves when the variation is DELETED.
#
# The post-delete checkpoint cannot prevent that. It must report it, reverse
# what is reversible, and above all not finish claiming 0 failed.

$M2 = '88888888-8888-8888-8888-888888888888'

function Reset-DeleteTimeTenant {
    $script:Archived = @{ $T1 = $true;  $M2 = $false }
    $script:GroupOf  = @{ $T1 = 333;    $M2 = 100 }
    $script:Names    = @{ $T1 = 'Order Handling::AU'; $M2 = 'Something Unrelated' }
    $script:Deleted  = @()
    $script:RestoreCalls = @()
    $script:ArchiveCalls = @()
    $script:TempGroupDeleted = $false
    $script:TempGroupContents = @()
    $script:LastResults = @()
}
Reset-DeleteTimeTenant

function Invoke-ApiGet {
    param([string]$Url,[string]$Token)
    if ($Url -match 'ListType=7') {
        $page = 1
        if ($Url -match 'Page=(\d+)') { $page = [int]$Matches[1] }
        if ($page -gt 1) { return [PSCustomObject]@{ items = @() } }
        $items = @()
        foreach ($id in @($T1,$M2)) {
            if (-not $script:Archived[$id]) { continue }
            $items += [PSCustomObject]@{ processUniqueId=$id; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return [PSCustomObject]@{ items = $items }
    }
    return [PSCustomObject]@{ items = @() }
}

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        $items = @()
        foreach ($id in @($T1,$M2)) {
            if ($null -eq $script:Archived[$id]) { continue }      # deleted
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $items += [PSCustomObject]@{
                processUniqueId=$id; id=1; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return Ok ([PSCustomObject]@{ items = $items })
    }
    if ($Url -match 'CheckProcessDependencies') { return Ok $null }

    # Restore and archive are clean. Nothing follows the target out.
    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId
        $script:RestoreCalls += $id
        $script:Archived[$id] = $false
        $script:GroupOf[$id] = [int]$Body.processGroupId
        return Ok @{}
    }
    if ($Url -match 'ArchiveProcess') {
        $id = $Body.processUniqueId
        $script:ArchiveCalls += $id
        $script:Archived[$id] = $true
        return Ok @{}
    }

    # The delete is where the coupling actually fires.
    if ($Url -match 'DeleteProcess') {
        $id = $Body.processUniqueId
        $script:Deleted += $id
        $script:Archived.Remove($id)
        if ($id -eq $T1) { $script:Archived[$M2] = $true }
        return Ok @{}
    }

    if ($Url -match 'mobile/api/v1/processes') {
        $data = @()
        foreach ($m in ($Url -split '&')) {
            if ($m -match 'processUniqueIds=([0-9a-fA-F\-]+)') {
                $id = $Matches[1]
                if ($null -ne $script:Archived[$id]) {
                    $data += [PSCustomObject]@{ ProcessModel = [PSCustomObject]@{
                        UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=2 } }
                }
            }
        }
        return Ok ([PSCustomObject]@{ data = $data })
    }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=1 } })
    }
    return Ok $null
}

$work3 = Join-Path ([System.IO.Path]::GetTempPath()) "deltime-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work3 -Force | Out-Null
Push-Location $work3
try {
    # -Force would be refused by the variation pre-flight, which is the point of
    # the next scenario. Here the master has an unrelated name, so the heuristic
    # stays quiet and the post-delete checkpoint is what has to catch it.
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force

    Assert-Equal 1 $script:Deleted.Count 'the target is deleted, as asked'
    Assert-True ($script:Deleted -contains $T1) 'and it is the right one'

    $rows = @($script:LastResults)
    $collateralRows = @($rows | Where-Object { $_.Operation -eq 'Collateral' })
    Assert-Equal 1 $collateralRows.Count 'the post-delete checkpoint reports the master'
    Assert-Equal $M2 $collateralRows[0].ObjectID 'by id'
    Assert-Equal 'Failed' $collateralRows[0].Status 'as a failure, so the run cannot report 0 failed'
    Assert-True (@($rows | Where-Object { $_.Status -eq 'Failed' }).Count -gt 0) `
        'the run does NOT finish with zero failures'

    Assert-Equal $false $script:Archived[$M2] 'the reversible damage is reversed: the master is active again'
    Assert-Equal 100 $script:GroupOf[$M2] 'and back in its own group'

    $planFile = @(Get-ChildItem -Path . -Filter 'Delete_Plan_*.json')[0]
    $plan = Get-Content $planFile.FullName -Raw | ConvertFrom-Json
    Assert-Equal 1 @($plan.Collateral).Count 'the plan records the collateral for audit'
    Assert-True ((@($plan.Log) -join ' ') -like '*after delete phase*') 'the log says which phase found it'
}
finally {
    Pop-Location
    Remove-Item $work3 -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the pre-flight stops an unattended run before it mutates" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

Reset-DeleteTimeTenant
$script:Names = @{ $T1 = 'Order Handling::AU'; $M2 = 'Order Handling' }   # now it matches

$work4 = Join-Path ([System.IO.Path]::GetTempPath()) "preflight-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work4 -Force | Out-Null
Push-Location $work4
try {
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force

    Assert-Equal 0 $script:Deleted.Count 'nothing is deleted'
    Assert-Equal 0 $script:RestoreCalls.Count 'nothing is even restored; the run stops before the Hold phase'
    Assert-Equal 0 $script:ArchiveCalls.Count 'and before anything is archived'
    Assert-Equal $false $script:Archived[$M2] 'the master is untouched'

    $rows = @($script:LastResults)
    $warnRows = @($rows | Where-Object { $_.Operation -eq 'VariationWarning' })
    Assert-Equal 1 $warnRows.Count 'the master is named in the results'
    Assert-Equal $M2 $warnRows[0].ObjectID 'by id'
    Assert-Equal 'Failed' $warnRows[0].Status 'and counted as a failure, not a clean finish'
}
finally {
    Pop-Location
    Remove-Item $work4 -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a process stranded BY the delete is seen and named once" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# Two defects meet here.
#
# W3: the observed-id list was gathered before the deletes. At that moment the
# holding group holds only the targets, every one of which is expected and so
# skipped, and the NotInBaseline branch could never fire on a real run. The
# process worth catching is stranded there BY the delete.
#
# W2: two producers raise collateral rows, the checkpoints and the holding-group
# sweep, and neither merged with the other. The group listing also drops the
# " :: Premium" suffix and returns the master's name, so one id printed under
# two different names.

$Ghost = 'ea181982-0000-0000-0000-0000000000aa'

function Reset-StrandTenant {
    $script:Archived = @{ $T1 = $true }
    $script:GroupOf  = @{ $T1 = 333 }
    $script:Names    = @{ $T1 = 'Create sales order' }
    $script:Deleted  = @()
    $script:RestoreCalls = @(); $script:ArchiveCalls = @()
    $script:TempGroupDeleted = $false
    $script:TempGroupContents = @()
    $script:LastResults = @()
}
Reset-StrandTenant

function Invoke-ApiGet {
    param([string]$Url,[string]$Token)
    if ($Url -match 'ListType=7') {
        $page = 1
        if ($Url -match 'Page=(\d+)') { $page = [int]$Matches[1] }
        if ($page -gt 1) { return [PSCustomObject]@{ items = @() } }
        $items = @()
        if ($script:Archived[$T1]) {
            $items += [PSCustomObject]@{ processUniqueId=$T1; processName=$script:Names[$T1]; groupId=$script:GroupOf[$T1] }
        }
        return [PSCustomObject]@{ items = $items }
    }
    return [PSCustomObject]@{ items = @() }
}

# The holding group is read live, so it reflects whatever the run has done.
function Get-ProcessesFromGroup {
    param([string]$SiteURL,[string]$Token,$GroupID,[string]$GroupUniqueId,$IncludeSubgroups)
    return @($script:TempGroupContents)
}

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        $items = @()
        foreach ($id in @($T1)) {
            if ($null -eq $script:Archived[$id]) { continue }
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $items += [PSCustomObject]@{
                processUniqueId=$id; id=1; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return Ok ([PSCustomObject]@{ items = $items })
    }
    if ($Url -match 'CheckProcessDependencies') { return Ok $null }
    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId
        $script:RestoreCalls += $id
        $script:Archived[$id] = $false
        $script:GroupOf[$id] = [int]$Body.processGroupId
        $script:TempGroupContents = @([PSCustomObject]@{ processUniqueId = $T1; processName = 'Create sales order' })
        return Ok @{}
    }
    if ($Url -match 'ArchiveProcess') {
        $script:ArchiveCalls += $Body.processUniqueId
        $script:Archived[$Body.processUniqueId] = $true
        return Ok @{}
    }
    if ($Url -match 'DeleteProcess') {
        $id = $Body.processUniqueId
        $script:Deleted += $id
        $script:Archived.Remove($id)

        # The delete strands a process that NO list sweep ever returned, and the
        # group listing reports it under its master's name without the suffix.
        $script:TempGroupContents = @([PSCustomObject]@{
            processUniqueId = $Ghost; processName = 'Issue Building Consent' })
        return Ok @{}
    }
    if ($Url -match 'mobile/api/v1/processes') { return Ok ([PSCustomObject]@{ data = @() }) }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=1 } })
    }
    return Ok $null
}

$work5 = Join-Path ([System.IO.Path]::GetTempPath()) "strand-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work5 -Force | Out-Null
Push-Location $work5
try {
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force

    $rows = @($script:LastResults)
    $ghostRows = @($rows | Where-Object { $_.Operation -eq 'Collateral' -and $_.ObjectID -eq $Ghost })

    Assert-True ($ghostRows.Count -gt 0) `
        'a process stranded by the DELETE is caught, which the pre-delete list never could'
    Assert-Equal 1 $ghostRows.Count 'and it is reported once, not once per producer'

    Assert-Equal 1 @($rows | Where-Object { $_.Operation -eq 'Collateral' } |
        ForEach-Object { $_.ObjectID } | Select-Object -Unique).Count `
        'one collateral row per affected process'
    Assert-Equal 1 @($rows | Where-Object { $_.Operation -eq 'Collateral' }).Count `
        'no duplicate rows across the two producers'

    Assert-True (@($rows | Where-Object { $_.Status -eq 'Failed' }).Count -gt 0) `
        'and the run does not report it as clean'

    # The plan's Collateral is written ONLY by the checkpoints, so this isolates
    # W3 from the holding-group sweep, which would otherwise cover for it and
    # make the checkpoint look like it worked when it had never fired.
    $planFile = @(Get-ChildItem -Path . -Filter 'Delete_Plan_*.json')[0]
    $plan = Get-Content $planFile.FullName -Raw | ConvertFrom-Json
    $planGhost = @($plan.Collateral | Where-Object { $_.UniqueId -eq $Ghost })

    Assert-Equal 1 $planGhost.Count 'the CHECKPOINT itself sees the stranded process, not just the cleanup sweep'
    Assert-Equal 'NotInBaseline' $planGhost[0].Change `
        'and classifies it as a process the baseline never covered'
    Assert-True ((@($plan.Log) -join ' ') -like '*NotInBaseline*') 'the plan log records it'
}
finally {
    Pop-Location
    Remove-Item $work5 -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a target whose Hold fails is NOT deleted" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The Hold phase exists because archiving hides Input and Output rows. A target
# that never came out of the archive was never checked, and the run says so in
# its own log. Deleting it anyway can leave a dangling reference on a process
# that survives, which is the one failure the dependency engine exists to stop.

$Good1 = 'aa000000-0000-0000-0000-00000000aa01'
$Good2 = 'aa000000-0000-0000-0000-00000000aa02'
$Stuck = 'd394677d-0000-0000-0000-00000000aa03'

function Reset-HoldFailTenant {
    $script:Archived = @{ $Good1 = $true; $Good2 = $true; $Stuck = $true }
    $script:GroupOf  = @{ $Good1 = 100;   $Good2 = 100;   $Stuck = 100 }
    $script:Names    = @{ $Good1 = 'Alpha'; $Good2 = 'Beta'; $Stuck = 'Prototype packaging structure' }
    $script:Deleted  = @()
    $script:RestoreCalls = @(); $script:ArchiveCalls = @()
    $script:TempGroupDeleted = $false
    $script:TempGroupContents = @()
    $script:LastResults = @()
}
Reset-HoldFailTenant

function Invoke-ApiGet {
    param([string]$Url,[string]$Token)
    if ($Url -match 'ListType=7') {
        $page = 1
        if ($Url -match 'Page=(\d+)') { $page = [int]$Matches[1] }
        if ($page -gt 1) { return [PSCustomObject]@{ items = @() } }
        $items = @()
        foreach ($id in @($Good1,$Good2,$Stuck)) {
            if (-not $script:Archived[$id]) { continue }
            $items += [PSCustomObject]@{ processUniqueId=$id; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return [PSCustomObject]@{ items = $items }
    }
    return [PSCustomObject]@{ items = @() }
}
function Get-ProcessesFromGroup {
    param([string]$SiteURL,[string]$Token,$GroupID,[string]$GroupUniqueId,$IncludeSubgroups)
    return @($script:TempGroupContents)
}

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        $items = @()
        foreach ($id in @($Good1,$Good2,$Stuck)) {
            if ($null -eq $script:Archived[$id]) { continue }
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $items += [PSCustomObject]@{
                processUniqueId=$id; id=1; processName=$script:Names[$id]; groupId=$script:GroupOf[$id] }
        }
        return Ok ([PSCustomObject]@{ items = $items })
    }
    if ($Url -match 'CheckProcessDependencies') { return Ok $null }

    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId
        # This one target refuses to come out of the archive, as the tenant did.
        if ($id -eq $Stuck) {
            return [PSCustomObject]@{ Success=$false; StatusCode=500; Response=$null; Error='server error' }
        }
        $script:RestoreCalls += $id
        $script:Archived[$id] = $false
        $script:GroupOf[$id] = [int]$Body.processGroupId
        return Ok @{}
    }
    if ($Url -match 'ArchiveProcess') {
        $script:ArchiveCalls += $Body.processUniqueId
        $script:Archived[$Body.processUniqueId] = $true
        return Ok @{}
    }
    if ($Url -match 'DeleteProcess') {
        $id = $Body.processUniqueId
        $script:Deleted += $id
        $script:Archived.Remove($id)
        return Ok @{}
    }
    if ($Url -match 'mobile/api/v1/processes') {
        $data = @()
        foreach ($m in ($Url -split '&')) {
            if ($m -match 'processUniqueIds=([0-9a-fA-F\-]+)') {
                $id = $Matches[1]
                if ($null -ne $script:Archived[$id]) {
                    $data += [PSCustomObject]@{ ProcessModel = [PSCustomObject]@{
                        UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=2 } }
                }
            }
        }
        return Ok ([PSCustomObject]@{ data = $data })
    }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId=$id; Name=$script:Names[$id]; GroupId=$script:GroupOf[$id]; StateId=1 } })
    }
    return Ok $null
}

$work6 = Join-Path ([System.IO.Path]::GetTempPath()) "holdfail-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work6 -Force | Out-Null
Push-Location $work6
try {
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force

    Assert-Equal $false ($script:Deleted -contains $Stuck) `
        'the target that never came out of the archive is NOT deleted'
    Assert-True ($script:Deleted -contains $Good1) 'the rest of the batch is still deleted'
    Assert-True ($script:Deleted -contains $Good2) 'both of them'
    Assert-Equal 2 $script:Deleted.Count 'exactly the two that were held'

    $rows = @($script:LastResults)
    $stuckDelete = @($rows | Where-Object { $_.ObjectID -eq $Stuck -and $_.Operation -eq 'Delete' })
    Assert-Equal 1 $stuckDelete.Count 'the excluded target still appears in the results'
    Assert-Equal 'Skipped' $stuckDelete[0].Status 'as skipped, not deleted'
    Assert-True ($stuckDelete[0].Message -like '*never checked*') 'and the reason says its references were never checked'

    Assert-Equal 0 @($rows | Where-Object {
        $_.ObjectID -eq $Stuck -and $_.Operation -eq 'Delete' -and $_.Status -eq 'Success' }).Count `
        'there is no Delete/Success row for it anywhere'
}
finally {
    Pop-Location
    Remove-Item $work6 -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: -AllowUnheldTargets is the only way to delete it unchecked" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

Reset-HoldFailTenant
$work7 = Join-Path ([System.IO.Path]::GetTempPath()) "holdallow-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work7 -Force | Out-Null
Push-Location $work7
try {
    Invoke-BulkDeleteProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Archived' `
        -TempGroupName 'Bulk Delete Temporary Group' -CurrentUsername 'u' -Force -AllowUnheldTargets

    Assert-True ($script:Deleted -contains $Stuck) `
        'with the explicit switch the unchecked target IS deleted'
    Assert-Equal 3 $script:Deleted.Count 'all three go'

    $planFile = @(Get-ChildItem -Path . -Filter 'Delete_Plan_*.json')[0]
    $plan = Get-Content $planFile.FullName -Raw | ConvertFrom-Json
    Assert-True ((@($plan.Log) -join ' ') -like '*UNCHECKED DELETE allowed*') `
        'and the plan records that it was an unchecked delete'
}
finally {
    Pop-Location
    Remove-Item $work7 -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: both archived-list readers page identically" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
$script:PageSizesSeen = @()
function Invoke-ApiGet {
    param([string]$Url,[string]$Token)
    if ($Url -match 'PageSize=(\d+)') { $script:PageSizesSeen += [int]$Matches[1] }
    return [PSCustomObject]@{ items = @() }
}

[void](Get-AllArchivedProcesses -SiteURL 'https://mock' -Token 't')
[void](Get-ArchivedProcesses -SiteURL 'https://mock' -Token 't')

Assert-Equal 1 @($script:PageSizesSeen | Select-Object -Unique).Count `
    'Get-AllArchivedProcesses and Get-ArchivedProcesses request the same page size'
Assert-Equal 200 @($script:PageSizesSeen | Select-Object -Unique)[0] `
    'that page size is 200, not 20'

Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "  Passed: $script:Pass   Failed: $script:Fail" -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "======================================`n" -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 }
