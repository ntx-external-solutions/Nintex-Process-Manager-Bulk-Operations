# Nintex Process Manager API Architecture Guide

This document outlines the correct API endpoints to use for different operations in the Nintex Process Manager Bulk Operations script.

## Core Principle

**ACTIVE processes** and **ARCHIVED processes** use different API endpoints. Using the wrong endpoint will result in errors or missing data.

---

## Process Fetching APIs

### List All Processes (Paginated)

**Endpoint:** `/Bff/Process/api/v1/processes`

**Query Parameters:**
- `Page`: Page number (starts at 1)
- `PageSize`: Number of items per page (typically 20)
- `ListType`: Process state filter

**ListType Values:**
- `0` = All active processes
- `7` = All archived processes

**Usage:**
```powershell
# Get active processes
$url = "$SiteURL/Bff/Process/api/v1/processes?Page=1&PageSize=20&ListType=0"

# Get archived processes
$url = "$SiteURL/Bff/Process/api/v1/processes?Page=1&PageSize=20&ListType=7"
```

**Returns:** List of process metadata (UniqueId, Name, etc.) without full process details

---

### Get Individual Process Details

#### For ACTIVE Processes

**Endpoint:** `/Api/v1/Processes/{processUniqueId}`

**Method:** GET

**Usage:**
```powershell
$url = "$SiteURL/Api/v1/Processes/$processUniqueId"
$response = Invoke-ApiGet -Url $url -Token $Token
$processJson = $response.processJson
```

**Returns:**
```json
{
  "processJson": {
    "UniqueId": "guid",
    "Name": "Process Name",
    "ProcessProcedures": { ... },
    "ProcessRevisionEditId": 123,
    ...
  },
  "processActions": { ... },
  "configuration": { ... }
}
```

**Use Cases:**
- Getting current working state of active process
- Fetching process details for editing
- Checking active process dependencies

#### For ARCHIVED Processes

**Endpoint:** `/mobile/api/v1/processes`

**Method:** GET

**Query Parameters:** `processUniqueIds={guid1}&processUniqueIds={guid2}&...`

**Batch Support:** Yes (can fetch multiple processes in one call)

**Usage:**
```powershell
# Single process
$url = "$SiteURL/mobile/api/v1/processes?processUniqueIds=$processUniqueId"

# Multiple processes (batch)
$queryParams = @("processUniqueIds=guid1", "processUniqueIds=guid2")
$url = "$SiteURL/mobile/api/v1/processes?" + ($queryParams -join '&')

$response = Invoke-ApiGet -Url $url -Token $Token
$processes = $response.data
```

**Returns:**
```json
{
  "data": [
    {
      "ProcessModel": {
        "UniqueId": "guid",
        "Name": "Process Name",
        "ProcessProcedures": { ... },
        ...
      }
    }
  ]
}
```

**Use Cases:**
- Getting archived process details
- Batch fetching multiple archived processes
- Searching archived processes for dependencies

---

## Process Link Removal Behavior

### CRITICAL: Decision Links vs Process Links

When removing process dependencies, Nintex Process Manager handles different link types differently:

#### Decision Links (ProcessProcedures.Decision)

**Behavior:** Decision links should be **orphaned**, not fully removed.

**What this means:**
- Clear the link reference fields: `LinkedProcessId`, `LinkedProcessUniqueId`, `LinkedProcessName`
- **KEEP** `LinkedProcessDisplayName` - Users need to see what was linked
- Change `DecisionLinkType` from `4` (linked) to `7` (orphaned/broken link)
- This creates a visual indicator in the UI that a link existed but is now broken

**Example:**
```json
// BEFORE removing link (linked decision)
{
  "LinkedProcessId": 1472,
  "LinkedProcessUniqueId": "b8631d0f-b7f8-44bb-80ed-f89886551c42",
  "LinkedProcessName": "CSM Onboarding Process",
  "LinkedProcessDisplayName": "CSM Onboarding Process",
  "DecisionLinkType": 4  // 4 = linked
}

// AFTER removing link (orphaned decision)
{
  "LinkedProcessId": null,
  "LinkedProcessUniqueId": null,
  "LinkedProcessName": null,
  "LinkedProcessDisplayName": "CSM Onboarding Process",  // ✅ KEPT!
  "DecisionLinkType": 7  // ✅ Changed to 7 = orphaned
}
```

#### Process Links (ProcessProcedures.ProcessLink)

**Behavior:** Process links should be **fully removed** from the array.

**What this means:**
- Remove the entire ProcessLink object from the ProcessProcedures.ProcessLink array
- No orphaning - the link is completely deleted

**Example:**
```json
// BEFORE
"ProcessLink": [
  { "LinkedProcessUniqueId": "guid-to-delete", ... },
  { "LinkedProcessUniqueId": "other-guid", ... }
]

// AFTER
"ProcessLink": [
  { "LinkedProcessUniqueId": "other-guid", ... }
]
```

### LinkedStakeholders Must Be Preserved

**CRITICAL:** Do NOT remove entries from `LinkedStakeholders.LinkedStakeholder` array.

**Why:** LinkedStakeholders is a reference cache that Process Manager uses to:
- Track process relationships
- Show related processes in the UI
- Maintain the process dependency graph

**Example:**
```json
// Always keep LinkedStakeholders intact, even when removing links
"LinkedStakeholders": {
  "LinkedStakeholder": [
    {"ProcessId": 1502, "Link": "Process A", ...},
    {"ProcessId": 1472, "Link": "Process B", ...}  // Keep even if we orphaned a decision to Process B
  ]
}
```

### DecisionLinkType Values

- `4` = Active/linked decision
- `7` = Orphaned/broken decision link
- Other values may exist but these are the critical ones for link removal

---

### Complete list of reference-bearing locations

A process holds references to other processes in more places than the two main arrays.
A locator that misses any of these will report a clean removal while leaving a live
reference behind.

| Location | Match field | Action |
|---|---|---|
| `ProcessProcedures.ProcessLink[]` | `LinkedProcessUniqueId` | Remove element |
| `ProcessProcedures.OrphanProcessLink[]` | `LinkedProcessUniqueId` | Remove element |
| `ProcessProcedures.EmbeddedProcessLink[]` | `LinkedProcessUniqueId` | Remove element |
| `ProcessProcedures.OrphanEmbeddedProcessLink[]` | `LinkedProcessUniqueId` | Remove element |
| `ProcessProcedures.ProcessGroupLink[]` | `LinkedProcessGroupUniqueId` | Report only |
| `ProcessProcedures.OrphanProcessGroupLink[]` | `LinkedProcessGroupUniqueId` | Report only |
| `ProcessProcedures.Decision[]` | `LinkedProcessUniqueId` | Orphan (see above) |
| `Inputs.Input[]` | `FromProcessUniqueId` | Remove element |
| `Outputs.Output[]` | `ToProcessUniqueId` | Remove element |
| any procedure | `EmbeddedLinkedProcessId` | Clear alongside `LinkedProcessId` |
| `*.ChildProcessProcedures.{Task,Note,Information,Form,Guide,Image,Policy,Training,Video,WebLink}[]` | `LinkedProcessUniqueId` | Orphan |
| `LinkedStakeholders.LinkedStakeholder[]` | - | **Never touch** |

**Recursion.** `ChildProcessProcedures` is not exclusive to `Activity`. `ProcessLink` and
`Decision` nodes carry it too, and child items carry it in turn. The walk must be
genuinely recursive rather than one level deep off `Activity`.

**Null shapes.** Live payloads use `null`, not empty arrays, for unused collections
(`"Outputs": null`, `"Triggers": null`, `"Targets": null`). Guard every access before
indexing.

**Cross-check.** `LinkedStakeholders` mirrors the link-type reference count exactly. In
the verified sample ACR held two link-type references to DT and two `LinkedStakeholder`
entries naming it; DT held one of each. Reading it is a free check on the site count, but
it is derived state and must never be edited.

---

## Complete Dependency Removal Example

This section shows a complete example of removing all dependency types from a process.

### Scenario

We want to delete **"CSM Onboarding Process"** (UniqueId: `b8631d0f-b7f8-44bb-80ed-f89886551c42`).

The CheckProcessDependencies API returns the following processes that reference it:

```json
[
    {
        "Type": "Linked Process",
        "Dependencies": [
            { "Name": "Sqeunce Approve", "UniqueId": "f5698de9-1956-4095-9d6f-edaf6e28f022" },
            { "Name": "Sqeunce Approve", "UniqueId": "f5698de9-1956-4095-9d6f-edaf6e28f022" }
        ]
    },
    {
        "Type": "Process Input",
        "Dependencies": [
            { "Name": "Sqeunce Approve", "UniqueId": "f5698de9-1956-4095-9d6f-edaf6e28f022" }
        ]
    },
    {
        "Type": "Process Output",
        "Dependencies": [
            { "Name": "Sqeunce Approve", "UniqueId": "f5698de9-1956-4095-9d6f-edaf6e28f022" }
        ]
    }
]
```

### Dependency Types and Locations

The "Sqeunce Approve" process has **four different references** to "CSM Onboarding Process":

| Type | Location in JSON | UniqueId Field | Action |
|------|------------------|----------------|--------|
| ProcessLink | `ProcessProcedures.ProcessLink[]` | `LinkedProcessUniqueId` | **Remove from array** |
| Decision | `ProcessProcedures.Decision[]` | `LinkedProcessUniqueId` | **Orphan** (clear fields, set DecisionLinkType=7) |
| Input | `Inputs.Input[]` | `FromProcessUniqueId` | **Remove from array** |
| Output | `Outputs.Output[]` | `ToProcessUniqueId` | **Remove from array** |

### BEFORE: Process JSON with Dependencies

```json
{
    "ProcessProcedures": {
        "Decision": [
            {
                "Id": 20646,
                "UniqueId": "dd79cc66-6391-4601-95da-a9eafe4dacd2",
                "LinkedProcessId": 1472,
                "LinkedProcessUniqueId": "b8631d0f-b7f8-44bb-80ed-f89886551c42",
                "LinkedProcessName": "CSM Onboarding Process",
                "LinkedProcessDisplayName": "CSM Onboarding Process",
                "DecisionLinkType": 4
            }
        ],
        "ProcessLink": [
            {
                "Id": 20649,
                "LinkedProcessUniqueId": "04e43b88-709e-4bbd-a1b1-ac38d92167a4",
                "LinkedProcessName": "Other Process"
            },
            {
                "Id": 20653,
                "LinkedProcessUniqueId": "b8631d0f-b7f8-44bb-80ed-f89886551c42",
                "LinkedProcessName": "CSM Onboarding Process"
            }
        ]
    },
    "Inputs": {
        "Input": [
            {
                "Id": 994,
                "FromProcessUniqueId": "b8631d0f-b7f8-44bb-80ed-f89886551c42",
                "FromProcess": "CSM Onboarding Process"
            }
        ]
    },
    "Outputs": {
        "Output": [
            {
                "Id": 1040,
                "ToProcessUniqueId": "b8631d0f-b7f8-44bb-80ed-f89886551c42",
                "ToProcess": "CSM Onboarding Process"
            }
        ]
    },
    "LinkedStakeholders": {
        "LinkedStakeholder": [
            { "ProcessId": 1502, "Link": "Other Process" },
            { "ProcessId": 1472, "Link": "CSM Onboarding Process" }
        ]
    }
}
```

### AFTER: Process JSON with Dependencies Removed

```json
{
    "ProcessProcedures": {
        "Decision": [
            {
                "Id": 20646,
                "UniqueId": "dd79cc66-6391-4601-95da-a9eafe4dacd2",
                "LinkedProcessId": null,
                "LinkedProcessUniqueId": null,
                "LinkedProcessName": null,
                "LinkedProcessDisplayName": "CSM Onboarding Process",
                "DecisionLinkType": 7
            }
        ],
        "ProcessLink": [
            {
                "Id": 20649,
                "LinkedProcessUniqueId": "04e43b88-709e-4bbd-a1b1-ac38d92167a4",
                "LinkedProcessName": "Other Process"
            }
        ]
    },
    "Inputs": {
        "Input": []
    },
    "Outputs": {
        "Output": []
    },
    "LinkedStakeholders": {
        "LinkedStakeholder": [
            { "ProcessId": 1502, "Link": "Other Process" },
            { "ProcessId": 1472, "Link": "CSM Onboarding Process" }
        ]
    }
}
```

### Key Changes Made

1. **Decision** (orphaned):
   - `LinkedProcessId` → `null`
   - `LinkedProcessUniqueId` → `null`
   - `LinkedProcessName` → `null`
   - `LinkedProcessDisplayName` → **KEPT** (`"CSM Onboarding Process"`)
   - `DecisionLinkType` → `7` (was `4`)

2. **ProcessLink** (removed):
   - Entry with `LinkedProcessUniqueId: "b8631d0f-..."` completely removed from array

3. **Input** (removed):
   - Entry with `FromProcessUniqueId: "b8631d0f-..."` completely removed from array

4. **Output** (removed):
   - Entry with `ToProcessUniqueId: "b8631d0f-..."` completely removed from array

5. **LinkedStakeholders** (preserved):
   - All entries kept, even the one referencing the deleted process

---

## Update Process APIs

### Update Active Process

**Endpoint:** `/Api/v1/Processes/{processUniqueId}`

**Method:** PUT

**Required Headers:**
```
Authorization: Bearer {token}
Content-Type: application/json
Accept: application/json
X-Requested-With: XMLHttpRequest
```

**Body Structure:**
```json
{
  "ProcessJson": "{\"Id\":1476,\"UniqueId\":\"f5698de9-1956-4095-9d6f-edaf6e28f022\",\"Name\":\"Process Name\",...}",
  "ChangeDescription": "",
  "DoSubmitForApproval": false,
  "DoPublish": false,
  "SuppressChangeNotification": false,
  "SharedActivityCollectionEditModel": {
    "ActivitiesToDelete": [],
    "ActivitiesToShare": [],
    "ActivitiesToUnlink": []
  },
  "VariantConnectionChangeStates": []
}
```

**CRITICAL: ProcessJson Field Format**

The `ProcessJson` field must be a **JSON-encoded string**, NOT an object. This means:
- The value is a string that contains escaped JSON
- Quotes inside the ProcessJson value are escaped as `\"`
- The outer body is then serialized, which properly escapes the inner quotes

**Correct Format (outer JSON with inner JSON string):**
```json
{"ProcessJson":"{\"Id\":1476,\"UniqueId\":\"f5698de9-1956-4095-9d6f-edaf6e28f022\"}","ChangeDescription":""}
```

**WRONG Format (ProcessJson as object - will not save changes):**
```json
{"ProcessJson":{"Id":1476,"UniqueId":"f5698de9-1956-4095-9d6f-edaf6e28f022"},"ChangeDescription":""}
```

**PowerShell Implementation:**
```powershell
# Step 1: Get the process data (returns object)
$processData = Invoke-ApiGet -Url "$SiteURL/Api/v1/Processes/$processUniqueId" -Token $Token
$processObj = $processData.processJson

# Step 2: Make changes to the object
$processObj.Name = "New Name"
# ... other modifications ...

# Step 3: Convert the process object to a JSON STRING
$processJsonString = $processObj | ConvertTo-Json -Depth 20 -Compress

# Step 4: Build the request body with ProcessJson as a STRING
$updateBody = @{
    ProcessJson = $processJsonString  # This is a string!
    ChangeDescription = ""
    DoSubmitForApproval = $false
    DoPublish = $false
    SuppressChangeNotification = $false
    SharedActivityCollectionEditModel = @{
        ActivitiesToDelete = @()
        ActivitiesToShare = @()
        ActivitiesToUnlink = @()
    }
    VariantConnectionChangeStates = @()
}

# Step 5: Serialize the entire body (ProcessJson string will be properly escaped)
$jsonBody = $updateBody | ConvertTo-Json -Depth 20

# Step 6: Send the request
$response = Invoke-RestMethod -Uri $url -Method Put -Headers $headers -Body $jsonBody
```

**Working cURL Example:**
```bash
curl 'https://demo.promapp.com/{tenantId}/Api/v1/Processes/{processUniqueId}' \
  -X 'PUT' \
  -H 'Authorization: Bearer {token}' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' \
  --data-raw '{"ProcessJson":"{\"Id\":1476,\"UniqueId\":\"f5698de9-1956-4095-9d6f-edaf6e28f022\",\"Name\":\"Process Name\",\"StateId\":1,\"Objective\":\"...\",\"ProcessProcedures\":{...},\"Version\":\"4.0\",\"ProcessRevisionEditId\":8970,...}","ChangeDescription":"","DoSubmitForApproval":false,"DoPublish":false,"SuppressChangeNotification":false,"SharedActivityCollectionEditModel":{"ActivitiesToDelete":[],"ActivitiesToShare":[],"ActivitiesToUnlink":[]},"VariantConnectionChangeStates":[]}'
```

**Important Notes:**
- `ProcessJson` must be a JSON **string** (use `ConvertTo-Json -Depth 20 -Compress` on the process object first)
- Then the entire body is serialized with `ConvertTo-Json -Depth 20` (this properly escapes the inner JSON string)
- Depth 20 is critical for complex process structures with nested activities
- After updating, may need to publish separately (see Publishing APIs)
- The API may return 200 OK but silently ignore changes if ProcessJson format is wrong

**Common Mistakes:**
1. Passing ProcessJson as an object instead of a string
2. Using insufficient depth (< 20) which truncates nested structures
3. Double-serializing the ProcessJson (serializing it twice)
4. Not including all required fields in the body

---

## Dependency Checking APIs

### Check Process Dependencies

**Endpoint:** `/Api/v1/Processes/{processUniqueId}/CheckProcessDependencies`

**Method:** GET

**Query Parameters:** `searchBehavior=31`

`searchBehavior` is a bitmask. Earlier revisions of this script used `15`; use `31`.
The individual bit-to-type mapping has not been confirmed. Probe it per tenant if you
ever need to filter by type at the API level rather than client-side.

**Usage:**
```powershell
$url = "$SiteURL/Api/v1/Processes/$processUniqueId/CheckProcessDependencies?searchBehavior=31"
$dependencies = Invoke-ApiGet -Url $url -Token $Token
```

**Response shape:**
```json
[
    { "Type": "Linked Process",       "Dependencies": [ { "Name": "...", "UniqueId": "guid" } ] },
    { "Type": "Process Input",        "Dependencies": [ ] },
    { "Type": "Process Output",       "Dependencies": [ ] },
    { "Type": "Linked Process Group", "Dependencies": [ ] }
]
```

---

### CRITICAL: the response is BIDIRECTIONAL

**Do not treat this as an "incoming dependencies" API.** Earlier revisions of this
document described it that way. That is wrong, and building on it produces a removal
plan that edits the wrong process.

`Linked Process` rows are an **undifferentiated union** of:

- references the queried process holds **to** other processes (outgoing), and
- references other processes hold **to** the queried process (incoming).

Nothing in the payload indicates which direction an edge belongs to. Two edges pointing
in opposite directions are byte-identical in the response.

`Process Input` and `Process Output` rows behave differently and are covered in
"Link and Input/Output are scoped differently" below. The practical conclusion is the
same for both: you cannot infer from the payload which process holds a reference.

**Consequence for removal planning:** given a dependency naming process Y, you cannot
tell whether the reference to remove lives inside Y or inside the queried process.
**Both sides must be fetched and their JSON walked.** Treat this endpoint strictly as a
candidate index. The process JSON is the only source of truth for where a reference
actually lives and which verb removes it.

### Link and Input/Output are scoped differently

The union above is measured for `Linked Process`. It does **not** hold for
`Process Input` and `Process Output`.

The ACR/DT pair holds one Input in each direction:

| Holder | Location | Names |
|---|---|---|
| ACR | `Inputs.Input[]` Id 1220 | DT |
| DT | `Inputs.Input[]` Id 1221 | ACR |

A union would put two `Process Input` rows on each query. Both queries return
exactly **one**. So Input and Output are scoped to a single direction while
`Linked Process` is not.

**Open question.** One symmetric sample cannot distinguish two explanations,
because both predict a count of one:

- **(a)** the row reports the **queried process's own** `Inputs` / `Outputs` only, or
- **(b)** it is a union **deduplicated** per related process.

Discriminating experiment, one call: give ACR a **second** Input row also sourced
from DT, then query ACR. Two rows means (a); one row means (b).

Until that is settled, `Test-DependencyReconciliation` scopes Input and Output to
the queried process's own sites. That is exactly right under (a), and under (b) it
reports a mismatch for investigation rather than silently leaving a reference
behind. Scoping `Linked Process` the same way would under-count and hide real
sites, so it stays a union.

### Link mismatch shapes measured at scale

A 497-target dry run on the same tenant produced 582 reconciliation entries and 120
`Link` mismatches. They are not scattered:

| shape | count |
|---|---|
| claimed 2, located 1 | 73 |
| claimed 1, located 0 | 30 |
| claimed 3, located 1 | 8 |
| claimed 3, located 2 | 6 |
| claimed 2, located 0 | 2 |
| claimed 1, located 2 | 1 |

Every shape but the last has the API claiming **more** than the JSON walk locates, and
the delta matches the holder's child-procedure count. That is the child-reference
asymmetry described above, which is why a mismatch of exactly that size is now
classified `MatchWithKnownAsymmetry` and reported as a warning instead of gating the
run. Anything that does not fit the shape still gates.

**Still open, and the thing to settle next.** The single `claimed 1, located 2` entry
runs the other way: the JSON holds more than the API reports. That is the only sample
where the asymmetry inverts, and it is the interesting one. Capturing a fixture from it,
and from one `claimed 2, located 1` pair (both process models plus both dependency
payloads), would settle both this and the (a)/(b) question above. Neither is settled by
the shape table alone; the table is evidence about the distribution, not about the
mechanism.

A second run against the same tenant confirmed the entry is still there and still
alone of its kind, now among only 6 remaining mismatches rather than 120. It is
**not** classified as known-shape asymmetry: the classifier only forgives a delta
that matches a child-procedure count on the queried side, and this pair has none,
so it still gates the run. That is deliberate. Of the observed shapes it is the
only one that could mean a real reference is being missed rather than
over-reported, and it should keep stopping runs until a fixture explains it.

### Process variations are coupled, and nothing in the payload says so

Measured on the demo tenant during a live 10-target run. The run archived two
processes that were active and moved a third into the temporary group. None were
targets. None were in the ledger. Nothing failed, and nothing in the output
mentioned them.

The cause is process variations. Nintex PM stores a variation as **its own
process record, in its own group**, with its own UniqueId. Acting on the
variation acts on the master as well. The coupling is not exposed anywhere this
tooling can see it:

| Source | Fields | Mentions the master? |
|---|---|---|
| Process model (`/Api/v1/Processes/{id}`) | 46 keys | no |
| Index entry (`ListType=0` / `ListType=7`) | 5 fields | no |
| `CheckProcessDependencies` | claim rows | no |

So a target cannot be inspected to find out whether operating on it will also
operate on something else. **There is no read that answers the question.**

What can be done is to record the state of every process in the tenant before
the run, and compare after each mutating phase. Anything that moved which was
not asked to move is collateral. That is what `New-TenantStateSnapshot` and
`Compare-TenantState` do, and the check runs twice:

1. after the Hold phase restores archived targets, and
2. after the pre-delete archive pass, which is the last point before the
   irreversible step.

Collateral stops the run. `-Force` cannot approve it: a run that has just
demonstrated it affects processes nobody listed has no business proceeding to a
delete unattended.

The same signal is produced by another user editing the tenant mid-run, which is
indistinguishable from the outside and is treated the same way.

**Reversal is partial, by design.** An unwanted archive is undone by restoring to
the recorded home group, and an unwanted un-archive by re-archiving. A process
that merely changed group while staying active is **not** moved back: the only
move endpoint available here is the one Mode 3 uses, which is documented below
as broken, and guessing with a broken endpoint on a process the operator never
meant to touch makes two problems out of one. Those are named for manual
correction. A process that disappeared cannot be recovered by anything.

### Some processes are in no list but are still fetchable

Also measured: processes that `CheckProcessDependencies` names as related, but
that appear in neither `ListType=0` nor `ListType=7`, while the mobile batch
endpoint returns them normally. Two were seen on the demo tenant.

This matters because such a process can be a **holder**. Skipping it means its
reference to a deleted target is never removed, which is the exact failure the
dependency engine exists to prevent. So a candidate missing from the index is
now retried against both fetch endpoints before being given up on, and one that
is genuinely unreachable is recorded on the plan as an unresolved participant
and blocks the run rather than passing unnoticed.

### Reconciliation is skipped when both sides are being deleted

Of those 120 mismatches, 114 were pairs where **both** processes were in the delete set
and 0 were pairs where neither was. References between two processes that are both
about to be deleted go away with them: there is no removal to get wrong and no decision
for an operator to make. Such pairs are recorded with `Status = 'NotApplicable'` so the
plan file stays a complete audit record, and excluded from the gate. On this tenant that
took the gate from 120 lines to 6.

### Counts are per-occurrence, summed across both directions

Each entry in `Dependencies` is one physical reference, not one related process. The same
`Name` / `UniqueId` appearing three times means three references exist. **Do not
deduplicate by `Type|UniqueId`.** That multiplicity is the count of sites to clear, and
collapsing it is how a partial removal passes unnoticed.

Because the response is a union, the count for a pair (X, Y) is
`(references X holds to Y) + (references Y holds to X)`. You therefore cannot reconcile
claims against sites found in a single process. Reconcile per pair:

```
claim count on either query  ==  sites in X pointing at Y  +  sites in Y pointing at X
```

### Verified reference model

Measured on demo tenant `93555a16...`, processes "Action Customer Request" (ACR,
`b4ac5598-...`) and "Dependency Test" (DT, `2e917985-...`).

Ground truth read from the process JSON:

| Edge | Location | Count |
|---|---|---|
| ACR to DT | `ProcessProcedures.ProcessLink[]` (Id 29211) | 1 |
| ACR to DT | `Activity[1].ChildProcessProcedures.Note[0]` (Id 29212) | 1 |
| ACR to DT | `Inputs.Input[]` (Id 1220) | 1 |
| DT to ACR | `ProcessProcedures.ProcessLink[]` (Id 29213) | 1 |
| DT to ACR | `Inputs.Input[]` (Id 1221) | 1 |
| PCL to ACR | inside PCL only; ACR's JSON holds no reference to PCL | 2 |

Observed `Linked Process` counts reconcile exactly, and only as a union:

```
Query DT  = DT's own ProcessLink (1) + ACR's ProcessLink + ACR's Note (2)   = ACR x3
Query ACR = ACR's own ProcessLink (1) + DT's ProcessLink (1)                = DT  x2
          + PCL's two inbound links                                         = PCL x2
```

The `PCL x2` rows are the direct proof of bidirectionality: ACR's JSON contains no
reference to `fce59755` anywhere, so those edges can only exist inside PCL.

Note one asymmetry: a linked-process reference carried by a **child** procedure (the Note
at Id 29212) counts as an **incoming** edge on the target but not as an **outgoing** edge
on the holder. This is inferred from a single sample and is the only assignment under
which both queries reconcile. Re-verify before depending on it.

---

### CRITICAL: archiving suppresses Input/Output rows

**The rule:** a `Process Input` or `Process Output` row is returned **if and only if the
process it NAMES is active.** The archive state of the *queried* process is irrelevant.
`Linked Process` and `Linked Process Group` rows are never suppressed.

Verified across all four archive states of the ACR/DT pair. All six Input rows were
predicted correctly.

| ACR | DT | Query DT | Query ACR |
|---|---|---|---|
| active | active | LP: ACR x3 - **PI: ACR x1** | LP: DT x2, PCL x2 - **PI: DT x1** - LPG x1 |
| archived | active | LP: ACR x3 | LP: DT x2, PCL x2 - **PI: DT x1** - LPG x1 |
| active | archived | LP: ACR x3 | LP: DT x3 \* , PCL x2 - LPG x1 |
| archived | archived | LP: ACR x3 | LP: DT x2, PCL x2 - LPG x1 |

\* captured against an earlier content revision of ACR that carried an extra link and an
Output. The suppression behaviour is the point here, not the count.

**The suppressed references still exist in the archived process's JSON.** Archiving hides
them from the dependency index. It does not remove them.

#### Consequences

1. **Any dependency scan taken while a participant is archived is incomplete.** Delete a
   process on the strength of such a scan and you leave a dangling `FromProcessUniqueId`
   or `ToProcessUniqueId` inside the archived process, which surfaces as a broken
   reference whenever it is restored. Restore every participant to active before
   discovery, then re-run discovery.

2. **Verify before re-archiving, never after.** A verification pass run after re-archiving
   returns a falsely clean result, because the rows that would reveal a missed reference
   are exactly the ones archiving suppresses. The order is: edit, publish, verify,
   re-archive.

3. **Querying an archived process still returns its complete link picture.** Only
   Input/Output edges *naming* an archived process are lost. The blind spot is narrower
   than it first looks.

### The blind spot this endpoint cannot cover

An archived process X whose **only** reference to target T is an Input or Output is
absent from every response. It appears in no query, so there is nothing to discover and
nothing to restore.

This cannot be bootstrapped away: discovering X requires restoring X, and knowing to
restore X requires discovering it.

**The archived-process JSON scan therefore remains mandatory.** It can be narrowed,
though: scan archived processes for **Input and Output references only**. Linked Process
edges are already covered by the API regardless of archive state.

1. List archived processes: `/Bff/Process/api/v1/processes?ListType=7`
2. Batch fetch details: `/mobile/api/v1/processes?processUniqueIds=...`
3. Match `Inputs.Input[].FromProcessUniqueId` and `Outputs.Output[].ToProcessUniqueId`
   against the target

## Publishing APIs

### Publish Process (No Approval)

**Endpoint:** `/Process/Edit/PublishProcessRevisionEdit`

**Method:** POST

**Body:**
```json
{
  "publishMessage": "Publishing Process",
  "processUniqueId": "guid",
  "processRevisionEditId": 123
}
```

### Publish Process (With Approval Bypass)

**Endpoint:** `/Api/v1/Processes/{processUniqueId}/Publish`

**Method:** POST

**Body:**
```json
{
  "ProcessRevisionEditId": "123",
  "IsPublishNow": true
}
```

---

## Group Management APIs

### Get Group Children (Breadcrumb)

**Endpoint:** `/bff/navigation/api/v1/breadcrumb/children`

**Query Parameters:** `type=ProcessGroup&id={groupUniqueId}`

**Returns:** Direct children (processes and subgroups) of a group

---

## Common Patterns

### Pattern 1: Build a removal plan for a process you intend to delete

The API is a candidate index, not a location index. It names related processes and how
many references exist; it does not say which side holds them or where. So discovery and
location are two distinct passes.

```powershell
# Pass 1 - candidates (cheap, 1 call per target)
$url = "$SiteURL/Api/v1/Processes/$targetUniqueId/CheckProcessDependencies?searchBehavior=31"
$claims = Invoke-ApiGet -Url $url -Token $Token
# Keep every occurrence. Do NOT dedupe by Type|UniqueId.

# Pass 2 - locations (1 fetch per unique related process, PLUS the target itself,
#           because the claim may describe an edge held on either side)
$sites = Find-ReferenceSites -ProcessObj $relatedObj -TargetUniqueIds $targets
$sites += Find-ReferenceSites -ProcessObj $targetObj  -TargetUniqueIds $relatedIds

# Pass 3 - reconcile per pair
#   claim count == sites in X pointing at Y + sites in Y pointing at X
```

Then invert by **source** process before executing. The query is target-centric, but the
edit is source-centric: one fetch, one PUT and one publish per source process, carrying
the removals for every target at once. Saving a source once per target instead produces
redundant published versions and a window in which it is already re-archived while later
edits are still pending.

### Pattern 2: Scan archived processes for the API's blind spot

Required, not optional. See "The blind spot this endpoint cannot cover" above. Narrow it
to Input and Output references; Linked Process is already covered by Pattern 1.

```powershell
# Step 1: list archived processes (paginated)
$listUrl = "$SiteURL/Bff/Process/api/v1/processes?Page=$page&PageSize=200&ListType=7"

# Step 2: batch fetch details via the mobile API
$queryParams = $uniqueIds | ForEach-Object { "processUniqueIds=$_" }
$batchUrl = "$SiteURL/mobile/api/v1/processes?" + ($queryParams -join '&')

# Step 3: match Inputs.Input[].FromProcessUniqueId / Outputs.Output[].ToProcessUniqueId
```

### Anti-pattern: enumerating all active processes

Fetching every active process individually to find references is 700+ calls on a typical
tenant. Pattern 1 gets the same candidate set in one call per target.

## Critical Rules

1. **Active processes** use `/Api/v1/Processes/{processUniqueId}` (individual fetch)
2. **Archived processes** use `/mobile/api/v1/processes` (batch fetch)
3. Never use the mobile API for active processes
4. Never use individual fetch for archived processes (too slow)
5. `CheckProcessDependencies` is **bidirectional**. Never infer from it which process
   holds a reference; fetch and walk both sides
6. Never deduplicate dependency results by `Type|UniqueId`. Every occurrence is a site
7. Never run dependency discovery while any participant is archived, and never verify
   removal after re-archiving. Both return falsely clean results
8. Always use `ConvertTo-Json -Depth 20` when preparing process JSON for PUT requests
9. `ProcessJson` in a PUT body must be a JSON **string**, not an object
10. Never edit `LinkedStakeholders`. It is a derived cache
11. Progress indicators should use `\r` with `-NoNewline` for single-line updates

## Error Codes

- **400 Bad Request** - Usually means:
  - Invalid JSON structure in PUT body
  - Missing required fields
  - ProcessJson depth too shallow (use -Depth 20)
  - Wrong endpoint for process state (active vs archived)

- **404 Not Found** - Process doesn't exist or wrong UniqueId

- **403 Forbidden** - Insufficient permissions

---

## Document APIs (DEFERRED)

> **Scope note.** Document operations are out of scope for the current refactor. The
> endpoints below are retained as reference for when document support is layered back
> in. Nothing in the process workflow should depend on them.


### List Archived Documents (Paginated)

**Endpoint:** `/bff/document/api/v1/documents`

**Method:** GET

**Query Parameters:**
- `Page`: Page number (starts at 1)
- `PageSize`: Number of items per page (typically 20)
- `ListType`: Document state filter (`Archived` for archived documents)
- `DocumentType`: Document type filter (`All` for all types)

**Usage:**
```powershell
$url = "$SiteURL/bff/document/api/v1/documents?Page=1&PageSize=20&ListType=Archived&DocumentType=All"
$response = Invoke-ApiGet -Url $url -Token $Token
```

**Response Structure:**
```json
{
    "items": [
        {
            "documentId": 495,
            "documentUniqueId": "72562f17-730f-487a-95d7-b903bf37ba11",
            "documentName": "Example Document.pdf",
            "primaryGroupUniqueId": "3de0747b-1984-4df2-93df-d6c0039325d6",
            "primaryGroupName": "Group Name",
            "archivedDate": "2025-11-18T14:42:55.27",
            "archivedByUserName": "User Name",
            "uploadDate": "2024-04-17T12:47:03.057",
            "userName": "Uploader Name",
            "isArchived": true,
            "isLinkedFile": false,
            "canRestore": true,
            "canDelete": true
        }
    ],
    "totalItemCount": 67
}
```

**Important Notes:**
- This is a paginated response - loop through pages until `items.Count < PageSize`
- The `documentId` (numeric) is used for deletion, not `documentUniqueId`

---

### Bulk Delete Archived Documents

**Endpoint:** `/bff/document/api/v1/documents/bulk`

**Method:** DELETE

**Required Headers:**
```
Authorization: Bearer {token}
Content-Type: application/json
Accept: application/json
X-Requested-With: XMLHttpRequest
```

**Body Structure:**
```json
{
    "documentIds": [32, 495, 561]
}
```

**Usage:**
```powershell
$deleteUrl = "$SiteURL/bff/document/api/v1/documents/bulk"
$deleteBody = @{
    documentIds = @(32, 495, 561)  # Array of numeric document IDs
}

$headers = @{
    "Authorization" = "Bearer $Token"
    "Content-Type" = "application/json"
    "Accept" = "application/json"
    "X-Requested-With" = "XMLHttpRequest"
}

$jsonBody = $deleteBody | ConvertTo-Json -Depth 10
$response = Invoke-RestMethod -Uri $deleteUrl -Method Delete -Headers $headers -Body $jsonBody
```

**Important Notes:**
- Use the numeric `documentId` from the list response, NOT `documentUniqueId`
- Can delete multiple documents in a single request
- Recommended to batch delete in groups of 50 for large operations
- This permanently deletes the documents - cannot be undone

---

## Questions?

If you encounter an API-related issue:

1. Check if you're using the correct endpoint for the process state (active vs archived)
2. Verify the request body structure matches the examples above
3. Check the -Depth parameter on ConvertTo-Json (should be 20)
4. Review the debug logs from Invoke-ApiPut/Post/Get functions
5. For document deletion, ensure you're using numeric `documentId`, not `documentUniqueId`
