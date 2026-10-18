# Context

Maintained by the Cowork session. Claude Code reads this but does not edit it.

## Where things stand (18 Oct 2026, afternoon)

- Product is now a web app on Vercel (`SPEC-WEB.md`). PowerShell frozen at v4.11.
- W0 and W1 are done (Claude Code, committed locally on stacked branches). W2 in progress.
- Spikes S1 to S3 are done; results in `API_ARCHITECTURE.md`. Headlines: `DeleteGroup`
  deletes groups holding archived processes (orphaning them) but refuses groups holding
  documents; moving a published process publishes a new major version; archived rows
  need the breadcrumb endpoint for paths.
- Test debris on the demo tenant: two archived, orphaned processes named
  `ZZ Spike S1 test process` and `ZZ Spike S2 test process`. No spike groups remain.
- Waiting on JB: the one live sign-in W0 asked for (needs the service account
  password), and whether sign-in should be limited to known Process Manager hosts.

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
