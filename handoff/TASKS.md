# Tasks

Written by the Cowork session from the R11 live test of v4.11 (`3454d69`). Target: v4.12.
Do T1 before T2. T2 adds a new kind of restore, and T1 is what guarantees it gets undone.

---

## T1. The unwind must put back every process the run un-archived

Status: Ready

**Seen in R11.** Planning was blocked (see T2). Before it stopped, the discovery pass in
`New-ProcessDeletePlan` had restored eleven archived dependency holders so their
Input/Output references could be read. The unwind re-archived the twenty targets but not
the eleven holders. They were left active in their original groups, and none of the 45
results rows mentioned them. The tenant's active count went up by eleven with nothing in
the output to say so. They were re-archived by hand.

**Cause.** `Restore-ProcessPlanState` puts back target state only. Holders flagged
`RestoredByThisRun` during discovery have nothing that puts them back.

**Asked.**
- Record every process the run un-archives, holders as well as targets, in the plan
  ledger at the moment it is restored.
- On the way out, re-archive each one where it belongs: holders in their original group,
  targets as they are handled today.
- Write one results row per process either way, success or failure.
- This must hold on every exit path: planning blocked, a failure mid-run, and a resumed
  run that re-imports the plan file. It should be resumable the same way target unwind is.

**Done when.** An offline test blocks planning after holders have been restored, and every
holder comes back archived with exactly one row each. Add a check that the results file
lists every process the run changed.

---

## T2. Orphaned holders get the same treatment orphaned targets already get

Status: Ready

**Seen in R11.** Eleven archived holders that reference the targets could not be restored
because their own groups had been deleted (six groups between them). Their references
could not be read, so the engine refused to delete the targets they point at and planning
stopped with "Cannot restore ... its group no longer exists."

The refusal is correct. The defect is that the script already solves this for orphaned
targets: the hold phase restores them into the holding group (built in R6). Holders never
got that path, so the run tells the operator to move processes by hand.

**Asked.**
- Restore an orphaned holder into the holding group, read its references there, and
  archive it in place on the way back, the same way orphaned targets are handled. The
  branch to change is the `$orphanedHolders` block in the discovery pass of
  `New-ProcessDeletePlan` (NintexProcessDependencies.ps1).
- Re-archive these holders before `Remove-HoldingGroup` runs, or cleanup will refuse a
  non-empty group.
- Give them their own operation in the results file, so an operator can tell a parked
  holder from a target.

**Done when.** An offline test with an orphaned holder plans successfully, the holder ends
archived, the holding group is removed, and the holder has its own row with the new
operation.
