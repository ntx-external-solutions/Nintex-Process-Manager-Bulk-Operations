# Context

Maintained by the Cowork session. Claude Code reads this but does not edit it.

## Where things stand (18 Oct 2026)

- Code: v4.11 at `3454d69` on `claude/main`.
- Last live test: R11, `-Mode 5 -Source CSV -Force -AcceptCollateral` over the first 20
  archived processes in the demo tenant.
- Next: T1 and T2 in `TASKS.md`, then R12 runs the same command again.

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
