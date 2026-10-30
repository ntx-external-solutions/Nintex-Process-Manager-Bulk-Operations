# Report

Written by Claude Code after each task. Newest at the top.
Per task: commit hash, what changed, functions touched, new results-file operations,
tests added and assertion count, anything deferred or disputed and why.

---

## F7. Small items from live round R15

Commit `1d39f00` on `claude/f7-r15-ui`.

1. **Holder count.** New `holderCountLine` in `delete/selection.ts`, from
   `previewHolders`. With no skipped holders it reads "1 holder to edit"; with one it
   reads "2 holders: 1 to edit, 1 skipped (open draft)". The plan summary uses it in place
   of `plan.workItems.length`, which counted the draft holders too.
2. **Phase 2 heading.** "Phase 2: already archived, deleted (5)". The overall count stays
   in the summary line above ("N process(es) to delete: ...").
3. **Slow calls.** New `lib/ui/slowCalls.ts` (`SlowCalls`, `slowCalls`, `slowMessage`).
   `callPm` reports each call's start and end. After 15 seconds without an answer, a
   second line under the progress line reads "Process Manager is slow to answer (20s so
   far). Still waiting, and a failed read is retried." The seconds move every 5 seconds,
   and the line clears as soon as the call answers. New `Progress` in `_ui/kit.tsx`
   replaces every `<p className="pending">` progress line on Archive, Move, Ownership,
   Delete (including the archived-view note) and the cleanup panel.

**Where I differed from the brief.** The brief asks for a status "while a retry is
pending". The retry happens in the proxy (`pmRequest` retries reads on a 5xx or a
dropped connection), inside the single request the browser makes. The browser never
sees the 500 or the retry. It only sees a call that hasn't answered. So the status is
keyed on time waited, not on the retry, and its wording doesn't claim a retry is
underway. In R15's case (60 seconds, a 500, then a retry that worked), it would have
shown from second 15 until the answer came back. Showing the retry itself would mean
moving read retries out of the proxy into `callPm`. That's a bigger change, and it
shortens how long one serverless request can run. Say if you want it.

**Functions touched.** `delete/selection.ts` (new `holderCountLine`),
`ui/gateway.ts` (`callPm` now wraps the new `sendToProxy`), `_ui/kit.tsx` (new
`Progress`), and the five pages and panel above.

**Results-file operations.** None new or renamed.

**Tests.** 574 tests, all pass, none skipped (570 before). One new test for the holder
count with a skipped holder. Three for the slow status: it appears past the threshold,
it updates, it clears on answer and stops its timer, it follows the oldest call still in
flight, and its snapshot stays stable. Typecheck and build are clean.
`Tests/Run-AllTests.ps1` wasn't run: there's no `pwsh` on this machine, and the
PowerShell wasn't touched. `$script:ScriptVersion` isn't bumped either, because the
PowerShell is frozen at v4.11.

**For R16.** Watch for the slow line on a slow tenant call. It can't be forced from
outside; the closest is a large archived view or a cleanup tree read.

---

## W6 follow-up. Closing the gaps against the W6 brief

Commit `362ad0a` on `claude/web-w6-delete-ui`. The full W6 brief was more detailed than
the TASKS entry the first three commits were built from. It differed in two places and
added four things. This commit brings the branch in line with the brief. The engine is
unchanged.

**Reversed from the first commits, as the brief says:**
- **Cleanup after a delete is W2b as it is.** `planCleanup` loses the `archivedProcesses:
  'keep'` option, and `CleanupPanel` loses the prop. A group still holding archived
  processes (targets held back, for example) is offered, and the warning names each
  process it would orphan. A document still keeps a group, with W2b's reason text.
- **A variation set is deleted whole or not at all.** `applyVariationSets` leaves out
  every selected member of a set that is only partly selected, with a `Select`
  `Skipped` row naming the missing siblings. The plan shows each set with every member
  named. Ticking a set rebuilds the plan with the missing members added as targets
  (source "Its variation set ticked in whole"). The old "I have reviewed the variation
  warnings" tick now gates only name-match masters and unread sets.

**Added:**
- **The archived view confirms each `groupExists: false` row** (`confirmArchivedOrphans`
  in `groups.ts`). It reads archived models in batches of 20, then runs the F6
  `confirmOrphan` check. A row whose model names a group the tree has moves to that
  group, under its real breadcrumb path, with a `GroupCheck` `Warning` row
  (`groupDisagreementRow`). The page lists these corrections. If the process becomes a
  target, the row goes in the results file. A row whose group couldn't be looked up
  stays in the orphan bucket and is counted on the page. `resolveDeleteSelection` takes
  the corrections, so a checked group also takes in a corrected process.
- **Revalidation before the run** (`deletePlacements`, then `revalidatePlacements`): each
  checked group in its parent and each tree target in its group, as Archive and Move
  do. Stale findings show on the plan with "Build the plan again".
- **Holders in the preview** (`previewHolders`): holders to be edited (with site counts),
  holders to be skipped for an open draft (unticked, as the run's own question starts),
  and the targets they hold back, each with its holder named.
- **The collateral gate is always on screen.** The "Accept collateral changes in advance"
  checkbox is gone, and the page always passes `acceptCollateral: false`. Every
  collateral checkpoint, and the variation pre-flight, now asks on screen with the table
  that names each process.
- **Never the holding group in cleanup:** `groupsTheRunDeletedFrom` takes the plan's
  holding group id and drops it from the offer.
- The phase tables are titled "Phase 1: archived, then deleted in phase 2" and "Phase 2:
  deleted".

**Functions touched.**
- `delete/selection.ts`:
  - new: `applyVariationSets`, `previewHolders`, `deletePlacements`, `corrected`;
  - changed: `resolveDeleteSelection` (`corrections`), `groupsTheRunDeletedFrom` (holding
    group);
  - new source kind `variation`.
- `delete/groups.ts`: new `confirmArchivedOrphans`.
- `cleanup/plan.ts`: `CleanupPlanOptions` removed.
- `app/components/CleanupPanel.tsx`: `archivedProcesses` prop removed.
- `app/delete/page.tsx`.

**Results-file operations.**
- No new operation names.
- `Select` `Skipped` rows now also cover variations left out.
- `GroupCheck` `Warning` rows now come from the archived view too.
- With the 'keep' option gone, cleanup after a delete can write `GroupDeleted` `Orphaned`
  rows (W2b's).

**Tests.** 570 tests, all pass, none skipped (562 before). Typecheck and build are clean.
`pwsh` is not installed on this machine, so `Tests/Run-AllTests.ps1` was not run. The
PowerShell is untouched.
- `selection.test.ts`, +9:
  - a group checked in a partly expanded tree takes in the unopened levels, active and
    archived;
  - shortcuts and document groups can't be ticked and never become targets;
  - the model check corrects a false `groupExists: false` (its bucket, path, row, and
    being taken in by group) and leaves a real orphan alone;
  - a partial set is left out by default;
  - a ticked set comes in whole, and a whole set needs no tick;
  - the holder preview;
  - revalidation placements;
  - no holding group in cleanup.
- `cleanup.test.ts`: the 'keep' test is replaced by a nested one. It checks that an
  emptied group is deleted, a group with a document is kept, a group with a held-back
  archived process is offered with it named, and the parent is kept for its kept
  subgroup.
- The `Archive`-then-`Delete` rows and the refused-delete wording are covered by the
  existing `deletion.test.ts` and `orchestrator.test.ts` tests from `d10ec1b`.

**Offline drive.** All ten drivers pass against the mock: the six delete drivers, plus
archive, move, ownership and expired. `drive-delete-group`:
- shows the two phase tables and the Holders panel;
- writes `Archive`, then `Delete`, for the active target;
- deletes Finance / Retired through cleanup, with a `DeleteGroup` row.

The new variation and orphan panels don't appear in a drive, because the mock has no
variation sets and no `groupExists: false` rows. They are covered by unit tests.

**For Cowork's live test, on top of the list under W6:**
1. The archived view on the demo tenant: how many `groupExists: false` rows the model
   check moves, and that each one's group really is in the tree.
2. A partly selected variation set: left out with its row; ticked, it is deleted whole.
   Watch the master's state after the delete, since that is the R3 risk.

**Where I'd question the brief.** The variation default is right while the post-delete
collateral checkpoint is unproven live. Once a live round has seen it fire, warning
instead of excluding would be friendlier. I've kept the brief's default.

**Superseded decisions from the W6 section below:** "after a delete, a group holding an
archived process is kept" and "the variation review is required before the run" no
longer hold. The other three stand.

---

## W6. Bulk Delete UI, and folder cleanup

Commits on `claude/web-w6-delete-ui`, cut from Cowork's R14 handoff commit (`4b40304`),
which goes into the PR untouched as its first commit:
- `d10ec1b`: the three R14 additions (engine);
- `8338ee6`: selection, cleanup candidates, and the collateral table (library);
- `6fb8676`: the page, the shared cleanup panel, the mock and drivers.

Cowork's R14 edits were already committed (`4b40304`, on the old F6 branch, not yet on
`claude/main`), so there was nothing left to commit first. I didn't change them.

**The three R14 additions.**
1. **A refused active target's row says what archiving and the restore did.** Before the
   restore, the run reads the archived model's version; after it, it reads the live
   version. The row now ends: "Not deleted, so made active again in group N. Archiving
   published it as 2.0, and the restore opened 2.1." If either read fails, the row says
   "a new major version" or "an in-progress revision on top" rather than guessing. That
   is two extra reads, made only for a refused active target.
2. **An `Archive` row for each active target the archive pass archives.**
   - `Success`, "Archived before the delete" (plus ", after the pending-approval
     override" when that ran);
   - or `Failed` with the archive's reason and status code, saying the delete was still
     sent.
   - A target the Hold restored gets no `Archive` row: it is going back to the state the
     run found it in, and its `Delete` row covers it.
3. **The guards.** The archived-draft branch is now labelled a guard in its comments
   (`checkHolderDrafts`, `RevisionBeforeRestore`) and test name. So is the
   never-published branch, which R14 showed can't happen either (archiving publishes a
   0.3 as 1.0).

Also from R14:
- The exact refusal body is a fixture, passed through `tenantMessage` as the proxy
  would. The row reads "Delete failed (HTTP 500): Process cannot be deleted as it has
  links to the following items. Still referenced by: <holder>." The parser needed no
  change.
- The fake tenant's archive now publishes a new major version with no revision state,
  as measured.

**The page.**
- **Three ways in, which add up:** the tree, the archived list, and ids or a CSV, as
  tabs. The archived list is read the first time its tab is opened, with breadcrumb
  paths.
- **Delete by group** (`resolveDeleteSelection`): a checked group means every process
  under it from the tree, plus every archived process in the index whose group is in
  the checked subtree.
  - The match is on the group's UniqueId, or its numeric id when the row has no
    UniqueId.
  - Orphans never match. They are picked from the archived list's own bucket.
  - A subgroup that is unchecked inside a checked group keeps its archived processes
    out.
- **The plan:**
  - two tables: "Archived first, then deleted" and "Deleted, already archived", each
    target with its group path and how it was chosen;
  - variation siblings (read from each tree target's `variationSetData`, with the name
    match beside them) and any sets that couldn't be read. The run stays disabled until
    "I have reviewed the variation warnings" is ticked;
  - the existing plan text.
- **Left out:** shortcuts, ids not found, and archived ticks that have gone since are
  listed under "Left out", and their rows go at the top of the results file.
- **The collateral gate** is its own panel: a table of process and what changed, with
  the same words as the text list (`collateralEntries`) and the notes under it.
- **The run** is unchanged. It gets the resolved ids, and the engine resolves them again
  against its own fresh read.
- **Cleanup afterwards** (`groupsTheRunDeletedFrom`, then the shared `CleanupPanel`):
  - Offered only after a run whose plan is `Completed`, and only for groups checked in
    the tree that a deleted target was in, or checked groups above one. They are
    checked against a fresh listing, deepest first.
  - `planCleanup` gains `archivedProcesses: 'keep'`. In a delete, a group still holding
    an archived process (one the run kept, or one not selected) is kept and the reason
    names the process. Archive keeps its old behaviour: it offers the group and warns
    about the orphans.
  - Documents, active processes, shortcuts and kept subgroups keep a group as before.
    Each group gets a `DeleteGroup` row.
  - A run that stopped, or whose fresh read failed, says why cleanup isn't offered.
- **A run that dies** still offers "Finish it" from the saved plan, as since phase 7.
  That was the W6 requirement from the phase 1 review.

**Functions touched.**
- `delete/executor.ts`:
  - new: `preDeleteArchiveRow`, `archiveAndRestoreVersions`;
  - changed: `returnActiveTarget` (reads versions), `deletePlanTargets` (`Archive`
    rows);
  - guard comments in `checkHolderDrafts`.
- `delete/ledger.ts`: guard comments on `RevisionBeforeRestore`.
- `delete/selection.ts` (new): `resolveDeleteSelection`, `groupsTheRunDeletedFrom`,
  `deleteVariations`, `selectionIds`, `selectionSummary`.
- `cleanup/plan.ts`: `planCleanup` takes `CleanupPlanOptions`.
- `delete/collateral.ts`: `collateralEntries`, and `COLLATERAL_NOTES` shared with
  `collateralLines`.
- `app/components/CleanupPanel.tsx`: moved from `app/archive/`, with `heading`, `offer`
  and `archivedProcesses` props. The archive page passes its old text.
- `app/delete/page.tsx`: rewritten around the above.
- `delete/testing/fakeTenant.ts`: archiving publishes a new major version.

**Results-file operations.**
- `Archive` is new in a delete run.
- `DeleteGroup` and `GroupDeleted` (Archive's) can now appear after a delete.
- `Select` and `Resolve` `Skipped` rows are new in a delete run, for what was selected
  and left out.
- The page's status list adds `Warning` (F6's `GroupCheck`), `Blocked` and `Orphaned`
  (cleanup's), so none of them is shown as unexpected.

**Tests.** 562 tests, all pass, none skipped (547 before W6). Typecheck and build are
clean.
- `deletion.test.ts`, +4:
  - versions that can't be read are described;
  - the R14 refusal body;
  - an `Archive` row only for active targets;
  - a refused archive is a `Failed` `Archive` row.

  The refused-delete test is updated to the versions wording.
- `orchestrator.test.ts`, +1: a refused active target end to end (`Archive`, then
  `Delete` with the versions, active at 2.1 in its group, not archived again). Two
  tests renamed `guard: …`.
- `selection.test.ts`, +8 (new):
  - a checked group takes in its subtree and its archived processes, with no group
    nobody checked and no orphan;
  - an unchecked subgroup stays out;
  - processes picked one by one bring no group;
  - the three ways in add up, each process once;
  - cleanup candidates, twice;
  - variations;
  - archived-view paths.
- `cleanup.test.ts`, +1: after a delete, an archived process keeps its group and the
  parent.
- `collateral.test.ts`, +1: the table carries the list's words.

Checked against the old code: the 6 new or updated engine tests fail with the old
`executor.ts`, and the cleanup test fails with the old `plan.ts`. The selection module
is new.

**Offline drive.** Every driver ran against the mock tenant in headless Chrome:
- `drive-delete-group` (new): check Retired.
  - The plan shows Old thing (archived first, picked in the tree) and an archived
    process from Retired (archived in a checked group).
  - The run writes 7 rows, all Success, including `Archive` before Old thing's
    `Delete`.
  - The cleanup offers Finance / Retired, deletes it, and adds a `DeleteGroup` row.
- `drive-delete-refused` (new): the R14 body. An `Archive` row, then `Delete` `Failed`
  500 naming the holder, ending "Archiving published it as 2.0, and the restore opened
  2.1."
- `drive-delete-archived` (new): a tick in the archived list plus an id. The plan shows
  both phases with group paths from the breadcrumbs, and no writes.
- `drive-delete`, `drive-delete-run` (now 6 rows, all Success: the new `Archive` row),
  `drive-delete-resume` (4 rows, all Success), `drive-archive` (its cleanup through the
  moved panel), `drive-move`, `drive-ownership` and `drive-expired` all pass.
- At 390px wide, the input and plan screens have no sideways scroll.

**Not verified offline. For Cowork's live test:**
1. Delete by group on the tenant: that the archived processes the listing places in a
   checked group are the ones the operator expects, including subgroups. They are
   matched on the listing's `groupUniqueId`.
2. The two version reads on a refused active target: that the mobile batch read serves
   the just-archived target with its new version, and the live read shows the restore's
   version afterwards.
3. Group cleanup after a delete on a real group: the documents check, the fresh read,
   and the `DeleteGroup` call are Archive's (R12), but they haven't run after a delete.
4. The collateral table was not shown in a drive, because the mock produces no
   collateral. It is tested as a function.

**Decisions I'd like from Cowork.**
- **Cleanup candidates are checked groups only.** A group whose processes were all picked
  one by one, or picked from the archived list, is not offered even if the run emptied
  it. The alternative is to offer every group a deleted target was in, which can offer a
  group nobody selected.
- **After a delete, a group holding an archived process is kept**, not offered with an
  orphan warning as after Archive. Delete by group takes in a checked group's archived
  processes, so one still there was kept by the run (held back, or refused). Deleting
  its group would strand it.
- **The variation review is required before the run**, as Archive's is. Before W6 the
  delete page had no preview of siblings. The run's own name-match question and the
  collateral checkpoints are unchanged.
- **A checked group with one process unchecked still takes in all its archived
  processes.** Unchecking speaks for that process only. The plan lists each archived one
  by name, so the operator sees them before running.
- **An archived target restored by the Hold gets no `Archive` row.** Its `Delete` row,
  or its `ReArchive` row if kept, covers it.

**Deferred or disputed.** Nothing deferred. The decisions above are where I went beyond
the task text.

---

## F6. Fixes from live round R13

Commits on `claude/web-f6-r13-fixes`. The branch is cut from the F5 branch because both
change the orchestrator, so the F6 PR shows F5's two commits until F5 is merged.

- `5cc92e1`: item 1, restored holders;
- `7530db3`: item 2, confirm an orphan;
- `c72f5ec`: item 3, coverage over archived rows;
- `2a031c9`: item 5, unticked is `Skipped`;
- `8a6de40`: item 4, the confirmation;
- `e6a092c`: item 6, a refused delete.

Item 5 went before item 4 because item 4 rebuilds the same check.

**1. The restore's own revision is no longer taken for a draft.**
- Just before the planner restores an archived holder, it records the holder's write
  state from its archived model as `revisionBeforeRestore` (`openDraft`,
  `publishedVersionExists`). This is kept on the plan ledger row, so a saved plan
  carries it.
- The draft check judges a restored holder from that record instead of the live read.
  It no longer reads the holder at all.
- **No draft before the restore:** `saveProcessModel` gets `restoredWithoutDraft`.
  - Published before: the restore's revision is published with the removal.
  - Never published (0.x): saved only, whatever the live read says.
  - The row reads "Removed N reference(s), Published; restored from the archive for the
    edit, and archived again at the end of the run", or "SavedUnpublished; …". It never
    says "its open draft went live".
- **A draft before the restore:** refused as before. The holder is already offered as a
  tick, because the plan's draft list is built from the archived model.
- **The never-published case.** I couldn't find why R13 refused one, and I don't know
  what the live read shows for a restored never-published process. The fix doesn't
  depend on it, because the decision comes from the archived model. The test makes the
  live read show 1.1 in progress, which the old code refused.
- **The fake tenant** now does what R13 measured: a restore opens an in-progress
  revision (1.0 becomes 1.1, state 1), and a publish moves to the next major version
  with state 3. With that, the phase 7 test for a scan-found holder fails on the old
  code, which is R13's bug reproduced offline.

**2. An orphan is confirmed before it is parked.**
- **The check.** When the listing says a process's group is gone, the run reads the
  group its model names (`ProcessGroupItems.ProcessGroup`) and looks it up with the
  breadcrumb read: found when the breadcrumb is not empty. That read was already on the
  allowlist. No new proxy operation.
- **Found:** restored into that group as an ordinary holder, with a `GroupCheck` /
  `Warning` row naming the disagreement. It is archived again in its own group and
  gets a `ReArchiveHolder` row.
- **Not found, or the model names no group:** parked as before. The parked message
  ("its original group N no longer exists") now only appears after this check.
- **The lookup fails:** I took a decision here. The run tries the model's group first
  and parks only if the tenant refuses it, because that refusal is the measured answer
  for a deleted group. That way a failed read can't repeat R13's damage.
- **Extended to targets, also a decision.** An archived target that the listing calls
  orphaned gets the same check before the orphan warning. A held-back one would
  otherwise be archived in the holding group, and the group deleted around it, the same
  way. If its group is found, the snapshot is corrected and a `GroupCheck` row is added.

**3. The coverage warning counts archived rows only.** The words now say "N of M archived
listing row(s) …".

**4. The confirmation names what happens.**
- The draft check is now a read-only function of its own, `checkHolderDrafts`. The run
  calls it after the draft ticks and before "Permanent deletion".
- The confirmation lists:
  - the targets to be deleted, by name and id;
  - each target kept, with the holder whose unticked draft keeps it;
  - the ticked holders whose drafts go live;
  - how many holders are edited first.
- The question is now asked **before any reference is removed**, so cancelling edits
  nothing. It used to come after the removal. The cancel stop reads "Nothing has been
  edited or deleted."
- The save-time backstop is unchanged. It reports a draft opened since the check.
- The page shows these lines (`deleteConfirmationLines`). I checked the rendered panel
  in the offline drive.

**5. Unticked draft holders are `Skipped`.** The backstop, where a draft is opened after
the check, stays `Failed`.

**6. A refused delete says why.**
- `deleteRefusalText` reads the raw body, which the proxy already forwards as `detail`:
  - any strings under `additionalInfos`, or the `name`/`Name`/`title`/`processName` of
    objects there, give "Still referenced by: …";
  - otherwise the tenant's message;
  - otherwise the first 500 characters of the raw body.
- The row stays `Failed` with StatusCode 500. The write policy never resends after a 5xx,
  and a test now pins that.
- An archived target goes home archived through the unwind, as a held-back one does.
- **A decision to check:** an *active* target that the pre-delete pass archived is made
  active again in its own group, and the row says so. The task says "re-archive as for
  any held-back target". A held-back active target is never archived, so this is the
  state it would be in. Before this change it was silently left archived.

**Functions touched.**
- `delete/executor.ts`:
  - new: `checkHolderDrafts`, `DraftCheck`, `deleteRefusalText`, `returnActiveTarget`;
  - changed: `saveProcessModel` (`restoredWithoutDraft`), `removePlanReferences`
    (takes `draftCheck`; unticked is `Skipped`), `deletePlanTargets` (refusal text,
    active target returned).
- `delete/planner.ts`: `restoreForReading`, which confirms orphans and records
  `revisionBeforeRestore`, and `afterRestore`, which is new. `DeletePlanOptions.onRow`.
  `PlanningGateway` gains `groupFound`.
- `delete/groups.ts`:
  - new: `modelGroupOf`, `confirmOrphan`, `groupDisagreementRow`;
  - changed: `groupExistsCoverage` (archived only), `CoverageEntry.isArchived`.
- `delete/bulkDelete.ts`:
  - new: `DeleteConfirmation`, `deleteConfirmationLines`, `deleteConfirmationOf`,
    `confirmOrphanedTargets`;
  - `DeleteDecisions.confirmDelete` now takes a `DeleteConfirmation` instead of a count;
  - the order is now: draft ticks, draft check, confirmation, removal, verification,
    delete.
- `delete/ledger.ts`: `PlanLedgerRow.revisionBeforeRestore`, `RevisionBeforeRestore`.
- `delete/gateway.ts`: `DeleteGateway.groupFound`.
- `ui/gateway.ts`: `groupFound`, via `group.breadcrumb`, on the planning gateway.
- `delete/testing/fakeTenant.ts`: the restore's revision, the version after a publish,
  `groupFound`, and `FakeFailure.body`.
- `app/delete/page.tsx`: the confirmation lines and the stage text.

**Results-file operations.**
- New: `GroupCheck`, with the new status `Warning`. The results screen lists any status
  outside Success, Skipped, Failed and Accepted as unexpected, so it will show there;
  the summary counts don't include it.
- Changed messages: `RemoveReferences` for a restored holder and for an unticked draft
  holder (now `Skipped`), and `Delete` for a refusal.
- No renames.

**Tests.** 547 tests, all pass, none skipped. That's 533 after F5 and 530 before F5.
Typecheck and build are clean.

New tests:
- `orchestrator.test.ts`, 11:
  - item 1: restored published holder; restored never-published holder; draft before
    the restore, unticked and ticked;
  - item 2: model's group found; not found; no model group; lookup failed, accepted and
    refused; target the listing calls orphaned;
  - item 4: kept targets named before any save; ticked draft named, and declining edits
    nothing;
  - item 6: refused archived target goes home.
- `deletion.test.ts`, 2: refusal names in three `additionalInfos` shapes, sent once, and
  an active target made active again; fallbacks to the message, then the raw body.
- `groups.test.ts`, 1: active rows aren't counted.

Updated:
- four status assertions to `Skipped`;
- the wording of the coverage line in `hold.test.ts`;
- the refused-delete message in `deletion.test.ts`.

Checked against the old code:
- item 1: 3 tests fail, including the phase 7 scan-found holder test, now that the fake
  opens a revision;
- item 2: 4 tests fail. The "names no group" test passes either way, as it should.

**Offline drive.** These ran against the mock tenant in headless Chrome:
- `drive-delete-run`: one question, whose panel lists the target and says 2 holders
  are edited first. 5 rows, all Success, with the writes in the expected order.
- `drive-delete-resume`: 4 rows, all Success.
- `drive-delete`, the dry run: no writes.
- `drive-archive`: passes.

**Not verified offline. For Cowork in the R13 re-run:**
1. What the live read shows after restoring a **never-published** archived process: its
   `Version` and `ProcessRevisionStateId`. This explains R13's refusal. The fix doesn't
   rely on it.
2. A restored published holder ends at the next major version with the link gone, and
   is archived again in its own group.
3. **A deleted group's breadcrumb.** `groupFound` treats an empty breadcrumb as not
   found. F1 said a deleted group's list "can be" empty, not that it always is. If it
   isn't empty, the run tries that group, the tenant refuses, and the run falls back to
   parking, so nothing is lost. But please confirm.
4. The `additionalInfos` shape of a refused `DeleteProcess`, so the parser can be pinned
   to it.
5. The holding group's new name in the tree (F5).

**Decisions I'd like from Cowork.**
- Item 2 checks targets as well as holders, and tries the model's group when the lookup
  fails. OK?
- Item 6 makes a refused active target active again. OK, or should it stay archived?
- Item 4 asks the confirmation before the removal rather than after. Verification still
  asks separately if references remain.
- The restored holder's row doesn't give the new version ("published as 2.0"), because
  it isn't read back after the publish. Adding it costs one read per restored holder.
  Want it?

**Deferred or disputed.** Nothing deferred. The decisions above are the only places I
went beyond the task text.

---

## F5. Name the holding group so it can't be mistaken for a real one

Commit `0460630` on `claude/web-f5-holding-group-name`, branched from `claude/main` after
PR #69.

**What changed.**

- **Order of operations.** After `group.create` the run saves the group's ids in the plan
  first, then renames the group to `Bulk Delete holding group (temporary, <run start UTC>)`,
  for example `… (temporary, 2026-10-19 14:03:22 UTC)`. The time is the run's start, to
  the second. The rename is sent before any process is touched.
- **A failed rename** goes in the plan log as "Could not rename the holding group
  (<reason>); it keeps the name '<default>' (id N)", and is also shown on screen. The run
  carries on. The group is still on record and is still removed at cleanup. A dead
  session still stops the run, as everywhere else.
- **The default name is now read back.** `group.create` returns the title the tenant gave
  the group, taken from the top-level tree read it already makes for the numeric id. The
  run starts out with that name, so a run whose rename fails still names the group as it
  appears in the tree. Before this, the run reported it under a name the tenant never
  gave it.
- **When cleanup can't remove the group,** the `Cleanup` row's message now carries the name
  as well as its Name column: "'<name>' left in place: still holds …", "Could not verify
  '<name>' is empty; find it at the top level of the tree …", or "Delete failed; remove
  '<name>' manually from the top level of the tree". The run log adds "The holding group
  '<name>' (id N) was left in place. It is at the top level of the tree; the results file
  says why." This is said once the stop's unwind has run, so it follows the stop reason.
  A resumed unwind ("Finish it") does the same.
- **The page** no longer forces the script's `Bulk Delete Temporary Group` name. The dry
  run's orphan warning says `Bulk Delete holding group (temporary, <run start> UTC)`,
  because a preview has no start time yet.

**Functions touched.**

- `delete/gateway.ts`:
  - `holdingGroupNameFor(runStart)`, new;
  - `DeleteGateway.renameGroup`, new;
  - the `createGroup` doc now says the returned name is the tenant's.
- `delete/bulkDelete.ts`:
  - `runBulkDelete`: the rename step, the `cleanup` closure, and the default for
    `holdingGroupName`;
  - `resumeUnwind`: logs when it leaves the group in place;
  - `holdingGroupLeftLine`, new.
- `delete/holdingGroup.ts`: the three `removeHoldingGroup` messages for a group left in
  place.
- `pm/groups.ts`: `renameGroup`, new, which treats a body with `isValid: false` as a
  refusal even under a 200. `createTopLevelGroup` now also returns `name`.
- `pm/operations.ts`:
  - `group.rename`: exactly one group GUID, plus `newName`, which must be one line of up
    to 200 characters with no control characters and nothing else alongside it;
  - added to `OPERATION_NAMES` and `WRITE_OPERATIONS`.
- `ui/gateway.ts`: `renameGroup`; `createGroup` returns the tenant's name.
- `delete/testing/fakeTenant.ts`:
  - `renameGroup`, and `groupName()` for asserting a rename;
  - `createGroup` gives the group its `holdingGroup` name, as the tenant names a new group
    itself.
- `dev/mock-pm.mjs`: a RenameGroup endpoint.
- `app/delete/page.tsx`: see "The page" above.

**Results-file operations.** None new or renamed. The `Cleanup` messages are reworded as
above.

**Tests.** 533 tests, all pass, none skipped (530 before). Typecheck and build are clean.

New tests:
- `orchestrator.test.ts`, "the holding group is renamed for the run, after its ids are
  saved". It checks that the plan named the group before the rename was sent, and that
  create, rename and the first process change come in that order. It also checks the name
  format and that the `Cleanup` row and the saved plan use the new name.
- `orchestrator.test.ts`, "a failed rename is logged and the run carries on, reporting the
  group by its default name". A process stranded in the group keeps cleanup from
  removing it, so the test checks the row and the log line name it by its default name.
- `operations.test.ts`, "a rename names exactly one group and one line of text".

Both orchestrator tests fail on the code before this change. The write-list test now
includes `group.rename`.

**Offline drive.** These ran against the mock tenant in headless Chrome:
- `drive-delete-run`: CreateGroup, then RenameGroup with the timestamped name, then the
  process writes, then DeleteGroup. 5 rows, all Success.
- `drive-delete-resume`: 4 rows, all Success.
- `drive-delete`, the dry run: no writes.

**Not verified offline.** The RenameGroup response body. The task says it was measured in
PGM and in S1, but the shape isn't in the repo, so the proxy accepts any 2xx and only
treats `isValid: false` as a refusal. **For Cowork in the R13 re-run:** check that the
group shows up in the tree under the new name, and whether the tenant caps name length.

**Deferred or disputed.** Nothing.

---

## W5 phase 7. Unwind, orchestrator, run page and the allowlist writes

Commits on `claude/web-w5-7-unwind`, branched from `claude/main` after PR #67:
- `38eb4c4`: the ordering fix from the phase 6 review;
- `b638b88`: unwind and orchestrator;
- `32585a1`: two engine defects found by the offline run;
- `8e918dd`: proxy writes and the run page;
- `89372a5`: the plan is saved after each restore during planning.

W5 is now fully ported, so this is the end of the engine. I stopped here for review before R13.

**What changed.**

- **Held-back targets decided before any removal (the phase 6 fix).**
  - `removePlanReferences` now reads every holder before the first save. A holder with an open draft (`isOpenDraft`, new in `pm/writePath.ts`) that isn't ticked holds back every target it references.
  - It then removes references only to targets still being deleted. A holder whose every target is kept is not edited; its row is `RemoveReferences`/`Skipped`, "Not edited: every target it references is being kept".
  - The edit-time refusal stays as a backstop. If it fires, the row is Failed ("A draft was opened after the check…"), and the plan log names the holders already edited for that target ("… is kept, but its references were already removed from: …").
  - The cost is one extra read per holder.
- **Unwind ported:**
  - `moveProcessToGroup`: the probe asks once per run with no retries, then falls back to archive-and-restore. It reports where the process really is.
  - `restorePlanState`:
    - uses the ledger, not the target list;
    - archives in place where the group is gone or no group was recorded;
    - saves after each entry, and is idempotent;
    - writes `ReArchive`, `ReArchiveHolder` or `ReArchiveOrphanedHolder` (the last one's message ends "…and stays archived without a group").
  - `currentGroupOf`: the active read, then the archived batch read.
  - `removeHoldingGroup`: deletes the group only when it lists nothing. Each stranded non-target gets a `Collateral`/`Failed` row, and nothing is raised twice.
  - `resolveCollateralOutcome`, `resolveTargetOutcome`, `resolveRunOutcome`: one fresh sweep, and none for a clean run.
- **Orchestrator ported:** `runBulkDelete`, `resumeUnwind`, `deleteResultsSummary`.
  - Same order as `Invoke-BulkDeleteProcesses`:
    1. gather and resolve targets (`Resolve` rows);
    2. snapshot and baseline;
    3. the variation pre-flight (`VariationWarning` Accepted/Failed);
    4. the orphaned-target and coverage warnings;
    5. hold, with the pre-mutation plan saved first (B4), `Hold` rows, and unheld targets excluded unless `allowUnheldTargets`;
    6. the hold checkpoint;
    7. the plan;
    8. the gates: Blocked, `PlannedIncomplete` (hard stop), unresolved, blocking mismatches, over-claims needing acknowledgement, draft-holder ticks, verification, and the final confirmation;
    9. removal;
    10. delete;
    11. unwind;
    12. cleanup;
    13. `finish`: reverse collateral not yet reversed, then re-check.
  - Every stop raises a new `stopped` event with the reason, then unwinds.
  - `resumeUnwind`:
    - restores from the plan alone;
    - reverses only collateral a fresh read shows is still changed (restoring an active process isn't harmless on this tenant);
    - removes the holding group unless the plan says it already went;
    - re-checks.
  - The `phases.ts` stubs and every `notPorted` are gone. No test is skipped.
- **Two engine defects the offline run found:**
  - **An archived holder that only the archive scan finds was never restored.** The script has the same defect. The scan put it on the ledger, but nothing un-archived it, so the removal couldn't edit it ("Could not fetch process for editing (it is archived)") and verification stopped the run. No live round had reached removal, so it was never seen. It's now restored in place, or parked when its group is gone, and archived again by the unwind.
  - **A dead run's rows were lost.** The engine functions take `onRow` and report each row as they make it. A run that dies saves them into `plan.interruptedResults`, and `resumeUnwind` puts them first in its results. So the results file still names every process the run changed (T1).
- **Mid-planning death.** The planner calls `onRestored` after each restore and the run saves the plan, so holders restored before a dead session are on record. The script has the same gap.
- **Proxy writes added** to the allowlist and `WRITE_OPERATIONS`. Each names at most one process or group:
  - `process.save`: the model as a string. The server parses it and refuses a model whose `UniqueId` isn't the process named. The server rebuilds the envelope, with `DoPublish` always false.
  - `process.restore`: `processGroupId` a positive integer, with `once` for the probe.
  - `process.delete`: optional group GUID.
  - `group.create`: no fields; top level only.
  - Also new, a read: `group.processes` (breadcrumb children).
  - New pm functions: `restoreProcess` and `deleteProcess` (`pm/processes.ts`), `createTopLevelGroup` and `getGroupProcesses` (`pm/groups.ts`).
  - The browser side is `browserDeleteGateway`. Its `listGroups` returns `[]`, because the listing's own group UniqueId is all the snapshot needs.
- **Run page (`/delete`):**
  - the dry run as before;
  - then "Delete for real", with the change description, the approval override, accept collateral in advance, allow unheld targets, and a typed DELETE;
  - the run asks each question in a panel (draft holders as ticks). An unanswered question waits; it never answers yes;
  - a live log; the results summary and CSV; the plan download.
  - The plan is kept in IndexedDB (`lib/ui/planStore.ts`). After a dead session the page offers "Finish it", or a downloaded plan can be uploaded.
- **Mock and drivers:**
  - `dev/mock-pm.mjs` answers RestoreProcess (500 for an active process or a missing group), DeleteProcess, CreateGroup and breadcrumb children, keeps references a save removes, and can expire the session at a chosen call (`/_expire?on=…`, `/_revive`).
  - Tree group ids now equal the listing's numeric group ids.
  - New drivers `drive-delete-run.mjs` and `drive-delete-resume.mjs`.

**Results-file operations.** All are now written by the web app: `Resolve`, `VariationWarning`, `Hold`, `DependencyCheck`, `ReArchive`, `ReArchiveHolder`, `ReArchiveOrphanedHolder` (new, from the phase 1 review), `Cleanup` (ObjectType ProcessGroup), and `Collateral` "Left stranded in the holding group…". There are new messages for `Delete`/`Skipped` (hold failed, or held back) and `RemoveReferences`/`Skipped` ("Not edited: …").

**Tests.** 530 tests: 530 pass, 0 fail, 0 skipped (was 514 / 474 / 40). The 40 unwind tests are turned on, and they passed against the port with no assertion changes. The stub test is removed, and 17 tests are new, so passing went up by 56.
- **`deletion.test.ts` (+3):**
  - a clean holder listed before a draft holder keeps its link to the target the draft keeps;
  - a holder whose every target is kept is not edited;
  - a draft opened between the check and the save is refused and logged.
- **New `orchestrator.test.ts` (10):**
  - a holding group even with only active targets;
  - a stop states its reason;
  - draft ticks reach the run, ticked and unticked;
  - an incomplete plan stops before any write and names what went unread;
  - a resume reverses only collateral that is still changed;
  - the summary merges producers;
  - a scan-found archived holder is restored, edited and archived again (fails without the fix; I checked);
  - a dead run's rows reach the resumed results;
  - a death mid-planning leaves its restored holders on record (fails without the fix; I checked).
- **`operations.test.ts` (+4):** the write list; save carries only the named process's model; the save envelope; restore, delete and create each name at most one thing, and the new group's numeric id is read from the tree.
- **`removal.test.ts`:** the read-count test now counts the draft-check read.

Typecheck and production build are clean. Offline, against the mock:
- `drive-delete.mjs` (dry run) sends no writes;
- `drive-delete-run.mjs` gives 5 rows, all Success, and sends exactly these writes in order: create group, restore the archived holder, save and publish both holders, pre-delete archive, delete, re-archive the holder, delete the group;
- `drive-delete-resume.mjs`: the session dies at the pre-delete archive, sign-in returns, the page offers "Finish it", and the resume gives 4 rows, all Success, including the two removals the dead run made.
- The other drivers (archive, move, ownership, expired) still pass after the mock's tree-id change.

I didn't run `Tests/Run-AllTests.ps1`, because the PowerShell is frozen and unchanged.

**Deliberate differences and things for R13.**

- **A holding group is made for every real run**, not only one with archived targets. Otherwise a holder whose group is gone blocks any run whose targets are all active, which is one of the R13 cases. An empty group is deleted at cleanup.
- **The holding group has the tenant's default name.** CreateGroup takes no name, and the script never renamed it either. On the tenant, look for a new top-level group with the default name; the plan file records its UniqueId and numeric id.
- **RestoreProcess retries.** It uses the write policy, so it's not resent after a 5xx (the script resent up to three times). The probe sends it once. A refused hold is read from its status.
- **Variation siblings from `variationSetData` are not read yet.** The pre-flight uses the name heuristic, and the checkpoints are the backstop, as in the script. The tree and archived-view entry points (W6) carry `variationSetId`, which is the cheap way to know which targets to read. Reading the set for every target here would be one call per target. I propose doing it in W6.
- **Not here, deliberately (W6):** the tree and archived-view entry points, delete by group, and empty-group cleanup.
- **For the live test:**
  - whether the tenant refuses a delete when only the draft is clean;
  - editing over a revision awaiting approval;
  - whether `breadcrumb/children` lists a process restored into a brand-new top-level group (the holding-group sweep depends on it);
  - the CreateGroup response's `groupid` and the new group appearing at the top level of `GetChildProcessGroupTreeItems` (measured by the script, never from the web app).

---

## W5 phase 6. Delete

Commit `69c657c` on `claude/web-w5-6-delete`, branched from `claude/main` after PR #66. I stopped after this PR, as the task asks.

**What changed.**

- **Reconciled-across-categories count (review follow-up).**
  - The line was there, but it was a sentence below every other section, and it counted reconciliation rows, not pairs.
  - `planSummaryLines` (`planner.ts`) now has a count line straight after the totals: "Reconciliation: N blocking mismatch(es), N claimed more than found, N link(s) counted twice, N pair(s) reconciled across categories".
  - The detail line is now a heading, `PAIRS RECONCILED ACROSS CATEGORIES (N)`, and counts distinct pairs.
  - On R11's set it should read 3 pairs.
- **Holders with an open draft: refused by default, published only when ticked (review follow-up).**
  - `pm/writePath.ts`:
    - `WriteState` gains `publishedVersionExists`. `writeStateOf` sets it from `Version`, using Move's F1 rule: a major version of 1 or more; 0.x was never published.
    - `chooseWritePath` takes `openDraft: 'save-only' | 'refuse' | 'publish'`. The default `save-only` is ownership's rule, so ownership is unchanged.
    - New refusal `open-draft`. Ownership's message table has an entry for it, though ownership never reaches it.
    - A 0.x process in progress is always save-only, since nothing live holds the reference. An unknown version counts as published.
  - `saveProcessModel` (`executor.ts`):
    - New option `publishOpenDraft`. It passes `refuse` unless that option is set.
    - `SaveOutcome` gains `refusal` and `draftPublished`.
  - `removePlanReferences`:
    - New option `publishDrafts` (holder ids). The decision comes from the fresh read at edit time, not from the plan.
    - Unticked: the holder's row is Failed before any save, with "Not saved: It has an unpublished draft; removing the reference would publish it. Its references remain, so the target it holds is left out of the delete. Tick it to publish the draft with the removal."
    - Its targets are returned in the new `heldBack` list (target, holder, reason).
    - Verification skips the refused holder, and checks other holders only for targets still being deleted. A known refusal doesn't stop the run.
    - Ticked: the draft is saved and published, and the row ends "…, Published; its open draft went live with the removal".
  - Plan: `DependencyPlan.draftHolders` (`DraftHolder`: holder, name, draft version, targets blocked). The planner builds it from the models it read.
  - The summary lists these holders under `HOLDERS WITH AN UNPUBLISHED DRAFT (N)`, each with the targets it blocks.
- **Delete phase ported.** `deletePlanTargets` (`executor.ts`) is a port of `Invoke-ProcessTargetDeletion`:
  1. **Archive pass.** Each target is archived ('Pre-delete archive', `PRE_DELETE_ARCHIVE_COMMENT`) unless the run found it archived and didn't restore it, or it is held back. A failed archive is logged to the plan log with its reason, and the delete still goes ahead, as in the script.
  2. **Checkpoint, if `tenantBaseline` is given.**
     - It reads a fresh index (`loadProcessIndex` over `listProcesses`).
     - Expected ids are the targets plus every ledger row with `restoredByThisRun`. Observed ids are `observedUniqueIds` plus `getObservedUniqueIds()`.
     - It uses `newCollateral` with `plan.collateral` as already raised, then appends to `plan.collateral` and logs "COLLATERAL after archive phase: …".
     - The gate is `decideCollateral` with `onCollateral`, and no gate means stop.
     - On stop it returns the Failed rows ("…; after archiving targets, before deleting; run stopped before anything was deleted") and no Delete row. The script's orchestrator uses "no Delete row" to tell it stopped.
     - On proceed it writes `Accepted` rows with `acceptanceAuthority`.
  3. **Delete.** `deleteProcess(id, originalGroupUniqueId || null)` for each target.
     - Success: the ledger row is marked `deleted` and the row reads "Deleted". Failure: "Delete failed (HTTP n)" with the status. GroupId is the original group.
     - A held-back target gets a `Delete`/`Skipped` row, "Not deleted: <holder> has an unpublished draft; removing its reference would publish it".
     - A dead session rethrows.
  4. **Post-delete checkpoint.** It reads a fresh index, and collects observed ids at that point (W3). For anything new it writes `collateralFailureRows(…, 'detected after deletion')`, then `restoreCollateral` through `collateralGateway`, logged "COLLATERAL after delete phase".
  - Events: the `archiving-targets`, `checking-collateral`, `deleting-targets`, `checking-collateral-after-delete` and `reversing-collateral` stages; progress counts; `collateral` and `collateralDecision`; a `log` event for each log line.

**Results-file operations.** Two are new to the web app, both the script's: `Delete` (Success / Failed), and `Delete`/`Skipped` for a held-back target, which is new behaviour. `RemoveReferences` has new messages for the refused and the ticked draft holder.

**Functions touched.** `chooseWritePath`, `writeStateOf` (`pm/writePath.ts`); ownership's `REFUSALS`; `saveProcessModel`, `removePlanReferences`, `deletePlanTargets` (`executor.ts`); `buildDeletePlan` (new `draftHoldersOf`) and `planSummaryLines` (`planner.ts`); `DependencyPlan` and the new `DraftHolder` (`ledger.ts`).

**Tests.** 514 tests: 474 pass, 0 fail, 40 skipped (was 495 / 454 / 41). That's 19 new tests and 1 turned on, so +20 passing.
- **Turned on (1):** "both active: the target is deleted" (`executor.test.ts`). It passed with no changes.
- **`removal.test.ts`:** "a draft in progress is saved and left unpublished" is replaced by two tests:
  - a draft over a published version is refused with nothing sent, and when ticked it is published with `draftPublished`;
  - a 0.x draft is saved only.
- **New `deletion.test.ts` (18):**
  - archive-then-delete with the group sent and the ledger marked;
  - a restored target is archived again;
  - a refused delete is a Failed row with its status, and the ledger is not marked;
  - a failed archive is logged and the delete still happens;
  - a dead session rejects;
  - collateral with no gate stops with no Delete row;
  - accepted collateral gets Accepted rows with the given authority and is not raised again after the delete;
  - an already-raised change is not asked about again;
  - post-delete collateral is reported as Failed and put back;
  - a process stranded by the delete is read after the delete (`NotInBaseline`);
  - a failing holding-group listing is logged;
  - a held-back target is neither archived nor deleted;
  - the plan's draft-holder heading;
  - unticked draft holder: Failed, nothing saved, target survives with a Skipped row;
  - ticked draft holder: published, and the target is deleted;
  - a draft opened after planning is still refused;
  - the write path's draft rules;
  - the across-categories count line.
- **Still skipped:** unwind 40.

Typecheck and production build are clean. The offline `drive-delete.mjs` dry run against the mock shows the new count line and sends no writes. I didn't run `Tests/Run-AllTests.ps1`, because the PowerShell is frozen and unchanged, so there's no `$script:ScriptVersion` bump.

**Deliberate differences and things to check.**

- **Draft detection reads the revision state, and the version only to rule out 0.x.** A draft opened since planning is refused at edit time even though the plan didn't list it, and a draft published since planning needs no tick. Only the run's own read counts.
- **"Unknown version" counts as published.** That's the side that costs nothing if wrong: the row fails and the target survives.
- **A held-back target isn't archived by the pre-delete pass.** It isn't being deleted, so archiving it would be a change with no purpose. If the run restored it, the unwind puts it back as usual.
- **A failed holding-group read before the deletes is now logged.** The script dropped it silently at that checkpoint, though it printed one at the post-delete checkpoint.
- **A failed pre-delete archive goes to the plan log** (and a `log` event), not only the console.
- **Not done here, deferred to the unwind/orchestrator phase:**
  - the tick UI itself. The delete page is still dry-run only, so there's nothing to tick yet. `runBulkDelete` will take the ticked holders as `publishDrafts` and pass `heldBack` to `deletePlanTargets`.
  - adding delete-proxy writes to the allowlist. As before, they stay off until the unwind exists.
- **For the live test:** whether the tenant refuses a delete when only the draft is clean (Cowork's note), and editing over a revision awaiting approval.

---

## W5 phase 5. Checkpoints

Commits `1292481` (the two fixes queued at the start of the phase) and `ac465d1` (checkpoints), on `claude/web-w5-5-checkpoints`, branched from `claude/main` after PR #65. I stopped after this PR, as the task asks.

**What changed.**

- **Pair total counts every site between the two (fix 1, from Cowork's live check).**
  - `reconcileDependencies` (`claims.ts`) now takes the pair's located total from `sitesBetween`: every planned site between the queried and related process, in either direction, any category, child sites included.
  - The per-category rows keep their scoping and their own numbers. The note adds the pair total ("… 1 site(s) between them in all").
  - R11's two Input pairs (a Link claimed on the target, an Input held by the related process) should now come out `MatchAcrossCategories`. That would leave 0 blocking on that set.
- **Publish route read from the process (fix 2, from the phase 4 review).**
  - New `pm/writePath.ts` holds `chooseWritePath`, `isWritePath` and `writeStateOf`. These are PGM's rules, moved out of `ownership/plan.ts`. They return a path or a refusal code (`cannot-save`, `awaiting-approval`, `cannot-publish`), and each caller words its own row.
  - Ownership's `chooseWritePath` is now a thin wrapper that keeps its existing messages, so ownership behaves the same.
  - `ActiveRead` (`pm/dependencies.ts`) carries `processActions` from the same read, so removal decides from the read it edits.
  - `saveProcessModel` (`executor.ts`) now takes `processActions` (required).
    - Can publish after edit: saved with `DoSubmitForApproval: false`, then `publishNow`.
    - Can only submit: saved with `DoSubmitForApproval: true`, then `publishNow`.
    - Neither: stage `Refused`, nothing sent. The `RemoveReferences` row reads "Not saved: It is published, and cannot be republished by this account: … Its references to the targets remain."
  - `publishRevisionEdit` is gone from `DeleteGateway`, the fake tenant and the save.
  - `approvalsEnabled` now only means permission to edit a revision awaiting approval and publish over it.
  - A save that won't be published no longer re-reads.
- **Checkpoints, ported** (every `notPorted('checkpoints')` stub is implemented):
  - `names.ts`: `isRealName`, `selectDisplayName`, `resolveCollateralName`.
  - `ledger.ts`: `tenantStateSnapshot`, a copy of each index entry with `groupExists` normalised.
  - `tenant/state.ts`: `Collateral` carries `originalGroupExists` (true for `NotInBaseline`). `compareTenantState` takes a null baseline or index and returns nothing, as the script does. `CollateralChange` is now an alias of `Collateral`.
  - `archive/plan.ts`: `findVariationMasters` returns `NameVariationMatch` with `baseName` and `targetGroupId`, and returns nothing for a null index. Archive callers are unaffected, because the new fields are extra.
  - `collateral.ts`:
    - `variationWarning` (master at risk first, then same group, then name) and `variationWarningLines`;
    - `collateralLines`;
    - `collateralAcceptanceRows`, plus `collateralFailureRows` for a stopped gate and for the post-delete checkpoint;
    - `restoreCollateral`.
  - Also new in `collateral.ts`, for the delete and unwind phases to call:
    - `newCollateral`: the diff, less anything an earlier checkpoint raised.
    - `decideCollateral`: the gate. Approved in advance gives `Accepted` rows ("accepted in advance on the preview"). A gate answering yes gives `Accepted` rows ("accepted at the on-screen confirmation"). No gate, or a no, stops with a `Failed` row per change ("…; run stopped before anything was deleted"). Each answer comes with the screen's lines.
  - `CollateralGate` and `ACCEPTANCE_AUTHORITY` moved into `collateral.ts`. `executor.ts` and `bulkDelete.ts` re-export them, so the names callers use haven't changed.
  - `collateralGateway`'s restore now passes `isFatal`. Without it, a dead session during a reversal's restore read as a refused restore. I found this while porting; there's a test for it.
- **Hard stop on `PlannedIncomplete`** (from the phase 4 review): `incompletePlanStop(plan)` in `bulkDelete.ts` returns the stop message, or null. The message names every unread process by name, id and status. There's no override parameter. `runBulkDelete` is still the unwind phase's stub, so it calls this from there.

**Results-file operations.** None new. This is the first phase to write `Collateral`/`Accepted`, `Collateral`/`Failed` and `ReverseCollateral`, all of them the script's operations.

**Tests.** 495 tests: 454 pass, 0 fail, 41 skipped (was 476 / 422 / 54). That's 19 new tests and 13 turned on, so +32 passing.
- **Turned on (13):** the 7 checkpoint tests in `collateral.test.ts`, 2 in `names.test.ts`, 2 in `ledger.test.ts`, 1 in `bulkDelete.test.ts` and 1 in `executor.test.ts`. They all passed against the port with no assertion changes. I only updated their stale "DIFFERS" comments.
- **New in `claims.test.ts` (1):** R11's exact shape, a Link claimed on the target and an Input held by the related process, comes out `MatchAcrossCategories` and nothing gates. It fails against the phase 4 code; I checked.
- **`removal.test.ts` (+6 net):**
  - The approvals-routed save tests are replaced by: publish-direct; submit-then-publish; the approvals flag no longer picks the route; can't republish is refused with nothing sent, and so is a read with no `processActions`; awaiting approval only with the override; a draft in progress is saved only.
  - New: a holder this account can't republish fails its row unsaved, and verification still finds its references.
  - "Skipping verification reads each holder once" now checks a published holder (2 reads) and a draft (1 read).
- **New `checkpoints.test.ts` (12):**
  - the checkpoint doesn't re-raise; no gate stops; no and yes at the gate; approval in advance;
  - nothing changed, no rows;
  - restore into the home group, and its failure with status;
  - re-archive, and its refusal;
  - move and disappearance not acted on;
  - a dead session during the reversal's restore ends the run;
  - the variation warning text;
  - write-path rules, including the version fallback;
  - the incomplete-plan stop.
- **Still skipped:** delete 1, unwind 40.

Typecheck and production build are clean. I didn't run `Tests/Run-AllTests.ps1`, because the PowerShell is frozen and unchanged. For the same reason there's no `$script:ScriptVersion` bump.

**End-to-end, offline.** I rebuilt against the mock and ran `drive-delete.mjs`. It gave the same plan as phase 4 (Elsewhere's ProcessLink, and the archived holder's Input found by the scan), `PlannedIncomplete` with the preview reason, and no PUT or POST.

**Deferred, and why.**

- **No checkpoint runs on the tenant yet.** The checkpoints sit between mutating phases, and their callers are `deletePlanTargets` (delete phase) and `runBulkDelete` (unwind phase). This phase ports what they call and tests it on its own. The restore and archive writes a reversal makes stay off the proxy allowlist for the same reason as phase 3's hold writes.
- **Bulk Archive's collateral still reports "does not reverse collateral yet"** (`archive/run.ts`). `restoreCollateral` could serve it now, but it needs the restore proxy operation, which waits for the unwind. Worth a small task once that lands.

**Decisions Cowork should check.**

- **The removal now follows ownership's rule for a draft in progress: saved, not published.** The script published any holder whose version was above 0.x, so a holder at 2.1 in progress had someone's draft published along with the removal. Now that holder is saved and left unpublished, and its published 2.0 still holds the reference. If the tenant refuses the delete because of that, the unwind puts things back. If it doesn't, the published version keeps a dangling link until someone publishes. I took the shared rule because that's what the review asked for, but this one deserves a look on the live test. The alternative is to fail such a holder before saving, like the other refusals.
- **A revision awaiting approval is edited only when `approvalsEnabled` is on** (default on for removal, as in the script, and never for ownership). With it on, the removal saves and publishes over the pending revision. That's the only meaning the flag has left, as the review said. It hasn't been measured on an edit, only on archive.
- **`writeStateOf` falls back to the version** when a model has no `ProcessRevisionStateId`: a major version above 0 counts as published. The active read always sends the field. The fallback is for the fake's minimal models and anything else, so it keeps the script's rule rather than refusing.
- **A refusal is a `Failed` row, not `Skipped`.** The reference stays, so the delete that follows can't succeed for that target. Verification also lists the holder, so the run stops at the verification gate before any delete.
- **A pure move isn't reversed, and the row gives a different reason from the script.** The script said "no trustworthy move endpoint". The app has one, but it publishes a new major version of a published process (S2), and doing that to a process nobody asked to touch is a second unasked-for change. The row says that instead.
- **One stop message for both gated checkpoints:** "run stopped before anything was deleted". This is true of both the hold checkpoint and the archive-pass checkpoint. The script worded them slightly differently.

---

## W5 phase 4. Reference removal

Commit `aecbc40` on `claude/web-w5-4-references`, branched from `claude/main` after PR #64. I stopped after this PR, as the task asks.

**What changed.**

- **The archived batch read: fixed first, as asked.**
  - `ARCHIVED_BATCH_SIZE` is 20 (`pm/dependencies.ts`). The proxy's `processes.archivedModels` takes that constant, so its limit is now 20 too.
  - `findHiddenInputOutputReferences` (`planner.ts`) returns `{ sites, unread }`. A batch that fails is no longer skipped: every id in it goes into `unread`, named from the index, with the status and the tenant's message. A dead session still ends the run. An active process the thorough scan can't read is counted as unread too.
  - `buildDeletePlan` puts these on `plan.unreadByScan`. If there are any, the plan comes back `PlannedIncomplete` with the reason, even on a real run. The plan also has `incompleteReasons` now, so the summary no longer calls every incomplete plan a preview. A plan file without the field still reads as a preview, as before.
  - The summary has a "NOT READ BY THE INPUT/OUTPUT SCAN (n)" section that names each id, with its HTTP status.
  - The fake tenant and the dev mock both refuse more than 20 ids with the tenant's 400 and message (the fake used to answer 414).
- **Reconciliation, with the gate relaxed** (`claims.ts`):
  - `reconcileDependencies` still counts per category, then judges the pair as a whole. If the pair's located total is not below its claimed total, each mismatched row becomes `MatchAcrossCategories`. Its note keeps every category's numbers ("claimed Link 1, Input 0, Output 0; located Link 0, Input 1, Output 0"). That covers R11's two Inputs labelled "Linked Process".
  - When the pair falls short, a doubled link keeps `doubleCounted`. Any other mismatch is `overClaim: true` if the pair located anything. If it located nothing, the row is left as it was.
  - `reconciliationGate(rows)` splits the mismatches three ways: `blocking` (nothing located), `overClaims` and `doubleCounted`. A plan file from before the flags existed reads everything as blocking.
  - `DeleteDecisions` (`bulkDelete.ts`): `mismatches` is now asked only about `blocking` rows. A new `overClaims` decision is the on-screen acknowledgement. Doubled links are never asked about. The orchestrator is ported with the unwind, so these are the hooks it will call. They are documented on the type.
  - The summary has three sections: "RECONCILIATION MISMATCHES" (nothing located), "CLAIMED MORE THAN FOUND", and "LINKS THE DEPENDENCY API COUNTS TWICE", which now says it doesn't stop a run. A count line covers pairs reconciled across categories. On R11's set I'd expect 0 mismatches, 1 over-claim (the variation's `Decision[0]`), 21 doubled links, and the 2 Input pairs reconciled.
- **Reference removal, ported from the script:**
  - `references.ts`: `copyProcessObject`, `clearNodeLink`, `removeChildReferences`, `removeProcessReferences`. These work on a copy and filter by value. They clear only fields that already exist. A live Decision link (4) becomes orphaned (7), and `LinkedProcessDisplayName` is kept.
  - `executor.ts`, `saveProcessModel`. The save sends `ProcessJson` as a string, `SuppressChangeNotification: true`, and `DoSubmitForApproval` set to the approvals flag. It then re-reads the process, and if it had been published, publishes the new revision: through `publishNow` when approvals are on, `publishRevisionEdit` when they're off. Both send the change description as the message (S2). A failure names the stage it failed at, with the tenant's status, and a dead session is rethrown. `REFERENCE_REMOVAL_DESCRIPTION` is the script's default text.
  - `executor.ts`, `removePlanReferences`. Each holder gets a fresh read, one save and one publish covering every target, and one `RemoveReferences` row. The rows are Success, Skipped ("No references found at edit time") or Failed ("Could not fetch process for editing (reason)", or "<stage> failed: …"). Then it verifies by re-reading each holder and walking it while everything is still active. It takes the run's `changeDescription` and raises the `removing-references` and `verifying` stages and their progress.

**Results-file operations.** None new. `RemoveReferences` is the script's operation, and this phase is the first to write it.

**Tests.** 476 tests: 422 pass, 0 fail, 54 skipped (was 454 / 394 / 60). That's 22 new tests, plus 6 skipped ones turned on, so +28 passing.
- **Now on:** the six reference tests, five in `references.test.ts` and "both active: one save per holder" in `executor.test.ts`. They all passed against the port with no test changes.
- **New in `claims.test.ts` (6):**
  - an Input the API calls a link reconciles, with both sets of numbers;
  - an over-claim is acknowledged and doesn't block;
  - nothing located blocks;
  - the shortfall is judged on the pair, not the category;
  - doubled links don't gate, and an old plan file blocks as it did;
  - both sides deleted is never judged as a pair.
- **New in `removal.test.ts` (16):**
  - The save: a never-published process isn't published. A published one goes by the right route for the approvals setting, with the message. A refused save, and a refused publish, each name their stage and status. A failed re-read doesn't pass a published process off as unpublished. A dead session ends the run.
  - The removal: one fresh read and one save, carrying the run's description, with `LinkedStakeholders` sent back untouched. Nothing to remove is Skipped with no save. An unreadable holder fails its row and fails verification. A save the tenant answers 200 but drops is caught by verification. Skipping verification reads each holder once. A dead session ends the run.
  - The batch read: 45 archived ids are read as 20, 20 and 5, every one of them, and the hidden Input in the last one is found. The fake refuses 21 ids. A failed batch is named id by id and the plan comes back `PlannedIncomplete`, on a real run, with the reason and not the preview text. A dead session still ends the run. An old plan file still reads as a preview.
- **Proxy:** 20 ids pass and 21 are refused.
- **Changed:** "located sites with no claims is a mismatch" is now "…is not a mismatch". The section test in `hold.test.ts` now expects the 3/1 pair under "CLAIMED MORE THAN FOUND". Both are the rule change you asked for.
- **Still skipped:** checkpoints 13, delete 1, unwind 40.

Typecheck and production build are clean. I didn't run `Tests/Run-AllTests.ps1`, because the PowerShell is frozen and unchanged. For the same reason there's no `$script:ScriptVersion` bump.

**End-to-end, offline.** I rebuilt against the mock and ran `drive-delete.mjs`. It gave the same plan as phase 3 (Elsewhere's ProcessLink, and the archived holder's hidden Input found by the scan, now in a batch of at most 20), `PlannedIncomplete` with the preview reason, and no PUT or POST.

**Deferred, and why.**

- **No proxy operation for the save or the publish yet,** and the page doesn't remove anything. That's the same reasoning as the hold writes in phase 3. Removing references from a restored holder with no unwind to re-archive it is the R11 failure, so the writes join the allowlist in the phase that first runs them from the browser.
- **For the orchestrator (unwind phase): a real run must stop on a `PlannedIncomplete` plan.** Today only a preview produced that status, so the script never checked it after planning. Now an unread scan batch produces it on a real run, and carrying on would delete targets whose archived Input/Output holders were never read. I've noted it here rather than in code, because `runBulkDelete` is still a stub.

**Decisions Cowork should check.**

- **Located above claimed is no longer a mismatch.** I took "only report a mismatch when the located total is lower" literally, which reverses one ported script test (sites located, nothing claimed). Every site found is removed, so finding more than the API claims can't leave a reference behind. If you meant only to reconcile across categories, and to keep flagging pairs where more is found than claimed, that's a one-line change in `reconcileDependencies`.
- **An over-claim is judged on the pair.** A Link claimed twice with no Link located, but an Input located, is an over-claim and doesn't block. Every mismatched row in that pair is listed for acknowledgement, so it can show two rows.
- **"Still blocks" kept the script's escape hatch.** A pair with nothing located goes to the `mismatches` decision, which stops by default and when unattended. The operator can still answer it yes, as the script's "Continue anyway?" allowed. The ported unwind tests rely on that answer to get past synthetic holders. If "blocks" should mean no override at all, the orchestrator can ignore the decision for those rows.
- **Three places this deliberately differs from the script:**
  - A failed re-read after a save falls back to the saved model's version. The script reported such a process as `SavedUnpublished` and left its draft unpublished. Now it's a `Publish` failure: "Saved, but the new revision could not be read back".
  - A holder that can't be read at verification counts as a verification failure (`unreadReason`). The script skipped it, so it went on to the delete unchecked.
  - There's no one-second sleep before the re-read. The ownership save reads straight after its save and matched the tenant in W4.
- **Unread is any non-fatal failure,** not only a 4xx. A 5xx batch that the client's retries couldn't get through is just as unread.

---

## W5 phase 3. Hold

Commit `a3ee966` on `claude/web-w5-3-hold`. Cowork's documentation commit `da8daea` was only on the F4 branch, so this branch merges `claude/main` on top of it. I stopped after this PR, as the task asks.

**What changed.**

- **Hold, ported from the script.** Every `notPorted('hold')` stub is now implemented:
  - `restoreProcess` (`executor.ts`), the port of `Restore-NpmProcess`. It sends nothing when the group is known to be gone, and the result is `MissingGroup`. A null group gets the same answer, because there is nowhere to send it. A refusal comes back as `Endpoint`, with the HTTP status for the results row. A dead session is rethrown. The planner's restore loop, written in phase 2, now runs on it.
  - `findOrphanedGroupProcesses` and `groupExistsCoverage` (`groups.ts`). Both key on the `groupExists` flag, never on `groupId === 1`. Also `groupExistsCoverageLines`, the text of `Show-GroupExistsCoverage`.
  - `processStateSnapshot`, `markSnapshotRestored`, `snapshotToPlanLedger` and `mergePlanLedger` (`ledger.ts`). The merge keeps every holder the snapshot doesn't cover, and keeps a `deleted` or `denormalized` the plan already recorded.
  - `orphanedTargetWarningLines` (`holdingGroup.ts`).
  - `groupDescendantIds` and `processesInGroups` (`groups.ts`). These were still `discovery` stubs, because phase 2 had no caller for them. Delete-by-group (W6) uses them. They are tested now, ported from Test-BulkArchive's "Enumerating a group".
- **Cowork's phase 2 review:**
  - **Archived holders with no group** are named in the plan summary, preview included: "Archived holders with no group: N. Their groups were deleted…". Each holder gets its id and the group that is gone. It also says what happened to it: not restored by this preview, parked in the holding group for this run, or could not be held, which blocks the run. Only holders are counted; orphaned targets have their own warning, below.
  - **`DoubleCounted`**: `Reconciliation` has a new `doubleCounted` field. It is true only for a Link mismatch with `located >= 1` and `claimed === 2 × located`. Those pairs are listed under "LINKS THE DEPENDENCY API COUNTS TWICE (n)", and "RECONCILIATION MISMATCHES" now holds only the rest. On R11's set, that should put 21 under the new heading and 3 under mismatches. The child-procedure asymmetry is still checked first. A plan file without the field lists everything as a mismatch, as before.
  - **W2's 404 branch** (`archive/outcome.ts`): a 404 after an archive is now `Failed`, "Not found; it may have been deleted", with status code 404, and no override is sent. Before, it was reported Archived. The `ArchiveState.found` comment in `pm/processes.ts` now says a 404 means a deleted process. The archive run's final read leaves a Failed row as it is.
- **The `/delete` dry run** also shows the warnings a real run raises before its first change. It names the orphaned targets (Cowork counted 4 on R11's set) and says when the listing doesn't report `groupExists`. These lines come before the plan summary. The page is still read-only.

**Results-file operations.** None new.

**Tests.** 454 tests: 394 pass, 0 fail, 60 skipped. That's +12 tests and +26 passing:
- The 14 hold tests are now on: the five in `groups.test.ts`, seven in `executor.test.ts`, one in `ledger.test.ts` and one in `bulkDelete.test.ts`. They all passed against the port with no test changes.
- 12 new tests:
  - two for the group enumeration;
  - two in `claims.test.ts` for the classification: 2/1 and 4/2 are double-counted, while 1/0, 3/1, matches and Input are not;
  - eight in the new `hold.test.ts`: the restore's failure paths, the snapshot's group UniqueId and restored flag, the orphaned-target warning, coverage lines, the summary section for holders with no group in a preview and in a real run, and the double-counted section. That last one includes a plan file from before the field existed.
- One test was rewritten: the archive outcome test for a 404 now expects Failed.

Typecheck and production build are clean.

**End-to-end, offline.** I rebuilt against the mock and ran all five scenarios:
- delete: the same plan as phase 2, and no writes;
- archive: 4 Success, 1 Overridden, 4 Skipped, 1 Blocked, 1 Orphaned, one group deleted;
- expired, move and ownership: unchanged.

The mock has no orphaned holder or doubled links, so the new summary sections are covered by unit tests only. Cowork's live dry run will be their first real exercise.

**Deferred, and why.**

- **There is no restore or create-group proxy operation yet, and the page doesn't hold anything.** The only callers of the hold writes are the planner with `allowRestore` and the orchestrator (`runBulkDelete`), and the orchestrator is ported with the unwind, as phase 1 laid out. A live run that restored processes before there's an unwind to put them back is the R11 failure. So the allowlist gains the writes in the phase that first runs them from the browser.

**Decisions Cowork should check.**

- **`doubleCounted` is a flag, not a new status.** A new status would have taken those rows out of every `status === 'Mismatch'` filter, including the mismatch gate. That would change the rule, which the review said not to do yet. When Cowork confirms the shape, changing the gate is one line.
- **The snapshot falls back to the listing's group UniqueId** when the numeric-to-UniqueId map doesn't have the group. The script's index had no group UniqueId to fall back to, and the app's index does. Without the fallback the field would be empty, and the delete call would be sent with no group.
- **The coverage and orphaned-target warnings on the dry run** weren't asked for. They're the script's pre-flight text, and they cost no extra calls.

---

## F4. Fixes from the W4 live test

Commit `ba4028b` on `claude/web-f4-ownership-fixes`, stacked on F3.

**What changed.**

- **Archived processes.** `getOwnership` (`pm/ownership.ts`) now reads through `readProcess`/`readProcessEnvelope`, the shared helper added in W5 phase 2. It returns `OwnershipRead`: `{ kind: 'process', state }`, or `{ kind: 'archived' }` for the 200 with no `processJson`.
  - The plan skips an archived process: "Skipped. The process is archived. Restore it before changing its owner or expert (line N)". The model's own `isArchived` stays as a second signal.
  - `setOwnership` returns `{ ok: false, archived: true }` if the process was archived after the preview. The run skips that row ("archived after the preview, so it was not saved") and saves nothing.
  - A 404 on the read now says the process may have been deleted. It no longer says "an archived process cannot be read this way", which was wrong.
- **Names.** `/ownership` reads both process listings (`loadProcessIndex`) before planning. `buildOwnershipPlan` takes them as `names`, and every row it does not write takes its name from there: unknown user, nothing provided, non-GUID, read failed, archived. "(name unavailable; not in any process list)" only appears when neither listing has the id. If the listings can't be read, planning carries on with the old wording; a dead session still stops it.

**Results-file operations.** None new. `UpdateOwnership` rows are now named.

**Tests.** 442 tests: 368 pass, 0 fail, 74 skipped (4 new):
- an archived process is skipped and named;
- each skipped row is named from the listings, falling back only when the id is in neither;
- a save that finds the process archived is Skipped;
- at the proxy, the ownership read and the write treat the archived envelope as archived, and nothing is saved.

The existing tests were updated for the new read shape.

**End-to-end, offline.** The ownership scenario now includes an archived process. "Not updating" names every row: "Disabled owner" (unknown user), "Old thing" (nothing provided), "Archived input" ("The process is archived"). The non-GUID id has no name to find. Three processes were still updated.

**Decisions Cowork should check.**

- **Names come from the listings only**, not from the ownership read: a skipped row is never read. A process neither listing returns (the R3 blind spot) still gets the fallback wording.

---

## F3. Two small things from the W5 parity check

Commit `c5c7933` on `claude/web-f3-parity`, stacked on W5 phase 2.

**What changed.**

- **Cycles.** `resolveSelection` (`select/resolve.ts`) keeps a set of groups walked. A group reached a second time is reported as an excluded item with `CYCLE_REASON` and not followed (`cycleExclusion`). I found the same unguarded walk in two more places and fixed both:
  - `resolveMoveSelection` (`move/select.ts`).
  - `visibleRows` (`select/rows.ts`). With both groups of a loop expanded, the tree view itself would have recursed until the page crashed.
  - The parent-chain helpers (`groupPathOf`, `isWithin`, `effectiveMark`) already had hop limits.
- **Archive warning.** `VARIATION_ARCHIVE_LIST_NOTE` (`archive/plan.ts`) is shown in the `/archive` variation panel. It says a master archived this way ends up in the archived list, where a later Bulk Delete takes its targets from, and suggests checking that list before deleting from it.

**Results-file operations.** None.

**Tests.** 438 tests: 364 pass, 0 fail, 74 skipped. That is 3 new tests (the looped tree in the archive resolver, the move resolver and the tree view) plus the warning-text test. The resolver test fails with `RangeError: Maximum call stack size exceeded` on the old code, which I checked.

**Decisions Cowork should check.**

- **A looped group is walked where it is first reached.** That is under its original parent, since the walk starts at the top level, and it is reported once. Nothing under it is counted twice.

---

## W5 phase 2. Discovery, and a read-only plan

Commit `13fdfe5` on `claude/web-w5-2-discovery`. Stopped after this PR, as the task asks.

**What changed.**

- **Pure discovery, ported from the script:**
  - `delete/model.ts`: case-insensitive field access (`nodeValue`, `nodeHas`, `setNodeValue`, `nodeArray`, plus `nodeString`/`nodeInt`).
  - `references.ts`: `matchTarget` and the three finders.
  - `claims.ts`: parse, candidates, inversion by holder, reconciliation.
  - Ids are compared case-insensitively throughout, as PowerShell's `-eq` and hashtable keys are.
- **The planner, `delete/planner.ts`:**
  - `checkProcessDependencies` (success carried in a field).
  - `loadDeleteIndex`, which adds the numeric `id` and whether the row reported `groupExists`.
  - `readModelAnyState` with an explicit `ModelCache`.
  - `findHiddenInputOutputReferences`.
  - `buildDeletePlan`: a full port of `New-ProcessDeletePlan`, covering passes, the retry, `onFailedTargets`, unlisted participants recovered or named, the restore and park branches, the blind-spot scan, locate, filter, reconcile, and `PlannedIncomplete`.
  - `planProcessName`, and `planSummaryLines` (the text of `Show-ProcessDeletePlan`).
  - A dead session rethrows instead of being counted as a failed check.
- **Plan file** (moved into discovery per your review): `newDependencyPlan` and `ledgerToPlanRows`, plus `newLedgerEntry`, `ledgerEntryFromModel`, `serializePlan` and `parsePlan`. `parsePlan` returns null for anything without schema 1, targets and ledger, because a later phase resumes from it.
- **Targets:** `targetsFromCsv`/`idFromCsvRow` (ObjectID and the other spellings, case-insensitive), and `resolveTargetIds` (numeric ids through the listing, unknown ones reported).
- **Proxy reads** (`pm/dependencies.ts`):
  - `process.dependencies`: one GUID, `searchBehavior=31`. An empty body comes back as null.
  - `process.model`: one GUID.
  - `processes.archivedModels`: 1 to 25 GUIDs. A batch is allowed because it only reads.
  - None of them is a write.
- **The archived read, as you measured it.** `readProcessEnvelope`/`readProcess` in `pm/processes.ts` is the shared helper you asked for: a model, or `{ kind: 'archived' }` for the 200 with no `processJson`. Anything else throws. F4 will use it too.
  - The gateway's `readModel` now returns `ActiveRead`, not a model or a 404.
  - The fake tenant answers an archived process with `{ kind: 'archived' }`, and `archiveState` reads `found: true, isArchived: true` from it.
  - 404 only comes after a delete.
  - The planner's active read falls through to the batch read when told "archived". The script returned the envelope as if it were the model and walked an empty process.
- **T2.** `reArchiveOperation(role, parked)` gives `ReArchiveOrphanedHolder` for a parked holder. The skipped unwind tests now expect it, with a message containing "stays archived without a group".
- **`/delete`**, a dry run page reached by URL; the landing tile is still disabled.
  - Input: ids (GUID or numeric), or a CSV such as a results file, and an optional thorough scan.
  - It builds the plan with `allowRestore: false` through `browserPlanningGateway`, whose `restore` refuses. It then shows the summary text and downloads the plan JSON.

**Results-file operations.** New: `ReArchiveOrphanedHolder`, used from the unwind phase. Nothing writes rows yet.

**Tests.** 434 tests: 360 pass, 0 fail, 74 skipped (was 424 / 322 / 102). There are no skipped discovery tests left.
- **Now running:** every pure discovery test, plus the planner scenarios that restore nothing:
  - both active
  - archived holder classification
  - a failed check blocks planning
  - a clean check is not a failure
  - both sides deleted
  - an unlisted participant, recovered or named
  - a preview restores nothing
  - the CSV id reader
- **Split:** "a preview restores nothing and says so" now runs; "a real run says what it restored" waits for hold.
- **New:** targets (3), the parked operation (1), the delete proxy reads (4), the envelope helper (1), and the fake tenant's archived and deleted reads.
- **Still skipped:** hold 14, references 6, checkpoints 13, delete 1, unwind 40.

**End-to-end, offline.** `web/dev/drive-delete.mjs` against the mock. The mock now answers the dependency check and the batch read, and serves the measured archived envelope. Planning the deletion of a process by its numeric id found:
- the active holder through the dependency check (a ProcessLink);
- the archived holder's hidden Input through the archive scan, logged as "never reported";
- `PlannedIncomplete`, with "none restored";
- no PUT or POST sent.

The archive, move, ownership and expired-session scenarios still give their earlier results.

**For your live dry run.** Sign in on the deployed app, go to `/delete`, and paste the ids or upload a results file. Download the plan to compare with the script's R3 output. Leave "Also scan active processes" off to match the script's default. The dependency checks run one at a time, as the script's do, so a few hundred targets takes minutes.

**Decisions Cowork should check.**

- **Recovering a participant no listing returns** tries the batch read first, then the active read, as the script does. When the active read says "archived", it falls through to the batch read.
- **`parsePlan` only accepts web plans** (schema 1 with targets and a ledger).
- **Two unwind tests still opt into `activeReadServesArchived`**, the old mock's behavior, for the relocation probe. The unwind phase has to revisit them against the measured envelope.
- **`archive/outcome.ts` (W2) reads a 404 on the archive-state read as the archive having taken effect.** Measured, 404 means deleted. Archive runs never delete, so nothing is misreported today, but that comment and branch are wrong. I left W2 alone. Worth a line in F4 or later.

---

## W5 phase 1. Tests and fixtures first

Commits `9d70974` and `d09159a` on `claude/web-w5-1-tests`, stacked on F2. `9d70974` was
not mine: it was committed and pushed from outside this session partway through, with
an auto-generated message ("implement bulk delete engine…") over half-written stubs.
Squash-merge the PR so that message does not land on `claude/main`. Per the task, I
stopped after this PR for Cowork's review.

**Approach.** Every test of the three engine suites is ported to TypeScript, written
against **typed stubs**: real signatures and types, with bodies that throw
`notPorted('<phase>')` (`delete/phases.ts`). Each ported test is marked
`{ skip: PHASE.<phase> }` with its full assertions, so it typechecks now and runs when
that phase removes the skip. Skip rather than todo: a failing todo prints its stack, and
a hundred of those would bury a real failure. Where the app already has the port
(`compareTenantState`, `findVariationMasters`, `readGroupExists`, `resultRow` naming,
the archive path), the test runs now against it.

**Fixtures.** `Tests/Fixtures` holds real captured tenant payloads. They are read in
place by `delete/testing/fixtures.ts`, never copied. Ids and names come from the fixture
objects at run time, and test titles say "the holder" and "the target". The PowerShell
suites also inline tenant ids and names (dependency responses, variation names, group
names). Those are rebuilt from fixture values or replaced with synthetic ones. A grep of
`web/src` for the known ids and names is empty.

**What was built.**

- Pure-function stubs, from `Test-Dependencies.ps1`:
  - `delete/model.ts`: models, the delete index, case-insensitive field access.
  - `references.ts`: the reference finders and removers. Its bucket tables are real
    data.
  - `claims.ts`: dependency claims, holder work items, reconciliation.
  - `ledger.ts`: ledger entries, snapshots, plan ledger rows, plan serialize/parse.
  - `collateral.ts`, `groups.ts`, `names.ts`.
- `delete/gateway.ts`: `DeleteGateway`, one method per proxy operation the engine
  needs. It extends `ArchiveGateway` with listing, dependency check, batch and single
  model reads, save, publish, restore (with a no-retry option for the relocation probe),
  delete, and the holding-group calls. Failures carry status and tenant message, as
  `PmRequestError` does.
- Planner, executor and orchestrator stubs: `planner.ts`, `executor.ts`,
  `runOutcome.ts`, `holdingGroup.ts`, `targets.ts`, `bulkDelete.ts`, plus `events.ts`.
  The console output becomes typed events, so tests check what was said and in what
  order. Prompts and switches (`-AcceptCollateral`, `-AllowUnheldTargets`, the
  collateral gate, `OnFailedTargets`) become explicit options and `decisions`
  callbacks. Module globals (the model cache, the relocation probe, the last-restore
  status) become explicit values. `resumeUnwind` finishes a run from an uploaded plan.
  `planStore.ts`: the plan must be saved before the first mutation.
- Working test infrastructure (not stubs, with 8 passing tests of their own):
  - `testing/fakeTenant.ts`: implements `DeleteGateway` with state, a call log and
    per-scenario hooks (`fail`, `noEffect`, `after`, `restoreActive`,
    `missingGroupIds`, and more).
  - `testing/planStore.ts`: records what was saved at the first mutation.
- `archive/parity.test.ts`: the uncovered assertions of `Test-BulkArchive.ps1` against
  the existing archive code. All pass.

**Assertion accounting.**

| PowerShell suite | Assertions | Ported | TS assertions | Run now | Skipped (phase) |
|---|---|---|---|---|---|
| Test-Dependencies | 194 | 194 (2 disk checks as 1 serialize check) | 195 | 47 | discovery 56, references 35, hold 30, checkpoints 26 |
| Test-Executor | 156 | 156 | 163 | 0 | tests: discovery 5, hold 11, references 1, checkpoints 1, delete 1, unwind 14 |
| Test-BulkDelete | 170 | 170 | 190 | 3 tests | tests: discovery 1, hold 1, checkpoints 1, unwind 26 |
| Test-BulkArchive | 150 | 53 already covered, 67 added, 21 not applicable (console and menu), 9 differ | 92 | all | none |

Disk and console checks are ported by intent: "plan on disk before the first restore" is
"plan saved to the store before the first mutation", and console order is event order.

**Tests.** 424 tests: 322 pass, 0 fail, 102 skipped until their phase (was 281). About
680 TS assertions added. Typecheck and production build are clean.

**New tests for T1 and T2** (skipped, unwind phase), marked `// NEW (T1)` / `// NEW (T2)`:

- **T1:** an uploaded plan alone puts back every process the run un-archived.
- **T1:** declining the final confirmation puts them all back.
- **T1:** every process that took a successful mutating call has a row.
- **T1:** a fatal 401 leaves a saved plan that `resumeUnwind` finishes.
- **T2:** the parked holder is restored into the holding group, discovery runs again
  while it is held, and it is re-archived before the group is removed.

**Decisions Cowork should check.**

- **Phase boundaries.** The planner's scenario tests are tagged `hold`, not
  `discovery`, because `buildDeletePlan` returns its plan through `newDependencyPlan`
  and `ledgerToPlanRows`, which are tagged `hold`. If the discovery PR should prove the
  planner, those two move into discovery. Every orchestrator scenario is tagged `unwind`,
  because `runBulkDelete` runs the end-of-run re-check on every exit path.
- **T2's "own results operation".** The script writes `ReArchiveHolder` for ordinary
  and parked holders alike. The tests keep that. Say if parked holders should get a
  distinct operation (e.g. `ReArchiveOrphanedHolder`).
- **The plan file is camelCase**, so it will not read the script's `Delete_Plan_*.json`.
  I assumed web plans only need to round-trip with the web app.
- **The fake tenant follows the tenant as measured** where the PowerShell mocks were
  loose: the active read 404s for archived processes, and `StateId` follows state. Two
  executor tests opt into the mocks' looser behaviour.
- **Fatal errors reject `runBulkDelete`** rather than returning a stopped result. The
  T1 resume test relies on the plan saved before that.

**Found in the archive parity check** (not fixed: outside W5; your call):

- **`resolveSelection` overflows the stack** if the tenant ever lists a group as its own
  descendant. The PowerShell test expects a cycle to finish. It fails before any write,
  so it is safe, but it is an exception, not an answer. W1 did not document it.
- **The `/archive` variation warning** does not say that a dragged-in master lands in the
  archived list, which is where a later Delete takes targets from. The script said so.
- Smaller documented differences remain as W2 recorded them: collateral reported, not
  reversed; a link column in the review file; a checked group always means its whole
  subtree.

---

## F2. Fixes from live round R12

Commit `809966c` on `claude/web-f2-r12`, stacked on W4.

**What changed.**

- **Dead session.** `pmRequest` (`pm/client.ts`) calls `fetch` with `redirect: 'manual'`.
  A 3xx (or a browser's opaque redirect) throws a `PmError` with `sessionEnded: true`
  and is never retried. A 401 sets `sessionEnded` too. A 2xx body that should be JSON
  and isn't raises a `PmError` with the status and a 200-character excerpt instead of a
  `SyntaxError`. If it is HTML (the sign-in page), it also ends the session. New
  `isSessionEnded()`. A 403 is unchanged: a refusal of that call.
- **Proxy mapping.** The route's error handling moved to `pm/proxyError.ts`
  (`proxyError`), so it can be tested without Next.js. It now signs out on
  `isSessionEnded`, not `status === 401`.
- **Picker layout.** `globals.css`: the checkbox rule now covers radios too
  (`width: auto; flex: none`). The full-width text input rule was reaching the
  destination picker's radios. Checked in headless Chrome: the radio computes to 13px
  and the names sit beside it.
- **Move results.** `describeOutcome` (`move/run.ts`) says what happened from the model
  read after the run: "Published as 2.0; the open draft went live.", "Published as
  4.0.", "Now at 0.4, in progress and not published.", "Now at 2.1, awaiting
  approval.", or "Its version could not be re-read." `settleMoves` takes those reads,
  and `/move` makes one `process.summary` per moved process after the run. Groups
  still say "No process revision changed." The preview wording is unchanged.
- Fixed in passing: the archive run's "Stopped while archiving" message ended in "..".

**Results-file operations.** None new. `UpdateLocation` messages for moved processes now
carry the version.

**Tests.** 281 tests, 281 pass (12 new). `client.test.ts`: a 302 is a dead session,
sent once, with `redirect: 'manual'`; an opaque redirect; a sign-in page; a non-JSON
body that is not HTML keeps the session; a 403 keeps it. `proxyError.test.ts` runs
browser gateway, route mapping and client in one process against a tenant answering as
R12 measured. For **a 302 and for a 2xx HTML page**, an archive run mid-flight signs out
and stops: one tenant call, then a Failed row and Skipped "Not attempted" rows. A read
reaches the browser as `signedOut`. A 403 keeps the tenant's words, and a refused SCIM
key stays a 400. `move.test.ts`: `describeOutcome` for each state, and the settle
messages.

**End-to-end, offline.** `web/dev/drive-expired.mjs`: the mock's new `/_expire` makes
`GET /Api/v1/Processes/{id}` and `ArchiveProcess` answer 302, as R12 measured. Expiring
between preview and run: the page says "Your session ended. Sign in again and resume.",
every process has a row (the batch already in flight Failed, the rest Skipped), and no
"Unexpected error" appears. The move scenario makes one version read per moved process
after the run.

**Decisions Cowork should check.**

- **Any 3xx from the tenant is treated as a dead session**, as the task says. If some
  endpoint legitimately redirects (http to https, say), it would now sign the operator
  out instead of following. Sign-in itself uses its own `fetch` and still follows
  redirects.
- **A non-JSON 2xx that is not HTML** is an error for that call, not a sign-out.
- The batch in flight when the session dies still gets sent (up to four archives), as
  before: a sent request cannot be recalled. Those rows are Failed "Stopped while
  archiving", and the final read settles them.

---

## W4. Bulk Update Ownership

Commit `d0062e7` on `claude/web-w4-ownership`, stacked on F1.

**What changed.**

- `ownership/csv.ts`: `parseOwnershipCsv` takes the script's column names, in any case,
  BOM stripped, the first non-blank matching column winning (`Get-RowValue`). It refuses a
  file with no id column, naming the columns it found, and lists non-GUID ids for a
  warning.
- `ownership/plan.ts`: `resolveCell` follows the script's cell rules: blank leaves the role
  unchanged, the five unassign keywords set id 2 "Needs to be reassigned N/A", a number is
  a user id, anything else a logon. Logons are matched case-insensitively against the
  SCIM directory, and a logon two accounts share is refused, not guessed (`scim.ts`).
  `buildOwnershipPlan` applies the script's row rules with its wording, reads each
  process once, and picks a `WritePath` with PGM's rules (`chooseWritePath`).
  `describeChange` uses the script's "Owner: Old (id 7) -> New (id 101)".
- `ownership/run.ts`: `runOwnership` sends one `process.setOwnership` per process and,
  when the path publishes, one `process.publishNow` with the change description as
  `PublishMessage`. Both steps are journaled and never resent. Two at a time.
  `settleOwnership` settles every written row from a fresh read of the process.
- `pm/ownership.ts`: `getOwnership` (compact: roles, revision, permissions) and
  `setOwnership`, the read-modify-write on the server. It refuses if
  `ProcessRevisionEditId` moved since the preview, saves through PGM's
  `buildUpdateEnvelope`/`updateProcess` (now in `pm/processes.ts`: `ProcessJson` as a
  string, `DoPublish: false`, `SuppressChangeNotification: true`), then reads the new
  revision for the publish.
- `pm/scim.ts`: the display name now prefers SCIM `displayName`, as the script does, so
  the name written into `Owner`/`Expert` matches the script's.
- Proxy: `process.setOwnership` (write: one GUID, a positive revision, each role null or
  exactly `{ id, name }`, at least one role, a change description, `submitForApproval`
  boolean, and no other field, including `suppressChangeNotification`).
  `process.ownership` and `users.directory` (the SCIM key and nothing else) are reads.
  `WRITE_OPERATIONS` is now archive, publishNow, group.delete, node.move and
  setOwnership.
- UI: `/ownership`, enabled on the landing page. Upload, SCIM key, publish choice
  (default "Save only", the script's behavior), then preview, change description and
  confirm.

**Decisions from the spec.** `SuppressChangeNotification` is always true, and there is no
switch to turn notifications on, as PGM did. "Save only" and "Match current state" are
PGM's. Under either, a process in progress is only saved, a process awaiting approval is
Blocked, and a published process the user can neither publish nor submit is Blocked
under "Match current state".

**Results-file operations.** `UpdateOwnership` (the script's Mode 4 name), `ObjectType`
`Process`, in the shared columns, not the standalone script's
`ProcessID,ProcessName,Status,Message,ActionUrl`. Statuses: `Success`, `Preview`,
`Skipped` (the script's reasons, plus already set, archived, and changed since the
preview), `Pending` (published but awaiting approval), `Blocked` (permission, awaiting
approval, or a 4xx), `Failed`, `Unverified`. Messages carry the CSV line numbers.

**Tests.** 269 tests, 269 pass (25 new). Covered: column aliases, case, BOM, first
non-blank match, the refusals, every cell rule including ids, inactive users and shared
logons, each script row rule, folding rows, already set and stale names, 404/5xx/archived
reads, a dead session in planning, every write path, the preview wording, the save and
publish calls and their arguments, a conflict, a 4xx, a failed publish, a missing
revision, a dead session mid-run, journal replay, and each settle outcome. Proxy tests:
the parse refusals above, and the PUT body (model as a string, only named roles changed,
everything else passed through, suppression on), the conflict check, and the compact
read.

**End-to-end, offline.** `web/dev/drive-ownership.mjs` against the extended mock, with
"Match current state": a published process saved and published (one PUT, one Publish
with the description), one in progress saved only, one set to the placeholder and
published, and rows skipped for an unknown username, a non-GUID id and an empty row. All
three settled Success from the final read. The archive and move scenarios still give
their earlier results against the extended mock.

**Decisions Cowork should check.**

- **Several rows for one process are folded into one write**, the last non-blank cell
  per role winning. The script saved once per row, so the end state is the same with
  fewer revisions.
- **Rows that change nothing are not saved** ("Already set"). The script saved them
  anyway, bumping a version.
- **Non-GUID ids are skipped without a call.** The script tried them and failed on the
  read.
- **An archived process is skipped** when its model says `isArchived`. If the tenant
  answers 404 for archived processes instead, the row is Failed "Process not found ...
  An archived process cannot be read this way". Not measured.
- **The SCIM directory is read whole** (`scim.ts`), not one filter query per username as
  the script does. One paged read per run. `SCIM_BASE_URL` overrides the host.
- **Submit-then-publish is one PUT with `DoSubmitForApproval: true`, then Publish**,
  as PGM's code does. PGM's design notes describe save, then submit, then publish as
  three writes. Worth one live check on a process where `CanPublishAfterEdit` is false.
- **Not measured live:** whether a 200 Publish after an ownership save can still be
  queued for approval. The final read reports that as Pending.

---

## F1. Answers to the W2 to W3 questions, and one cleanup bug

Commit `c1667ad` on `claude/web-f1-fixes`.

**What changed.**

- **Cleanup and archived documents.** `getGroupDocuments` (`pm/processes.ts`) now reads
  `ListType=All` and `ListType=Archived` and adds them up, so a group whose only
  document is archived is kept and reported, not offered for deletion. Archived names
  carry "(archived)" in the reason. I made the change in the read rather than in
  `gatherFacts`, so `group.documents` stays one proxy operation (two tenant calls) and the
  planner and its tests are unchanged.
- **Breadcrumb.** `breadcrumbTitles` (`pm/groups.ts`) reads only the captured shape,
  `breadcrumbItems[].name`, dropping the first item (the tenant). An empty list is an
  empty path. The guessed shapes are gone.
- **Group links.** `groupLink` gives `{siteUrl}/Process/Group/{uuid}`. `itemLink` moved
  from the results component into `archive/run.ts` beside `processLink`. It links
  `ProcessGroup` rows as well as processes, on screen and in the manual review file.
  Documents still get no link.
- **Draft detection.** `isDraftOverPublished` (`move/plan.ts`): revision state 1 at a
  major version of 1 or more. `buildMovePlan` reads the model through `process.summary`
  (new `revision` read on `MovePlanReads`) **only for moves the pre-flight prompted on
  whose wording didn't already say "outstanding changes"**. Either signal puts the process
  in "Tick to move". If that read fails, the process goes there as `unknown`, with a note.
- **Dev tools.** `web/dev/`: `mock-pm.mjs` (stand-in Process Manager, all names made up),
  `cdp.mjs` (headless Chrome driver), `drive-archive.mjs`, `drive-move.mjs`, and a
  README. Nothing in `src/` imports them, and they sit outside the build and the
  typecheck. I extended the mock with archived documents, the breadcrumb and a full
  process model.

**Results-file operations.** None new or renamed.

**Tests.** 244 tests, 244 pass (5 new, 1 rewritten). Covered: both document lists
read and summed, a group with only an archived document has documents, the captured
breadcrumb shape (and an empty one, and the old shapes no longer read), group and
document links, the revision rule, a draft the wording misses caught by its revision
(with only that one model read sent), and a failed revision read setting the process
aside.

**End-to-end, offline.** Against the mock, production build, headless Chrome. Archive
then cleanup: Retired deleted (one `DeleteGroup`), and Forms, Policies (archived
document only), Payables and Finance kept. Before this fix Policies would have been
offered for deletion. Move: two `ReorderTreeNodes` calls, the draft left unticked, and
one model read, for the published process.

**Decisions Cowork should check.**

- **The structured check costs one extra GET per published process moved**, not zero.
  The move plan never called `process.summary`, and it reads `variationSetData` only for
  processes the tree marks with a set. For a large move of published processes this
  roughly doubles the pre-flight calls. I could fold both into one read later if it
  matters.
- A move the pre-flight doesn't prompt on is never model-read. S2 says every process with
  a published version prompts, so a draft over a published version always prompts.
- `group.documents` makes two tenant calls. If the archived document list is ever
  refused for a permission reason, the read fails and the group is kept, which is safe.

---

## W3. Bulk Move

Commit `5ebca76` on `claude/web-w3-move`, stacked on W2b.

**What changed.**

- `move/select.ts`: `resolveMoveSelection` picks the fewest, highest nodes. A fully
  checked group moves as one node. A checked group with exceptions inside is opened and
  its included children considered one by one. A checked process moves on its own.
  Shortcuts, document groups and unmeasured types are excluded with the reason.
  `destinationOf` builds the destination with its ancestry (document groups are refused).
  `destinationProblem` holds PGM's checks: never into itself or its own subtree, never a
  process at the top level, and no call for something already there.
- `move/plan.ts`: `buildMovePlan` pre-flights each individually moved process with
  `ValidateProcessAction` (action 11). `classifyValidation` sorts each into `clean`,
  `republish` (prompt), `draft` (prompt mentioning "outstanding changes"), `refused`
  (Blocked, with the tenant's words) or `unknown` (the pre-flight couldn't be read). It
  reads `variationSetData` for any process the tree marks with a set id and lists every
  sibling. Viewer counts come from one `GetTotalSpecifiedGroupRoleAndUserViewers` call
  for both ends of every move (advisory; failure is reported, not a gate).
- `move/run.ts`: `runMoves` sends one node per call, journaled, and passes `nodeType`
  through. `settleMoves` settles each from fresh reads of the destination and source
  levels, and gives each variation sibling its own row from the listing.
- Proxy: `node.move` (write) takes one node GUID, a movable `nodeType` (`group`,
  `process`, `inprogress-process`, `vanillaprocess`), and parents that are each one GUID
  or null. It refuses a shortcut, a document group, a node as its own parent, a process
  at the top level, and any extra field. `process.validateMove` and `groups.viewers`
  (up to 200 numeric ids) are reads.
- `select/resolve.ts`: the level-reading loop is now `readUntilResolved`, shared by
  Archive and Move.
- UI: `/move` with `DestinationPicker` (groups only, top level allowed for groups).
  `components/ResultsSummary.tsx` and `components/SessionGate.tsx` are now shared by
  Archive and Move.

**The preview, per S2.** "Would move" lists groups ("No process revision changes"),
never-published processes ("minor version bump") and published ones ("A new major
version will be published", with the tenant's message). **"Tick to move"** lists
processes whose draft would go live, and any whose pre-flight couldn't be read. These
are unticked by default, each with the tenant's message. The confirmation button counts
the republishes. Variation siblings are named under the process they move with.

**Results-file operations.** `UpdateLocation`, the script's Mode 3 name, with
`ObjectType` `Process` or `ProcessGroup`. Statuses: `Success`, `Preview`, `Skipped`
(already there, not ticked, not attempted), `Blocked` (refused, in the pre-flight or by a
4xx), `Failed`, `Unverified`. One row per variation sibling that moved with a process.

**Tests.** 239 tests, 239 pass (19 new). Covered: whole group vs per-child resolution,
the three destination checks, document-group destinations refused, every pre-flight
classification, drafts set aside and only sent when ticked, refused and unreadable
pre-flights, siblings named from the set, one viewer call for both ends, one call per
node with the type passed through, `success: false`, 4xx and a dead session, and the
final read in both directions with sibling rows. The allowlist tests cover every refusal
listed above.

**End-to-end, offline.** Against the mock: moving a group, a published process and a
process with an open draft into another group sent two `ReorderTreeNodes` calls (one
node each, `NodeType` passed through). The published process was flagged and counted as
republished. The draft was left unticked and recorded as Skipped with the tenant's
message.

**Decisions Cowork should check.**

- **"Draft goes live" is detected by the words "outstanding changes"** in the
  pre-flight message, as the task describes. If the tenant words it differently in
  another language or version, those processes would land in "Would move" as ordinary
  republishes, still flagged and counted, but ticked. A field that says so would be
  better if one exists.
- **The variation set is read only for processes the tree marks with a
  `variationSetId`**, the same trigger as Archive.
- A group moved whole is never pre-flighted, because the task and S2 say a group move
  changes no revision. Groups have no `ValidateProcessAction` equivalent with a
  destination (S2).
- Viewer "before" for a group is the group's own count and for a process its group's,
  as PGM did. "After" is the destination's count. Both are the product's numbers.
- No link for group rows: the group URL format isn't recorded.

---

## W2b. Folder cleanup after Archive

Commit `3026aa3` on `claude/web-w2b-cleanup`, stacked on W2.

**What changed.**

- `select/resolve.ts`: a complete resolution now also returns `groups`, every group the
  selection covers (checked itself or inside a checked group), with path and depth. The
  archive plan carries them as the cleanup candidates.
- `cleanup/plan.ts`: `planCleanup` decides deepest first. A group is **kept** if it
  still holds an active process, a shortcut, a document group or an unmeasured item; if
  it holds a subgroup that is kept (including one the selection didn't cover); if it
  holds any document; or if its contents or documents couldn't be read. Otherwise it is
  deleted, carrying the archived processes that will lose it.
- `cleanup/facts.ts`: `gatherFacts` reads each candidate's tree level and documents.
  Archived processes come from the archive run's final index, filtered by
  `groupUniqueId`.
- `cleanup/run.ts`: `runCleanup` deletes one at a time, deepest first, and **re-reads
  each group just before its delete**. Children this run already deleted are ignored, so
  a parent isn't blocked by a stale entry. `settleCleanup` settles every group row from
  a fresh read of the parent level, the same rule as archive.
- `pm/groups.ts`: `deleteGroup`, `readAssociatedContents` (parses the 409),
  `getGroupBreadcrumb` / `breadcrumbTitles`. `pm/processes.ts`: `getGroupDocuments`
  (`ListType=All`, `ProcessGroupId`).
- Proxy: `group.delete` (write), `group.documents` and `group.breadcrumb` (reads), each
  taking exactly one group GUID and no other field. `WRITE_OPERATIONS` is now archive,
  publishNow and group.delete.
- `select/archived.ts`: `loadGroupPaths` and `groupsNeedingPaths` for breadcrumb bucket
  labels. **Not wired to a screen yet**, because the archived view's only consumer is
  Bulk Delete (W6). The helper and the read are tested.
- `/archive`: step 4 appears under the results only when the run finished cleanly and
  the final read succeeded. It checks, shows what would be deleted with every archived
  process that becomes unrestorable, needs its own checkbox, and appends its rows to the
  same results file.

**Results-file operations.** `DeleteGroup` rows with `ObjectType: ProcessGroup` (the
script's spelling, from `Remove-HoldingGroup`): `Success` (deleted), `Skipped` (kept,
message starts "Kept." with the reason), `Blocked` (409, naming the documents), `Failed`.
**`GroupDeleted`/`Orphaned`**: one row per archived process a deleted group leaves
without a home, so every process the run changed has a row. I changed the report's
`ObjectType` from `Group` to `ProcessGroup` to match the script.

**Tests.** 220 tests, 220 pass (23 new). The five cases the task names are all
covered: a group that deletes, one kept for a document, one kept for an active process,
a 409 from the tenant (Blocked, document names, sent once, no orphan rows), and nested
groups deleted deepest first. Also covered: a kept subgroup keeps every ancestor, a
shortcut keeps its group, unreadable facts keep the group, a group that gained an item
since the preview is kept, a dead session stops the step, and the final read overrules
the calls in both directions.

**End-to-end, offline.** The same mock and headless Chrome run, extended: after the
archive, Retired (emptied) was deleted, Forms was kept for its document, Payables for
the process the tenant refused, and Finance because its subgroups were kept. One
`DeleteGroup` was sent.

**Decisions Cowork should check.**

- **The breadcrumb response shape was not recorded** beyond "root first, group last".
  `breadcrumbTitles` accepts an array or `{items|breadcrumbs|data|breadcrumb}`, takes
  `name`/`title`/`Name`/`Title`/`text`, and drops the first entry as the tenant. A
  captured response would let me pin it.
- `group.documents` uses `ListType=All`, from the task. The API notes only show
  `ListType=Archived`. If `All` isn't valid, the read fails and every group is kept,
  which is safe but would make cleanup useless. Worth one call to confirm.
- A shortcut (`linked-process`) in a group keeps it. Nobody has measured what
  `DeleteGroup` does to a shortcut, and deleting through one is the risk W1 avoided.
- Cleanup isn't offered when the archive stopped early or its final read failed. The
  candidates and orphan lists both come from that read.

---

## W2. Bulk Archive

Commits `2f9832a`, then two follow-ups for requirements added while W2 was in flight:
`5f36abf` (`PublishMessage` on every publish) and `6bbf48b` (siblings from
`variationSetData`). All on `claude/web-w2-archive`, stacked on W1. `c8bda99` and
`2745a6f` commit Cowork's spike results and variation findings as written.

**What changed.**

- Proxy: `process.archive` (id plus comment), `process.publishNow` (id, revision,
  `publishMessage`) and a read, `process.archiveState`. `WRITE_OPERATIONS` is exactly the
  first two. All three go through `singleProcessId`: the id must be one GUID, and **a
  body with any field the operation doesn't name is refused**, so a second id can't ride
  along under another key.
- `pm/processes.ts`: `archiveProcess` (write retry policy, so 5xx isn't resent),
  `getArchiveState` (isArchived from the model, then the envelope, case-insensitive;
  absent reads as null; 404 is `found: false`). `publishProcess` now always sends
  `PublishMessage`.
- `pm/client.ts`: `tenantMessage`, a port of `Get-NpmErrorDetail` (first text field of
  message/Message/error/errorMessage/title/detail, capped at 500).
- Proxy route: errors carry `status` and `message` (the tenant's words). **A 403 is no
  longer treated as a dead session**; see below.
- `archive/outcome.ts`: `archiveOne`, a branch-for-branch port of
  `Set-NpmProcessArchived`. Same outcome names (`Archived`, `PendingApproval`,
  `Overridden`, `Refused`, `Failed`) and messages, same status mapping, with "no
  response" instead of "HTTP 0".
- `archive/plan.ts`: `buildArchivePlan`, `findVariationSiblings` (every
  `variationSetData.OtherVariedProcesses` entry that isn't a target, read at planning
  time for each target the tree marks with a `variationSetId`), `findVariationMasters`
  (the script's name heuristic, still run alongside), `previewRows`. A set that can't be
  read is listed in the preview as unread, not silently skipped.
- Proxy read `process.variationSet` (one id) and `pm/processes.ts` `getVariationSet`.
- `archive/run.ts`: `runArchive`, `settleFromFinalRead`, `collateralRows`,
  `manualReviewCsvRows`, `processLink`.
- `tenant/state.ts`: `loadProcessIndex` and `compareTenantState`, ported from
  `Get-NpmProcessIndex` and `Compare-TenantState`. W5 will reuse both.
- `/archive` page: select, preview (downloadable), one change description, the approval
  override checkbox (on by default), variation acceptance, a confirm step, cancel
  between batches, results with counts, a needs-attention table linking each process,
  results CSV, and the manual review CSV.
- `/api/auth` GET now returns `siteUrl` so a refusal can link to the process.

**Results-file operations and statuses.** `Archive`, `VariationWarning` and `Select`
(a shortcut or other excluded item, Skipped with the reason) are new, plus
**`Collateral`/`Unreversed`**. Statuses follow the script's vocabulary plus `Accepted`
(as the script uses it) and `Unreversed`.

**Tests.** 197 tests, 197 pass (55 new). `outcome.test.ts` covers every branch of the
port, including the two the task names: **a 200 that's still pending** (overridden with
the post-archive revision, or reported Pending when the override is withheld or fails),
and in `run.test.ts`, **a call that reports failure but took effect**, which the final
read settles as Success. Allowlist tests cover one id only, no second id under another
key, and the exact request bodies.

**End-to-end, offline.** I ran the built app against a local mock Process Manager
(not a tenant) and drove it through headless Chrome: sign in, check a group, preview,
apply. The plan resolved the subgroup and left out the unselected group. The pending
process was overridden with the post-archive revision as a string. The 400 came out
Blocked with the tenant's message. The 500 that still took effect came out Success. Each
archive was sent exactly once. The mock and driver are in my scratchpad, not the repo;
say if you want them committed as a dev tool.

**Deviations from the script, and why.**

- **The final read checks every sent row, not just successes.** The script only
  re-checked rows the calls called successful, but the API notes record failed calls
  that took effect, and the spec says every final status comes from a fresh read.
- **Collateral is reported, not reversed.** The script restores unwanted archives
  (`Restore-CollateralState`). That needs a restore operation, which isn't in W2's
  allowlist. Collateral rows say so and point to Process Manager. Given that S-results
  and R-rounds place the coupling on delete rather than archive, I expect these to be
  rare. W5 adds restore anyway, and archive can use it then.
- **The baseline is re-read just before the first write**, not reused from the preview,
  so another operator's edits between preview and apply aren't blamed on this run, and
  a target archived meanwhile is skipped rather than sent.
- **403 is a refusal, not a sign-out.** PGM signed the operator out on 401 or 403. For a
  bulk archive, a 403 on one process is much more likely to be a permission refusal than
  a dead token, and signing out would stop the run. **Cowork: worth checking what an
  expired token returns on this tenant.** If it's 403, I'll treat N consecutive 403s as
  fatal.
- **Variation warnings use two signals**: `variationSetData` siblings, plus the
  script's name heuristic. Both need explicit acceptance on screen before Apply is
  enabled. The set is read only for targets the tree marks with a `variationSetId`.
  Reading every target's full process document would cost one GET each, and the tree
  marked all 13 variation records Cowork found. If a variation can turn up without a set
  id, that trigger needs widening.
- **Resume is by re-planning.** If the tab dies mid-run, the journal stays in
  sessionStorage and the page says how many archives are in doubt on the next visit.
  Re-planning lists anything already archived as skipped, which is naturally idempotent
  for archive. There's no plan-file upload for archive.
- The manual review CSV gains a `Link` column. The spec asked for the tenant's message
  and a link.

---

## W1. Tree browser with processes, and the archived view

Commit `7e97808` on `claude/web-w1-tree` (stacked on W0's branch).

**What changed.** New `web/src/lib/select/`:

- `browse.ts`: tree model that keeps every item type. Nodes are keyed by placement
  (`groupId` for groups, `parent>processId` for everything else), because a process can
  appear under its home group and again as a shortcut. `addBrowseLevel` replaces a
  level on re-read and drops anything that has gone, keeping loaded levels below groups
  that survive.
- `selection.ts`: tri-state selection as explicit include/exclude marks. `toggle`,
  `checkState`, `effectiveMark`, `isSelectable`. A checked group means "everything
  under it", whatever was expanded.
- `resolve.ts`: `resolveSelection(tree, selection)` is pure. It returns every selected
  process with its group path, group id and `variationSetId`, plus an `excluded` list
  with a reason per item. If a level it needs is unread, it returns `incomplete` with
  the groups to read, never a partial answer. `loadForSelection` reads exactly those
  levels and resolves.
- `archived.ts`: `loadArchived` (pages ListType 7 until a short page, deduplicates by
  id, page cap), `readGroupExists` (the script's `ConvertTo-NpmGroupExists` rules),
  `groupArchived` (buckets by original group, orphans last, counts unreported rows).
  Bucket labels use the tree path when the tree knows the group, else `groupName`,
  until S3 says which fields give the path.
- `rows.ts`: what the tree component draws, as plain data, so it is testable without a
  DOM.
- `fixtures.ts`: a synthetic recorded tree and archived listing in the endpoints' exact
  response shapes.

UI: `components/TreeBrowser.tsx` (with the `useBrowseTree` lazy-loading hook),
`components/ArchivedView.tsx`, `components/Checkbox.tsx` (tri-state). `/preview` renders
both views from the fixture in development and answers 404 in production. I checked it
in headless Chrome: both views render, and the production build returns 404.

`web/AGENTS.md` is written by `next dev` and recreated if deleted; it is committed so the
tree stays clean.

**Results-file operations.** None. Still read-only.

**Tests.** 142 tests, 142 pass (33 new): `resolve.test.ts` 19, `archived.test.ts` 10,
`rows.test.ts` 4. The four cases the task names are covered: nested groups, partial
selection, document groups excluded, and a group checked then one child unchecked. Also
covered: an unexpanded checked group is never resolved from the screen, a group the
server says has no children is still read, shortcuts and unknown types are excluded with
a reason, and a process listed twice resolves once. For `groupExists`: the flag decides
(including an orphan with a real numeric id), `groupId 1` with the flag true is not an
orphan, and absent is not false.

**Decisions Cowork should check.**

- **Which tree item types are processes.** Only `process`, `vanillaprocess` and
  `inprogress-process` resolve into a plan. `linked-process`, `embeddedprocess`,
  `suggested-process` and any unknown type are shown, can't be selected, and are listed
  as excluded. I think `linked-process` is how a shortcut appears in
  `GetChildProcessGroupTreeItems`, and archiving or deleting through a shortcut would act
  on a process homed in a group nobody selected. Nobody has measured this. **Worth adding
  to the spikes: what itemType does a shortcut have in the tree, and what are
  `embeddedprocess` and `suggested-process`?** If `linked-process` turns out to be
  something else, it's a one-line change in `browse.ts`.
- A group is always read when it's needed, even when `hasChild` is false, because
  `hasChild` hasn't been shown to count processes as well as subgroups.
- Selecting in the archived view is a flat set of ids. A bucket's checkbox means "these
  rows as listed now", not "whatever is archived from this group at plan time". Delete
  by group (W6) covers the plan-time meaning from the tree side.

---

## W0. Scaffold `web/` from process-group-manager

Commit `624b9ae` on `claude/web-w0-scaffold`. (`9c28459` before it commits the Cowork
session's spec and task changes as written, so the PR carries them.)

**What changed.** New `web/` Next.js 16 app lifted from PGM at
`429b6403e28b37bb1572241291954fc3311b2a81`. `web/README.md` has the module-by-module
table of what was kept and what changed. In short:

- Auth (`lib/auth/*`, `api/auth`) unchanged except the cookie name (`npmbo_session`).
- Proxy allowlist (`lib/pm/operations.ts`) is read-only: `groups.tree`,
  `process.summary`, `processes.list`. New `WRITE_OPERATIONS` constant, empty.
- `groups.ts` lost create and rename; `processes.ts` lost shortcuts, the PUT and the CSV
  report. Both come back only if a later task needs them.
- `exec/journal.ts`: this app's action kinds and step names, keyed by object id.
- `exec/runner.ts`: rewritten down to `createControls`, `defaultIsFatal`,
  `forEachBatched`. PGM's runner is 1,450 lines of group, champion and shortcut steps;
  none of it applies, and its rules are kept in the shared controls.
- `exec/report.ts`: rewritten to the script's results columns (`ObjectType, ObjectID,
  Name, Operation, Status, Message, GroupId, StatusCode`) via `resultRow`,
  `resultsToCsv`, `countByStatus`. `resultRow` holds the script's rule that Name is
  never the ObjectID, using the script's `(name unavailable; not in any process list)`.
- `plan/revalidate.ts`: generalised to `revalidatePlacements`, which checks each planned
  item is still in the level the preview saw it in. PGM's version only knew group plans.
- `plan/load.ts`: the whole-tree loader from PGM's `orchestrate.ts`.
- Landing page with four disabled tiles; SSO warning on the sign-in page.
- Root README section on running it locally.

**Results-file operations.** None yet.

**Tests.** `npm test` in `web/`: 109 tests, 109 pass. `npm run typecheck` and
`npm run build` clean. New tests: `exec/runner.test.ts` (6), `exec/report.test.ts` (5,
replacing PGM's), `plan/revalidate.test.ts` (5, replacing PGM's), two allowlist tests
in `pm/operations.test.ts` (read-only, and no archive/delete/publish/move op can be
named). Tests for stripped functionality were dropped. Live tenant ids and GUIDs in
PGM's fixtures were replaced with synthetic ones.

**Done-when, honestly.** Tests and typecheck pass and the allowlist has no write. I did
not sign in against a tenant, because CLAUDE.md keeps live calls with Cowork. Locally I
checked the built app: `/api/auth` reports signed out, the proxy refuses an unsigned
call with `signedOut: true`, a malformed site address is refused, and the security
headers are set. **Cowork: please do the one live sign-in.**

**Disagreed or deferred.**

- `vercel.json` is in `web/`, not the repo root. Vercel's root directory is a project
  setting, not a `vercel.json` key, so the file can only name the framework. The README
  says to set Root Directory to `web`.
- Sign-in accepts any host, as PGM does: the server POSTs the password to whatever
  origin the operator typed. That is how regional and custom hosts work, but it also
  means the deployment will make a request to any address. Worth deciding whether to
  restrict sign-in to known Process Manager hosts before this is public. I didn't,
  because I don't know the full host list and a wrong list locks real tenants out.
- `scim.ts` is lifted but no operation uses it until W4.
