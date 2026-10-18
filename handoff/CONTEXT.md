# Context

Maintained by the Cowork session. Claude Code reads this but does not edit it.

## Where things stand (18 Oct 2026, evening)

- Product is a web app, live at `https://bulk.ntx-poc.com/` against the demo tenant.
  PowerShell frozen at v4.11.
- Done and merged: W0 scaffold, W1 tree and archived view, W2 Bulk Archive, W2b folder
  cleanup, W3 Bulk Move (PRs #50 to #52). 239 offline tests pass.
- Handed over: F1 (small fixes), W4 Bulk Update Ownership, W5 Bulk Delete engine (one PR
  per phase). W6 waits on W5.
- Next for Cowork: live round R12 on the deployed app (Archive, folder cleanup, Move)
  using `ZZ Spike` test content only, plus measuring what an expired token returns.
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
