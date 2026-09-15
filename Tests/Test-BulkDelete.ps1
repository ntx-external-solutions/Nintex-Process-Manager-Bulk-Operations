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
            $items += [PSCustomObject]@{
                processUniqueId = $id
                id              = 1000 + [int]($id.Substring(0,1))
                processName     = $script:Names[$id]
                groupId         = $script:GroupOf[$id]
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
