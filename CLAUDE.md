# Working in this repo

Two Claude sessions share this repo. A Cowork session plans and runs the live tests against
the demo tenant, then writes findings. Claude Code (you) implements them. The handoff lives
in `handoff/`.

## At the start of every session

1. Read `handoff/CONTEXT.md` for where things stand.
2. Read `handoff/TASKS.md` and work every task marked `Status: Ready`, in order.
3. Don't run anything against a live tenant. Live testing is the Cowork session's job.

## When you finish

- Add a section to `handoff/REPORT.md` for each task: commit hash, what changed, functions
  touched, any new or renamed results-file operations, tests added and the new assertion
  count, and anything you deferred or disagreed with and why.
- Set the task's status in `TASKS.md` to `Done (<hash>)` or `Blocked: <reason>`.
- Leave `CONTEXT.md` alone. The Cowork session owns it.

## Conventions

- The default branch is `claude/main`, not `main`. Open PRs against it.
- Bump `$script:ScriptVersion` in `Nintex-BulkOperations.ps1` once per round (4.11 to 4.12).
- Commit subjects are plain sentences about what changes for the operator. See `git log`.
- Comments say why, including which test round found the defect.
- Run `Tests/Run-AllTests.ps1` before committing and report the assertion count.
- Every process the script changes on the tenant gets a row in the results CSV. A change
  with no row is a defect, not a cosmetic gap.
- Never commit tenant data. Results CSVs, plan JSONs and `config.txt` are gitignored. Keep
  tenant ids, account names and process names out of code, tests and handoff files.
