# Tasks

Written by the Cowork session. The product is now a web app; read `handoff/SPEC-WEB.md`
before starting any task here. Work every task marked `Status: Ready`, in order, one PR
per task against `claude/main`. Tasks marked `Queued` are waiting on a spike or an
earlier task; don't start them.

The R11 tasks for the PowerShell (old T1 and T2) are superseded. They're folded into W5.
The PowerShell is frozen at v4.11: don't change it.

## Next handover (18 Oct, evening): F1, then W4, then W5

W0 to W3 are merged and the app is live at `https://bulk.ntx-poc.com/` on the demo
tenant. Cowork runs the live tests there (round R12: Archive, folder cleanup, Move) in
parallel with this work, and writes any findings as new F tasks. Don't run anything
against it yourself.

Work F1 first (small, from Cowork's review of your W2 to W3 reports), then W4, then W5.

---

## F1. Answers to the W2 to W3 questions, and one cleanup bug

Status: Done (c1667ad)

From your "Decisions Cowork should check" notes, using what the spikes recorded:

- **Bug: cleanup misses archived documents.** `ListType=All` does **not** include
  archived documents. Measured in S1: after the test document was archived, `ListType=All`
  with its `ProcessGroupId` returned 0 rows and `ListType=Archived` returned 1, and that
  archived document still made `DeleteGroup` return 409. So `gatherFacts` must read both
  lists and keep the group if either has a row. Today the plan would call it deletable
  and the tenant would refuse it (reported as Blocked, so safe, but the preview is wrong).
- **Breadcrumb shape, captured.** Pin `breadcrumbTitles` to it and drop the guesses:

  ```json
  {"isChildren": false,
   "breadcrumbItems": [
     {"id": "<tenant root uuid>", "parentId": null, "name": "Promapp Demo Ltd.",
      "position": 1, "type": "ProcessGroup", "url": "https://.../Process/Group/<uuid>", "version": null},
     {"id": "<group uuid>", "parentId": null, "name": "Library & History Services",
      "position": 2, "type": "ProcessGroup", "url": "...", "version": null}]}
  ```

  Root (the tenant) first, the group itself last. For a deleted group the list can be
  empty; treat that as "path unknown", not an error.
- **Group link.** `{siteUrl}/Process/Group/{groupUniqueId}`. That's the breadcrumb
  items' `url` and the URL of the group page in the product. Add it to group rows.
- **Draft detection, add a structured signal.** Keep the "outstanding changes" wording
  check, and also treat a process as "draft goes live" when its model has
  `ProcessRevisionStateId` 1 (in progress) and a major version of 1 or more. Measured:
  never-published processes were 0.x in state 1; the draft over a published version was
  1.1 in state 1. Either signal puts it in "Tick to move". `process.summary` already
  reads the model, so this should be no extra calls for most rows.
- **403 vs an expired token.** Not measured yet. Cowork will check it in R12 and add a
  task if it matters. Keep your current handling.
- **Shortcuts keep a group, the archive variation trigger, and resume-by-re-planning:**
  agreed, no change.
- **Your mock and headless driver:** yes, commit them under `web/dev/` as a dev tool, kept
  out of the production build.

---

## W0. Scaffold `web/` from process-group-manager

Status: Done (624b9ae)

Create a Next.js app in `web/`, lifting the foundation from
`github.com/ntx-external-solutions/process-group-manager` (public): auth route and
`lib/auth/*`, the proxy route, `lib/pm/client.ts`, `types.ts`, `groups.ts`, `scim.ts`,
`lib/exec/journal.ts`, `runner.ts`, `report.ts`, `lib/ui/treeCache.ts`,
`lib/plan/tree.ts`, `revalidate.ts`, security headers in `next.config.mjs`, and their
tests. Keep PGM's stack (Node 24, TypeScript, `node --test`). Note the source commit in
`web/README.md`.

Strip what this app doesn't do (shortcuts, champions, group create and rename, CSV group
import). The operation allowlist starts **read-only**: `groups.tree`, `processes.list`,
`process.summary`, `auth`. A landing page after sign-in lists the four operations as
disabled tiles. The sign-in page says SSO-only tenants are not supported.

Add `vercel.json` with the project rooted at `web/`, and a root README section on running
it locally.

**Done when:** `npm test` and `npm run typecheck` pass in `web/`, sign-in works locally
against a tenant, and the allowlist has no write operation.

---

## W1. Tree browser with processes, and the archived view

Status: Done (7e97808)

Build the shared selector described in the spec:

- Lazy tree from `GetChildProcessGroupTreeItems` showing groups, document groups and
  processes (PGM's `GroupBrowser` filters processes out; ours keeps them).
- Tri-state selection. A checked group resolves to its full subtree at plan time, not to
  what's expanded on screen.
- `resolveSelection(tree, selection)` returns every selected process with its group path,
  as a pure function with tests (nested groups, partial selection, document groups
  excluded, a group checked and then one child unchecked).
- The archived view: paginated archived listing, grouped by original group, with a
  separate "group no longer exists" bucket driven by `groupExists === false`. Test the
  flag, never `groupId === 1` (see `API_ARCHITECTURE.md`, "groupExists"). Absent is not
  false.

Still read-only. No writes in this task.

**Done when:** the selector resolves correctly in tests, and both views render against a
recorded fixture.

---

## W2. Bulk Archive

Status: Done (2f9832a, 5f36abf, 6bbf48b)

Port the archive path from `Nintex-BulkOperations.ps1` (`Invoke-BulkArchiveProcesses`)
and `Set-NpmProcessArchived` in `NintexProcessDependencies.ps1`. Add `process.archive`
and `process.publishNow` to the allowlist, each taking exactly one process id.

Must carry over, all covered in `API_ARCHITECTURE.md`:

- One change description per run, required before Apply is enabled.
- Read back `isArchived` after every archive. If false, re-read the revision id and call
  `Publish` with `IsPublishNow: true`, id as a string. Use the script's outcome names
  (`Archived`, `PendingApproval`, `Overridden`), and report refusals and failures with
  the tenant's status code and message, as `New-NpmArchiveOutcome` does.
- A 400 is reported with the tenant's message and a link, and not retried.
- Final status for every process comes from a fresh read at the end of the run.
- The preview lists variation siblings of selected processes, from `variationSetData`
  (top level of `GET /Api/v1/Processes/{id}`, beside `processJson`):
  `OtherVariedProcesses[].ProcessUniqueId`. Siblings aren't in the tree.
- Results CSV with the script's columns.
- Every `Publish` sends `PublishMessage` set to the change description (S2: 400 without
  it on a tenant in "Publish Only mode").

**Not in this task:** deleting groups afterwards. That's W2b.

**Done when:** offline tests cover each outcome, including a 200 that's still pending
and a call that reports failure but took effect.

---

## W2b. Folder cleanup after Archive

Status: Done (3026aa3)

After an archive run finishes and is re-read, offer to delete the groups it left behind.
S1 measured the API: `DeleteGroup` deletes a group holding archived processes (they
become orphans, `groupExists: false`) and refuses a group holding any document with 409
`AssociatedContents`, listing the documents in `additionalInfos.documents`. The server's
validation gate says nothing. So the app does the checking:

- Candidates are groups the selection covered that now hold no active process, deepest
  first. Check each group's documents with
  `/bff/document/api/v1/documents?...&ListType=All&ProcessGroupId=<uuid>` and the
  archived listing; a group with documents is kept and reported, not attempted.
- The warning lists, per group, every archived process that will no longer be restorable
  to it. Separate explicit confirmation from the archive's.
- Add `group.delete` to the allowlist taking exactly one group id. A 409 is reported with
  the document names, never retried.
- One results row per group: deleted, kept with reason, or failed.
- Also: archived-view bucket labels use the breadcrumb path
  (`/bff/navigation/api/v1/breadcrumb?type=ProcessGroup&id=<uuid>`, root first, the group
  last), one call per distinct group. Add it to the allowlist as a read.

**Done when:** offline tests cover a group that deletes, one kept for a document, one
kept for an active process, a 409 from the tenant, and nested groups deleted deepest
first.

---

## W3. Bulk Move

Status: Done (5ebca76)

`ReorderTreeNodes`, one node per call, `NodeType` from the item's `itemType`. Destination
picker from the same tree. Reuse PGM's `groupPlan.ts` checks (no cycles, not into its
own subtree, not into a document group). Show viewer deltas from
`GetTotalSpecifiedGroupRoleAndUserViewers` in the preview.

S2 measured the revision effects, and the preview must show them:

- A group move changes no process revision. When a whole group is selected, move the
  group, not its processes one by one.
- An in-progress process gets a minor version bump.
- **A published process gets a new major version published.** Pre-flight each
  individually selected process with
  `ValidateProcessAction?processUniqueId=<id>&actionType=11&processGroupUniqueId=<dest>&isShortcut=false`.
  When it returns `isPrompt: true`, show its title and message in the preview and count
  those processes in the confirmation.
- **Drafts go live.** Moving a process that has a published version publishes it, and
  if it has an open draft, the draft is published too (measured on a real variation,
  v1.1 draft became published 2.0). `ValidateProcessAction` says so in its message
  ("has outstanding changes ... will also be published"). Put these processes in their
  own section of the preview, unselected by default, with the tenant's message.
- **A variation set moves as one.** The tree shows one node per set; moving it moves
  every variation (siblings are not in the tree at all). Read `variationSetData` from
  `GET /Api/v1/Processes/{id}` (top level, beside `processJson`) and list every sibling
  in `OtherVariedProcesses` in the preview as moving too.
- `linked-process` items can't be moved here. List them as excluded with the reason.

---

## W4. Bulk Update Ownership

Status: Done (d0062e7)

Port `Update-ProcessOwnership.ps1`: same CSV columns and cell rules, SCIM lookup via
`scim.ts` with the key entered per run. Two changes from the script, both explained in
the spec: `SuppressChangeNotification` defaults to true, and the operator chooses "save
only" or "match current state" for published processes, the way PGM does it.

---

## F2. Fixes from live round R12

Status: Done (809966c)

R12 ran Archive, folder cleanup and Move on `https://bulk.ntx-poc.com/` against test
content on the demo tenant. All three worked end to end and the tenant matched every
results row (report: project doc `claude/bulk-ops-r12-2026-10-18.md`). Three fixes:

- **A dead session crashes instead of signing out.** Measured with an invalid bearer
  token and no cookies: the tenant answers **401** on `GetChildProcessGroupTreeItems`,
  the BFF process list and `ReorderTreeNodes`, but **302** on `GET /Api/v1/Processes/{id}`
  and `POST /Process/Edit/ArchiveProcess`. It never answered 403. `pmRequest` uses the
  default `fetch`, which follows the 302 to a login page, gets HTML with a 2xx, and
  `JSON.parse` throws. The proxy then returns a 500 "Unexpected error" per process, and
  the operator is never told to sign in again. Nothing is written, so it's safe, but a
  long run would fail every row. Fix:
  - call `fetch` with `redirect: 'manual'` and treat any 3xx from the tenant as a dead
    session, exactly like 401 (`signedOut: true`);
  - when JSON is expected and the body isn't JSON, raise a `PmError` with the status and a
    short excerpt, not a `SyntaxError`;
  - keep 403 as a per-process refusal. That was the right call.
  - Tests: a 302 and a 2xx HTML body each sign out cleanly mid-run, and the runner stops.
- **Destination picker layout.** On `/move`, "Choose where it goes" renders radio
  buttons centered and labels pushed to the right edge, wrapping. Cause: the radio
  `<input>` in `li.tree-row` (a flex row) computes to `width: 579px`, so a global
  input width rule is reaching radios. Scope that rule to text inputs, or set
  `.tree-row input[type=radio] { width: auto; flex: none; }`.
- **Move result rows read like the preview.** After the run, each process row still
  says "Its open draft will be published along with the move." Use the final read to say
  what happened, with the version: for example "Moved. Published as 2.0; the open draft
  went live." The preview wording stays as is.

---

## W5. Bulk Delete engine

Status: Ready. Phase 1 (tests and fixtures) done in d09159a and **reviewed by Cowork**;
phase 2 (discovery) is next

### Cowork's review of phase 1 (18 Oct)

Approved. The assertion accounting, the stub-and-skip approach and keeping fixtures in
place are all right. Do these as part of phase 2:

- **Fix the fake tenant's archived read.** It's wrong where it claims to follow the
  measured tenant. `GET /Api/v1/Processes/{id}` for an **archived** process answers
  **200** with a body of only `{"success": true, "isArchived": true}` (no
  `processJson`). Measured twice on 18 Oct, in S1 and in the S2 cleanup. **404 is for a
  deleted process** (measured after `DeleteProcess`). So in the fake:
  - `readModel` on an archived process returns that envelope with no model, not a 404;
  - `archiveState` returns `found: true, isArchived: true`, which matches what the live
    `getArchiveState` already reads from the envelope;
  - 404 only after a delete.

  Any engine code that treats "not found" as "archived" has to treat "200 without
  `processJson`" that way instead. Check which ported tests change; that's the point.
- **Phase boundaries.** Move `newDependencyPlan` and `ledgerToPlanRows` into discovery,
  so the discovery PR produces a complete read-only plan. That lets Cowork run a live
  dry run against the demo tenant and compare it to the script's R3 numbers before any
  mutation code exists. Keep the orchestrator scenarios under unwind.
- **T2's operation.** Yes, distinct: `ReArchiveOrphanedHolder` for a holder that was
  parked in the holding group because its own group is gone, with a message saying it
  stays archived without a group. Ordinary holders keep `ReArchiveHolder`.
- **Plan file in camelCase:** fine. Web plans only round-trip with the web app.
- **Fatal errors reject `runBulkDelete`:** fine, provided the page catches it and offers
  resume from the saved plan. Make that a W6 requirement.
- **Commit `9d70974`** was JB's commit from outside the session. Squash-merging the PR is
  fine.

This is the big one, so break it up: one PR per phase (tests and fixtures first, then
discovery, hold, reference removal, checkpoints, delete, unwind), each green on its own.
Stop and report after each PR rather than running all of it in one session. Cowork will
check each phase against the PowerShell's behavior before the next one starts.

Port `NintexProcessDependencies.ps1` into `web/src/lib/delete/`, phase by phase as the
spec lists them, with the offline tests and `Tests/Fixtures` ported first so behavior
equivalence is checked as you go. Includes, as new behavior:

- **Old T1.** The unwind puts back every process the run un-archived, holders and
  targets, one results row each, on every exit path including a resumed run. A results
  file never omits a process the run changed.
- **Old T2.** An orphaned dependency holder (its group is gone) is restored into the
  holding group, read there, and re-archived before `Remove-HoldingGroup`, with its own
  results operation.

Variation siblings come from `variationSetData.OtherVariedProcesses` at planning time,
so the preview can name them before the run; the R3 collateral checkpoints stay as the
backstop.

The plan ledger goes in IndexedDB. The plan file is downloadable and can be re-uploaded
to resume or unwind.

---

## F3. Two small things from the W5 parity check

Status: Ready (after W5 phase 2)

- `resolveSelection` overflows the stack if the tenant ever lists a group as its own
  descendant. Keep a visited set and report the cycle as an excluded item with a reason,
  rather than throwing.
- The `/archive` variation warning should say what the script said: a master that's
  dragged in by its variation ends up in the archived list, which is where a later Bulk
  Delete takes its targets from.

---

## F4. Fixes from the W4 live test

Status: Ready (after F3)

W4 was tested live on 18 Oct with four test processes. The SCIM lookup, the
unknown-user and non-GUID refusals, "Match current state" and the results file all
worked, and the tenant matched: the in-progress process was saved only (0.2 to 0.3, new
owner); the published one was saved and republished (1.0 to 2.0, owner set to the
placeholder, new expert). Two fixes:

- **An archived process fails instead of being skipped.** Its row read "Failed. Could not
  be read (no response): Unexpected error handling the request." `GET
  /Api/v1/Processes/{id}` for an archived process answers 200 with only `{"success":
  true, "isArchived": true}` and no `processJson` (measured again today), so
  `getOwnership` must treat a 200 without `processJson` and with `isArchived: true` as
  "Skipped. The process is archived." and not throw. This is the same shape as the W5
  fake-tenant note; put the check in one shared helper both use.
- **Rows that are skipped or failed always say "(name unavailable; not in any process
  list)".** That was shown for a live process (the unknown-user row) and an archived
  one, both of which are in a list. Look the name up from the active index and the
  archived listing for every row, and only use that wording when neither has it.

---

## W6. Bulk Delete UI, and folder cleanup

Status: Queued (after W5)

Both entry points (tree and archived view), delete-by-group target resolution, the
collateral confirmation on screen, and the optional "delete now-empty groups" step,
deepest first, offered only for groups the run actually emptied. Reuse W2b's group
cleanup. After a delete, a group can still hold archived documents, which block deletion
(S1), so those groups are kept and reported.
