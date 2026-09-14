# Nintex Process Manager Bulk Operations (DEPRECATED)

A comprehensive PowerShell script for performing bulk operations on Nintex Process Manager (Promapp) processes and documents.

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

```
SiteURL=https://yourcompany.promapp.com
Username=your.email@company.com
Password=YourPasswordHere
DefaultRestoreGroupID=123
TempGroupName=Bulk Delete Temporary Group
```

**IMPORTANT:** Add `config.txt` to your `.gitignore` file to prevent committing credentials to version control.

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

This mode performs a comprehensive deletion workflow:

1. Identifies processes to delete (from CSV or group)
2. Creates/uses a temporary holding group
3. Restores all archived processes temporarily
4. Scans entire site for references to processes being deleted
5. Optionally removes references from other processes
6. Updates ownership of target processes to current user
7. Archives target processes
8. Permanently deletes target processes
9. Re-archives previously archived processes
10. Cleanup (temp group should be manually deleted if empty)

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
Enter CSV file path: processes-to-delete.csv
Type 'DELETE' to confirm: DELETE
Enter the ID of a temporary group to use: 999
Include subgroups? (Y/N): N
[Process scans for references...]
Do you want to attempt to remove these references? (Y/N): Y
Ready to archive processes. Continue? (Y/N): Y
Ready to PERMANENTLY DELETE processes. Type 'DELETE' to confirm: DELETE
```

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

## Dependency Engine (new)

`NintexProcessDependencies.ps1` implements the corrected dependency model. It is
dot-sourceable and not yet wired into Mode 5.

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

98 assertions covering the locator, remover, orphan semantics, null and
single-element shape handling, claim parsing, inversion, reconciliation and plan
persistence.

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
- **Mode 5 dependency handling** calls `CheckProcessDependencies` twice with contradictory
  assumptions about direction, and deduplicates results in a way that drops removal sites.
  See the caveats under "API Endpoints Used".
- The reference locator does not cover `EmbeddedProcessLink`, `ProcessGroupLink`, their
  orphan variants, or `EmbeddedLinkedProcessId`, and only recurses one level into
  `ChildProcessProcedures` off `Activity`.
- Process group creation for Mode 5 requires manual setup.
- Large-scale operations (1000+ items) may take significant time. Only
  `Update-ProcessOwnership.ps1` implements retry/backoff and throttling.

## Support

For issues or questions:

1. Check the Troubleshooting section above
2. Review the results CSV for specific error messages
3. Consult Nintex Process Manager documentation
4. Contact your Nintex administrator

## Version History

**Version 1.1** (Current)
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
