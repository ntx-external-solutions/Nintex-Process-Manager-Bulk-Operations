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

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a participant missing from both list sweeps" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# Processes exist that the dependency API reports but that neither ListType=0
# nor ListType=7 returns, while the mobile batch endpoint still serves them.
# Dropping such a participant silently means a holder whose reference to a
# deleted target is never removed.

$GhostId  = 'eeee0000-0000-0000-0000-00000000000e'
$TargetId = 'ffff0000-0000-0000-0000-00000000000f'
$script:GhostFetchable = $true

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok3($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    # Only the target is listed. The ghost appears in neither sweep.
    if ($Url -match 'ListType=(\d+)') {
        $items = @()
        if ([int]$Matches[1] -eq 0) {
            $items = @([PSCustomObject]@{ processUniqueId=$TargetId; id=7; processName='Target'; groupId=12 })
        }
        return Ok3 ([PSCustomObject]@{ items = $items })
    }

    if ($Url -match 'CheckProcessDependencies') {
        if ($Url -match "/Processes/$TargetId/") {
            return Ok3 (@'
[{"Type":"Linked Process","Dependencies":[{"Name":"Ghost Holder","UniqueId":"eeee0000-0000-0000-0000-00000000000e"}]}]
'@ | ConvertFrom-Json)
        }
        return Ok3 $null
    }

    # The ghost is served by the batch endpoint despite being unlisted.
    if ($Url -match 'mobile/api/v1/processes') {
        $data = @()
        if ($script:GhostFetchable -and $Url -match [regex]::Escape($GhostId)) {
            $data += [PSCustomObject]@{ ProcessModel = [PSCustomObject]@{
                UniqueId = $GhostId; Name = 'Ghost Holder'; Id = 4242
                GroupId = 77; GroupUniqueId = 'g-77'; StateId = 2 } }
        }
        return Ok3 ([PSCustomObject]@{ data = $data })
    }

    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        if ($id -eq $TargetId) {
            return Ok3 ([PSCustomObject]@{ processJson = [PSCustomObject]@{
                UniqueId=$id; Name='Target'; GroupId=12; GroupUniqueId='g-12'; StateId=1 } })
        }
        return [PSCustomObject]@{ Success=$false; StatusCode=404; Response=$null; Error='Not found' }
    }

    return Ok3 $null
}

$indexGhost = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
Assert-Equal 1 $indexGhost.Count 'the ghost really is absent from the index'

$planGhost = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($TargetId) -Index $indexGhost -AllowRestore $false

$ghostLedger = @($planGhost.Ledger | Where-Object { $_.UniqueId -eq $GhostId })
Assert-Equal 1 $ghostLedger.Count 'the unlisted participant is recovered into the ledger, not dropped'
Assert-Equal 'Ghost Holder' $ghostLedger[0].Name 'its name comes back with it'
Assert-Equal 77 $ghostLedger[0].OriginalGroupId 'its group comes back with it'
Assert-Equal 0 @($planGhost.Unresolved).Count 'a recoverable participant is not reported unresolved'
Assert-True ((@($planGhost.Log) -join ' ') -like '*Recovered participant*') 'the recovery is logged'

# Now the same participant, unreachable by any endpoint.
$script:GhostFetchable = $false
$planLost = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($TargetId) -Index $indexGhost -AllowRestore $false

Assert-Equal 1 @($planLost.Unresolved).Count 'a genuinely unreachable participant is recorded, not ignored'
Assert-Equal $GhostId @($planLost.Unresolved)[0].UniqueId 'it is named by id'
Assert-Equal 'Ghost Holder' @($planLost.Unresolved)[0].Name 'and by the name the dependency payload carried'
Assert-True ((@($planLost.Log) -join ' ') -like '*UNRESOLVED*') 'the run says its references will not be removed'

# W3: a name is available for a process no sweep returned.
Assert-Equal 'Ghost Holder' (Resolve-PlanProcessName -Plan $planLost -Index $indexGhost -UniqueId $GhostId) `
    'the claim name is used rather than printing a bare GUID'
Assert-Equal 'Target' (Resolve-PlanProcessName -Plan $planLost -Index $indexGhost -UniqueId $TargetId) `
    'the ledger still wins where it has an entry'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a preview does not claim restores it did not make" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$script:Models = @{
    $AcrId = (Get-Content (Join-Path $root 'Tests/Fixtures/ActionCustomerRequest.json') -Raw | ConvertFrom-Json)
    $DtId  = (Get-Content (Join-Path $root 'Tests/Fixtures/DependencyTest.json') -Raw | ConvertFrom-Json)
}
$script:ArchivedIds = @($AcrId)

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok4($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $listType = [int]$Matches[1]
        $items = @()
        foreach ($id in $script:Models.Keys) {
            $isArch = ($script:ArchivedIds -contains $id)
            if (($listType -eq 7) -ne $isArch) { continue }
            $m = $script:Models[$id]
            $items += [PSCustomObject]@{ processUniqueId=$id; id=$m.Id; processName=$m.Name; groupId=$m.GroupId }
        }
        return Ok4 ([PSCustomObject]@{ items = $items })
    }
    if ($Url -match 'CheckProcessDependencies') {
        if ($Url -match '/Processes/([0-9a-fA-F\-]+)/CheckProcessDependencies') {
            $id = $Matches[1]
            if ($script:DepResponses.ContainsKey($id)) { return Ok4 ($script:DepResponses[$id] | ConvertFrom-Json) }
        }
        return Ok4 $null
    }
    if ($Url -match 'mobile/api/v1/processes') {
        $data = @()
        foreach ($m in ($Url -split '&')) {
            if ($m -match 'processUniqueIds=([0-9a-fA-F\-]+)') {
                $id = $Matches[1]
                if ($script:Models.ContainsKey($id)) { $data += [PSCustomObject]@{ ProcessModel = $script:Models[$id] } }
            }
        }
        return Ok4 ([PSCustomObject]@{ data = $data })
    }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        if ($script:Models.ContainsKey($id) -and ($script:ArchivedIds -notcontains $id)) {
            return Ok4 ([PSCustomObject]@{ processJson = $script:Models[$id] })
        }
        return [PSCustomObject]@{ Success=$false; StatusCode=404; Response=$null; Error='Not found' }
    }
    return Ok4 $null
}

$previewIndex = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
$preview = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($DtId) -Index $previewIndex -AllowRestore $false

Assert-Equal 0 @($preview.Ledger | Where-Object { $_.RestoredByThisRun }).Count `
    'a preview restores nothing, so nothing is flagged as restored'
Assert-True (@($preview.Ledger | Where-Object { $_.WasArchived }).Count -gt 0) `
    'the preview still knows an archived participant is involved'

$shown = (Show-ProcessDeletePlan -Plan $preview -Index $previewIndex 6>&1 | Out-String)
Assert-True ($shown -match 'none restored') 'the preview says plainly that it restored nothing'
Assert-True (-not ($shown -match 'restored for the run')) 'the preview does not claim restores it never made'

# A real run does restore, and says so.
$script:ArchivedIds = @($AcrId)
$realIndex = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
$real = New-ProcessDeletePlan -SiteURL 'https://mock' -Token 't' `
    -TargetUniqueIds @($DtId) -Index $realIndex -HoldingGroupId 999 -AllowRestore $true
$shownReal = (Show-ProcessDeletePlan -Plan $real -Index $realIndex 6>&1 | Out-String)
Assert-True ($shownReal -match 'restored for the run') 'a real run does report the restores it made'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a cancelled run puts targets back in their OWN group" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# ArchiveProcess archives a process where it currently sits, and at unwind time
# the targets sit in the temporary holding group. Archiving without moving them
# first left three targets archived under the temp group instead of their homes,
# while the results CSV asserted the home group anyway.

$R1 = 'a1a1a1a1-0000-0000-0000-00000000000a'
$R2 = 'b2b2b2b2-0000-0000-0000-00000000000b'
$TempGrp = 834

$script:Grp = @{ $R1 = $TempGrp; $R2 = $TempGrp }
$script:Arch = @{ $R1 = $false;  $R2 = $false }
$script:MoveCalls = @()

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok5($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'RestoreProcess') {
        $id = $Body.processUniqueId
        $script:MoveCalls += "restore:$id->$($Body.processGroupId)"
        $script:Grp[$id] = [int]$Body.processGroupId
        $script:Arch[$id] = $false
        return Ok5 @{}
    }
    if ($Url -match 'ArchiveProcess') {
        $script:Arch[$Body.processUniqueId] = $true
        return Ok5 @{}
    }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok5 ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId = $id; Name = "Proc $id"; GroupId = $script:Grp[$id]; StateId = 1 } })
    }
    return Ok5 $null
}

$unwindPlan = New-DependencyPlan -SiteURL 'https://mock' -TargetUniqueIds @($R1, $R2)
$unwindPlan.Ledger = @(
    [PSCustomObject]@{ UniqueId=$R1; Name='Alpha'; NumericId=1; WasArchived=$true
                       OriginalGroupUniqueId='g-134'; OriginalGroupId=134
                       RestoredByThisRun=$true; Denormalized=$false; Deleted=$false },
    [PSCustomObject]@{ UniqueId=$R2; Name='Beta'; NumericId=2; WasArchived=$true
                       OriginalGroupUniqueId='g-649'; OriginalGroupId=649
                       RestoredByThisRun=$true; Denormalized=$false; Deleted=$false }
)

$unwound = @(Restore-ProcessPlanState -SiteURL 'https://mock' -Token 't' -Plan $unwindPlan -PlanPath '')

Assert-Equal 2 $unwound.Count 'both restored targets are unwound'
Assert-Equal 134 $script:Grp[$R1] 'Alpha ends in its own group, not the holding group'
Assert-Equal 649 $script:Grp[$R2] 'Beta ends in its own group, not the holding group'
Assert-Equal $true $script:Arch[$R1] 'Alpha ends archived'
Assert-Equal $true $script:Arch[$R2] 'Beta ends archived'
Assert-Equal 0 @($script:Grp.Values | Where-Object { $_ -eq $TempGrp }).Count `
    'nothing is left archived under the temporary group'

Assert-Equal 'Success' $unwound[0].Status 'the unwind reports success'
Assert-True ($unwound[0].Message -like '*group 134*') 'the results row names the group it actually reached'
Assert-True (-not ($unwound[0].Message -like "*$TempGrp*")) 'and does not name the holding group'

# The message must describe what happened, not what was hoped for.
$script:Grp = @{ $R1 = $TempGrp }
$script:Arch = @{ $R1 = $false }
function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok6($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }
    # A tenant that refuses to move the process: every relocation silently fails.
    if ($Url -match 'RestoreProcess') { return Ok6 @{} }
    if ($Url -match 'ArchiveProcess') { $script:Arch[$Body.processUniqueId] = $true; return Ok6 @{} }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok6 ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId=$id; Name='Alpha'; GroupId=$script:Grp[$id]; StateId=1 } })
    }
    return Ok6 $null
}

$stuckPlan = New-DependencyPlan -SiteURL 'https://mock' -TargetUniqueIds @($R1)
$stuckPlan.Ledger = @(
    [PSCustomObject]@{ UniqueId=$R1; Name='Alpha'; NumericId=1; WasArchived=$true
                       OriginalGroupUniqueId='g-134'; OriginalGroupId=134
                       RestoredByThisRun=$true; Denormalized=$false; Deleted=$false }
)
$stuck = @(Restore-ProcessPlanState -SiteURL 'https://mock' -Token 't' -Plan $stuckPlan -PlanPath '')

Assert-Equal 1 $stuck.Count 'the stuck process still produces a row'
Assert-True ($stuck[0].Message -like "*group $TempGrp*") 'the row names where it REALLY is'
Assert-True ($stuck[0].Message -like '*NOT the original group 134*') 'and says plainly that it is not home'
Assert-Equal 'Skipped' $stuck[0].Status 'a failed relocation is not reported as a clean success'

# No recorded home group: archive in place, and say that is what happened.
$script:Grp = @{ $R1 = $TempGrp }; $script:Arch = @{ $R1 = $false }
$noHome = New-DependencyPlan -SiteURL 'https://mock' -TargetUniqueIds @($R1)
$noHome.Ledger = @(
    [PSCustomObject]@{ UniqueId=$R1; Name='Alpha'; NumericId=1; WasArchived=$true
                       OriginalGroupUniqueId=''; OriginalGroupId=$null
                       RestoredByThisRun=$true; Denormalized=$false; Deleted=$false }
)
$noHomeRows = @(Restore-ProcessPlanState -SiteURL 'https://mock' -Token 't' -Plan $noHome -PlanPath '')
Assert-True ($noHomeRows[0].Message -like '*no original group was recorded*') `
    'with no recorded home group the row says so rather than inventing one'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the relocation probe is asked once, not once per process" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# RestoreProcess answers HTTP 500 for an already-active process on this tenant,
# every time. Run through the normal retry ladder that is 2 + 4 + 8 seconds per
# process before the fallback: 14 seconds each, and close to two hours of pure
# backoff on a 479-target run. The answer is the same for every process, so it
# is asked once and remembered.

$P1 = 'aa11bb22-0000-0000-0000-0000000000f1'
$P2 = 'aa11bb22-0000-0000-0000-0000000000f2'

$script:RestoreAttempts = @()
$script:ArchiveCount = 0
$script:Group = @{ $P1 = 834; $P2 = 834 }

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=$script:NpmMaxRetries)
    function Ok7($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'RestoreProcess') {
        $script:RestoreAttempts += [PSCustomObject]@{
            Id = $Body.processUniqueId; Group = $Body.processGroupId; MaxRetries = $MaxRetries }

        # Only relocates a process that is currently ARCHIVED.
        if ($script:Archived[$Body.processUniqueId]) {
            $script:Archived[$Body.processUniqueId] = $false
            $script:Group[$Body.processUniqueId] = [int]$Body.processGroupId
            return Ok7 @{}
        }
        return [PSCustomObject]@{ Success=$false; StatusCode=500; Response=$null; Error='server error' }
    }
    if ($Url -match 'ArchiveProcess') {
        $script:ArchiveCount++
        $script:Archived[$Body.processUniqueId] = $true
        return Ok7 @{}
    }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok7 ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId=$id; Name='P'; GroupId=$script:Group[$id]; StateId=1 } })
    }
    return Ok7 $null
}

Reset-NpmRelocationProbe
$script:Archived = @{ $P1 = $false; $P2 = $false }

$m1 = Move-NpmProcessToGroup -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P1 -TargetGroupId 493
Assert-Equal $true $m1.Moved 'the fallback lands the first process in its group'
Assert-Equal 493 $m1.ActualGroupId 'and says where it actually is'
Assert-Equal 'No' (Get-NpmRelocationProbeState) 'the run has learned that RestoreProcess does not relocate an active process'

$probe1 = @($script:RestoreAttempts | Where-Object { $_.Id -eq $P1 })[0]
Assert-Equal 0 $probe1.MaxRetries 'the probe runs with NO retry ladder, so a 500 costs nothing'

$attemptsAfterFirst = $script:RestoreAttempts.Count
$m2 = Move-NpmProcessToGroup -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P2 -TargetGroupId 493
Assert-Equal $true $m2.Moved 'the second process still lands correctly'

$secondCalls = @($script:RestoreAttempts | Where-Object { $_.Id -eq $P2 })
Assert-Equal 1 $secondCalls.Count 'the second process skips the probe entirely and restores once'
Assert-Equal ($attemptsAfterFirst + 1) $script:RestoreAttempts.Count 'no wasted call is made for it'

# A tenant where the probe DOES work must not be pushed down the fallback.
Reset-NpmRelocationProbe
$script:RestoreAttempts = @()
$script:ArchiveCount = 0
$script:Archived = @{ $P1 = $true }
$script:Group = @{ $P1 = 834 }

$m3 = Move-NpmProcessToGroup -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P1 -TargetGroupId 493
Assert-Equal $true $m3.Moved 'a tenant whose probe succeeds relocates on the first call'
Assert-Equal 'Yes' (Get-NpmRelocationProbeState) 'and that is remembered too'
Assert-Equal 0 $script:ArchiveCount 'with no archive/restore round trip forced on it'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the manual list reflects the tenant when the run ENDS" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The list is built from the checkpoint diff, taken before the targets are
# returned to their groups. Returning a target appears to bring its sibling
# variations back with it, so by the end some entries have undone themselves.
# One run told an operator to go and move five processes that were already home.

$Sib1 = 'cc00dd00-0000-0000-0000-0000000000c1'
$Sib2 = 'cc00dd00-0000-0000-0000-0000000000c2'

$collateralRecords = @(
    [PSCustomObject]@{ UniqueId=$Sib1; Name='Procure :: $5000 - $50000'; Change='Moved'
                       WasArchived=$false; IsArchivedNow=$false; OriginalGroupId=8; CurrentGroupId=836 },
    [PSCustomObject]@{ UniqueId=$Sib2; Name='Create sales order :: EMEA'; Change='Moved'
                       WasArchived=$false; IsArchivedNow=$false; OriginalGroupId=20; CurrentGroupId=836 }
)

$manualRows = @(
    [PSCustomObject]@{ ObjectType='Process'; ObjectID=$Sib1; Name='Procure :: $5000 - $50000'
                       Operation='ReverseCollateral'; Status='Skipped'; Message='Moved from group 8 to 836. Move it back manually' },
    [PSCustomObject]@{ ObjectType='Process'; ObjectID=$Sib2; Name='Create sales order :: EMEA'
                       Operation='ReverseCollateral'; Status='Skipped'; Message='Moved from group 20 to 836. Move it back manually' },
    [PSCustomObject]@{ ObjectType='Process'; ObjectID='zz'; Name='Unrelated'
                       Operation='Delete'; Status='Success'; Message='Deleted' }
)

# By the end of the run Sib1 is home again; Sib2 genuinely is not.
function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok8($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }
    if ($Url -match 'ListType=(\d+)') {
        $items = @()
        if ([int]$Matches[1] -eq 0) {
            $items = @(
                [PSCustomObject]@{ processUniqueId=$Sib1; id=1; processName='Procure :: $5000 - $50000'; groupId=8 },
                [PSCustomObject]@{ processUniqueId=$Sib2; id=2; processName='Create sales order :: EMEA'; groupId=836 }
            )
        }
        return Ok8 ([PSCustomObject]@{ items = $items })
    }
    return Ok8 $null
}

$resolved = @(Resolve-CollateralOutcome -SiteURL 'https://mock' -Token 't' `
    -Collateral $collateralRecords -Results $manualRows)

Assert-Equal 3 $resolved.Count 'every row survives; none is silently dropped'

$row1 = @($resolved | Where-Object { $_.ObjectID -eq $Sib1 })[0]
Assert-Equal 'Success' $row1.Status 'a process already back in its group is cleared from the manual list'
Assert-True ($row1.Message -like '*no action needed*') 'and says plainly that nothing needs doing'

$row2 = @($resolved | Where-Object { $_.ObjectID -eq $Sib2 })[0]
Assert-Equal 'Skipped' $row2.Status 'a process that is genuinely still misplaced stays on the list'

Assert-Equal 1 @($resolved | Where-Object {
    $_.Operation -eq 'ReverseCollateral' -and $_.Status -ne 'Success' }).Count `
    'the outstanding count is what is really outstanding, not what was outstanding mid-run'

# A process the baseline never covered has no home group to compare against.
$ghostRecord = @([PSCustomObject]@{ UniqueId=$Sib2; Name='Ghost'; Change='NotInBaseline'
                                    WasArchived=$null; IsArchivedNow=$false; OriginalGroupId=$null; CurrentGroupId=836 })
$ghostRows = @([PSCustomObject]@{ ObjectType='Process'; ObjectID=$Sib2; Name='Ghost'
                                  Operation='ReverseCollateral'; Status='Skipped'; Message='No before-state' })
$ghostResolved = @(Resolve-CollateralOutcome -SiteURL 'https://mock' -Token 't' `
    -Collateral $ghostRecord -Results $ghostRows)
Assert-Equal 'Skipped' $ghostResolved[0].Status 'an unbaselined process is never cleared, having nothing to be compared to'

Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "  Passed: $script:Pass   Failed: $script:Fail" -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "======================================`n" -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 }
