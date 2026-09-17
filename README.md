# Nintex Process Manager Bulk Operations

**Version 4.5.** The version is defined once, in `$script:ScriptVersion` at the top of
`Nintex-BulkOperations.ps1`, and printed at startup.

A PowerShell script for bulk operations on Nintex Process Manager (Promapp) processes
and documents.

> **Status.** Modes 1, 2 and 5 are in use. Modes 3 and 4 have known defects; see
> [Limitations](#limitations). Nintex Process Manager itself is a legacy product, but
> this tooling is maintained and Mode 5 has been exercised against a live tenant.

## Features

This script supports five distinct operation modes:

1. **Bulk Archive** - Archive processes/documents from CSV or group selection
2. **Bulk Restore** - Restore archived items to a specified group
3. **Bulk Update Location** - Move processes/documents to different groups
4. **Bulk Update Ownership** - Update process owners and experts
5. **Bulk Delete Processes** - Safely delete processes with reference detection and removal

### Key Features

- **Interactive Group Picker**: Browse and select groups from a hierarchical tree view
- **Flexible ID Support**: Use numeric Group IDs or GUIDs from URLs
- **CSV Flexibility**: Accepts various column naming conventions
- **Comprehensive Error Handling**: Detailed logging and results tracking
- **Safety Features**: Multiple confirmations for destructive operations

## Requirements

- PowerShell 5.1 or later
- Nintex Process Manager (Promapp) account with appropriate permissions
- Internet connectivity to access your Nintex PM site

## Setup

### 1. Download the Script

Clone or download this repository to your local machine.

### 2. Fix Windows Security Warning (Recommended)

When you download and run the PowerShell script for the first time, Windows may display a security warning showing "Unknown Publisher". This happens because the script is not digitally signed.

**You have three options to fix this:**

#### Option A: Unblock the Script (Quickest)

The simplest solution is to unblock the downloaded file:

```powershell
# Right-click the script in Windows Explorer
# Select "Properties" > Check "Unblock" > Click "OK"

# OR use the provided helper:
# Double-click Unblock-Script.bat
# OR run in PowerShell: .\Unblock-Script.ps1
```

#### Option B: Self-Sign the Script (Recommended for Regular Use)

Create a self-signed certificate and sign the script. This provides a trusted publisher on your machine:

```powershell
# Right-click Sign-Script.bat and select "Run as Administrator"
# OR run PowerShell as Administrator, then: .\Sign-Script.ps1
```

This will:
1. Create a self-signed code signing certificate
2. Install it to your Trusted Root Certification Authorities
3. Sign the Nintex-BulkOperations.ps1 script

After signing, the script will show your certificate as the publisher instead of "Unknown Publisher".

#### Option C: Adjust Execution Policy (Alternative)

Modify PowerShell's execution policy to allow local scripts:

```powershell
# Run PowerShell as Administrator, then:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

This allows locally created scripts to run without warnings while still requiring downloaded scripts to be signed.

**Security Note:** All these methods are safe when you trust the source of the script. Review the script contents before running if you have any concerns.

### 3. Create Configuration File

Copy `config.template.txt` to `config.txt` and fill in your details:

```powershell
Copy-Item config.template.txt config.txt
```

```
SiteURL=https://yourcompany.promapp.com
Username=your.email@company.com
Password=YourPasswordHere
DefaultRestoreGroupID=123
TempGroupName=Bulk Delete Temporary Group
```

For a tenant whose URL carries a tenant segment, include it:
`SiteURL=https://demo.promapp.com/93555a16ceb24f139a6e8a40618d3f8b`

**Credentials.** `config.txt` is listed in `.gitignore` and is not tracked in this
repository. `.gitignore` has no effect on a file that is already tracked or that
someone stages with `git add -f`, so there is also a hook that refuses such a commit
outright. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

If you are updating an existing clone that had a tracked `config.txt`, git may remove
your local copy when you pull. Back it up first.

### 4. Prepare CSV Files (if needed)

Depending on your operation, you may need CSV files with specific columns. See the Examples folder for templates.

## Usage

### Running the Script

Open PowerShell and navigate to the script directory:

```powershell
cd path\to\Nintex-Process-Manager-Bulk-Operations
.\Nintex-BulkOperations.ps1
```

The script will:
1. Load your configuration from `config.txt`
2. Authenticate to your Nintex PM site
3. Present a menu of operation modes
4. Guide you through the selected operation

### Running It Non-Interactively

Supplying `-Mode` skips the menu and runs that one mode from the parameters given.
This is what makes the script scriptable and schedulable; the menu path is unchanged.

```powershell
# Dry-run a delete over the whole archive
.\Nintex-BulkOperations.ps1 -Mode 5 -Source Archived -WhatIf

# Delete the processes named in a CSV, unattended
.\Nintex-BulkOperations.ps1 -Mode 5 -Source CSV -CsvPath .\targets.csv -Force

# Archive a group and everything under it
.\Nintex-BulkOperations.ps1 -Mode 1 -Source Group -GroupId 655 -IncludeSubgroups -Force
```

| Parameter | Meaning |
|---|---|
| `-Mode` | `1` Archive, `2` Restore, `3` Update Location, `4` Update Ownership, `5` Delete |
| `-Source` | `CSV`, `Group`, `Archived`, `ArchivedDocuments` |
| `-CsvPath` | CSV file, for `-Source CSV` |
| `-GroupId` | Numeric group id, for `-Source Group` |
| `-ObjectType` | `Process`, `Document` or `Both`; defaults to `Process` |
| `-RestoreGroupId` | Target group for Mode 2 (parked) |
| `-ConfigPath` | Alternative config file; defaults to `config.txt` |
| `-WhatIf` | Preview. Nothing is changed. |
| `-Force` | Answer the confirmation prompts and run unattended |
| `-ApprovalsEnabled` | Declare that process approvals are on in this tenant |
| `-ThoroughScan` | Mode 5: read every active process for Input/Output references |
| `-IncludeSubgroups` | Include subgroups for `-Source Group` |
| `-AllowUnheldTargets` | Mode 5, dangerous: delete a target that could not be restored out of the archive, and whose references were therefore never checked |

`-Force` does **not** wave through a Mode 5 reconciliation mismatch, a failed
verification, an unresolved participant, a collateral change, or a variation
pre-flight warning. Those still stop the
run, because they mean the plan does not match the tenant, and that is precisely when
nobody should be deleting anything unattended.

Exit codes: `0` success, `1` the mode failed, `2` bad configuration, `3` authentication
failed.

### Dot-Sourcing

Dot-sourcing loads the functions and runs nothing, which is how the test suite uses it:

```powershell
. .\Nintex-BulkOperations.ps1
```

### Group Selection

When operations require selecting a process group, the script offers two options:

#### Option 1: Interactive Group Tree Picker

The script fetches all process groups and displays them in a hierarchical tree structure. Simply enter the number next to your desired group.

**Example:**
```
Select Process Group
======================================
[1] Select from group tree
[2] Enter Group ID manually
======================================
Choose an option (1-2): 1

Available Process Groups:
======================================
[1] Corporate (ID: a1b2c3d4-...)
  [2] Finance
    [3] Accounts Payable
    [4] Accounts Receivable
  [5] Human Resources
[6] Operations
  [7] Manufacturing
  [8] Quality Control
======================================

Enter the number of the group you want to select: 3
Selected: Accounts Payable
```

#### Option 2: Manual Group ID Entry

If you prefer to enter the Group ID directly, you can:

- **Numeric ID**: Enter the number from the URL (e.g., `123` from `.../ProcessGroup/View/123`)
- **GUID**: Enter the full GUID from the URL (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)

The script automatically detects the format and resolves GUIDs to the internal numeric ID.

**Example:**
```
Choose an option (1-2): 2

Enter Process Group ID
Examples:
  - Numeric ID: .../ProcessGroup/View/123 - enter: 123
  - GUID: .../ProcessGroup/View/a1b2c3d4-... - enter: a1b2c3d4-e5f6-7890-abcd-ef1234567890

Group ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Resolving GUID to numeric ID...
Found group: Accounts Payable
```

### Operation Modes

#### Mode 1: Bulk Archive Processes

Archives every active process in a group, or a CSV's worth of processes, with the
same collateral protection the delete path has.

**Options:**
- Source: CSV file or Process Group
- Include Subgroups: Yes/No (for group-based operations)

**CSV Format:**
- Required column: `ProcessID` (or `ProcessId`, `Process ID`, `Id`)

**What it does, in order:**

1. **Enumerates from the index**, which pages at 200, rather than from the
   navigation breadcrumb endpoint, which was fetched once with no paging. It
   reports the count as "N active process(es) in `<group>` and its M subgroup(s)"
   so you can check it against the UI before anything happens.
2. **Warns about variations whose master is not in the target set**, and refuses
   to proceed under `-Force`. See below for why this matters more here than
   anywhere else.
3. **Archives** through the engine's hardened path: one call per process with
   retry and backoff, using the change description from `config.txt`.
4. **Verifies against one re-read of the tenant**, not against what each API call
   said. A process the archive call claimed and the tenant disagrees about is
   reported failed.
5. **Checks for collateral** and reverses what it finds, restoring anything it
   archived without being asked to back into the group the baseline recorded.

**Why archive needs protection even though it is reversible**

Mode 5 takes its targets from the archive list. Mode 1 fills the archive list.
Archiving a variation also archives its master, which may live in a group nobody
named, and once archived that master is an ordinary member of the archive list.
So an unprotected archive of one group can put a master from another group in
front of a delete run, with every step looking correct in isolation.

Mode 5's own protection cannot catch this, because by then the master is a
legitimate archive entry. The guard has to be in Mode 1, which is why it is.

Mode 1 reports and reverses rather than stopping the way Mode 5 does. Archiving
is undoable and the reversal is well defined, and refusing halfway would leave a
partly archived group, which is worse than finishing and putting back what was
not asked for.

#### Parked functionality

This build covers **bulk archive (Mode 1)** and **bulk delete (Mode 5)** only.
The following are parked: removed from the menu and refused by `-Mode`, with
their code left in place.

| Parked | Why |
|---|---|
| Mode 2, Bulk Restore | Reads `isArchived` / `name` off the unwrapped response, so its preview and verification cannot be trusted |
| Mode 3, Bulk Update Location | Sends the process wrapper instead of the required `ProcessJson` string, and never publishes |
| Mode 4, Bulk Update Ownership | Same defect as Mode 3. Use `Update-ProcessOwnership.ps1`, which implements the correct pattern |
| All document operations | Partially implemented, including the document branches inside Modes 1 and 5. Mode 1's document path announced at runtime that it "may not be supported in all Nintex PM versions" |

Parked rather than deleted, deliberately. Mode 4 is meant to adopt the
`Update-ProcessOwnership.ps1` pattern when it returns, and the document branches
are the only document code there is. Passing a parked mode to `-Mode` prints what
it is and why, rather than crashing or silently doing nothing.

#### Mode 5: Bulk Delete Processes

**WARNING: This is a DESTRUCTIVE operation that permanently deletes processes.**

Delegates all dependency work to `NintexProcessDependencies.ps1`. The phase order
is dictated by measured API behaviour, not preference:

1. **Gather** - resolve CSV, group or archived sources to process UniqueIds
2. **Hold** - restore archived *targets*, so references held against them stop being
   suppressed from the dependency check
3. **Plan** - discover claims, restore archived holders *in place*, re-run discovery
   until the claim set is stable, scan for the API's blind spot, locate every site by
   walking JSON, reconcile, and write the plan to disk
4. **Remove** - one fetch, one save, one publish per *holding* process, carrying every
   target at once
5. **Verify** - re-walk each holder while everything is still **active**, because
   archiving suppresses the very rows that would reveal a miss
6. **Delete** - archive then delete the targets
7. **Restore** - re-archive whatever the run restored, to its **original** group
8. **Cleanup** - remove the holding group, optionally the source group folders

The plan file (`Delete_Plan_<timestamp>.json`) is the crash-safety net. It is written
before the first mutation and updated after each re-archive, so an interrupted run can
be finished from it rather than leaving processes stranded in the wrong state.

**Reconciliation mismatches and verification failures both stop and ask** before
anything irreversible happens.

**On the thorough scan.** The run offers to read every active process looking for Input
and Output references. It is slow (one call per process) but it is the only way to be
certain none are missed while the open question in API_ARCHITECTURE.md is unsettled.
Declining it risks leaving a dangling input on a surviving process.

**CSV Format:**
- Required column: `ProcessID`

**Safety Features:**
- Multiple confirmation prompts
- Reference detection across all processes
- Staged execution with checkpoints
- Detailed logging

**Example:**
```
Select Mode: 5
Select Source: 1 (CSV)
Execution Mode: 1 (Execute)
Enter CSV file path: processes-to-delete.csv
Are process approvals enabled in your environment? (Y/N): N
Run the thorough scan? (Y/N): N
Type 'DELETE' to confirm you want to proceed: DELETE
[Gather, snapshot, hold, plan...]
[N reconciliation mismatch(es) above.]  Continue anyway? (Y/N): Y
[Remove references, verify...]
Type 'DELETE' to confirm: DELETE
```

The holding group is created by the script. There is no prompt for a temporary group
id; earlier versions asked for one and the README described that flow for longer than
the code did.

## Output

All operations generate timestamped CSV files with results:

- `Archive_Results_YYYYMMDD_HHMMSS.csv`
- `Restore_Results_YYYYMMDD_HHMMSS.csv`
- `UpdateLocation_Results_YYYYMMDD_HHMMSS.csv`
- `UpdateOwnership_Results_YYYYMMDD_HHMMSS.csv`
- `Delete_Results_YYYYMMDD_HHMMSS.csv`

Each results file contains:
- Object Type (Process/Document)
- Object ID
- Operation performed
- Status (Success/Failed/Skipped)
- Message with details
- Action URL (where applicable)

## CSV Column Name Flexibility

The script accepts various column naming conventions:

**For IDs:**
- `ProcessID`, `ProcessId`, `Process ID`, `ProcessUniqueId`, `Id`, `ID`
- `DocumentID`, `DocumentId` (for documents)

**For Group IDs:**
- `NewGroupID`, `NewGroupId`, `TargetGroupID`, `TargetGroupId`, `GroupID`, `GroupId`

**For Ownership:**
- `NewOwner`, `Owner`, `OwnerUsername`, `ProcessOwner`
- `NewExpert`, `Expert`, `ExpertUsername`, `ProcessExpert`

## Troubleshooting

### Windows Security Warning ("Unknown Publisher")

If you see a security warning when trying to run the script:

**Quick Fix:**
- Right-click the script file, select Properties, check "Unblock", and click OK
- OR double-click `Unblock-Script.bat`

**Permanent Fix:**
- Right-click `Sign-Script.bat` and select "Run as Administrator"
- See the "Fix Windows Security Warning" section in Setup for detailed instructions

### Authentication Fails

- Verify your SiteURL, Username, and Password in `config.txt`
- Ensure there are no extra spaces or special characters
- Check that your account has not been locked

### CSV Not Found

- Use absolute paths: `C:\Users\YourName\Documents\file.csv`
- Or relative paths from the script directory: `.\data\file.csv`
- Ensure the file exists and has the correct extension

### Operations Fail

- Check that you have appropriate permissions in Nintex PM
- Verify IDs are correct (Process IDs, Group IDs)
- Review the results CSV for specific error messages
- Some operations may require processes to be in specific states (published, archived, etc.)

### Document Operations Not Working

Document-related features may vary by Nintex PM version. The script includes placeholder implementations that may need adjustment based on your specific API endpoints.

## Best Practices

1. **Test First** - Start with a small CSV of test items before bulk operations
2. **Backup** - Consider exporting processes before bulk delete operations
3. **Review Results** - Always check the results CSV files after operations
4. **Security** - Never commit `config.txt` to version control
5. **Permissions** - Ensure you have necessary permissions for all operations
6. **References** - For delete operations, carefully review reference reports

## Dependency Engine

`NintexProcessDependencies.ps1` implements the corrected dependency model. **Mode 5
delegates to it entirely**: every piece of dependency discovery, reference removal and
process deletion lives here, and `Invoke-BulkDeleteProcesses` is a thin orchestrator
over it. The file is also dot-sourceable on its own:

```powershell
. .\NintexProcessDependencies.ps1
```

It splits deliberately in two. **Pure** functions (`Find-`, `Remove-`,
`ConvertFrom-`, `Group-`, `Test-`) operate on process objects in memory, make no
network calls, and are covered by the test suite. **API** functions
(`Get-*Claim`, `Get-Npm*`, `Save-Npm*`) touch the tenant.

| Function | Does |
|---|---|
| `Find-ProcessReferenceSite` | Locates every physical reference site in one process, with the removal verb for each |
| `Remove-ProcessReference` | Clears those sites on a deep clone, leaving the caller's object untouched |
| `ConvertFrom-DependencyResponse` | Parses a dependency response into one claim per occurrence |
| `Get-DependencyCandidate` | Both sides of every claim, since the payload never says which side holds the reference |
| `Group-ReferenceSiteByHolder` | Inverts sites so each holder is saved once for all targets |
| `Test-DependencyReconciliation` | Compares claims against located sites and flags drift |
| `Save-NpmProcessModel` | PUT with `ProcessJson` as a string, then publish, notifications suppressed |
| `Export-/Import-DependencyPlan` | Crash-safe ledger so a failed run can finish denormalising |

### Running the tests

No tenant required. Fixtures are real payloads captured from demo.promapp.com
plus one synthetic process covering the buckets the real pair does not contain.

```powershell
pwsh -NoProfile -File Tests/Test-Dependencies.ps1
```

```powershell
pwsh -NoProfile -File Tests/Test-Executor.ps1
```

`Test-Dependencies.ps1` has 98 assertions covering the locator, remover, orphan
semantics, null and single-element shape handling, claim parsing, inversion,
reconciliation and plan persistence.

`Test-Executor.ps1` has 37 assertions running the whole pipeline against a mocked
tenant: index sweep, discovery, the restore-and-rediscover loop, site location,
inversion, reconciliation, reference removal, save contract, verification, deletion
and the re-archive round trip. It also asserts that a failed dependency check blocks
the run rather than being read as "no dependencies".

## API Endpoints Used

See **[API_ARCHITECTURE.md](API_ARCHITECTURE.md)** for request/response shapes, the
active-vs-archived endpoint split, and the verified dependency-checking semantics. That
document is authoritative; this list is a summary.

| Endpoint | Purpose |
|---|---|
| `/oauth2/token` | Authentication |
| `/Api/v1/Processes/{uniqueId}` | Get / update an **active** process |
| `/Api/v1/Processes/{uniqueId}/CheckProcessDependencies` | Dependency check (see caveats below) |
| `/Api/v1/Processes/{uniqueId}/Publish` | Publish with approval bypass |
| `/Bff/Process/api/v1/processes` | Process listing (`ListType=0` active, `7` archived) |
| `/mobile/api/v1/processes` | Batch fetch **archived** process details |
| `/Process/Edit/{Archive,Restore,Delete}Process` | Archive, restore, delete |
| `/Process/Edit/PublishProcessRevisionEdit` | Publish without approval |
| `/bff/navigation/api/v1/breadcrumb/children` | Group children |
| `/user/autocomplete.aspx` | User search (legacy) |

### Dependency checking caveats

Three behaviours of `CheckProcessDependencies` are easy to get wrong and have each been
verified against a live tenant. Full evidence is in API_ARCHITECTURE.md.

1. **The response is bidirectional.** It returns both what the queried process references
   and what references it, in one undifferentiated list. You cannot tell from the payload
   which process holds a given reference, so both sides must be fetched and inspected.

2. **Counts are per-occurrence.** The same process appearing three times means three
   separate references exist. Deduplicating the results silently drops removal sites.

3. **Archiving hides Input and Output references.** A `Process Input` or `Process Output`
   row is returned only if the process it *names* is active. The references still exist in
   the archived process's JSON. Consequences: never run dependency discovery while a
   participant is archived, and never verify a removal after re-archiving. Both return
   falsely clean results.

## What a first run is expected to do

**Stop.** At least once, on a real tenant, without deleting anything. That is the
tool working, not failing.

A validation run over the first 20 rows of a 463-process archive, taken in listing
order and unfiltered, is the measured example. The target set contained three
processes named as variations whose masters had been renamed or removed, so the
variation pre-flight found nothing to match on and did not fire. That is the
documented blind spot in a name heuristic, and it behaved exactly as documented.
The Hold phase then restored those three, which pulled in twelve sibling
variations, and the collateral checkpoint caught all twelve and refused to
continue. `-Force` cannot approve collateral changes, so the run stopped itself.
Verified afterwards against the tenant rather than against the run's own output:
the archive count was unchanged, all twenty targets were back to archived, and no
temporary group was left behind.

So the shape to expect is: the cheap check misses something, the expensive check
catches it, and the run stops with the affected processes named. Read what it
names, decide whether those processes should be in the target set, and re-run.
The one thing not to do is reach for a flag to push past it; `-Force` deliberately
cannot.

## Limitations

Known broken or incomplete as of this revision:

- **Modes 2, 3 and 4 and all document operations are parked.** See "Parked
  functionality" above for what each one's defect is. They are unreachable from the
  menu and refused by `-Mode` rather than being available and unreliable.
- **Mode 5 Input/Output completeness** depends on the open question in
  API_ARCHITECTURE.md. Until it is settled, only the thorough scan guarantees no
  Input or Output reference is missed.
- Large-scale operations (1000+ items) may take significant time. Only
  `Update-ProcessOwnership.ps1` and the Mode 5 dependency engine implement
  retry/backoff and throttling.
- **Link reconciliation over-expects on some tenants.** Mismatches cluster into a few
  exact shapes (`claimed 2, located 1` and similar) whose delta equals the holder's
  child-procedure count. That is the signature of the child-reference asymmetry
  API_ARCHITECTURE.md already flags as an open question, not of real drift, so those
  are now reported as a warning rather than gating the run. Shapes that do not fit
  still gate. Settling it needs a captured fixture; until then treat a Link warning as
  worth a look on a first run against a new tenant. One `claimed 1, located 2` pair,
  where the JSON holds more than the API reports, still gates deliberately: it is the
  only observed shape that could mean a reference is being missed.
- **The variation pre-flight is a name heuristic, and its blind spot is measured.**
  It matches `<master>::<variant>` against existing process names, so it can only
  fire when a process named `<master>` still exists. A validation run over 20
  archived processes contained three variation-named targets whose masters had all
  been renamed or removed: the pre-flight correctly found nothing to match and did
  not fire, and the Hold phase then pulled in twelve sibling variations. The
  collateral checkpoint caught them and stopped the run, which is why this is a
  documented limitation rather than a defect. Nothing in the API exposes the real
  link. The heuristic can also flag two unrelated processes that share a prefix.
  Treat a warning as a prompt to check, not a verdict, and treat its silence as no
  evidence either way.
- **The before/after baseline cannot cover the whole tenant.** It is built from the
  two list sweeps, and processes exist that neither returns. Those cannot be
  diffed at all; the run reports them as `NotInBaseline` when it encounters one and
  reverses nothing for them, because no prior state was recorded.
- **A target that cannot be restored out of the archive is not deleted.** Its
  references were never checked, so deleting it risks leaving a dangling reference
  behind. Re-run it once the tenant will restore it, or pass `-AllowUnheldTargets`
  to accept the risk explicitly.
- **Orphan detection depends on a field the tenant may not send.** It reads
  `groupExists` from the process listing. Where the listing omits it, every row
  falls back to "the group is there" and the run reports zero orphans because it
  cannot see them, not because there are none. The run says so rather than
  leaving a silent zero to be read as a clean result.
- **A process whose group was deleted cannot be put back.** The process listing reports
  this per row as `groupExists: false`; on the demo tenant it is 177 of 467 archived
  rows. Such a process can be archived, because archiving takes no group, but it cannot
  be restored anywhere, because `RestoreProcess` needs a group id and answers HTTP 500
  for one that does not exist. The run names these targets before it starts, never
  attempts the doomed restore, archives them where they sit, and the results file names
  the group they are actually in. A dependency *holder* in this state blocks the run
  instead: its Input and Output references cannot be read while it is archived, and it
  cannot be un-archived, so a target pointing at it cannot be deleted on a complete
  reading of the tenant. Move it into a group that exists and re-run.
- **Group moves are not reversed automatically.** When a run changes a process it was
  not asked to change, an unwanted archive or un-archive is undone, but a process that
  merely moved group while staying active is named for manual correction instead. The
  only move endpoint available is Mode 3's, which is broken.

## Testing

```powershell
pwsh -NoProfile -File Tests/Run-AllTests.ps1
```

Four suites run against mocked tenants, no network and no credentials:

| Suite | Covers |
|---|---|
| `Test-Dependencies.ps1` | The pure functions: site location, removal, inversion, reconciliation, plan persistence |
| `Test-Executor.ps1` | Plan construction and execution end to end, including a clean dependency result and the both-sides-deleted case |
| `Test-BulkDelete.ps1` | Mode 5 orchestration: the Hold phase, the pre-mutation plan, ledger truthfulness, holding group cleanup, pagination, collateral detection at both checkpoints, and the pre-flight warnings |
| `Test-BulkArchive.ps1` | Mode 1 orchestration: paginated and subgroup-aware enumeration, the variation pre-flight, the collateral checkpoint and its reversal, verification against the tenant, and the mode surface |

## Support

For issues or questions:

1. Check the Troubleshooting section above
2. Review the results CSV for specific error messages
3. Consult Nintex Process Manager documentation
4. Contact your Nintex administrator

## Version History

**Version 4.9** (Current)
- Scope: this build covers bulk archive (Mode 1) and bulk delete (Mode 5) only.
  Modes 2, 3 and 4 and all document operations are parked, meaning removed from
  the menu and refused by `-Mode` with their code left in place. Mode 4 is meant
  to adopt the `Update-ProcessOwnership.ps1` pattern when it returns, and the
  document branches are the only document code there is, so deleting them would
  mean rewriting from the commit history later.
- Fixed, and the reason the scope decision came with work attached: **Mode 1 and
  Mode 5 composed into a data-loss path.** Mode 5 takes its targets from the
  archive list, Mode 1 fills it, and Mode 1 had no collateral protection at all.
  Archiving a variation also archives its master, so archiving one group could
  put a master from another group into the archive list, where a later delete run
  would treat it as an ordinary candidate. Nobody names the master at any point
  and every step looks correct in isolation. Mode 5 cannot catch this, because by
  then the master is a legitimate archive entry, so Mode 1 now runs the variation
  pre-flight, takes a tenant baseline, checks for collateral after archiving, and
  reverses what it finds.
- Fixed: **Mode 1 could not enumerate a group.** It made one unpaginated call to
  the navigation breadcrumb endpoint, so a group larger than one response was
  silently partially archived and the run reported success for the part it had
  seen. Enumeration now filters the paged index and walks the group tree for
  subgroups, and the count is reported before anything happens so it can be
  checked against the UI.
- Fixed: Mode 1 made three un-retried calls per process, resolving, archiving and
  verifying one at a time. It now takes the unique id from the enumeration it
  already has, archives through `Set-NpmProcessArchived` with retry and backoff,
  and verifies from a single re-read. A 200-process group is 200 hardened calls
  rather than 600 unhardened ones.
- Fixed: verification read `isArchived` off an unwrapped response, the pattern
  already called out as unreliable for Mode 2. It reads the tenant instead, so a
  process the archive call claimed and the tenant disagrees about is reported
  failed rather than successful.
- Added: `ArchiveChangeDescription` in `config.txt`, so one change description
  covers a cleanup instead of being hardcoded per call.
- Fixed: `Format-NpmProcessName` was applied at print time, so `Delete_Results_*.csv`
  still carried bare GUIDs where the console said `(name unavailable)`. Rows are
  named where they are built, in both producers, with the invariant that a results
  row's `Name` is never its `ObjectID`.

**Version 4.8**
- Fixed: a collateral process that no source could name printed as a bare GUID
  where the name goes, and again as the id, which reads as a broken tool. Such a
  process is real: absent from the before-state, absent from both process lists,
  and named by no dependency claim, so all three name sources are genuinely
  empty. The run now says `(name unavailable; not in any process list)` and
  prints the id once. The marker is excluded from the longest-name contest used
  to reconcile two producers naming one process differently, since it is longer
  than most real names and would otherwise win it.
- Documented: what a first bulk run against a real tenant is expected to do.

**Version 4.7**
- Fixed: the target list of things needing manual attention was never
  re-verified. A run reported two targets as `still active and must be archived
  manually`; a read afterwards found all three archived. The archive call
  reported failure and took effect anyway. The collateral list was already
  re-checked against a fresh read at the end of a run; the target list was built
  from a different source and was not. Both are now re-derived from one sweep
  taken at the moment the run ends, which also halves the cost of doing it. A
  process that really is still active is still reported as still active, and a
  process absent from both list sweeps is never cleared, because those sweeps are
  known to be incomplete.
- Added: `groupExists` is now three-state. Absent and false are different claims,
  and collapsing them lost the ability to say which. Control flow is unchanged,
  absence still reads as "the group is there", but a run against a listing that
  omits the field now says orphan detection is unavailable rather than reporting
  a clean zero from an unmeasured tenant. Mixed presence, where some rows carry
  the field and some do not, is called out separately: that is the shape where an
  absent field probably does mean the group is gone.

**Version 4.6**
- Fixed: restores failed for every process whose group had been deleted while it
  sat in the archive. The process listing has been reporting this all along, in a
  field called `groupExists`, and the script was discarding it. On the demo tenant
  it is 177 of 467 archived rows, so it is an ordinary state rather than an edge
  case: `RestoreProcess` was being asked to restore into a group that does not
  exist, answering HTTP 500 and then answering it three more times on the way up
  the retry ladder. The flag is now carried on the index, the snapshot, the tenant
  baseline and the plan ledger, and nothing asks the endpoint a question the
  listing already answered.
- Added: a pre-flight that names these targets before the first mutation, the same
  way the variation warning does. It is a warning, not a gate. They can be held and
  deleted normally; what they cannot do is go home if the run stops short.
- Fixed: the unwind now archives such a process where it sits and the results file
  names the group it is actually in, rather than attempting a move that cannot
  succeed and then reporting a placement that never happened.
- Fixed: a dependency holder in this state now blocks the run and is named, with
  the reason given as its group no longer existing. It cannot be un-archived, so
  its Input and Output references cannot be read, so a target that points at it
  cannot be deleted on a complete reading of the tenant. That used to surface
  three floors down as a reconciliation mismatch, which describes the symptom and
  not the cause.
- Note: the test is on `groupExists`, never on `groupId -eq 1`. The API returns
  `groupId: 1` with the tenant's own name as a placeholder for the vanished group,
  and there is no group 1 in a 243-group tree, but two of the measured rows are
  orphaned with a real numeric group that has since been deleted. An id test
  misses both.

**Version 4.5**
- Fixed: a target whose Hold restore failed was deleted anyway. The Hold phase
  exists because archiving hides Input and Output rows, so a target that never
  came out of the archive was never checked; the run logged exactly that and
  deleted it regardless, which can leave a dangling reference on a process that
  survives. Such a target is now excluded from the delete set and reported as
  skipped, and the rest of the batch continues. `-AllowUnheldTargets` overrides
  it; `-Force` does not.
- Fixed: the relocation probe cost 14 seconds per process to learn the same
  thing every time. `RestoreProcess` returns HTTP 500 for an already-active
  process on this tenant, and the retry ladder spent 2 + 4 + 8 seconds
  establishing it before each fallback, which on a 479-target run is close to
  two hours of pure backoff. The probe now runs without retries and the answer
  is remembered for the rest of the run.
- Fixed: the manual-attention list named processes that were already fine. It
  was generated from a checkpoint diff taken before the unwind, and returning
  the targets to their groups brings their sibling variations back too, so one
  run told an operator to go and move five processes that were already home.
  The list is now re-checked against a fresh read at the moment the run ends.
- Fixed: the pre-mutation plan's log was overwritten by the final plan, losing
  the record of which targets could not be held and whether an unchecked delete
  was authorised.

**Version 4.4**
- Fixed: a cancelled run left its targets archived in the temporary group. The
  unwind archived each process where it stood, and at that point they stood in
  the holding group, so three ended up under group 834 instead of 134, 649 and
  493. Worse, the results row asserted the home group regardless, so the one
  file operators are told to check claimed a placement that never happened. The
  unwind now returns each process to its recorded group first, verifies where it
  actually landed, and reports that rather than the intention. A relocation that
  fails is reported as such instead of as a clean success.
- Fixed: the `NotInBaseline` classification could never fire. The observed-id
  list was gathered before the deletes, and at that moment the holding group
  contains only targets, all of which are expected and skipped; the processes
  worth catching are stranded there *by* the delete. Each checkpoint now
  collects the list at the moment it runs. This is why a checkpoint counted 2
  changed where 5 were affected.
- Fixed: collateral was reported by two producers that merged neither ids nor
  names, giving 7 rows for 5 processes, with one id under two different names
  because the group listing drops the variation suffix and returns the master's
  name. Rows are merged by id, the index name wins, and the count is of
  processes affected rather than rows emitted.
- Fixed: the variation warning counted target/master pairs and called them
  targets, reporting 13 for 3. Targets and candidate masters are now counted
  separately.
- Fixed: a cleanup path computed its result rows and discarded them, so a
  process stranded during a blocked run never reached the results file.
- Changed: candidate masters are ordered with active ones first, then by group
  proximity to the target, then by name. Only an active master can be
  collaterally archived, so the row carrying the risk is now the first one read,
  and it is marked.

**Version 4.3**
- Fixed: the collateral guard reported clean while five non-target processes
  changed state. Measurement settled why. A lone archived process was restored,
  polled, re-archived and polled again, and each poll showed the new state
  immediately: the index does not lag, so the existing checkpoints were not
  blind, they ran before anything had happened. The variation coupling fires on
  **delete**, not on restore or archive, and there was no checkpoint after the
  delete. There is now. It cannot prevent the delete, which is why the two
  earlier checkpoints still exist, but it names what changed and restores what
  is still restorable.
- Fixed: a run that changed processes it was not asked to change could still
  finish reporting `0 failed`. Collateral is now counted as failure and printed
  under its own heading, naming every process and what is left to do by hand.
- Added: a pre-flight warning, which is the only check that can **prevent** the
  damage rather than report it. A target named `<master>::<variant>` whose base
  name matches an existing process that is not itself a target means the run is
  about to touch a master nobody listed. It warns an attended run and stops an
  unattended one. This is a name heuristic, not an API guarantee: it can miss a
  variation whose master was renamed and can flag two unrelated processes that
  share a prefix. The separator is configurable.
- Changed: the baseline no longer implies it covers the tenant. It covers what
  the two list sweeps return, and processes exist that neither returns. Any id
  the run encounters that the baseline never saw is reported as `NotInBaseline`
  rather than passed over, and nothing is reversed for it because no prior state
  was ever recorded. Processes left stranded in the holding group feed the
  collateral report instead of appearing only in the group-deletion message.

**Version 4.2**
- Fixed: a bulk operation on a process **variation** silently acted on its master.
  A live run archived two processes and moved a third, none of them targets and
  none in the ledger. Nintex PM stores a variation as its own record in its own
  group and the link to the master is in none of the 46 keys of the process model
  nor the 5 fields of a list entry, so no amount of reading a target reveals it.
  The run now snapshots the whole tenant before it starts and re-checks after the
  Hold phase and again after the pre-delete archive. Anything that moved which was
  not a target stops the run, is named, is recorded in the plan, and is put back
  where it can be. `-Force` cannot approve it.
- Fixed: a participant the dependency API named but that neither process list
  returned was dropped in silence, so a holder in that state never had its
  reference removed. Such a participant is now retried against both fetch
  endpoints, and one that is genuinely unreachable is recorded on the plan and
  blocks the run.
- Fixed: a dry run reported archived participants as "restored for the run" when a
  preview restores nothing.
- Fixed: `Delete_Plan_*.json` is gitignored. Every run, dry ones included, left
  the repository dirty.
- Changed: the archived blind-spot sweep uses a narrow Input/Output finder instead
  of walking every activity tree and discarding the result. Across a 479-process
  archive that is 479 whole activity trees, plus their child recursion, no longer
  walked for nothing.
- Changed: the sweep no longer caches every model it reads. It caches only the
  ones that produced a hit and will be read again, rather than holding hundreds of
  full process models to serve no reads at all. A zero-hit cache report is normal
  and is no longer printed as though it were a fault.
- Changed: a process with no name in the ledger or the index falls back to the
  name the dependency payload already carried, instead of printing a bare GUID.

**Version 4.1**
- Fixed: a clean dependency check was read as a failed one. An empty result array
  unrolled to `$null` on return, so every dependency-free process blocked the run.
  `Get-ProcessDependencyClaim` now returns a result object whose `Success` field
  cannot unroll.
- Fixed: the delete plan recorded the temporary holding group as each archived
  target's original group, and recorded them as never archived, because the ledger
  was built from an index read *after* the Hold phase moved them. State is now
  snapshotted before the first mutation, and the plan is written to disk before it
  too, which is what the crash-safety net always claimed.
- Fixed: reconciliation gated on pairs where both processes were being deleted. On the
  measured tenant that was 114 of 120 mismatches. Such pairs are now `NotApplicable`:
  still recorded in the plan for audit, no longer a decision.
- Added: `-Mode` and friends, so the script runs without the menu, plus a dot-source
  guard so it can be loaded for tests. The menu used to run at load, and under
  redirected stdin it looped forever between `Read-Host` and `ReadKey`.
- Added: retry for a target whose dependency check fails transiently, and the option
  to proceed with the subset that checked cleanly rather than discarding the batch.
- Added: `Write-Progress` and counters through discovery, the ledger build and the
  blind-spot scan.
- Changed: the holding group is no longer deleted while it still holds processes.
- Changed: reconciliation mismatches are reported by process name, grouped by holder,
  with the reference paths, instead of 120 identical unnamed lines.
- Changed: both archived-list readers share one paginator at 200 per page. Mode 5 used
  the 20-per-page copy, which was 25 round trips for 497 processes.
- Changed: the blind-spot scan skips the targets and reuses models already fetched
  during planning.
- Security: `config.txt` is no longer tracked in git. `config.template.txt` is, and a
  pre-commit hook in `.githooks` refuses a commit that stages `config.txt`.

**Version 1.1**
- Added interactive group tree picker
- Support for GUID-based group IDs from URLs
- Hierarchical group display with parent-child relationships
- Automatic GUID to numeric ID resolution
- Improved group selection with fallback options

**Version 1.0** (Initial Release)
- Five operation modes
- Text-based configuration
- Flexible CSV column detection
- Comprehensive error handling
- Detailed results logging

## License

This script is provided as-is without warranty. Test thoroughly before production use.

## Credits

Based on patterns from the Process Manager Bulk Delete Processes script.
