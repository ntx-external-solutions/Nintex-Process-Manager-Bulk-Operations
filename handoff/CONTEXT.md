# Context

Maintained by the Cowork session. Claude Code reads this but does not edit it.

## Where things stand (30 Oct 2026)

- Product is a web app, live at `https://bulk.ntx-poc.com/` against the demo tenant.
  PowerShell frozen at v4.11.
- Done and merged: W0 scaffold, W1 tree and archived view, W2 Bulk Archive, W2b folder
  cleanup, W3 Bulk Move (PRs #50 to #52). 239 offline tests pass.
- Handed over: F1 (small fixes), W4 Bulk Update Ownership, W5 Bulk Delete engine (one PR
  per phase). W6 waits on W5.
- R12 (live, 18 Oct evening) passed: Archive, folder cleanup and Move all matched the
  tenant. Fixes are in F2 (dead-session handling, picker layout, move result wording).
  All R12 test content was removed; tenant back to 13 top-level groups, 463 archived.
- F2 verified live (18 Oct, after PR #55): the picker lays out correctly (radio 13px);
  move results carry the version ("Published as 2.0.", "Now at 0.3, in progress and not
  published."), matching the tenant; a plain published process was republished as the
  preview said; an archive and cleanup under a valid session had no false sign-outs on
  the endpoints that now treat a redirect as a dead session. The dead-session path
  itself was not reproduced live (no way to kill a token from outside); it rests on the
  offline tests and `web/dev/drive-expired.mjs`.
- W4 tested live (18 Oct): works, tenant matched. Fixes in F4 (archived process fails
  instead of skipping; skipped rows lose their names).
- W5 phase 1 reviewed and approved with notes (fake tenant's archived read is wrong;
  move plan building into discovery so a read-only dry run is possible). Phase 2 next.
- W5 phase 2 live dry run (18 Oct): 74 claims (matches direct reads), 24 mismatches and
  11 orphaned holders (both match R11). 21 of the 24 mismatches are the dependency API
  listing each link twice; 3 are still unexplained. Phase 3 (hold) handed over.
- F4 verified live (18 Oct, no writes): an archived process is "Skipped. The process is
  archived ..." and named; an unknown-user row on a live process is named from the
  listing.
- W5 phase 3 (hold) code reviewed and approved; phase 4 handed over. Hold writes stay off
  the allowlist until the unwind phase, so live mutation testing waits for it.
- Phase 3 live check passed (18 Oct). Found: the archived batch read caps at 20 ids and
  both script and port used 25 with silent skips, so the archive-wide Input/Output scan
  read almost nothing; fix handed to phase 4. All 24 mismatches on R11's set verified as
  API over-claims (raw models match the plan in 24 of 24); gate relaxation handed to
  phase 4.
- W5 phase 4 (reference removal) reviewed and approved; the publish path must be read
  from each process (reuse W4's `chooseWritePath`), fixed at the start of phase 5.
- W5 phase 5 (checkpoints) reviewed and approved; live dry run after PR #66 shows 0 blocking
  mismatches (20 doubled, 1 over-claim, 3 reconciled across categories). Draft holders:
  refuse by default with an opt-in to publish, handed to phase 6.
- W5 phase 6 (delete) reviewed and approved; held-back targets must be decided before any
  reference is removed (fix at the start of phase 7).
- W5 phase 7 (unwind, orchestrator, run page) reviewed and approved. F5 (name the holding
  group) handed over.
- R13 (19 Oct), the first live delete, through the app on Cowork-built test content. Deletes,
  held-back re-archives, the ordering fix, the ticked draft publish and holding-group
  cleanup all worked; no collateral. Two engine bugs: every restored archived holder was
  refused as an open draft (the restore's own in-progress revision), and a false
  `groupExists: false` led the run to park a holder and then delete the group it was
  re-archived in, orphaning it. Both are in F6 with three smaller fixes. All R13 content
  removed; tenant back to 13 top-level groups, 186 active, 463 archived, every
  pre-existing id present.
- F5 and F6 done, reviewed and merged (19 Oct, PRs #70 to #72, 547 tests).
- R14 (19 Oct), the R13 cases again: pass, 16 Success and 2 Skipped, tenant matched every
  row. Restored holders are edited and re-archived, the real orphan was handled, the
  confirmation names everything before any edit, the holding group has its new name.
  Found: archiving publishes a new major version (so there's no archived draft, and no
  restored never-published process). All content removed; tenant back to 13 top-level
  groups, 186 active, 463 archived, every pre-existing id present.
- W6 done and merged (30 Oct, PRs #74 and #75; #75 opened the home-page tile, which was
  still disabled). 570 offline tests.
- R15 (30 Oct), W6 live through the app on Cowork-built test content: pass. Delete 17 rows
  (15 Success, 2 Skipped, 0 Failed), cleanup 4 rows (2 deleted, 2 kept); the tenant matched
  every row. Confirmed live: delete by group across levels never expanded, an unchecked
  subgroup kept out, the three ways in adding up, the holder preview, the final
  confirmation, `Archive` rows before `Delete`, cleanup deepest first with kept-subgroup
  reasons, and the archived view's orphan check (26 of 191 `groupExists: false` rows
  corrected, each verified by breadcrumb). Three small UI items in F7. All content
  removed; tenant back to 13 top-level groups, 186 active, 463 archived, every
  pre-existing id present.
- F7 (R15 UI items) and W7 (Archive by id or CSV, shared with Delete) done and merged
  (30 Oct, PRs #78 and #79).
- Documents spike (30 Oct): archive, restore and delete measured on `ZZ` content; results
  in `API_ARCHITECTURE.md`. Headlines: the API archives a document attached to a process
  (the UI refuses), refuses to delete one (`ProcessAttachment`), but misses draft-only
  references, and deleting a document a draft points at breaks that process. One process on
  the demo tenant is already broken that way. JB decided: attached documents (processes or
  training units) are never archived or deleted; documents get their own area, with restore
  and a repair tool for dead references added to W8.
- Next: W8 (documents) is Ready. Variations are still untested live (see below).
- Token duration (60000 minutes) deferred by JB; not a task.
- Process and group names were removed from Cowork's handoff text (18 Oct) per CLAUDE.md.
- Spikes S1 to S3 and the variation test are in `API_ARCHITECTURE.md`. One lasting change
  on the tenant: the variation set used for the S2 move test is published at 3.0 (both variations).
- Restricting sign-in to known Process Manager hosts is deferred by JB.

## What R11 confirmed working

- `-AcceptCollateral` opens the collateral gate as designed. The affected processes are
  listed, the approval is announced after the list, and each gets an `Accepted` row.
- `GroupId` is filled on results rows. The only blanks are processes no list sweep returns,
  plus the group row.
- `ObjectID` round-trips. A results file can be fed back in as a target file.
- `Set-NpmProcessArchived` works live. Most re-archives came back `Overridden` (pending,
  then cleared by the publish override) and a few came back `Archived` outright. That mix
  is why the archive state is read back from `isArchived` and not inferred from a switch.

## Still open, not yet tasks

- Variation sets in Bulk Delete (the partial-set default, and the R3 risk of deleting a
  variation archiving its master) are untested live: there is no test set, and creating
  one through the API is unmeasured. It's also the only realistic way to make the
  post-delete collateral checkpoint fire.
- Cleanup's "group still holding a held-back archived process" warning hasn't fired live.
  Such a group is only a candidate when the run also deleted something from it.
- The post-delete collateral checkpoint ran live in R13 and found none, which was right;
  it has not yet seen real collateral live.
- Edits over a revision awaiting approval can't be tested on the demo tenant (no
  approvals). Offline only.
- Three temporary groups on the tenant still hold eight processes stranded in rounds 2 to 4.
  This is manual tenant cleanup, not code.
- `Compare-TenantState` can only classify processes in the index, and the listing endpoints
  are incomplete (R3, F2). The output should say coverage is partial.

## How the loop works

1. Cowork tests against the tenant and writes tasks into `TASKS.md`.
2. Claude Code implements, commits, and reports in `REPORT.md`.
3. Cowork reads the report and the diff, re-tests, and updates this file.
