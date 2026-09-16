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
Write-Host "`nCollateral detection (process variations)" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# A variation is its own record in its own group, and acting on one acts on its
# master. Nothing in the model or a list entry says so, so the only handle is a
# before/after diff of the whole tenant.

function New-MockIndex {
    param($Rows)
    $ix = @{}
    foreach ($r in $Rows) {
        $ix[$r.UniqueId.ToLowerInvariant()] = [PSCustomObject]@{
            UniqueId   = $r.UniqueId
            NumericId  = $r.NumericId
            Name       = $r.Name
            IsArchived = $r.IsArchived
            GroupId    = $r.GroupId
        }
    }
    return $ix
}

$TargetId  = 'aaaa0000-0000-0000-0000-00000000000a'   # the variation being deleted
$MasterId  = 'bbbb0000-0000-0000-0000-00000000000b'   # its master, in another group
$BystandId = 'cccc0000-0000-0000-0000-00000000000c'   # unrelated, must not be flagged
$VanishId  = 'dddd0000-0000-0000-0000-00000000000d'

$before = New-MockIndex @(
    @{ UniqueId=$TargetId;  NumericId=1; Name='Order Handling (AU)'; IsArchived=$true;  GroupId=493 },
    @{ UniqueId=$MasterId;  NumericId=2; Name='Order Handling';      IsArchived=$false; GroupId=493 },
    @{ UniqueId=$BystandId; NumericId=3; Name='Unrelated';           IsArchived=$false; GroupId=200 },
    @{ UniqueId=$VanishId;  NumericId=4; Name='Doomed';              IsArchived=$false; GroupId=200 }
)

$baseline = New-TenantStateSnapshot -Index $before
Assert-Equal 4 $baseline.Count 'the baseline covers every process in the tenant, not just the targets'
Assert-Equal $true $baseline[$TargetId.ToLowerInvariant()].IsArchived 'the baseline records archive state'
Assert-Equal 493 $baseline[$MasterId.ToLowerInvariant()].GroupId 'the baseline records the home group'

# The Hold phase restores the target into temp group 831. The master follows it
# out of the archive, and an unrelated process vanishes.
$after = New-MockIndex @(
    @{ UniqueId=$TargetId;  NumericId=1; Name='Order Handling (AU)'; IsArchived=$false; GroupId=831 },
    @{ UniqueId=$MasterId;  NumericId=2; Name='Order Handling';      IsArchived=$true;  GroupId=493 },
    @{ UniqueId=$BystandId; NumericId=3; Name='Unrelated';           IsArchived=$false; GroupId=200 }
)

$collateral = @(Compare-TenantState -Baseline $baseline -Index $after -ExpectedUniqueIds @($TargetId))

Assert-Equal 2 $collateral.Count 'only the unexpected changes are reported'
Assert-Equal 0 @($collateral | Where-Object { $_.UniqueId -eq $TargetId }).Count `
    'the target is expected to move and is not reported as collateral'
Assert-Equal 0 @($collateral | Where-Object { $_.UniqueId -eq $BystandId }).Count `
    'an untouched process is not reported'

$master = @($collateral | Where-Object { $_.UniqueId -eq $MasterId })[0]
Assert-Equal 'Archived' $master.Change 'the master is reported as newly archived'
Assert-Equal $false $master.WasArchived 'the master was active before the run'
Assert-Equal 493 $master.OriginalGroupId 'the home group is carried so it can be put back'

$vanished = @($collateral | Where-Object { $_.UniqueId -eq $VanishId })[0]
Assert-Equal 'Disappeared' $vanished.Change 'a process that vanished from the tenant is caught'

# A pure move, with archive state unchanged.
$moved = New-MockIndex @(
    @{ UniqueId=$TargetId;  NumericId=1; Name='Order Handling (AU)'; IsArchived=$true;  GroupId=493 },
    @{ UniqueId=$MasterId;  NumericId=2; Name='Order Handling';      IsArchived=$false; GroupId=831 },
    @{ UniqueId=$BystandId; NumericId=3; Name='Unrelated';           IsArchived=$false; GroupId=200 },
    @{ UniqueId=$VanishId;  NumericId=4; Name='Doomed';              IsArchived=$false; GroupId=200 }
)
$movedCollateral = @(Compare-TenantState -Baseline $baseline -Index $moved -ExpectedUniqueIds @($TargetId))
Assert-Equal 1 $movedCollateral.Count 'a group move with no archive change is still collateral'
Assert-Equal 'Moved' $movedCollateral[0].Change 'it is classified as a move'
Assert-Equal 831 $movedCollateral[0].CurrentGroupId 'the group it was parked in is named'

# A clean run reports nothing.
$clean = @(Compare-TenantState -Baseline $baseline -Index $before -ExpectedUniqueIds @($TargetId))
Assert-Equal 0 $clean.Count 'an unchanged tenant produces no collateral'

# Holders the run restored on purpose are expected, not collateral.
$expected = @(Compare-TenantState -Baseline $baseline -Index $after -ExpectedUniqueIds @($TargetId, $MasterId, $VanishId))
Assert-Equal 0 $expected.Count 'processes the run deliberately changed are excluded'

# ---------------------------------------------------------------------------
Write-Host "`nVariation pre-flight heuristic" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The only check that can PREVENT collateral damage, because it runs before the
# first mutation. Nothing in the API exposes the variation/master link; the
# naming convention "<master>::<variant>" does, imperfectly.

$VarA   = '1111aaaa-0000-0000-0000-00000000000a'   # "Order Handling::AU"
$MastA  = '2222bbbb-0000-0000-0000-00000000000b'   # "Order Handling"
$VarB   = '3333cccc-0000-0000-0000-00000000000c'   # "Invoicing::NZ", master also a target
$MastB  = '4444dddd-0000-0000-0000-00000000000d'   # "Invoicing"
$Orphan = '5555eeee-0000-0000-0000-00000000000e'   # "Shipping::EU", no master exists
$Plain  = '6666ffff-0000-0000-0000-00000000000f'   # no separator at all

$varIndex = New-MockIndex @(
    @{ UniqueId=$VarA;   NumericId=1; Name='Order Handling::AU'; IsArchived=$true;  GroupId=333 },
    @{ UniqueId=$MastA;  NumericId=2; Name='Order Handling';     IsArchived=$false; GroupId=100 },
    @{ UniqueId=$VarB;   NumericId=3; Name='Invoicing::NZ';      IsArchived=$true;  GroupId=333 },
    @{ UniqueId=$MastB;  NumericId=4; Name='Invoicing';          IsArchived=$false; GroupId=100 },
    @{ UniqueId=$Orphan; NumericId=5; Name='Shipping::EU';       IsArchived=$true;  GroupId=333 },
    @{ UniqueId=$Plain;  NumericId=6; Name='Just A Process';     IsArchived=$true;  GroupId=333 }
)

# Deleting the AU variation alone: its master is not a target, so warn.
$hits = @(Find-VariationMaster -Index $varIndex -TargetUniqueIds @($VarA))
Assert-Equal 1 $hits.Count 'a variation whose master is not a target is flagged'
Assert-Equal $MastA $hits[0].MasterUniqueId 'the master is identified by id'
Assert-Equal 'Order Handling' $hits[0].BaseName 'the base name is the text before the separator'
Assert-Equal $false $hits[0].MasterIsArchived 'the master state is carried so the warning can describe it'
Assert-Equal 100 $hits[0].MasterGroupId 'the master group is carried too'

# Deleting the variation AND its master: nothing surprising about that.
$bothTargets = @(Find-VariationMaster -Index $varIndex -TargetUniqueIds @($VarB, $MastB))
Assert-Equal 0 $bothTargets.Count 'a master that is itself a target is not flagged'

# A separator with no matching base name cannot warn about anything.
$orphaned = @(Find-VariationMaster -Index $varIndex -TargetUniqueIds @($Orphan))
Assert-Equal 0 $orphaned.Count 'a variation with no existing master is not flagged'

$plainOnly = @(Find-VariationMaster -Index $varIndex -TargetUniqueIds @($Plain))
Assert-Equal 0 $plainOnly.Count 'a process with no separator is not treated as a variation'

# The whole set at once, which is how a real run calls it.
$allHits = @(Find-VariationMaster -Index $varIndex -TargetUniqueIds @($VarA, $VarB, $Orphan, $Plain))
Assert-Equal 2 $allHits.Count 'both AU and NZ warn when neither master is a target'

Assert-Equal 0 @(Find-VariationMaster -Index $varIndex -TargetUniqueIds @()).Count 'no targets, no warnings'
Assert-Equal 0 @(Find-VariationMaster -Index $null -TargetUniqueIds @($VarA)).Count 'a null index does not throw'

# The separator is a naming convention, not an API contract.
$pipeIndex = New-MockIndex @(
    @{ UniqueId=$VarA;  NumericId=1; Name='Order Handling|AU'; IsArchived=$true;  GroupId=333 },
    @{ UniqueId=$MastA; NumericId=2; Name='Order Handling';    IsArchived=$false; GroupId=100 }
)
Assert-Equal 1 @(Find-VariationMaster -Index $pipeIndex -TargetUniqueIds @($VarA) -Separator '|').Count `
    'the separator is configurable for tenants with another convention'
Assert-Equal 0 @(Find-VariationMaster -Index $pipeIndex -TargetUniqueIds @($VarA)).Count `
    'and the default does not match a different convention'

# ---------------------------------------------------------------------------
Write-Host "`nVariation warning counts and ordering" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The warning emits one row per (target, candidate master) pair, so the row
# count is not the target count. Reporting 13 "targets" for 3 targets is how a
# warning stops being read.

$MultiA = 'aaaa1111-0000-0000-0000-00000000001a'
$MultiB = 'bbbb1111-0000-0000-0000-00000000001b'
$Cand1  = 'cccc1111-0000-0000-0000-00000000001c'   # active, same group as target
$Cand2  = 'dddd1111-0000-0000-0000-00000000001d'   # archived
$Cand3  = 'eeee1111-0000-0000-0000-00000000001e'   # active, different group

$multiIndex = New-MockIndex @(
    @{ UniqueId=$MultiA; NumericId=1; Name='Payments::AU'; IsArchived=$true;  GroupId=500 },
    @{ UniqueId=$MultiB; NumericId=2; Name='Payments::NZ'; IsArchived=$true;  GroupId=500 },
    @{ UniqueId=$Cand1;  NumericId=3; Name='Payments';     IsArchived=$false; GroupId=500 },
    @{ UniqueId=$Cand2;  NumericId=4; Name='Payments';     IsArchived=$true;  GroupId=700 },
    @{ UniqueId=$Cand3;  NumericId=5; Name='payments';     IsArchived=$false; GroupId=900 }
)

$multi = @(Find-VariationMaster -Index $multiIndex -TargetUniqueIds @($MultiA, $MultiB))

# Two targets, three candidate masters each: six pairs, but only two targets.
Assert-Equal 6 $multi.Count 'one row per target/master pair'
Assert-Equal 2 @($multi | ForEach-Object { $_.TargetUniqueId } | Select-Object -Unique).Count `
    'the number of TARGETS is two, whatever the row count says'
Assert-Equal 3 @($multi | ForEach-Object { $_.MasterUniqueId } | Select-Object -Unique).Count `
    'and the number of distinct masters is three'
Assert-Equal 500 @($multi | Where-Object { $_.TargetUniqueId -eq $MultiA })[0].TargetGroupId `
    'the target group is carried so masters can be ordered by proximity'

# Case-insensitive name matching means 'payments' matches 'Payments::AU'.
Assert-True (@($multi | Where-Object { $_.MasterUniqueId -eq $Cand3 }).Count -gt 0) `
    'a master differing only by case is still found'

# Only an ACTIVE master can be collaterally archived, so it must sort first.
$shown = (Show-VariationWarning -Matches $multi 6>&1 | Out-String)
Assert-True ($shown -match '2 target\(s\)') 'the warning counts targets, not pairs'
Assert-True ($shown -match '3 candidate master\(s\)') 'and reports the master count separately'

$firstMasterLine = @($shown -split "`n" | Where-Object { $_ -match 'master:' })[0]
Assert-True ($firstMasterLine -match 'active') 'the first master listed is an active one, which is the one at risk'
Assert-True ($firstMasterLine -match 'can be archived by this run') 'and it is marked as the row carrying the risk'

$lastMasterLine = @($shown -split "`n" | Where-Object { $_ -match 'master:' })[-1]
Assert-True ($lastMasterLine -match 'archived') 'an archived master, which cannot be archived again, sorts last'

# ---------------------------------------------------------------------------
Write-Host "`nProcesses the baseline never covered" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The baseline is built from the two list sweeps and those sweeps are not
# complete. A process the run meets but that no sweep returned has no
# before-state, so it cannot be diffed, only reported.

$Ghost = '7777aaaa-0000-0000-0000-00000000000a'
$smallBase = New-TenantStateSnapshot -Index (New-MockIndex @(
    @{ UniqueId=$TargetId; NumericId=1; Name='Target'; IsArchived=$true; GroupId=493 }
))
$smallAfter = New-MockIndex @(
    @{ UniqueId=$TargetId; NumericId=1; Name='Target'; IsArchived=$true;  GroupId=493 },
    @{ UniqueId=$Ghost;    NumericId=9; Name='Issue Building Consent'; IsArchived=$false; GroupId=832 }
)

$withGhost = @(Compare-TenantState -Baseline $smallBase -Index $smallAfter `
    -ExpectedUniqueIds @($TargetId) -ObservedUniqueIds @($Ghost))
Assert-Equal 1 $withGhost.Count 'a process the run met but the baseline never saw is reported'
Assert-Equal 'NotInBaseline' $withGhost[0].Change 'it gets its own category rather than a guessed one'
Assert-Equal $Ghost $withGhost[0].UniqueId 'it is named by id'
Assert-Equal $null $withGhost[0].WasArchived 'no before-state is invented for it'
Assert-Equal 832 $withGhost[0].CurrentGroupId 'where it is now is recorded'

# Without the observed list there is nothing to notice it by.
Assert-Equal 0 @(Compare-TenantState -Baseline $smallBase -Index $smallAfter -ExpectedUniqueIds @($TargetId)).Count `
    'an unobserved absent process cannot be detected and is not invented'

# A target is expected even when it is not in the baseline.
Assert-Equal 0 @(Compare-TenantState -Baseline $smallBase -Index $smallAfter `
    -ExpectedUniqueIds @($TargetId, $Ghost) -ObservedUniqueIds @($Ghost)).Count `
    'an observed id that was expected is not reported'

# Reversal must not guess at a state it never recorded.
$noGuess = @(Restore-CollateralState -SiteURL 'https://mock' -Token 't' -Collateral $withGhost)
Assert-Equal 1 $noGuess.Count 'the unbaselined process still produces a result row'
Assert-Equal 'Skipped' $noGuess[0].Status 'it is skipped rather than guessed at'

# ---------------------------------------------------------------------------
Write-Host "`nInput/Output finder matches the full walk" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The blind-spot sweep uses the narrow finder instead of walking every activity
# tree and discarding the result. The two must agree on Input and Output sites.

$acr = Get-Content (Join-Path $root 'Tests/Fixtures/ActionCustomerRequest.json') -Raw | ConvertFrom-Json
$dtTarget = '2e917985-9446-4969-bfad-eef7350532a4'

$viaFull = @(Find-ProcessReferenceSite -ProcessObject $acr -TargetUniqueIds @($dtTarget) |
    Where-Object { $_.Category -eq 'Input' -or $_.Category -eq 'Output' })
$viaNarrow = @(Find-InputOutputReferenceSite -ProcessObject $acr -TargetUniqueIds @($dtTarget))

Assert-Equal $viaFull.Count $viaNarrow.Count 'the narrow finder finds the same number of Input/Output sites'
if ($viaFull.Count -gt 0 -and $viaNarrow.Count -eq $viaFull.Count) {
    $samePaths = $true
    for ($i = 0; $i -lt $viaFull.Count; $i++) {
        if ($viaFull[$i].Path -ne $viaNarrow[$i].Path) { $samePaths = $false }
    }
    Assert-True $samePaths 'the narrow finder reports the same paths as the full walk'
}
Assert-Equal 0 @(Find-InputOutputReferenceSite -ProcessObject $acr -TargetUniqueIds @($dtTarget) |
    Where-Object { $_.Category -eq 'Link' }).Count 'the narrow finder never returns Link sites'
Assert-Equal 0 @(Find-InputOutputReferenceSite -ProcessObject $null -TargetUniqueIds @($dtTarget)).Count `
    'a null process yields no sites rather than throwing'

# ---------------------------------------------------------------------------
Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "  Passed: $script:Pass   Failed: $script:Fail" -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "======================================`n" -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 }
