# Context

Maintained by the Cowork session. Claude Code reads this but does not edit it.

## Where things stand (19 Oct 2026)

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
- Next: Claude Code works F5 then F6. Cowork then re-runs the R13 cases live before W6.
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
