<#
.SYNOPSIS
    Mode 1 orchestration tests: enumeration, collateral protection, and the
    composition risk between archive and delete, against a mocked tenant.

.DESCRIPTION
    Mode 5 takes its targets from the archive list and Mode 1 fills it, so a
    master archived here without being asked for becomes an ordinary delete
    candidate later. That is the reason Mode 1 needs protection even though
    archiving is by itself reversible, and it is what most of this file tests.

    Run:  pwsh -NoProfile -File Tests/Test-BulkArchive.ps1
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
Write-Host "`nThe server's own words survive a failed call" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# These run FIRST, before Invoke-NpmApi is replaced by the tenant mock below,
# because two of them are about Invoke-NpmApi itself.
#
# $_.Exception.Message on a 400 is "Response status code does not indicate
# success: 400 (Bad Request).", which tells an operator nothing. The reason the
# tenant refused lives in the response body, and PowerShell 7 puts that body in
# $_.ErrorDetails.Message.

function New-MockErrorRecord {
    param([string]$Body, [int]$Status = 400)

    $ex = New-Object System.Exception 'Response status code does not indicate success: 400 (Bad Request).'
    if ($Status -gt 0) {
        $ex | Add-Member -NotePropertyName Response -NotePropertyValue ([PSCustomObject]@{ StatusCode = $Status })
    }
    $record = New-Object System.Management.Automation.ErrorRecord(
        $ex, 'Mock', [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
    if ($null -ne $Body) {
        $record.ErrorDetails = New-Object System.Management.Automation.ErrorDetails($Body)
    }
    return $record
}

$disabledUser = 'The process owner or expert is a disabled user.'
Assert-Equal $disabledUser `
    (Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body "{`"message`":`"$disabledUser`"}")) `
    'a JSON error body yields the human-readable message, not the envelope'
Assert-Equal $disabledUser `
    (Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body "{`"Message`":`"$disabledUser`"}")) `
    'whatever case the field is spelled in'
Assert-Equal 'Link validation failed' `
    (Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body '{"title":"Link validation failed","status":400}')) `
    'and problem-details envelopes are read too'
Assert-Equal 'Bad Request' `
    (Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body '  Bad Request  ')) `
    'a plain-text body survives, trimmed'
Assert-Equal '{"unexpected":1}' `
    (Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body '{"unexpected":1}')) `
    'JSON with no recognised field falls back to the raw string rather than losing it'
Assert-Equal $null (Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body '')) `
    'an empty body is no detail at all, not an empty string'
Assert-Equal $null (Get-NpmErrorDetail -ErrorRecord $null) `
    'and a null error record does not throw'
Assert-Equal '{"broken":' (Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body '{"broken":')) `
    'a body that only looks like JSON falls back to the raw text instead of throwing'

# One HTML error page must not flood the console or a CSV cell.
$long = Get-NpmErrorDetail -ErrorRecord (New-MockErrorRecord -Body ('x' * 4000))
Assert-True ($long.Length -le 520) 'a very long body is truncated'
Assert-True ($long.EndsWith('...')) 'and says it was truncated'

# Invoke-NpmApi itself, with the transport shadowed rather than the wrapper.
function Invoke-RestMethod {
    param([string]$Uri, [string]$Method, $Headers, $Body, $ErrorAction)
    if ($Uri -match 'refuse') { throw (New-MockErrorRecord -Body "{`"message`":`"$disabledUser`"}") }
    return [PSCustomObject]@{ ok = $true }
}

$refused = Invoke-NpmApi -Url 'https://mock/refuse' -Token 't' -Method Post -Body @{ a = 1 } -MaxRetries 0
Assert-Equal $false $refused.Success 'a refused call is not a success'
Assert-Equal 400 $refused.StatusCode 'and carries the status code'
Assert-Equal $disabledUser $refused.Detail 'and the reason the server gave, not the generic status line'
Assert-True ($refused.Error -match 'does not indicate success') 'while Error keeps its old meaning for existing callers'

$fine = Invoke-NpmApi -Url 'https://mock/fine' -Token 't' -Method Get -MaxRetries 0
Assert-Equal $true $fine.Success 'a successful call still succeeds'
Assert-Equal $null $fine.Detail 'and Detail is present and null, so callers can read it unconditionally'

Remove-Item Function:\Invoke-RestMethod

# The mock tenant below replaces Save-ArchiveResults with a stub that captures
# rows. The real one writes the files, so keep a handle on it for the section
# that tests exactly that.
$script:RealSaveArchiveResults = ${function:Save-ArchiveResults}

# ---------------------------------------------------------------------------
# Mock tenant
# ---------------------------------------------------------------------------
# Group 100 "Library" holds three processes and has one subgroup, 110 "History",
# holding two more. Group 200 "Elsewhere" holds a master whose variation lives
# in 100: the composition case.
$P1 = '11111111-0000-0000-0000-000000000001'   # Library, ordinary
$P2 = '11111111-0000-0000-0000-000000000002'   # Library, ordinary
$VAR = '11111111-0000-0000-0000-000000000003'  # Library, 'Advertise Job Position :: Thailand'
$S1 = '11111111-0000-0000-0000-000000000004'   # History (subgroup)
$S2 = '11111111-0000-0000-0000-000000000005'   # History (subgroup)
$MASTER = '22222222-0000-0000-0000-000000000001' # Elsewhere, 'Advertise Job Position'

$script:Names = @{
    $P1 = 'Borrow a book'; $P2 = 'Return a book'
    $VAR = 'Advertise Job Position :: Thailand'
    $S1 = 'Catalogue an accession'; $S2 = 'Retire a record'
    $MASTER = 'Advertise Job Position'
}

# Group 300 holds more processes than one page of the index sweep. The old
# enumeration made a single unpaginated call, so a group this size came back
# truncated and the run reported success for the part it had seen.
$script:Filler = @()
for ($i = 1; $i -le 250; $i++) {
    $fid = 'ffff0000-0000-0000-0000-{0:D12}' -f $i
    $script:Filler += $fid
    $script:Names[$fid] = "Filler $i"
}
$script:AllIds = @($P1,$P2,$VAR,$S1,$S2,$MASTER) + $script:Filler

function Reset-ArchiveTenant {
    $script:Archived = @{}
    $script:GroupOf = @{ $P1 = 100; $P2 = 100; $VAR = 100; $S1 = 110; $S2 = 110; $MASTER = 200 }
    foreach ($fid in $script:Filler) { $script:GroupOf[$fid] = 300 }
    $script:ArchiveCalls = @()
    $script:RestoreCalls = @()
    $script:ArchiveComments = @()
    $script:PageSizes = @()
    $script:PublishCalls = @()
    $script:PublishRevisions = @()
    # Process id -> the reason the tenant gives for refusing it with a 400.
    $script:Refuse = @{}
    # Whether the tenant leaves an accepted archive Pending Archive Approval.
    $script:ApprovalsPending = $false
    $script:Pending = @{}
    $script:PublishFails = $false
    # Process ids the list sweeps stop returning once they have been archived.
    $script:VanishOnArchive = @{}
    $script:Vanished = @{}
    # Archiving a variation drags its master: the coupling rounds 2 to 4 found.
    $script:VariationCoupling = @{ $VAR = $MASTER }
    $script:LastArchiveResults = @()
    foreach ($id in $script:AllIds) { $script:Archived[$id] = $false }
}
Reset-ArchiveTenant

function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)

    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        if ($Url -match 'PageSize=(\d+)') { $script:PageSizes += [int]$Matches[1] }

        $page = 1
        if ($Url -match 'Page=(\d+)') { $page = [int]$Matches[1] }
        $pageSize = 200
        if ($Url -match 'PageSize=(\d+)') { $pageSize = [int]$Matches[1] }

        $all = @()
        foreach ($id in $script:AllIds) {
            # Neither sweep is complete on the real tenant: a process can be
            # returned by neither listing. See API_ARCHITECTURE.md.
            if ($script:Vanished.ContainsKey($id)) { continue }
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $all += [PSCustomObject]@{
                processUniqueId = $id; id = 900; processName = $script:Names[$id]
                groupId = $script:GroupOf[$id]; groupExists = $true
            }
        }
        $items = @($all | Select-Object -Skip (($page - 1) * $pageSize) -First $pageSize)
        return Ok ([PSCustomObject]@{ items = $items; totalItemCount = $all.Count })
    }

    if ($Url -match 'ArchiveProcess') {
        $id = [string]$Body.processUniqueId
        $script:ArchiveCalls += $id
        $script:ArchiveComments += [string]$Body.comment

        # The tenant refuses some processes outright: a linked document that was
        # already deleted, an owner or expert who is a disabled user. The version
        # bump the archive triggers revalidates the process and the refusal
        # surfaces as a 400 with the reason in the body, not in the status line.
        if ($script:Refuse.ContainsKey($id)) {
            return [PSCustomObject]@{ Success=$false; StatusCode=400; Response=$null
                Error='Response status code does not indicate success: 400 (Bad Request).'
                Detail=$script:Refuse[$id] }
        }

        if ($script:ApprovalsPending) {
            # Accepted, but left in Pending Archive Approval until the override.
            $script:Pending[$id] = $true
        } else {
            $script:Archived[$id] = $true
        }
        if ($script:VanishOnArchive.ContainsKey($id)) { $script:Vanished[$id] = $true }

        # The coupling: archiving a variation CAN archive its master too.
        if ($script:VariationCoupling.ContainsKey($id)) {
            $script:Archived[$script:VariationCoupling[$id]] = $true
        }
        return Ok ([PSCustomObject]@{ ok = $true })
    }

    if ($Url -match 'RestoreProcess') {
        $id = [string]$Body.processUniqueId
        $script:RestoreCalls += $id
        $script:Archived[$id] = $false
        $script:GroupOf[$id] = [int]$Body.processGroupId
        return Ok ([PSCustomObject]@{ ok = $true })
    }

    if ($Url -match '/Publish$') {
        $id = ''
        if ($Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)/Publish$') { $id = $Matches[1] }
        $script:PublishCalls += $id
        $script:PublishRevisions += [string]$Body.ProcessRevisionEditId
        if ($script:PublishFails) {
            return [PSCustomObject]@{ Success=$false; StatusCode=500; Response=$null
                Error='Response status code does not indicate success: 500 (Internal Server Error).'
                Detail='The publish could not be completed.' }
        }
        # The override is what makes a pending archive take effect.
        $script:Archived[$id] = $true
        $script:Pending[$id] = $false
        return Ok ([PSCustomObject]@{ actionUrl = '/x' })
    }

    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        # isArchived is the field Set-NpmProcessArchived decides the override on,
        # so the mock has to carry it: the archive call succeeding and the
        # process being archived are two different things on an approvals tenant.
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId = $id; Name = $script:Names[$id]; GroupId = $script:GroupOf[$id]
            GroupUniqueId = 'from-model'; ProcessRevisionEditId = 10133
            isArchived = [bool]$script:Archived[$id]
            StateId = $(if ($script:Archived[$id]) { 2 } else { 1 }) } })
    }

    return Ok $null
}

function Get-ProcessGroups {
    param([string]$SiteURL,[string]$Token)
    return @(
        @{ id = 100; uniqueId = 'g-100'; name = 'Library'; parentId = $null }
        @{ id = 110; uniqueId = 'g-110'; name = 'History'; parentId = 100 }
        @{ id = 200; uniqueId = 'g-200'; name = 'Elsewhere'; parentId = $null }
        @{ id = 300; uniqueId = 'g-300'; name = 'Big'; parentId = $null }
    )
}
function Save-ArchiveResults { param($Results,[string]$Timestamp,[switch]$WhatIf) $script:LastArchiveResults = @($Results) }

# Later scenarios replace Invoke-NpmApi with narrower mocks of their own and do
# not put it back, so keep a handle on the full tenant mock.
$script:PrimaryApi = ${function:Invoke-NpmApi}

# ---------------------------------------------------------------------------
Write-Host "`nEnumerating a group" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The old path made one unpaginated call to the navigation breadcrumb, so a
# group larger than one response was silently partially archived and the run
# reported success for the part it saw.

$groups = @(Get-ProcessGroups -SiteURL 'https://mock' -Token 't')

Assert-Equal 1 @(Get-NpmGroupDescendantId -Groups $groups -RootGroupId 100 -IncludeSubgroups $false).Count `
    'without subgroups a group is just itself'
$withSubs = @(Get-NpmGroupDescendantId -Groups $groups -RootGroupId 100 -IncludeSubgroups $true)
Assert-Equal 2 $withSubs.Count 'with subgroups it is the group and its descendants'
Assert-Equal '100' $withSubs[0] 'the root comes first'
Assert-True ($withSubs -contains '110') 'and the child is included'
Assert-Equal 0 @(Get-NpmGroupDescendantId -Groups $groups -RootGroupId $null).Count `
    'a null group id yields nothing rather than everything'

# A malformed tree must not hang the run before it has archived anything.
$cyclic = @(
    @{ id = 1; uniqueId = 'a'; name = 'A'; parentId = 2 }
    @{ id = 2; uniqueId = 'b'; name = 'B'; parentId = 1 }
)
Assert-Equal 2 @(Get-NpmGroupDescendantId -Groups $cyclic -RootGroupId 1).Count `
    'a cycle in the group tree terminates instead of hanging'

$index = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
Assert-Equal 256 $index.Count 'the index sweep pages past the first response'
Assert-Equal 250 @(Select-NpmProcessInGroup -Index $index -GroupIds @('300')).Count `
    'a group larger than one page is enumerated whole, not truncated at the page boundary'

$inLibrary = @(Select-NpmProcessInGroup -Index $index -GroupIds @('100'))
Assert-Equal 3 $inLibrary.Count 'three processes live directly in the group'
$withChildren = @(Select-NpmProcessInGroup -Index $index -GroupIds $withSubs)
Assert-Equal 5 $withChildren.Count 'and five once the subgroup is included'
Assert-Equal 0 @($withChildren | Where-Object { $_.UniqueId -eq $MASTER }).Count `
    'the master in another group is not swept in by the enumeration'

$script:Archived[$P1] = $true
$freshIndex = Get-NpmProcessIndex -SiteURL 'https://mock' -Token 't'
Assert-Equal 2 @(Select-NpmProcessInGroup -Index $freshIndex -GroupIds @('100')).Count `
    'an already-archived process is not offered for archiving again'
Assert-Equal 3 @(Select-NpmProcessInGroup -Index $freshIndex -GroupIds @('100') -IncludeArchived $true).Count `
    'unless the caller asks for archived ones too'
$script:Archived[$P1] = $false

# ---------------------------------------------------------------------------
Write-Host "`nSet-NpmProcessArchived reports an outcome, not a boolean" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# It returned $true/$false until R10, which destroyed the status code and the
# reason one frame below the code that needed them. A PSCustomObject is always
# truthy, so the danger of the change is a call site still written `if ($ok)`.

Reset-ArchiveTenant
$script:Refuse[$P1] = 'The process owner or expert is a disabled user.'

$refusal = Set-NpmProcessArchived -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P1
Assert-Equal 'Refused' $refusal.Outcome 'a 400 is a refusal by the tenant'
Assert-Equal $false $refusal.Success 'which is not a success'
Assert-Equal 400 $refusal.StatusCode 'the status code survives the call'
Assert-Equal 'The process owner or expert is a disabled user.' $refusal.Detail `
    'and so does the reason, unchanged'
Assert-True ($refusal.Message -match 'disabled user') 'the row message carries the tenant words, not "Archive call failed"'
Assert-Equal $false $script:Archived[$P1] 'and nothing was archived'
Assert-Equal 0 $script:PublishCalls.Count 'a refused archive never reaches the override'

# A 5xx is not a refusal: it is a fault, and it is ours to investigate.
Reset-ArchiveTenant
function Invoke-NpmApi-Saved { }
$script:FaultId = $P2
$savedApi = ${function:Invoke-NpmApi}
function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    if ($Url -match 'ArchiveProcess') {
        return [PSCustomObject]@{ Success=$false; StatusCode=503; Response=$null
            Error='Service Unavailable'; Detail='The service is temporarily unavailable.' }
    }
    return & $savedApi @PSBoundParameters
}
$fault = Set-NpmProcessArchived -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P2
Assert-Equal 'Failed' $fault.Outcome 'a 5xx is Failed, not Refused'
Assert-Equal 503 $fault.StatusCode 'and still carries its status'
${function:Invoke-NpmApi} = $savedApi

# The pending state is DETECTED from isArchived, not declared by a switch.
Reset-ArchiveTenant
$script:ApprovalsPending = $true
$overridden = Set-NpmProcessArchived -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P1
Assert-Equal 'Overridden' $overridden.Outcome 'a pending archive is overridden'
Assert-Equal $true $overridden.Success 'and the process ends up archived'
Assert-Equal $true $overridden.Overridden 'the row can say the override ran'
Assert-Equal 1 $script:PublishCalls.Count 'by exactly one publish'
Assert-Equal '10133' $script:PublishRevisions[0] `
    'with the revision id read back AFTER the archive, sent as a string'
Assert-Equal $true $script:Archived[$P1] 'and the tenant agrees'

# Permission withheld: no publish, and the results file says pending.
Reset-ArchiveTenant
$script:ApprovalsPending = $true
$withheld = Set-NpmProcessArchived -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P1 -ApprovalsEnabled $false
Assert-Equal 'PendingApproval' $withheld.Outcome 'withholding the override leaves the archive pending'
Assert-Equal $false $withheld.Success 'which is not an archived process'
Assert-Equal 0 $script:PublishCalls.Count 'and sends no publish'

# The override can fail, and that is exactly the case the operator needs told.
Reset-ArchiveTenant
$script:ApprovalsPending = $true
$script:PublishFails = $true
$stuckPending = Set-NpmProcessArchived -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P1
Assert-Equal 'PendingApproval' $stuckPending.Outcome 'a failed override leaves the process pending'
Assert-Equal $false $stuckPending.Success 'and is not reported as archived'
Assert-Equal 500 $stuckPending.StatusCode 'the publish status is carried out, not cast to void'
Assert-True ($stuckPending.Message -match 'override failed') 'and the message says which half failed'

# No approvals on this tenant: nothing is pending, so nothing is published.
Reset-ArchiveTenant
$plain = Set-NpmProcessArchived -SiteURL 'https://mock' -Token 't' -ProcessUniqueId $P1
Assert-Equal 'Archived' $plain.Outcome 'a process that archives outright is just Archived'
Assert-Equal $true $plain.Success 'and succeeds'
Assert-Equal $false $plain.Overridden 'without an override'
Assert-Equal 0 $script:PublishCalls.Count `
    'no publish is sent when isArchived already says the archive took effect'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a clean group archives, and nothing else moves" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

Reset-ArchiveTenant
$work = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work -Force | Out-Null
Push-Location $work
try {
    # Group 110 holds no variations.
    Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Group' `
        -GroupID 110 -ChangeDescription 'Bulk Cleanup.' -Force

    Assert-Equal 2 $script:ArchiveCalls.Count 'both processes in the subgroup are archived'
    Assert-True ($script:Archived[$S1] -and $script:Archived[$S2]) 'and both are archived afterwards'
    Assert-Equal $false $script:Archived[$P1] 'a process in the parent group is untouched'

    Assert-Equal 1 @($script:ArchiveComments | Select-Object -Unique).Count 'one change description for the run'
    Assert-Equal 'Bulk Cleanup.' $script:ArchiveComments[0] 'and it is the one that was asked for'

    $rows = @($script:LastArchiveResults)
    Assert-Equal 2 @($rows | Where-Object { $_.Operation -eq 'Archive' -and $_.Status -eq 'Success' }).Count `
        'both are reported archived'
    Assert-Equal 0 @($rows | Where-Object { $_.Status -eq 'Failed' }).Count 'and nothing failed'
    Assert-Equal 0 @($rows | Where-Object { $_.Operation -eq 'ReverseCollateral' }).Count `
        'with no collateral to reverse'
}
finally { Pop-Location; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the composition risk, caught before it starts" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# Archiving group 100 archives a variation, which drags a master out of group
# 200. That master would then be an ordinary member of the archive list, which
# is where Mode 5 takes its targets from.

Reset-ArchiveTenant
$work2 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work2 -Force | Out-Null
Push-Location $work2
try {
    $out = (Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Group' `
        -GroupID 100 -ChangeDescription 'Bulk Cleanup.' -Force) 6>&1 | Out-String

    Assert-True ($out -match 'Advertise Job Position') 'the master is named before anything is archived'
    Assert-True ($out -match 'archive list') 'and the run says why that matters for a later delete'
    Assert-Equal 0 $script:ArchiveCalls.Count '-Force does not proceed past the variation warning'
    Assert-Equal $false $script:Archived[$MASTER] 'so the master is never archived'
    Assert-Equal $false $script:Archived[$P1] 'and neither is anything else'

    $rows = @($script:LastArchiveResults)
    Assert-Equal 1 @($rows | Where-Object { $_.Operation -eq 'VariationWarning' }).Count `
        'the master is named in the results file too'
    Assert-Equal $MASTER @($rows | Where-Object { $_.Operation -eq 'VariationWarning' })[0].ObjectID `
        'by id'
}
finally { Pop-Location; Remove-Item $work2 -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a master dragged into the archive is put back" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The pre-flight is a name heuristic and its blind spot is measured: a master
# that has been renamed cannot be matched. Then the checkpoint is what is left.

Reset-ArchiveTenant
$script:Names[$MASTER] = 'Recruitment advertising (renamed)'   # the heuristic can no longer match

$work3 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work3 -Force | Out-Null
Push-Location $work3
try {
    Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Group' `
        -GroupID 100 -ChangeDescription 'Bulk Cleanup.' -Force

    Assert-Equal 3 $script:ArchiveCalls.Count 'the run proceeds, because the heuristic had nothing to match'
    Assert-True ($script:ArchiveCalls -notcontains $MASTER) 'the master was never a target'

    $rows = @($script:LastArchiveResults)
    $reversal = @($rows | Where-Object { $_.ObjectID -eq $MASTER -and $_.Operation -eq 'ReverseCollateral' })
    Assert-Equal 1 $reversal.Count 'the checkpoint catches the master the pre-flight missed'
    Assert-Equal 'Success' $reversal[0].Status 'and puts it back'
    Assert-Equal $false $script:Archived[$MASTER] 'so it does not reach the archive list'
    Assert-Equal 200 $script:GroupOf[$MASTER] 'and goes back to its own group, not the one being archived'
    Assert-True ($script:RestoreCalls -contains $MASTER) 'by an actual restore, not by assertion'

    Assert-True ($script:Archived[$P1] -and $script:Archived[$P2] -and $script:Archived[$VAR]) `
        'while the three real targets stay archived'
}
finally { Pop-Location; Remove-Item $work3 -Recurse -Force -ErrorAction SilentlyContinue }
$script:Names[$MASTER] = 'Advertise Job Position'

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the preview changes nothing" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

Reset-ArchiveTenant
$work4 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work4 -Force | Out-Null
Push-Location $work4
try {
    Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Group' `
        -GroupID 110 -ChangeDescription 'Bulk Cleanup.' -WhatIf

    Assert-Equal 0 $script:ArchiveCalls.Count 'a preview archives nothing'
    $rows = @($script:LastArchiveResults)
    Assert-Equal 2 @($rows | Where-Object { $_.Status -eq 'Preview' }).Count 'and names what it would archive'
}
finally { Pop-Location; Remove-Item $work4 -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
Write-Host "`nScenario: the archive call lies" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# Measured on the delete path: ArchiveProcess reports failure and takes effect.
# The inverse matters here, so verification reads the tenant, not the response.

Reset-ArchiveTenant
$script:StubbornId = $S2
function Invoke-NpmApi {
    param([string]$Url,[string]$Token,[string]$Method='Get',$Body=$null,[int]$MaxRetries=0)
    function Ok($r) { return [PSCustomObject]@{ Success=$true; StatusCode=200; Response=$r; Error=$null } }

    if ($Url -match 'ListType=(\d+)') {
        $wantArchived = ([int]$Matches[1] -eq 7)
        $page = 1
        if ($Url -match 'Page=(\d+)') { $page = [int]$Matches[1] }
        $pageSize = 200
        if ($Url -match 'PageSize=(\d+)') { $pageSize = [int]$Matches[1] }
        $all = @()
        foreach ($id in $script:AllIds) {
            if ($script:Archived[$id] -ne $wantArchived) { continue }
            $all += [PSCustomObject]@{ processUniqueId = $id; id = 900; processName = $script:Names[$id]
                groupId = $script:GroupOf[$id]; groupExists = $true }
        }
        $items = @($all | Select-Object -Skip (($page - 1) * $pageSize) -First $pageSize)
        return Ok ([PSCustomObject]@{ items = $items; totalItemCount = $all.Count })
    }
    if ($Url -match 'ArchiveProcess') {
        $id = [string]$Body.processUniqueId
        $script:ArchiveCalls += $id
        # Says yes, does nothing.
        if ($id -ne $script:StubbornId) { $script:Archived[$id] = $true }
        return Ok ([PSCustomObject]@{ ok = $true })
    }
    if ($Url -match '/Publish$') { return Ok ([PSCustomObject]@{ actionUrl = '/x' }) }
    if ($Method -eq 'Get' -and $Url -match '/Api/v1/Processes/([0-9a-fA-F\-]+)$') {
        $id = $Matches[1]
        return Ok ([PSCustomObject]@{ processJson = [PSCustomObject]@{
            UniqueId = $id; Name = $script:Names[$id]; GroupId = $script:GroupOf[$id]
            ProcessRevisionEditId = 10133; isArchived = [bool]$script:Archived[$id] } })
    }
    return Ok $null
}

$work5 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work5 -Force | Out-Null
Push-Location $work5
try {
    Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Group' `
        -GroupID 110 -ChangeDescription 'Bulk Cleanup.' -Force

    $rows = @($script:LastArchiveResults)
    $stubborn = @($rows | Where-Object { $_.ObjectID -eq $script:StubbornId })[0]
    Assert-Equal 'Failed' $stubborn.Status 'a process the API claimed to archive but did not is reported failed'
    Assert-True ($stubborn.Message -match 'still active') 'with the tenant state, not the API response'
    Assert-Equal 'Success' (@($rows | Where-Object { $_.ObjectID -eq $S1 })[0].Status) `
        'while the one that really was archived is reported as such'
}
finally { Pop-Location; Remove-Item $work5 -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
Write-Host "`nScenario: a refusal does not stop the batch" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# JB's instruction for this round, end to end. A tenant where a fifth of a group
# has a stale document link must still archive the other four fifths in one run.

${function:Invoke-NpmApi} = $script:PrimaryApi
Reset-ArchiveTenant
$F1 = $script:Filler[0]
$script:Refuse[$S2] = 'One or more linked documents could not be validated.'

$work6 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work6 -Force | Out-Null
Push-Location $work6
try {
    $csvPath = Join-Path $work6 'targets.csv'
    "ProcessUniqueId`n$S1`n$S2`n$F1" | Set-Content -Path $csvPath

    $out = (Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'CSV' `
        -CsvPath $csvPath -ChangeDescription 'Bulk Cleanup.' -Force) 6>&1 | Out-String

    Assert-Equal 3 $script:ArchiveCalls.Count 'every target is attempted, the refused one included'
    Assert-True ($script:ArchiveCalls -contains $F1) 'including the one AFTER the refusal'

    $rows = @($script:LastArchiveResults | Where-Object { $_.Operation -eq 'Archive' })
    Assert-Equal 1 @($rows | Where-Object { $_.Status -eq 'Blocked' }).Count 'one row is Blocked'
    Assert-Equal 2 @($rows | Where-Object { $_.Status -eq 'Success' }).Count 'and the other two are archived'
    Assert-Equal 0 @($rows | Where-Object { $_.Status -eq 'Failed' }).Count `
        'a tenant refusal is not Failed; Failed still means something may be our fault'

    $blocked = @($rows | Where-Object { $_.Status -eq 'Blocked' })[0]
    Assert-Equal $S2 $blocked.ObjectID 'the blocked row is the refused process'
    Assert-Equal 'Retire a record' $blocked.Name 'named, never by its id'
    Assert-True ($blocked.Message -match 'linked documents') 'with the tenant own words in the row'
    Assert-True ($blocked.Message -match '400') 'and the status it refused with'
    Assert-Equal '400' $blocked.StatusCode 'carried in its own column for the review list'
    Assert-Equal '110' ([string]$blocked.GroupId) 'alongside the group an administrator has to look in'

    Assert-True ($script:Archived[$S1] -and $script:Archived[$F1]) 'the other two really are archived'
    Assert-Equal $false $script:Archived[$S2] 'and the refused one is not'

    # The loop names each refusal as it happens; the end-of-run block and its
    # companion file are Save-ArchiveResults' job and are tested against the
    # real one below, because this scenario runs against the capturing stub.
    Assert-True ($out -match 'BLOCKED') 'the run says so as it happens rather than only at the end'
    Assert-True ($out -match 'Retire a record') 'naming the process'
    Assert-True ($out -match 'linked documents') 'and giving the reason the tenant gave'
}
finally { Pop-Location; Remove-Item $work6 -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
Write-Host "`nScenario: archived, but in neither listing" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# The verification pass had two different mismatches and called both Failed.
# Still active is a real failure. In neither listing is the listing being
# incomplete, which this tenant does routinely, and sending an operator after a
# process that is almost certainly archived is a worse answer than saying so.

${function:Invoke-NpmApi} = $script:PrimaryApi
Reset-ArchiveTenant
$script:VanishOnArchive[$S2] = $true

$work8 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work8 -Force | Out-Null
Push-Location $work8
try {
    Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Group' `
        -GroupID 110 -ChangeDescription 'Bulk Cleanup.' -Force

    $rows = @($script:LastArchiveResults | Where-Object { $_.Operation -eq 'Archive' })
    $ghost = @($rows | Where-Object { $_.ObjectID -eq $S2 })[0]
    Assert-Equal 'Unverified' $ghost.Status 'a process neither listing returns is Unverified, not Failed'
    Assert-True ($ghost.Message -match 'could not be confirmed') 'and the row says the state could not be confirmed'
    Assert-Equal 'Retire a record' $ghost.Name 'while still carrying its name'
    Assert-Equal 'Success' (@($rows | Where-Object { $_.ObjectID -eq $S1 })[0].Status) `
        'and the process the listing does return is confirmed as usual'
    Assert-Equal 0 @($rows | Where-Object { $_.Status -eq 'Failed' }).Count `
        'nothing is reported as a failure'
}
finally { Pop-Location; Remove-Item $work8 -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
Write-Host "`nThe results file, its summary, and the manual review companion" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# Save-ArchiveResults iterated a hard-coded status list, so a status missing from
# it was written to the CSV and counted nowhere.

$saveStub = ${function:Save-ArchiveResults}
${function:Save-ArchiveResults} = $script:RealSaveArchiveResults

$work7 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work7 -Force | Out-Null
Push-Location $work7
try {
    $mixed = @(
        New-ProcessResultRow -UniqueId $P1 -Name 'Borrow a book' -Operation 'Archive' -Status 'Success' -Message 'Archived'
        New-ProcessResultRow -UniqueId $P2 -Name 'Return a book' -Operation 'Archive' -Status 'Overridden' -Message 'Archived after the pending-approval override'
        New-ProcessResultRow -UniqueId $S1 -Name 'Catalogue an accession' -Operation 'Archive' -Status 'Pending' -Message 'Archive is pending approval'
        New-ProcessResultRow -UniqueId $S2 -Name 'Retire a record' -Operation 'Archive' -Status 'Unverified' -Message 'Neither listing returns it'
        New-ProcessResultRow -UniqueId $VAR -Name 'Advertise Job Position :: Thailand' -Operation 'Archive' `
            -Status 'Blocked' -GroupId 100 -StatusCode 400 `
            -Message 'HTTP 400 refused by the tenant: The process owner or expert is a disabled user.'
    )

    $summary = (Save-ArchiveResults -Results $mixed -Timestamp 'R10TEST') 6>&1 | Out-String

    foreach ($status in @('Success', 'Overridden', 'Pending', 'Unverified', 'Blocked')) {
        Assert-True ($summary -match "$status\s*: 1") "the summary counts $status"
    }

    Assert-True (Test-Path 'Archive_Results_R10TEST.csv') 'the results file is written'
    $written = @(Import-Csv 'Archive_Results_R10TEST.csv')
    Assert-Equal 5 $written.Count 'with every row'
    Assert-True (($written[0].PSObject.Properties.Name) -contains 'StatusCode') `
        'and the columns the review list is built from'

    Assert-True (Test-Path 'Archive_ManualReview_R10TEST.csv') 'the manual review companion is written'
    $review = @(Import-Csv 'Archive_ManualReview_R10TEST.csv')
    Assert-Equal 1 $review.Count 'holding only the blocked rows'
    Assert-Equal $VAR $review[0].ObjectID 'by id'
    Assert-Equal 'Advertise Job Position :: Thailand' $review[0].Name 'by name'
    Assert-Equal '100' $review[0].GroupId 'with the group to look in'
    Assert-Equal '400' $review[0].StatusCode 'the status the tenant refused with'
    Assert-True ($review[0].Reason -match 'disabled user') 'and the reason it gave'
    Assert-Equal 'ObjectID,Name,GroupId,StatusCode,Reason' `
        (($review[0].PSObject.Properties.Name) -join ',') 'in the agreed columns, in the agreed order'

    # No refusals, no companion file: an empty list is worse than no list.
    $clean = @(New-ProcessResultRow -UniqueId $P1 -Name 'Borrow a book' -Operation 'Archive' -Status 'Success' -Message 'Archived')
    $cleanOut = (Save-ArchiveResults -Results $clean -Timestamp 'R10CLEAN') 6>&1 | Out-String
    Assert-Equal $false (Test-Path 'Archive_ManualReview_R10CLEAN.csv') `
        'no manual review file is written when nothing was refused'
    Assert-True ($cleanOut -notmatch 'NEEDS MANUAL REVIEW') 'and no block is printed'

    # Rows built by hand elsewhere in the run must not truncate the CSV header.
    $handBuilt = @(
        [PSCustomObject]@{ ObjectType='Process'; ObjectID=$P1; Name='Borrow a book'
                           Operation='ReverseCollateral'; Status='Success'; Message='Restored' }
        New-ProcessResultRow -UniqueId $VAR -Name 'Advertise Job Position :: Thailand' -Operation 'Archive' `
            -Status 'Blocked' -GroupId 100 -StatusCode 400 -Message 'HTTP 400 refused by the tenant: nope'
    )
    [void](Save-ArchiveResults -Results $handBuilt -Timestamp 'R10MIX' 6>&1)
    $mixedReview = @(Import-Csv 'Archive_ManualReview_R10MIX.csv')
    Assert-Equal '400' $mixedReview[0].StatusCode `
        'a hand-built first row does not strip the columns off the rows after it'
}
finally { Pop-Location; Remove-Item $work7 -Recurse -Force -ErrorAction SilentlyContinue }

${function:Save-ArchiveResults} = $saveStub

# ---------------------------------------------------------------------------
Write-Host "`nEvery results row carries a name, never its own id" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

$idOnly = @($script:LastArchiveResults | Where-Object { $_.Name -eq $_.ObjectID })
Assert-Equal 0 $idOnly.Count 'no archive results row has its id in the Name column'

# The R8 defect, re-checked against every status this round added. A Blocked row
# is handed to a tenant administrator, so a bare GUID there is worse than most.
${function:Invoke-NpmApi} = $script:PrimaryApi
Reset-ArchiveTenant
$script:Refuse[$S1] = 'The process owner or expert is a disabled user.'
$script:VanishOnArchive[$S2] = $true
$work9 = Join-Path ([System.IO.Path]::GetTempPath()) "bulkarchive-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work9 -Force | Out-Null
Push-Location $work9
try {
    Invoke-BulkArchiveProcesses -SiteURL 'https://mock' -Token 't' -SourceType 'Group' `
        -GroupID 110 -ChangeDescription 'Bulk Cleanup.' -Force
    $mixedRows = @($script:LastArchiveResults)
    Assert-True ($mixedRows.Count -gt 0) 'the mixed run produced rows'
    Assert-Equal 0 @($mixedRows | Where-Object { $_.Name -eq $_.ObjectID }).Count `
        'no Blocked or Unverified row has its id in the Name column either'
    Assert-Equal 1 @($mixedRows | Where-Object { $_.Status -eq 'Blocked' }).Count 'one refusal'
    Assert-Equal 1 @($mixedRows | Where-Object { $_.Status -eq 'Unverified' }).Count 'one unconfirmed'
}
finally { Pop-Location; Remove-Item $work9 -Recurse -Force -ErrorAction SilentlyContinue }

$marker = Get-NpmUnknownProcessName
$ghost = 'ffffffff-0000-0000-0000-00000000000f'
$row = New-ProcessResultRow -UniqueId $ghost -Operation 'Archive' -Status 'Failed' -Message 'x'
Assert-Equal $marker $row.Name 'a row for a process nothing can name says so'
Assert-True ($row.Name -ne $row.ObjectID) 'and still never repeats the id'
$named = New-ProcessResultRow -UniqueId $ghost -Name 'Real Name' -Operation 'Archive' -Status 'Success' -Message 'x'
Assert-Equal 'Real Name' $named.Name 'a row with a name keeps it'

# ---------------------------------------------------------------------------
Write-Host "`nThe mode surface" -ForegroundColor Cyan
# ---------------------------------------------------------------------------

Assert-True (Test-ModeEnabled -Mode '1') 'archive is offered'
Assert-True (Test-ModeEnabled -Mode '5') 'delete is offered'
foreach ($parked in @('2','3','4')) {
    Assert-Equal $false (Test-ModeEnabled -Mode $parked) "mode $parked is parked"
}
$menu = (Show-MainMenu) 6>&1 | Out-String
foreach ($gone in @('[2]','[3]','[4]')) {
    Assert-True ($menu -notmatch [regex]::Escape($gone)) "the menu has no selectable $gone"
}
Assert-True ($menu -match 'Bulk Archive Processes') 'the menu offers archive'
Assert-True ($menu -match 'parked in this build') 'and says the rest are parked rather than leaving a gap'

$parkedMsg = (Show-ParkedModeMessage -Mode '4') 6>&1 | Out-String
Assert-True ($parkedMsg -match 'Update-ProcessOwnership.ps1') `
    'and points ownership changes at the script that does it correctly'

Assert-Equal 'Processes' (Get-ObjectType -Mode 1) 'Mode 1 no longer offers documents'

# ---------------------------------------------------------------------------
Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "  Passed: $script:Pass   Failed: $script:Fail" -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "======================================`n" -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 }
