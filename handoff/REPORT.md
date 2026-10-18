# Report

Written by Claude Code after each task. Newest at the top.
Per task: commit hash, what changed, functions touched, new results-file operations,
tests added and assertion count, anything deferred or disputed and why.

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
