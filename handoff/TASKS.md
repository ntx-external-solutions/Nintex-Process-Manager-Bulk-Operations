# Tasks

Written by the Cowork session. The product is now a web app; read `handoff/SPEC-WEB.md`
before starting any task here. Work every task marked `Status: Ready`, in order, one PR
per task against `claude/main`. Tasks marked `Queued` are waiting on a spike or an
earlier task; don't start them.

The R11 tasks for the PowerShell (old T1 and T2) are superseded. They're folded into W5.
The PowerShell is frozen at v4.11: don't change it.

## Next handover (30 Oct): F7

W6 passed live in R15 on 30 Oct (review under W6). F7 is three small UI items from that
round. One PR, then stop for review. Don't run anything against the tenant yourself.

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
     {"id": "<tenant root uuid>", "parentId": null, "name": "<tenant name>",
      "position": 1, "type": "ProcessGroup", "url": "https://.../Process/Group/<uuid>", "version": null},
     {"id": "<group uuid>", "parentId": null, "name": "<group name>",
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

Status: Done (phases 1 to 7), reviewed by Cowork. Live test R13 run 19 Oct; fixes in F6

### Cowork's live test R13 (19 Oct)

The first live delete, through the app, on Cowork-built test content: 7 archived targets
and 10 holders covering every case in the R13 plan, plus probes. Drafts refused by
default, one draft holder ticked. All test content was removed afterwards and the tenant
is back to its baseline (top level, active and archived counts, and every pre-existing
process id).

**What worked**

- The two targets nothing blocked were deleted. The five held-back targets were
  re-archived in their own group. The holding group was created, used and removed. No
  collateral outside the test content.
- The ordering fix: of two holders of one target, the one with an open draft was refused
  and the clean one was left unedited ("every target it references is being kept"). Same
  for an active holder whose target another holder kept alive.
- The ticked draft holder published with the removal (1.1 to 2.0). A plain published
  holder republished at 2.0 with the link gone. The two deliberate open-draft holders,
  left unticked, were refused and their targets kept.
- An archived holder whose group had really been deleted was parked, re-archived in the
  holding group, and its row says the original group no longer exists.

**Your four open items**

1. **Delete with only the draft clean:** measured outside the app. The tenant refuses:
   HTTP 500 "Process Cannot Be Deleted", with `additionalInfos` naming the holder. A link
   is counted once per stored revision, so the published revision still holds it. Refusing
   draft holders by default is right; cleaning the draft alone frees nothing.
2. **Edit over a revision awaiting approval:** not measurable here. The demo tenant has no
   approvals (submit for approval answers 400). It stays offline-tested only.
3. **`breadcrumb/children` on a brand-new top-level group:** works, and lists a process
   restored into it.
4. **The new group in the tree:** appears at once, with its numeric id.

**Found (fixes in F6)**

1. **Every archived holder the run restored was refused as an open draft.** All four, one
   of them never published. Their targets were held back with no tick offered, because
   the holders were archived when the plan was made. A restore creates an in-progress
   revision (1.0 becomes 1.1, revision state 1), and the pre-save check in `executor.ts`
   can't tell that from a real draft.
2. **A false orphan, and the run made it real.** One archived holder's listing row said
   `groupExists: false` (group id 1), while its model named a group that was in the tree.
   The run parked it, re-archived it in the holding group, then deleted the holding
   group, so the process is now orphaned for real. Not reproduced; the cause is the
   listing's. This is the one that matters: the app destroyed a restorable location.
3. The `groupExists` coverage warning counted active rows, which never carry the field
   ("194 of 673 listing row(s) do not report groupExists"). Noise on every run.
4. The final "Permanent deletion" confirmation doesn't name the targets, or say which
   will be held back and why. That's decided after the confirmation today.
5. Holders refused because the operator left them unticked are `Failed` rows. They did
   what was asked.

### Cowork's review of phase 7 (18 Oct)

Code approved. The two engine defects you found offline (an archived holder only the
scan finds was never restored; a dead run's rows were lost) are real, and the script has
them too. Good catches. Decisions:

- **A holding group on every real run:** agreed.
- **The holding group's default name: not OK, fix as F5 before W6.** Every stranded group
  from rounds 2 to 4 was a default-named group nobody could tell from a real one, and PGM
  flagged the same risk (create-then-rename debris). See F5.
- **RestoreProcess not resent after a 5xx, the probe sent once:** agreed.
- **Variation siblings from `variationSetData` in W6, using the tree's `variationSetId`:**
  agreed.

R13 runs on Cowork-built test content and measures your four open items: a delete with
only the draft clean, an edit over a revision awaiting approval, `breadcrumb/children` on a
brand-new top-level group, and the new group appearing in the tree with its numeric id.

### Cowork's review of phase 6 (18 Oct)

Approved, with one ordering fix to make at the start of phase 7.

- **Fix: decide what's held back before removing any reference.** Today a holder's draft
  is detected at edit time, inside the removal loop. If target T is held by H1 (open
  draft, refused) and H2 (clean), and H2 comes first, H2 has its link to T removed and a
  new version published, then T is held back by H1 and survives. H2 has lost a working
  link for nothing, and nothing puts references back (the unwind restores archive state,
  not references). Fix:
  - before the first save, read every holder's write state (fresh reads, the same ones
    the removal would make) and compute the full held-back target set;
  - then remove references only for targets still being deleted. A holder whose only
    targets are held back is not edited at all; its row is Skipped, "every target it
    references is being kept";
  - keep the edit-time check as the backstop for a draft opened between that pre-pass
    and the save. If it fires, the row is Failed as now, and the plan log names the
    holders already edited for that target, so the operator knows which links went for
    nothing;
  - tests: H2-before-H1 ordering leaves H2 unedited; a draft opened between pre-pass and
    save is still refused and logged.
- **Not archiving a held-back target in the pre-delete pass:** agreed.
- **A failed pre-delete archive is logged and the delete still goes ahead:** agreed. A
  failed archive call can still take effect, and the delete's own result settles it.
- **Draft detection by revision state at edit time, unknown version counts as
  published:** agreed.
- **Logging the failed holding-group read:** good.
- **Count line and the draft-holder heading:** what was asked. Cowork will see them on
  the next dry run.

Phase 7 is the one that first writes to the tenant from the browser. Before it lands,
Cowork will build the R13 test content (see `CONTEXT.md`). The live test covers the two
open questions you listed: whether a delete is refused when only the draft is clean, and
editing over a revision awaiting approval.

### Cowork's review of phase 5 (18 Oct)

Approved. Live dry run on R11's set after PR #66: **0 blocking mismatches**, 1 over-claim, 20
double-counted links, 3 pairs `MatchAcrossCategories`, nothing unread by the scan. That is
exactly what Cowork's raw-model check predicted (24 = 20 + 1 + 3; the 21st doubled pair
now clears across categories, as it should).

- **Small:** the summary doesn't say how many pairs reconciled across categories (your
  report says a count line covers them; it isn't on the page). Add it.
- **A holder with an open draft: refuse by default, opt in per holder.** Saving the
  removal into the draft leaves the reference in the published version, so the delete
  either fails or leaves a dangling link. Publishing silently puts someone else's draft
  live, which S2 showed is easy to do by accident and can't be undone. So treat it like
  Move's "Tick to move":
  - in the plan, list holders with an open draft under their own heading, with the
    target each one blocks;
  - unticked (the default), the holder's row is Failed before any save, "has an
    unpublished draft; removing the reference would publish it", and its targets are left
    out of the delete with that reason;
  - ticked, save and publish, and say in the row that the draft went live.
  The live test will also measure whether the tenant refuses a delete when only the draft
  is clean, in case "save the draft only" turns out to be enough.
- **Editing over a revision awaiting approval:** fine as specified. It's unmeasured on an
  edit, so it's on the live test list.
- **`writeStateOf`'s version fallback, refusals as Failed rows that stop at verification,
  not reversing a pure move, one stop message:** all agreed.

### Cowork's live check after phase 4 deployed (18 Oct)

Dry run on R11's set: 21 double-counted (right), 1 over-claim (right), nothing unread by
the scan (right; the archive-wide read now takes 73s instead of 44s, which is the full
archive actually being read). But **2 blocking mismatches remain where 0 were expected**,
and they're the two Input pairs the cross-category rule was meant to clear.

Cause: `reconcileDependencies` counts Input/Output sites per category only where the
**queried** process is the holder (`claims.ts` line 223, the R2 scoping rule, which is right
per category). The pair-level total is the sum of those per-category counts, so an Input
held by the **related** process is never counted. In both pairs, the related process
(an archived variation record in one pair, an active process in the other) holds `Inputs.Input[0]` from the
target, and the plan does have that site.

Fix at the start of phase 5, with the publish-path fix below: the pair-level located total
is **every planned site between the two processes, in either direction and any
category** (child sites included). Keep the per-category numbers and scoping for each
row's own status. Add a test with exactly R11's shape: a Link claimed on the target, an
Input held by the related process, which must come out `MatchAcrossCategories`. After the
fix this set should show 0 blocking mismatches.

### Cowork's review of phase 4 (18 Oct)

Approved, with one change to make at the start of phase 5. The batch fix, the
three-way gate and the removal port are what was asked.

- **Fix: decide the publish path from the process, not from `approvalsEnabled`.**
  `saveProcessModel` chooses `DoSubmitForApproval` and the publish route from an operator
  flag, and its default disagrees with its caller's (`false` in `saveProcessModel`, `true`
  in `removePlanReferences`). That's the "declared, not read" pattern R10/R11 removed from
  archive. The holder's fresh read already carries `processActions`, and W4's
  `chooseWritePath` (PGM's rules, `ownership/plan.ts`) already makes this decision for
  ownership saves. Move the decision into a shared module that takes `processActions` and
  the revision state, and have both ownership and removal call it:
  - `CanPublishAfterEdit` true: save with `DoSubmitForApproval: false`, then
    `POST /Api/v1/Processes/{id}/Publish` with `IsPublishNow: true` and `PublishMessage`
    (measured working on this tenant, S2 and W4);
  - only `CanSubmitForApprovalAfterEdit` true: save with `DoSubmitForApproval: true`, then
    the same Publish;
  - neither: the row is Failed "cannot be republished by this account", before saving.
  - Drop `PublishProcessRevisionEdit` from the removal path. It has never been measured on
    the web app, and one publish route is easier to trust than two. Keep
    `approvalsEnabled` only for what its comment says: permission to override a pending
    approval.
- **Located above claimed is not a mismatch:** agreed. Every located site is removed, so
  finding more than claimed can't leave a reference behind.
- **Over-claims judged on the pair:** agreed.
- **The escape hatch for "nothing located":** keep it, with two conditions: the
  confirmation names each pair, and an unattended run (or no answer) stops. In practice a
  real leftover reference makes the tenant refuse the delete, and the unwind puts things
  back.
- **The three deliberate differences from the script** (failed re-read is a Publish
  failure, unreadable at verification fails, no one-second sleep): all agreed. R3 measured
  that the index doesn't lag, and W4 confirmed a read straight after a save.
- **Unread means any non-fatal failure:** agreed.
- **A real run must stop on `PlannedIncomplete`:** agreed. Make it a hard rule in the
  orchestrator, with no override, and name the unread ids in the stop message.

Live check (Cowork, read-only, after this PR deploys): R11's set should show 0 blocking
mismatches, 1 over-claim, 21 doubled links, 2 pairs reconciled across categories, and
nothing unread by the scan.

### Cowork's live check after phase 3 deployed (18 Oct)

The dry run on R11's set shows exactly what it should: 21 double-counted, 3 mismatches, 11
holders with no group (in the same four deleted groups R11 hit), 4 orphaned targets. Two
things for phase 4, both in `API_ARCHITECTURE.md`:

- **Bug, fix first: the archived batch read takes at most 20 ids.** The tenant answers
  21 or more with 400 "The processUniqueIds parameter maximum size is 20." We use 25, and
  `findHiddenInputOutputReferences` skips a failed batch silently, so the archive-wide
  Input/Output scan reads only the last partial batch: 18 of 19 batches lost on the demo
  tenant. The script has the same bug. Fix:
  - `ARCHIVED_BATCH_SIZE = 20`, and the proxy's `processes.archivedModels` limit 20;
  - a batch that fails with a 4xx is **not** skipped: the plan records which ids went
    unread, names them, and comes back `PlannedIncomplete` with that reason (a dead
    session still stops the run);
  - a test with 45 archived ids that asserts every one is read, and one where a batch
    fails that asserts the plan says so.
- **Mismatches: safe to relax, with one rule.** Cowork searched both raw models of all 24
  mismatched pairs for every mention of each other: the count equals the plan's sites in
  24 of 24. Nothing was missed. So:
  - **`doubleCounted` no longer blocks.** Make the one-line gate change. Keep the
    separate section in the summary.
  - **Reconcile a pair across categories before calling it a mismatch.** Two of the
    three are Input references the API labels "Linked Process" (claimed 1 Link, 1 Input
    located). Compare the pair's total claims with its total located sites, and only
    report a mismatch when the located total is lower. Keep the per-category numbers in
    the note.
  - The third (a variation's single `Decision[0]` claimed 3 times) stays a mismatch.
    Over-claims (located >= 1 but fewer than claimed) should need an explicit
    acknowledgement on screen, not block outright. A pair with **nothing** located still
    blocks.

### Cowork's review of phase 3 (18 Oct)

Code approved. Start phase 4.

- **Keeping restore and create-group out of the allowlist until the unwind exists is the
  right call.** It's exactly how R11 went wrong. It means the live test of hold, removal
  and delete happens together once the orchestrator lands. Cowork will do that on
  test content it builds, including an orphaned holder, and check every process ends
  where it started.
- **`doubleCounted` as a flag, the mismatch gate unchanged:** agreed. Cowork confirmed
  the shape on one pair. Before the gate changes, Cowork will check all 21 pairs on the
  R11 set against the holders' models after this PR deploys, and say so here. Then it's
  your one-line change.
- **Snapshot falling back to the listing's group UniqueId,** and **the extra dry-run
  warnings:** both fine.
- Live check still to do (Cowork, after deploy, read-only): the dry run on R11's set
  should show 21 double-counted links, 3 mismatches, 11 named holders with no group and 4
  orphaned targets.

### Cowork's review of phase 2 (18 Oct)

Approved. Live dry run on the deployed app, first 20 archived processes (R11's target
set), compared against direct reads of the tenant:

- **74 claims**, identical to calling `CheckProcessDependencies` (flags 31) on each
  target directly. 29 holders, 33 reference sites, 42 archived participants, status
  `PlannedIncomplete`, 42s.
- **24 reconciliation mismatches**, the same count R11 reported from the PowerShell.
- **11 archived holders whose groups are gone**: the same eleven that blocked R11. Plus 4
  orphaned targets.
- An unlisted participant was recovered by direct fetch, as the script does.
- Nothing changed on the tenant: archived count unchanged, all 20 targets still archived,
  nothing restored in the plan.

For phase 3:

- **Name the orphaned holders in the dry run.** The ledger already has them
  (`wasArchived`, `originalGroupExists: false`, role Holder), but `orphanedHolders` is
  empty in a preview and the summary doesn't mention them. Add a line such as "11
  archived holders have no group. A real run parks them in the holding group, reads them
  there and re-archives them (T2)", with their names. That's the R11 blocker, and it
  should be visible before anyone runs a delete.
- **Most of the 24 mismatches are the API double-counting links.** Cowork measured it
  (`API_ARCHITECTURE.md`, "Why links reconcile as 'claimed 2, located 1'"): the
  dependency check lists every linked process twice, and the holders' models hold one
  reference each. Don't change reconciliation's rule yet, but **classify** the exact
  shape "Link, claimed = 2 x located, located >= 1" as `DoubleCounted` and report it
  separately from real mismatches, so the three that are different stand out. Cowork
  will investigate those three before the delete phase.
- **W2's 404 branch** in `archive/outcome.ts` (you flagged it): 404 means deleted, not
  archived. Change the branch and its comment to report "Not found; it may have been
  deleted" as Failed. Small; do it in this PR.

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

Status: Done (c5c7933)

- `resolveSelection` overflows the stack if the tenant ever lists a group as its own
  descendant. Keep a visited set and report the cycle as an excluded item with a reason,
  rather than throwing.
- The `/archive` variation warning should say what the script said: a master that's
  dragged in by its variation ends up in the archived list, which is where a later Bulk
  Delete takes its targets from.

---

## F4. Fixes from the W4 live test

Status: Done (ba4028b)

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

## F5. Name the holding group so it can't be mistaken for a real one

Status: Done (0460630)

After `group.create`, record the new group's ids in the plan **first** (already done),
then rename it with `POST /Process/Edit/RenameGroup` `{processGroupUniqueId, newName}`
(PGM's `renameGroup`; measured working with a bearer token in PGM and from the browser in
S1). Name it `Bulk Delete holding group (temporary, <run start UTC>)`. Add
`group.rename` to the allowlist, taking exactly one group GUID and a name. A failed
rename is logged in the plan and the run carries on: the group is still recorded and
still removed at cleanup. If cleanup can't remove it, the stop message and the
`Cleanup` row give its name, so an admin can find it in the tree. Tests: the rename is
sent after the ids are saved; a failed rename doesn't stop the run.

**Deferred by JB (19 Oct):** the sign-in token duration (`duration=60000`, about 41 days)
stays as it is for now. Not a task.

---

## F6. Fixes from live round R13

Status: Done (5cc92e1, 7530db3, c72f5ec, 2a031c9, 8a6de40, e6a092c)

### Cowork's review of F5 and F6 (19 Oct)

Code approved; 547 tests pass on Cowork's run too. Your five decisions:

- **The orphan check on targets as well as holders:** agreed. A held-back target is
  stranded the same way.
- **A failed group lookup tries the model's group first:** agreed. RestoreProcess answers
  500 for a group that doesn't exist (measured), so the fallback to parking is safe.
- **An active target refused deletion is made active again in its group:** agreed; it
  matches where a held-back active target stays. One addition, corrected after R14: the archive pass
  publishes a new major version and the restore opens an in-progress revision on top
  (1.0 becomes 2.0, then 2.1), so the row should say both. Otherwise the owner finds a
  version and a draft nobody made. In W6, not a new PR (see W6).
- **The confirmation before any reference is removed:** agreed, that's the point of item 4.
- **No new version number on the restored holder's row:** fine. The R13 re-run reads the
  versions from the tenant instead.

Noted, not a change: a restored holder now has no save-time draft backstop, so a draft
someone opens on it between the restore and the edit would be published. The window is
minutes and the holder is archived again at the end. Accepted.

Your four unverified items go on the R13 re-run (R14): what a restored never-published
process looks like, a deleted group's breadcrumb, the `additionalInfos` shape, and the
holding group's new name in the tree.

From Cowork's live test R13 (under W5). Items 1 and 2 are engine bugs; do them first.

1. **Don't take the revision our own restore created for an open draft.** Restoring an
   archived published process creates an in-progress revision (measured: 1.0 becomes 1.1,
   `ProcessRevisionStateId` 1), so the pre-save check (`isOpenDraft` in `executor.ts`,
   "Checking holders for open drafts") refuses every restored published holder. A
   restored never-published holder was refused too, so `writeStateOf` likely doesn't see
   `publishedVersionExists: false` after a restore; check, and add a fixture for it.
   Fix: for a holder with `restoredByThisRun`, judge the draft from its archived model,
   read before the restore (the batch read already has it). No draft there means the
   in-progress revision is ours: choose the path as for a clean holder (publish when a
   published version exists, save-only when not), and the unwind re-archives it as now.
   A real draft there keeps today's refusal, and the holder is offered as a tick like an
   active one. The row should say what happened, e.g. "Removed 1 reference(s), published
   as 2.0, re-archived". Tests: restored published holder with no prior draft is edited
   and published; restored never-published holder is saved only; archived holder with a
   draft before the restore is refused and offered as a tick.
2. **Confirm an orphan before parking it.** `findOrphanedGroupProcesses` trusts the
   listing's `groupExists`. Measured once: `false` with group id 1 on a process whose
   model (`ProcessGroupItems.ProcessGroup`) named a group that exists. Treat a process as
   orphaned only when the listing says so **and** that group isn't in the tree discovery
   already walked (or a breadcrumb read fails to find it). When they disagree, restore it
   into its group as an ordinary archived holder and add a warning row naming the
   disagreement. When the model is unreadable or names no group, keep today's behavior.
   The `ReArchiveOrphanedHolder` message ("its original group N no longer exists") must
   only appear after this check. Tests for all three cases.
3. **Coverage warning over archived rows only.** Active rows never carry `groupExists`, so
   `groupExistsCoverage` should count archived entries only.
4. **Name the targets in the final confirmation.** Run the draft check (item 1, reads
   only) before the "Permanent deletion" confirmation, so it can list the targets that
   will be deleted, the ones held back with the holder and reason, and the holders that
   will be published. The executor still re-checks at save time and reports any change.
5. **Unticked draft holders are `Skipped`, not `Failed`.** Keep `Failed` for errors.
6. **Show why the tenant refused a delete.** `DeleteProcess` refuses a still-referenced
   target with HTTP 500 "Process Cannot Be Deleted" and `additionalInfos` naming the
   blocking items (measured from the browser; shape not captured, so read it defensively
   and fall back to the raw body). Put those names in the `Delete` row with StatusCode
   500, re-archive the target as for any held-back target, and don't retry.

---

### Cowork's live test R14 (19 Oct): pass

The R13 cases again, through the app after PRs #70 to #72, on Cowork-built test content
(7 targets, 6 holders, removed afterwards; tenant back to its baseline, every
pre-existing id present). 18 rows: 16 Success, 2 Skipped, 0 Failed. The tenant matched
every row.

- **F6 item 1:** the three restored archived holders (published, never published, and one
  archived over an open draft) and the orphaned one were all edited, published and
  re-archived ("restored from the archive for the edit, and archived again"). None was
  offered as a tick. Their targets were deleted.
- **F6 item 2:** the real orphan was confirmed (its group's breadcrumb is empty), parked,
  re-archived in the holding group and reported as "already orphaned". The listing was
  right this time, so the disagreement path wasn't exercised live; it rests on the tests.
- **F6 item 3:** no `groupExists` coverage warning.
- **F6 item 4:** the confirmation named all six targets, the one kept and the holder
  keeping it, before any holder was edited (checked on the tenant at that moment).
- **F6 item 5:** the unticked draft holder and its kept target are `Skipped`.
- **F5:** the holding group showed in the tree as `Bulk Delete holding group (temporary,
  <UTC time>)` and was removed at cleanup.
- An active target nothing held was archived and deleted. The kept active target was left
  active and untouched (still 1.0, no new revision).

**Your four unverified items**

1. **A restored never-published process:** there's no such thing. Archiving publishes a
   new major version: a never-published 0.3 is archived as 1.0 and a published 1.0 as
   2.0 (the archived model has `ProcessRevisionStateId` null). A restore then opens an
   in-progress revision on top (1.1, 2.1). That's why R13 refused it: after the restore it
   looks published with an open draft. Your fix handles it, and publishes it.
2. **A deleted group's breadcrumb:** HTTP 200 `{"isChildren":false,"breadcrumbItems":[]}`.
   A live group gives the tenant, the parents and itself.
3. **`additionalInfos` on a refused delete:** HTTP 500
   `{"additionalInfos":{"linked Process":["<holder name>"]},"caption":"Process Cannot Be
   Deleted","errorMessage":"Process cannot be deleted as it has links to the following
   items","field":""}`. An object keyed by category, each a list of names. Your reader
   handles it; add this exact body as a fixture.
4. **The holding group's new name in the tree:** yes, as above.

**One consequence for F6 item 1:** an archived holder with "a real draft" can't exist,
because archiving publishes the draft. The archived model never shows one, so the
refuse-and-offer-a-tick branch for archived holders never fires. Leave it as a guard,
but say so in its comment and test name.

## F7. Small items from live round R15

Status: Ready

1. **The plan summary miscounts holders.** It says "2 process(es) to edit" when the Holders
   panel shows 1 to be edited and 1 skipped for an open draft. Count only holders that
   will be edited, or say "2 holders: 1 to edit, 1 skipped (open draft)".
2. **The phase 2 heading reads as if rows are missing.** "Phase 2: deleted (9; 5 already
   archived)" sits over a table of the 5 already archived. Title the table for what it
   lists (for example "Phase 2: already archived, deleted (5)") and keep the overall count
   in the summary line.
3. **Say when a tenant call is being retried.** In R15 one tree read during cleanup hung
   for about 60 seconds, then the tenant answered 500 ("Your request could not be
   completed at this time"), and the retry succeeded. The page sat on "Deleting 2 of 2"
   the whole time. Show a short "Process Manager is slow to answer, retrying" status
   while a retry is pending, on every page that uses the shared progress line.

**Done when:** offline tests cover the holder count with a skipped holder and the retry
status appearing and clearing.

---

## W6. Bulk Delete UI, and folder cleanup

Status: Done (d10ec1b, 8338ee6, 6fb8676, 362ad0a). Live test R15 passed (30 Oct)

### Cowork's review of W6 (R15, 30 Oct)

Approved. Your decisions stand: cleanup candidates are checked groups a deleted target was
in; a partial variation set is left out by default; the collateral gate is always on
screen. R15 answered your live-test list:

- **Delete by group:** the archived processes the listing places in a checked group were
  exactly the ones expected, two levels below groups never expanded. A partly checked
  parent still took in its own archived process; the unchecked subgroup's stayed out.
- **The archived view:** the model check moved 26 of 191 `groupExists: false` rows. Cowork
  read all 191 models and resolved each group by breadcrumb: the same 26 are live, the
  other 165 are real orphans. The listing's flag is wrong on 14% of those rows, every
  time, so the check is load-bearing.
- **Cleanup after a delete:** documents check, fresh read and `DeleteGroup` all ran. Two
  groups deleted deepest first, two kept with the kept-subgroup reason.
- **Version reads on a refused active target:** not exercised. Nothing was refused.
- **The collateral table and the variation panels:** not exercised. No collateral, and no
  test variation set.
- One transient 500 on a tree read (about 60 seconds, then retried successfully). Handled
  correctly; the UI gap is F7 item 3.

Both entry points (tree and archived view), delete-by-group target resolution, the
collateral confirmation on screen, and the optional "delete now-empty groups" step,
deepest first, offered only for groups the run actually emptied. Reuse W2b's group
cleanup. After a delete, a group can still hold archived documents, which block deletion
(S1), so those groups are kept and reported.

Also in W6, from R14:

1. **Say what a refused delete did to an active target.** The archive pass publishes a new
   major version, and making it active again opens an in-progress revision on top (1.0
   becomes 2.0, then 2.1). The row should say so, e.g. "Not deleted, so made active again
   in group N. Archiving published it as 2.0, and the restore opened 2.1."
2. **An `Archive` row for each active target the archive pass archives** before
   deleting it. R14's active target was archived and deleted with only a `Delete` row.
3. The F6 guard for an archived holder with a draft never fires (see R14 under F6):
   update its comment and test name to say it's a guard.
