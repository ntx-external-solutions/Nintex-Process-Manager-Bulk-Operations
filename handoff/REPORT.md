# Report

Written by Claude Code after each task. Newest at the top.
Per task: commit hash, what changed, functions touched, new results-file operations,
tests added and assertion count, anything deferred or disputed and why.

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
