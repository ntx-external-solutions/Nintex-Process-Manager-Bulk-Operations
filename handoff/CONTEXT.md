# Context

Maintained by the Cowork session. Claude Code reads this but does not edit it.

## Where things stand (18 Oct 2026, evening)

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
- Next for Cowork: investigate the 3 unexplained mismatches before W5's delete phase;
  verify F4 live (needs JB to paste the SCIM key); review phase 3.
- Spikes S1 to S3 and the variation test are in `API_ARCHITECTURE.md`. One lasting change
  on the tenant: "SOC 2 Submission Review" and its Partner variation are published at 3.0.
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

- The post-delete collateral checkpoint has not been exercised in four rounds, because no
  run has reached a delete. It needs R12 to get past planning.
- Link reconciliation still reports 24 mismatches, all `claimed 2, located 1`. Not yet
  diagnosed.
- Three temporary groups on the tenant still hold eight processes stranded in rounds 2 to 4.
  This is manual tenant cleanup, not code.
- `Compare-TenantState` can only classify processes in the index, and the listing endpoints
  are incomplete (R3, F2). The output should say coverage is partial.

## How the loop works

1. Cowork tests against the tenant and writes tasks into `TASKS.md`.
2. Claude Code implements, commits, and reports in `REPORT.md`.
3. Cowork reads the report and the diff, re-tests, and updates this file.
