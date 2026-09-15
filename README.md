# Nintex Process Manager Bulk Operations

**Version 4.2.** The version is defined once, in `$script:ScriptVersion` at the top of
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
| `-RestoreGroupId` | Target group for Mode 2 |
| `-ConfigPath` | Alternative config file; defaults to `config.txt` |
| `-WhatIf` | Preview. Nothing is changed. |
| `-Force` | Answer the confirmation prompts and run unattended |
| `-ApprovalsEnabled` | Declare that process approvals are on in this tenant |
| `-ThoroughScan` | Mode 5: read every active process for Input/Output references |
| `-IncludeSubgroups` | Include subgroups for `-Source Group` |

`-Force` does **not** wave through a Mode 5 reconciliation mismatch, a failed
verification, an unresolved participant, or a collateral change. Those still stop the
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

#### Mode 1: Bulk Archive

Archives processes or documents based on a CSV file or group selection.

**CSV Format:**
- Required column: `ProcessID` (or `ProcessId`, `Process ID`, `Id`)

**Options:**
- Source: CSV file or Process/Document Group
- Object Type: Processes, Documents, or Both
- Include Subgroups: Yes/No (for group-based operations)

**Example:**
```
Select Mode: 1
Select Source: 1 (CSV)
Select Object Type: 1 (Processes)
Enter CSV file path: archive-list.csv
```

#### Mode 2: Bulk Restore

Restores archived processes or documents to a specified target group.

**CSV Format:**
- Required column: `ProcessID` (or similar)

**Options:**
- Source: CSV file or All Archived Items
- Object Type: Processes, Documents, or Both
- Target Group: Specify the group ID to restore items to

**Example:**
```
Select Mode: 2
Select Source: 2 (All Archived)
Select Object Type: 1 (Processes)
Select Target Group for Restore: 456
```

#### Mode 3: Bulk Update Location

Moves processes or documents to new groups based on a CSV mapping.

**CSV Format:**
- Required columns:
  - `ProcessID` (or similar) - The ID of the item to move
  - `NewGroupID` (or `TargetGroupID`) - The destination group ID

**Example CSV:**
```csv
ProcessID,NewGroupID
1234,456
1235,457
1236,456
```

**Example:**
```
Select Mode: 3
Select Object Type: 1 (Processes)
Enter CSV file path: update-locations.csv
```

#### Mode 4: Bulk Update Ownership

Updates process owners and experts based on a CSV file.

**Note:** Currently supports Processes only.

**CSV Format:**
- Required columns:
  - `ProcessID` - The process to update
  - `NewOwner` - Username of the new owner (optional)
  - `NewExpert` - Username of the new expert (optional)

**Example CSV:**
```csv
ProcessID,NewOwner,NewExpert
1234,john.doe@company.com,jane.smith@company.com
1235,jane.smith@company.com,john.doe@company.com
```

**Example:**
```
Select Mode: 4
Enter CSV file path: update-ownership.csv
```

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

## Limitations

Known broken or incomplete as of this revision:

- **Mode 3 (Update Location)** and **Mode 4 (Update Ownership)** send the process wrapper
  object to the update endpoint instead of the required `ProcessJson` string, and never
  publish. Neither reliably applies changes. Use `Update-ProcessOwnership.ps1` for
  ownership; it implements the correct pattern.
- **Mode 2 (Restore)** reads `isArchived` / `name` off the unwrapped response, so its
  preview and verification output is unreliable even when the restore itself succeeds.
- **Document operations** are deferred and partially implemented. Do not rely on them.
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
- **Group moves are not reversed automatically.** When a run changes a process it was
  not asked to change, an unwanted archive or un-archive is undone, but a process that
  merely moved group while staying active is named for manual correction instead. The
  only move endpoint available is Mode 3's, which is broken.

## Testing

```powershell
pwsh -NoProfile -File Tests/Run-AllTests.ps1
```

Three suites run against mocked tenants, no network and no credentials:

| Suite | Covers |
|---|---|
| `Test-Dependencies.ps1` | The pure functions: site location, removal, inversion, reconciliation, plan persistence |
| `Test-Executor.ps1` | Plan construction and execution end to end, including a clean dependency result and the both-sides-deleted case |
| `Test-BulkDelete.ps1` | Mode 5 orchestration: the Hold phase, the pre-mutation plan, ledger truthfulness, holding group cleanup, pagination, and collateral detection at both checkpoints |

## Support

For issues or questions:

1. Check the Troubleshooting section above
2. Review the results CSV for specific error messages
3. Consult Nintex Process Manager documentation
4. Contact your Nintex administrator

## Version History

**Version 4.2** (Current)
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
