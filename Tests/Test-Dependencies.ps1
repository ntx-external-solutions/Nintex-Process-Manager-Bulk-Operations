<#
.SYNOPSIS
    Offline tests for the pure functions in NintexProcessDependencies.ps1.

.DESCRIPTION
    No tenant required. Fixtures under Tests/Fixtures are real payloads captured
    from demo.promapp.com, plus one synthetic process exercising the buckets the
    real pair does not contain (Decision, Embedded*, Orphan*, Outputs, and
    ChildProcessProcedures nested two deep).

    Run:  pwsh -NoProfile -File Tests/Test-Dependencies.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $root 'NintexProcessDependencies.ps1')

$script:Pass = 0
$script:Fail = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Because)
    if ($Expected -eq $Actual) {
        $script:Pass++
        Write-Host "  PASS  $Because" -ForegroundColor Green
    } else {
        $script:Fail++
        Write-Host "  FAIL  $Because" -ForegroundColor Red
        Write-Host "        expected [$Expected] got [$Actual]" -ForegroundColor Red
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Because)
    Assert-Equal -Expected $true -Actual $Condition -Because $Because
}

function Read-Fixture {
    param([string]$Name)
    return (Get-Content -Path (Join-Path $root "Tests/Fixtures/$Name") -Raw | ConvertFrom-Json)
}

$AcrId = 'b4ac5598-1aae-4b76-aa19-3c1d34c20ffa'
$DtId  = '2e917985-9446-4969-bfad-eef7350532a4'

# ---------------------------------------------------------------------------
Write-Host "`nLocator against real payloads" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$acrModel = Read-Fixture 'ActionCustomerRequest.json'
$sites = @(Find-ProcessReferenceSite -ProcessObject $acrModel -TargetUniqueIds @($DtId))

Assert-Equal 3 $sites.Count 'ACR holds exactly 3 references to Dependency Test'
Assert-Equal 1 @($sites | Where-Object { $_.Bucket -eq 'ProcessLink' }).Count 'finds the top-level ProcessLink (29211)'
Assert-Equal 1 @($sites | Where-Object { $_.Bucket -eq 'Note' }).Count 'finds the Note nested in ChildProcessProcedures (29212)'
Assert-Equal 1 @($sites | Where-Object { $_.Category -eq 'Input' }).Count 'finds the Input (1220)'
Assert-Equal 29212 (@($sites | Where-Object { $_.Bucket -eq 'Note' })[0].ElementId) 'captures the Note element id'
Assert-True (@($sites | Where-Object { $_.Bucket -eq 'Note' })[0].IsChild) 'marks the Note as a child site'
Assert-Equal 'ProcessProcedures.Activity[1].ChildProcessProcedures.Note[0]' `
    (@($sites | Where-Object { $_.Bucket -eq 'Note' })[0].Path) 'records the full path to the nested Note'
Assert-Equal 0 @($sites | Where-Object { $_.Bucket -eq 'LinkedStakeholder' }).Count 'never reports LinkedStakeholders as a site'

$dtModel = Read-Fixture 'DependencyTest.json'
$dtSites = @(Find-ProcessReferenceSite -ProcessObject $dtModel -TargetUniqueIds @($AcrId))
Assert-Equal 2 $dtSites.Count 'DT holds exactly 2 references to ACR'

# This is the arithmetic from API_ARCHITECTURE.md: the union of both sides is
# what the API reports, and it only reconciles when both are walked.
Assert-Equal 3 (@($sites | Where-Object { $_.Category -eq 'Link' }).Count + `
                @($dtSites | Where-Object { $_.Category -eq 'Link' }).Count) `
    'link sites across both sides sum to the 3 the API reports for query DT'

# ---------------------------------------------------------------------------
Write-Host "`nLocator against all buckets" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$all = Read-Fixture 'AllBuckets.json'
$aSites = @(Find-ProcessReferenceSite -ProcessObject $all -TargetUniqueIds @('TARGET-A'))

Assert-Equal 1 @($aSites | Where-Object { $_.Bucket -eq 'Activity' }).Count 'finds an Activity-level link'
Assert-Equal 1 @($aSites | Where-Object { $_.Bucket -eq 'Decision' }).Count 'finds a Decision link'
Assert-Equal 1 @($aSites | Where-Object { $_.Bucket -eq 'ProcessLink' }).Count 'finds a ProcessLink'
Assert-Equal 1 @($aSites | Where-Object { $_.Bucket -eq 'OrphanProcessLink' }).Count 'finds an OrphanProcessLink'
Assert-Equal 1 @($aSites | Where-Object { $_.Bucket -eq 'OrphanEmbeddedProcessLink' }).Count 'finds an OrphanEmbeddedProcessLink'
Assert-Equal 1 @($aSites | Where-Object { $_.Bucket -eq 'Note' }).Count 'finds a child Note'
Assert-Equal 1 @($aSites | Where-Object { $_.Category -eq 'Input' }).Count 'finds an Input'
Assert-Equal 7 $aSites.Count 'finds all 7 TARGET-A sites'

$bSites = @(Find-ProcessReferenceSite -ProcessObject $all -TargetUniqueIds @('TARGET-B'))
Assert-Equal 1 @($bSites | Where-Object { $_.Bucket -eq 'EmbeddedProcessLink' }).Count 'finds an EmbeddedProcessLink'
Assert-Equal 1 @($bSites | Where-Object { $_.Category -eq 'Output' }).Count 'finds an Output'
Assert-Equal 1 @($bSites | Where-Object { $_.Bucket -eq 'WebLink' }).Count 'finds a WebLink nested two levels deep'
Assert-Equal 4 $bSites.Count 'finds all 4 TARGET-B sites'

$gSites = @(Find-ProcessReferenceSite -ProcessObject $all -TargetUniqueIds @() -TargetGroupUniqueIds @('GROUP-1'))
Assert-Equal 1 $gSites.Count 'finds the ProcessGroupLink when a group id is supplied'
Assert-Equal 'Report' $gSites[0].Action 'group links are report-only'

$both = @(Find-ProcessReferenceSite -ProcessObject $all -TargetUniqueIds @('TARGET-A','TARGET-B'))
Assert-Equal 11 $both.Count 'multi-target search returns the union of both site sets'

# ---------------------------------------------------------------------------
Write-Host "`nRemover" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$result = Remove-ProcessReference -ProcessObject $acrModel -TargetUniqueIds @($DtId)
Assert-Equal 3 $result.ReferencesRemoved 'removes all 3 ACR references'

$after = @(Find-ProcessReferenceSite -ProcessObject $result.CleanedObject -TargetUniqueIds @($DtId))
Assert-Equal 0 $after.Count 'no references survive the removal'

$originalAfter = @(Find-ProcessReferenceSite -ProcessObject $acrModel -TargetUniqueIds @($DtId))
Assert-Equal 3 $originalAfter.Count 'the caller-supplied object is not mutated'

$clean = $result.CleanedObject
Assert-Equal 0 @($clean.ProcessProcedures.ProcessLink).Count 'the matching ProcessLink element is dropped'
Assert-Equal 0 @($clean.Inputs.Input).Count 'the matching Input element is dropped'
Assert-Equal 2 @($clean.LinkedStakeholders.LinkedStakeholder).Count 'LinkedStakeholders is left intact'
Assert-Equal 2 @($clean.ProcessProcedures.Activity).Count 'activities are preserved'

$note = @($clean.ProcessProcedures.Activity)[1].ChildProcessProcedures.Note[0]
Assert-Equal $null $note.LinkedProcessUniqueId 'the child Note link is cleared'
Assert-Equal $null $note.LinkedProcessId 'the child Note LinkedProcessId is cleared'
Assert-Equal '@TODO: Enter some text here' $note.Text 'the child Note keeps its text rather than being deleted'

# ---------------------------------------------------------------------------
Write-Host "`nRemover: orphan semantics and collateral damage" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$aResult = Remove-ProcessReference -ProcessObject $all -TargetUniqueIds @('TARGET-A')
$ac = $aResult.CleanedObject
Assert-Equal 7 $aResult.ReferencesRemoved 'removes all 7 TARGET-A references'

$decisions = @($ac.ProcessProcedures.Decision)
Assert-Equal 2 $decisions.Count 'decisions are orphaned, never deleted'
Assert-Equal 7 $decisions[0].DecisionLinkType 'a live decision link (4) becomes orphaned (7)'
Assert-Equal 'Target A' $decisions[0].LinkedProcessDisplayName 'orphaned decision keeps LinkedProcessDisplayName'
Assert-Equal $null $decisions[0].LinkedProcessUniqueId 'orphaned decision clears LinkedProcessUniqueId'
Assert-Equal 4 $decisions[1].DecisionLinkType 'an unrelated decision keeps DecisionLinkType 4'
Assert-Equal 'SOMETHING-ELSE' $decisions[1].LinkedProcessUniqueId 'an unrelated decision is untouched'

$activity = @($ac.ProcessProcedures.Activity)[0]
Assert-Equal $null $activity.EmbeddedLinkedProcessId 'orphaning clears EmbeddedLinkedProcessId'
Assert-Equal $null $activity.LinkedProcessGroupUniqueId 'orphaning clears the group fields of the same link'
Assert-Equal 'Target A' $activity.LinkedProcessDisplayName 'orphaning keeps the display name breadcrumb'

$links = @($ac.ProcessProcedures.ProcessLink)
Assert-Equal 2 $links.Count 'only the matching ProcessLink is dropped'
Assert-True ($links.LinkedProcessUniqueId -contains 'SOMETHING-ELSE') 'the unrelated ProcessLink survives'
Assert-True ($links.LinkedProcessUniqueId -contains 'TARGET-B') 'the other target ProcessLink survives a single-target removal'

Assert-Equal 1 @($ac.Inputs.Input).Count 'only the matching Input is dropped'
Assert-Equal 1 @($ac.ProcessProcedures.ProcessGroupLink).Count 'group links are never removed'
Assert-Equal 1 @($ac.Outputs.Output).Count 'unrelated Outputs survive'

$unrelatedTask = @($ac.ProcessProcedures.Activity)[0].ChildProcessProcedures.Task[0]
Assert-Equal 'SOMETHING-ELSE' $unrelatedTask.LinkedProcessUniqueId 'an unrelated child link is untouched'

$deep = @($ac.ProcessProcedures.Activity)[0].ChildProcessProcedures.Note[0].ChildProcessProcedures.WebLink[0]
Assert-Equal 'TARGET-B' $deep.LinkedProcessUniqueId 'a two-deep child pointing elsewhere is untouched'

$bothResult = Remove-ProcessReference -ProcessObject $all -TargetUniqueIds @('TARGET-A','TARGET-B')
Assert-Equal 11 $bothResult.ReferencesRemoved 'a multi-target removal clears every site in one pass'
Assert-Equal 0 @(Find-ProcessReferenceSite -ProcessObject $bothResult.CleanedObject -TargetUniqueIds @('TARGET-A','TARGET-B')).Count `
    'nothing survives a multi-target removal'
Assert-Equal 1 @($bothResult.CleanedObject.ProcessProcedures.ProcessLink).Count 'the unrelated ProcessLink still survives'

# ---------------------------------------------------------------------------
Write-Host "`nNull and shape tolerance" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$empty = @{} | ConvertTo-Json | ConvertFrom-Json
Assert-Equal 0 @(Find-ProcessReferenceSite -ProcessObject $empty -TargetUniqueIds @($DtId)).Count 'an empty object yields no sites'
Assert-Equal 0 @(Find-ProcessReferenceSite -ProcessObject $null -TargetUniqueIds @($DtId)).Count 'a null process yields no sites'

# ACR carries "Outputs": null, which a naive walk indexes into and throws on.
Assert-Equal $null $acrModel.Outputs 'the real fixture really does carry a null Outputs'

$single = '{"UniqueId":"H","ProcessProcedures":{"ProcessLink":{"Id":1,"LinkedProcessUniqueId":"TARGET-A"}}}' | ConvertFrom-Json
Assert-Equal 1 @(Find-ProcessReferenceSite -ProcessObject $single -TargetUniqueIds @('TARGET-A')).Count `
    'a bucket collapsed to a bare object by ConvertFrom-Json is still walked'

$mixedCase = '{"UniqueId":"H","Inputs":{"Input":[{"Id":1,"FromProcessUniqueId":"2E917985-9446-4969-BFAD-EEF7350532A4"}]}}' | ConvertFrom-Json
Assert-Equal 1 @(Find-ProcessReferenceSite -ProcessObject $mixedCase -TargetUniqueIds @($DtId)).Count `
    'GUID matching is case-insensitive'

# ---------------------------------------------------------------------------
Write-Host "`nClaims parsing" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

# The verbatim response from querying Dependency Test with both processes active.
$dtResponse = @'
[
  {"Type":"Linked Process","Dependencies":[
    {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"},
    {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"},
    {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"}]},
  {"Type":"Process Input","Dependencies":[
    {"Name":"Action Customer Request ","UniqueId":"b4ac5598-1aae-4b76-aa19-3c1d34c20ffa"}]}
]
'@ | ConvertFrom-Json

$claims = @(ConvertFrom-DependencyResponse -Response $dtResponse -QueriedUniqueId $DtId)
Assert-Equal 4 $claims.Count 'every occurrence becomes a claim, duplicates included'
Assert-Equal 3 @($claims | Where-Object { $_.Category -eq 'Link' }).Count 'the 3 duplicate Linked Process rows are all kept'
Assert-Equal 1 @($claims | Where-Object { $_.Category -eq 'Input' }).Count 'the Process Input row is categorised'

$singleEntry = '[{"Type":"Linked Process","Dependencies":[{"Name":"X","UniqueId":"TARGET-A"}]}]' | ConvertFrom-Json
Assert-Equal 1 @(ConvertFrom-DependencyResponse -Response $singleEntry -QueriedUniqueId 'Q').Count `
    'a single-entry response is not lost to array collapsing'
Assert-Equal 0 @(ConvertFrom-DependencyResponse -Response $null -QueriedUniqueId 'Q').Count 'a null response yields no claims'

$candidates = @(Get-DependencyCandidate -Claims $claims -TargetUniqueIds @($DtId))
Assert-Equal 2 $candidates.Count 'both sides of a claim become fetch candidates'

$groupClaim = '[{"Type":"Linked Process Group","Dependencies":[{"Name":"G","UniqueId":"GROUP-1"}]}]' | ConvertFrom-Json
$gc = @(ConvertFrom-DependencyResponse -Response $groupClaim -QueriedUniqueId 'Q')
Assert-Equal 1 @(Get-DependencyCandidate -Claims $gc -TargetUniqueIds @('Q')).Count 'group claims are not fetched as processes'

# ---------------------------------------------------------------------------
Write-Host "`nInversion" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$allSites = @($sites) + @($dtSites)
$work = @(Group-ReferenceSiteByHolder -Sites $allSites)
Assert-Equal 2 $work.Count 'sites invert to one work item per holder'

$acrWork = @($work | Where-Object { $_.HolderUniqueId -eq $AcrId })[0]
Assert-Equal 3 $acrWork.Sites.Count 'the ACR work item carries all 3 of its sites'
Assert-Equal 1 $acrWork.TargetsAffected.Count 'the ACR work item names 1 affected target'

$withGroup = @($aSites) + @($gSites)
$gWork = @(Group-ReferenceSiteByHolder -Sites $withGroup)
Assert-Equal 7 @($gWork | Where-Object { $_.HolderUniqueId -eq 'aaaaaaaa-0000-0000-0000-000000000001' })[0].Sites.Count `
    'report-only group sites are excluded from work items'

# ---------------------------------------------------------------------------
Write-Host "`nReconciliation" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$rec = @(Test-DependencyReconciliation -QueriedUniqueId $DtId -RelatedUniqueId $AcrId `
    -Claims $claims -Sites $allSites -RelatedIsArchived $false)

$link = @($rec | Where-Object { $_.Category -eq 'Link' })[0]
Assert-Equal 3 $link.Claimed 'query DT claims 3 link references'
Assert-Equal 3 $link.Located 'walking both sides locates 3 link references'
Assert-Equal 'Match' $link.Status 'the union reconciles exactly'

$inputRec = @($rec | Where-Object { $_.Category -eq 'Input' })[0]
Assert-Equal 1 $inputRec.Claimed 'query DT claims 1 input reference'
Assert-Equal 'Match' $inputRec.Status 'the input reconciles'

# With ACR archived the API drops the Input row, but the reference still exists.
$archivedClaims = @($claims | Where-Object { $_.Category -ne 'Input' })
$recArchived = @(Test-DependencyReconciliation -QueriedUniqueId $DtId -RelatedUniqueId $AcrId `
    -Claims $archivedClaims -Sites $allSites -RelatedIsArchived $true)

$archivedInput = @($recArchived | Where-Object { $_.Category -eq 'Input' })[0]
Assert-Equal 0 $archivedInput.Claimed 'an archived related process suppresses the Input claim'
Assert-Equal 1 $archivedInput.Located 'the suppressed reference is still located in the JSON'
Assert-Equal 'Match' $archivedInput.Status 'suppression is expected, not a mismatch'
Assert-True ($archivedInput.Note -like '*suppressed*') 'the suppression is called out in the note'

# Measured, not assumed: the pair holds one Input each way (ids 1220 and 1221)
# but each query reports exactly one, so Input is not the union that Link is.
# Reconciliation scopes Input/Output to the queried process's own sites.
$inputSites = @($allSites | Where-Object { $_.Category -eq 'Input' })
Assert-Equal 2 $inputSites.Count 'the pair really does hold one Input in each direction'
Assert-Equal 1 @($inputSites | Where-Object { $_.HolderUniqueId -eq $DtId }).Count 'DT holds one of them'
Assert-Equal 1 @($inputSites | Where-Object { $_.HolderUniqueId -eq $AcrId }).Count 'ACR holds the other'

$recAcr = @(Test-DependencyReconciliation -QueriedUniqueId $AcrId -RelatedUniqueId $DtId `
    -Claims @(ConvertFrom-DependencyResponse -Response ('[{"Type":"Process Input","Dependencies":[{"Name":"Dependency Test","UniqueId":"' + $DtId + '"}]}]' | ConvertFrom-Json) -QueriedUniqueId $AcrId) `
    -Sites $allSites -RelatedIsArchived $false)
$acrInput = @($recAcr | Where-Object { $_.Category -eq 'Input' })[0]
Assert-Equal 1 $acrInput.Located 'querying the other side scopes to that side''s own Input'
Assert-Equal 'Match' $acrInput.Status 'Input reconciles from either side under the scoped rule'

# Link stays a union: scoping it the same way would under-count and hide sites.
$linkSites = @($allSites | Where-Object { $_.Category -eq 'Link' })
Assert-Equal 3 $linkSites.Count 'link sites are counted across both sides'

$recBad = @(Test-DependencyReconciliation -QueriedUniqueId $DtId -RelatedUniqueId $AcrId `
    -Claims @() -Sites $allSites -RelatedIsArchived $false)
Assert-Equal 'Mismatch' @($recBad | Where-Object { $_.Category -eq 'Link' })[0].Status `
    'located sites with no claims is flagged as a mismatch'

# ---------------------------------------------------------------------------
Write-Host "`nLedger and plan persistence" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$entry = New-ProcessLedgerEntryFromModel -ProcessModel $acrModel
Assert-Equal $false $entry.WasArchived 'StateId 1 reads as active'
Assert-Equal '92d1e6ca-0534-4273-8124-7f838a1e335a' $entry.OriginalGroupUniqueId 'the original group is captured for denormalisation'

$archivedModel = '{"UniqueId":"X","Name":"X","StateId":2,"GroupUniqueId":"G","GroupId":5}' | ConvertFrom-Json
Assert-Equal $true (New-ProcessLedgerEntryFromModel -ProcessModel $archivedModel).WasArchived 'a non-active StateId reads as archived'

$plan = New-DependencyPlan -SiteURL 'https://example.promapp.com/t' -TargetUniqueIds @($DtId)
$plan.Ledger = @($entry)
$plan.Claims = $claims
$plan.Sites = $allSites

$planPath = Join-Path ([System.IO.Path]::GetTempPath()) "npm-plan-test-$([guid]::NewGuid()).json"
[void](Export-DependencyPlan -Plan $plan -Path $planPath)
Assert-True (Test-Path $planPath) 'the plan is written to disk'
Assert-True (-not (Test-Path "$planPath.tmp")) 'the temp file is moved into place, not left behind'

$reloaded = Import-DependencyPlan -Path $planPath
Assert-Equal 4 @($reloaded.Claims).Count 'claims survive the round trip'
Assert-Equal 5 @($reloaded.Sites).Count 'sites survive the round trip'
Assert-Equal $DtId @($reloaded.TargetUniqueIds)[0] 'targets survive the round trip'
Assert-Equal '92d1e6ca-0534-4273-8124-7f838a1e335a' @($reloaded.Ledger)[0].OriginalGroupUniqueId 'the ledger survives the round trip'
Remove-Item $planPath -Force -ErrorAction SilentlyContinue

Assert-Equal $null (Import-DependencyPlan -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'does-not-exist.json')) `
    'importing a missing plan returns null rather than throwing'

# ---------------------------------------------------------------------------
Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "  Passed: $script:Pass   Failed: $script:Fail" -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "======================================`n" -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 }
