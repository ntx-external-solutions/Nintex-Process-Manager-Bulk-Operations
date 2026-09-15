<#
.SYNOPSIS
    End-to-end test of plan construction and execution against a mocked tenant.

.DESCRIPTION
    Overrides Invoke-NpmApi so the whole pipeline runs offline: index sweep,
    dependency discovery, site location, inversion, reconciliation, reference
    removal, save, and verification.

    The dependency responses are the verbatim payloads captured from
    demo.promapp.com, and the process models are the real fixtures, so the
    scenario under test is the one that was actually measured.

    Run:  pwsh -NoProfile -File Tests/Test-Executor.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $root 'NintexProcessDependencies.ps1')

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

$AcrId = 'b4ac5598-1aae-4b76-aa19-3c1d34c20ffa'
$DtId  = '2e917985-9446-4969-bfad-eef7350532a4'

# ---------------------------------------------------------------------------
# Mock tenant
# ---------------------------------------------------------------------------
$script:Models = @{
    $AcrId = (Get-Content (Join-Path $root 'Tests/Fixtures/ActionCustomerRequest.json') -Raw | ConvertFrom-Json)
    $DtId  = (Get-Content (Join-Path $root 'Tests/Fixtures/DependencyTest.json') -Raw | ConvertFrom-Json)
}
$script:ArchivedIds = @()
$script:Calls = @()
$script:Saves = @()

# Verbatim from the tenant: querying DT with both processes active.
$script:DepResponses = @{
    $DtId = @'
[{"Type":"Linked Process","Dependencies":[
  {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"},
  {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"},
  {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"}]},
 {"Type":"Process Input","Dependencies":[
  {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"}]}]
'@
    $AcrId = @'
[{"Type":"Linked Process","Dependencies":[
  {"Name":"Dependency Test","UniqueId":"2e917985-9446-4969-bfad-eef7350532a4"},
  {"Name":"Dependency Test","UniqueId":"2e917985-9446-4969-bfad-eef7350532a4"}]},
 {"Type":"Process Input","Dependencies":[
  {"Name":"Dependency Test","UniqueId":"2e917985-9446-4969-bfad-eef7350532a4"}]}]
'@
}

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)

    $script:Calls += [PSCustomObject]@{ Method = $Method; Url = $Url }

    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $listType = [int]$Matches[1]
        $items = @()
        foreach ($id in $script:Models.Keys) {
            $isArch = ($script:ArchivedIds -contains $id)
            if (($listType -eq 7) -ne $isArch) { continue }
            $m = $script:Models[$id]
            $items += [PSCustomObject]@{
                processUniqueId = $id; id = $m.Id; processName = $m.Name; groupId = $m.GroupId
            }
        }
        return Ok ([PSCustomObject]@{ items = $items; totalItemCount = $items.Count })
    }

    if ($Url -match 'CheckProcessDependencies') {
        if ($Url -match '/Processes/([0-9a-fA-F\-]+)/CheckProcessDependencies') {
            $id = $Matches[1]
            if ($script:DepResponses.ContainsKey($id)) {
                return Ok ($script:DepResponses[$id] | ConvertFrom-Json)
            }
        }
        return Ok @()
    }

    if ($Url -match 'mobile/api/v1/processes') {
        $data = @()
        foreach ($m in ($Url -split '&')) {
            if ($m -match 'processUniqueIds=([0-9a-fA-F\-]+)') {
                $id = $Matches[1]
                if ($script:Models.ContainsKey($id)) {
                    $data += [PSCustomObject]@{ ProcessModel = $script:Models[$id] }
                }
            }
        }
        return Ok ([PSCustomObject]@{ data = $data })
    }

    if ($Method -eq 'Put' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        $script:Saves += [PSCustomObject]@{ UniqueId = $id; Body = $Body }
        # ProcessJson must arrive as a STRING; store what was actually sent so the
        # test can assert the contract rather than trusting it.
        if ($Body.ProcessJson -is [string]) {
            $script:Models[$id] = ($Body.ProcessJson | ConvertFrom-Json)
        }
        return Ok ([PSCustomObject]@{ ok = $true })
    }

    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        if ($script:Models.ContainsKey($id) -and ($script:ArchivedIds -notcontains $id)) {
            return Ok ([PSCustomObject]@{ processJson = $script:Models[$id] })
        }
        return [PSCustomObject]@{ Success=$false; StatusCode=404; Response=$null; Error='Not found' }
    }

    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId
        $script:ArchivedIds = @($script:ArchivedIds | Where-Object { $_ -ne $id })
        return Ok ([PSCustomObject]@{ ok = $true })
    }
    if ($Url -match 'ArchiveProcess') {
        $script:ArchivedIds += $Body.processUniqueId
        return Ok ([PSCustomObject]@{ ok = $true })
    }
    if ($Url -match 'DeleteProcess') {
        $script:Models.Remove($Body.processUniqueId)
        return Ok ([PSCustomObject]@{ ok = $true })
    }
    if ($Url -match 'PublishProcessRevisionEdit' -or $Url -match '/Publish$') {
        return Ok ([PSCustomObject]@{ ok = $true })
    }

    return Ok $null
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario: delete Dependency Test, both processes active" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$index = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
Assert-Equal 2 $index.Count 'the index sweep classifies both processes'
Assert-Equal $false (Get-NpmIndexEntry -Index $index -UniqueId $DtId).IsArchived 'DT reads as active'

$plan = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($DtId) -Index $index -HoldingGroupId 999 -AllowRestore $true

Assert-Equal 'Planned' $plan.Status 'the plan completes'
Assert-Equal 4 @($plan.Claims).Count 'all 4 occurrences from the DT query become claims'
Assert-Equal 1 @($plan.WorkItems).Count 'exactly one holder needs editing'
Assert-Equal $AcrId @($plan.WorkItems)[0].HolderUniqueId 'ACR is the holder, not DT'
Assert-Equal 3 @(@($plan.WorkItems)[0].Sites).Count 'all 3 ACR sites are queued'

# DT holds 2 references to ACR, but DT is the target and is about to be deleted,
# so editing it would be wasted work.
Assert-Equal 0 @($plan.Sites | Where-Object { $_.HolderUniqueId -eq $DtId }).Count `
    'sites held by the target itself are excluded from the work set'
Assert-Equal 2 @($plan.Ledger).Count 'both participants are recorded in the ledger'

$linkRec = @($plan.Reconciliation | Where-Object { $_.Category -eq 'Link' })[0]
Assert-Equal 3 $linkRec.Claimed 'link claims reconcile against the union'
Assert-Equal 'Match' $linkRec.Status 'link reconciliation matches'

# ---------------------------------------------------------------------------
Write-Host "`nExecution" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$script:Saves = @()
$exec = Invoke-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' -Plan $plan -PlanPath '' 

Assert-Equal 1 @($script:Saves).Count 'the holder is saved exactly once, not once per site'
Assert-True ($script:Saves[0].Body.ProcessJson -is [string]) 'ProcessJson is sent as a STRING, not an object'
Assert-Equal $true $script:Saves[0].Body.SuppressChangeNotification 'change notification is suppressed'
Assert-Equal 0 @($exec.VerificationFailed).Count 'verification passes'
Assert-Equal 'Success' @($exec.Results)[0].Status 'the removal is reported successful'

$acrAfter = $script:Models[$AcrId]
Assert-Equal 0 @(Find-ProcessReferenceSite -ProcessObject $acrAfter -TargetUniqueIds @($DtId)).Count `
    'no references to DT survive in the saved process'
Assert-Equal 2 @($acrAfter.LinkedStakeholders.LinkedStakeholder).Count 'LinkedStakeholders survives the save'
Assert-Equal 2 @($acrAfter.ProcessProcedures.Activity).Count 'activities survive the save'
Assert-Equal '@TODO: Enter some text here' `
    (@($acrAfter.ProcessProcedures.Activity)[1].ChildProcessProcedures.Note[0].Text) `
    'the orphaned note keeps its text'

$deleteResults = @(Invoke-ProcessTargetDeletion -SiteURL 'https://mock' -Token 't' -Plan $plan)
Assert-Equal 'Success' $deleteResults[0].Status 'the target is deleted'
Assert-Equal $false $script:Models.ContainsKey($DtId) 'the target is gone from the tenant'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the holder is archived" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$script:Models = @{
    $AcrId = (Get-Content (Join-Path $root 'Tests/Fixtures/ActionCustomerRequest.json') -Raw | ConvertFrom-Json)
    $DtId  = (Get-Content (Join-Path $root 'Tests/Fixtures/DependencyTest.json') -Raw | ConvertFrom-Json)
}
$script:ArchivedIds = @($AcrId)
$script:Saves = @()

$index2 = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
Assert-Equal $true (Get-NpmIndexEntry -Index $index2 -UniqueId $AcrId).IsArchived 'ACR reads as archived'

$plan2 = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($DtId) -Index $index2 -HoldingGroupId 999 -AllowRestore $true

$acrLedger = @($plan2.Ledger | Where-Object { $_.UniqueId -eq $AcrId })[0]
Assert-Equal $true $acrLedger.WasArchived 'the ledger records that ACR was archived'
Assert-Equal $true $acrLedger.RestoredByThisRun 'ACR was restored so its hidden edges become visible'
Assert-Equal '92d1e6ca-0534-4273-8124-7f838a1e335a' $acrLedger.OriginalGroupUniqueId `
    'the original group is captured before anything moves'
Assert-Equal 1 @($plan2.WorkItems).Count 'the archived holder still becomes a work item'
Assert-Equal 3 @(@($plan2.WorkItems)[0].Sites).Count 'all 3 sites are found once restored'

$exec2 = Invoke-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' -Plan $plan2 -PlanPath ''
Assert-Equal 0 @($exec2.VerificationFailed).Count 'verification passes for the restored holder'

$planPath = Join-Path ([System.IO.Path]::GetTempPath()) "exec-plan-$([guid]::NewGuid()).json"
$restoreResults = @(Restore-ProcessPlanState -SiteURL 'https://mock' -Token 't' -Plan $plan2 -PlanPath $planPath)
Assert-Equal 1 $restoreResults.Count 'one process is re-archived'
Assert-Equal 'Success' $restoreResults[0].Status 're-archiving succeeds'
Assert-True ($script:ArchivedIds -contains $AcrId) 'ACR is archived again afterwards'
Assert-Equal $true @($plan2.Ledger | Where-Object { $_.UniqueId -eq $AcrId })[0].Denormalized `
    'the ledger marks the entry denormalised'

# Re-running must be a no-op, so an interrupted run can be resumed safely.
$again = @(Restore-ProcessPlanState -SiteURL 'https://mock' -Token 't' -Plan $plan2 -PlanPath $planPath)
Assert-Equal 0 $again.Count 're-running denormalisation is idempotent'
Remove-Item $planPath -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a failed dependency check blocks the run" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    if ($Url -match 'ListType=(\d+)') {
        $items = @()
        if ([int]$Matches[1] -eq 0) {
            $items = @([PSCustomObject]@{ processUniqueId = $DtId; id = 1540; processName = 'Dependency Test'; groupId = 655 })
        }
        return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=([PSCustomObject]@{ items=$items }); Error=$null }
    }
    if ($Url -match 'CheckProcessDependencies') {
        return [PSCustomObject]@{ Success=$false; StatusCode=500; Response=$null; Error='server error' }
    }
    return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$null; Error=$null }
}

$index3 = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
$plan3 = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($DtId) -Index $index3 -HoldingGroupId 999 -AllowRestore $true

Assert-Equal 'Blocked' $plan3.Status 'a failed dependency check blocks planning'
Assert-Equal 0 @($plan3.WorkItems).Count 'a blocked plan queues no work'
Assert-True (@($plan3.Log) -join ' ' -like '*failed*') 'the block reason is logged'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a CLEAN dependency check is not a failed one" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The inverse of the scenario above, and the one that was missing. The tenant
# answers HTTP 200 with an empty body for a process that has no dependencies.
# PowerShell unrolls an empty array on return, so the old code assigned $null at
# the call site and read a clean check as a failed one: on the measured tenant
# that blocked 392 of 497 targets, which is to say every dependency-free process.

$CleanA = 'aaaaaaaa-0000-0000-0000-000000000001'
$CleanB = 'bbbbbbbb-0000-0000-0000-000000000002'

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)

    function Ok2($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $items = @()
        if ([int]$Matches[1] -eq 0) {
            $items = @(
                [PSCustomObject]@{ processUniqueId = $CleanA; id = 11; processName = 'Clean A'; groupId = 5 },
                [PSCustomObject]@{ processUniqueId = $CleanB; id = 12; processName = 'Clean B'; groupId = 5 }
            )
        }
        return Ok2 ([PSCustomObject]@{ items = $items })
    }
    # An empty body is what the tenant actually sends for "no dependencies".
    if ($Url -match 'CheckProcessDependencies') { return Ok2 $null }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        return Ok2 ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId = $Matches[1]; Name = 'Clean'; GroupId = 5; GroupUniqueId = 'g-5'; StateId = 1 } })
    }
    return Ok2 $null
}

# Pure: the shape of the return value, independent of any caller.
$clean = Get-ProcessDependencyClaim -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $CleanA
Assert-Equal $true $clean.Success 'an empty dependency payload is a SUCCESSFUL check'
Assert-Equal 0 @($clean.Claims).Count 'an empty payload yields zero claims'
Assert-True ($null -ne $clean.Claims) 'Claims is an empty collection, never $null'
Assert-True ($clean.Claims -is [array]) 'Claims survives the return as an array rather than unrolling'

$indexClean = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
$planClean = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($CleanA, $CleanB) -Index $indexClean -HoldingGroupId 999 -AllowRestore $true

Assert-True ($planClean.Status -ne 'Blocked') 'a tenant-wide clean dependency result does NOT block the plan'
Assert-Equal 'Planned' $planClean.Status 'the plan reaches Planned'
Assert-Equal 0 @($planClean.Claims).Count 'no claims were discovered, correctly'
Assert-Equal 0 @($planClean.WorkItems).Count 'dependency-free targets queue no reference removal'
Assert-Equal 0 @($planClean.FailedTargets).Count 'no target is recorded as failed'
Assert-Equal 2 @($planClean.TargetUniqueIds).Count 'both targets stay in the delete set'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: reconciliation skips pairs where both sides are deleted" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# 114 of the 120 mismatches on the measured tenant were pairs like this. The
# references between them cease to exist when both are deleted, so gating on
# them asked the operator to adjudicate 120 lines to protect 6.

$claimsPair = @(
    [PSCustomObject]@{ QueriedUniqueId=$AcrId; RelatedUniqueId=$DtId; Type='Linked Process'; Category='Link' },
    [PSCustomObject]@{ QueriedUniqueId=$AcrId; RelatedUniqueId=$DtId; Type='Linked Process'; Category='Link' }
)

$bothGone = @(Test-DependencyReconciliation -QueriedUniqueId $AcrId -RelatedUniqueId $DtId `
    -Claims $claimsPair -Sites @() -BothSidesDeleted $true)
$bothLink = @($bothGone | Where-Object { $_.Category -eq 'Link' })[0]

Assert-Equal 'NotApplicable' $bothLink.Status 'a pair with both sides deleted is NotApplicable, not a mismatch'
Assert-Equal 0 @($bothGone | Where-Object { $_.Status -eq 'Mismatch' }).Count 'no category of that pair gates the run'
Assert-Equal 2 $bothLink.Claimed 'the claim count is still recorded for the audit trail'

# One side surviving is exactly the case the gate exists for, so it still fires.
$oneSide = @(Test-DependencyReconciliation -QueriedUniqueId $AcrId -RelatedUniqueId $DtId `
    -Claims $claimsPair -Sites @() -BothSidesDeleted $false)
Assert-Equal 'Mismatch' @($oneSide | Where-Object { $_.Category -eq 'Link' })[0].Status `
    'a surviving holder still raises a mismatch'

Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "  Passed: $script:Pass   Failed: $script:Fail" -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "======================================`n" -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 }
