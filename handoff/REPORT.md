# Report

Written by Claude Code after each task. Newest at the top.
Per task: commit hash, what changed, functions touched, new results-file operations,
tests added and assertion count, anything deferred or disputed and why.

---

## W2b. Folder cleanup after Archive

Commit `3026aa3` on `claude/web-w2b-cleanup`, stacked on W2.

**What changed.**

- `select/resolve.ts`: a complete resolution now also returns `groups`, every group the
  selection covers (checked itself or inside a checked group), with path and depth. The
  archive plan carries them as the cleanup candidates.
- `cleanup/plan.ts`: `planCleanup` decides deepest first. A group is **kept** if it
  still holds an active process, a shortcut, a document group or an unmeasured item; if
  it holds a subgroup that is kept (including one the selection didn't cover); if it
  holds any document; or if its contents or documents couldn't be read. Otherwise it is
  deleted, carrying the archived processes that will lose it.
- `cleanup/facts.ts`: `gatherFacts` reads each candidate's tree level and documents.
  Archived processes come from the archive run's final index, filtered by
  `groupUniqueId`.
- `cleanup/run.ts`: `runCleanup` deletes one at a time, deepest first, and **re-reads
  each group just before its delete**. Children this run already deleted are ignored, so
  a parent isn't blocked by a stale entry. `settleCleanup` settles every group row from
  a fresh read of the parent level, the same rule as archive.
- `pm/groups.ts`: `deleteGroup`, `readAssociatedContents` (parses the 409),
  `getGroupBreadcrumb` / `breadcrumbTitles`. `pm/processes.ts`: `getGroupDocuments`
  (`ListType=All`, `ProcessGroupId`).
- Proxy: `group.delete` (write), `group.documents` and `group.breadcrumb` (reads), each
  taking exactly one group GUID and no other field. `WRITE_OPERATIONS` is now archive,
  publishNow and group.delete.
- `select/archived.ts`: `loadGroupPaths` and `groupsNeedingPaths` for breadcrumb bucket
  labels. **Not wired to a screen yet**, because the archived view's only consumer is
  Bulk Delete (W6). The helper and the read are tested.
- `/archive`: step 4 appears under the results only when the run finished cleanly and
  the final read succeeded. It checks, shows what would be deleted with every archived
  process that becomes unrestorable, needs its own checkbox, and appends its rows to the
  same results file.

**Results-file operations.** `DeleteGroup` rows with `ObjectType: ProcessGroup` (the
script's spelling, from `Remove-HoldingGroup`): `Success` (deleted), `Skipped` (kept,
message starts "Kept." with the reason), `Blocked` (409, naming the documents), `Failed`.
**`GroupDeleted`/`Orphaned`**: one row per archived process a deleted group leaves
without a home, so every process the run changed has a row. I changed the report's
`ObjectType` from `Group` to `ProcessGroup` to match the script.

**Tests.** 220 tests, 220 pass (23 new). The five cases the task names are all
covered: a group that deletes, one kept for a document, one kept for an active process,
a 409 from the tenant (Blocked, document names, sent once, no orphan rows), and nested
groups deleted deepest first. Also covered: a kept subgroup keeps every ancestor, a
shortcut keeps its group, unreadable facts keep the group, a group that gained an item
since the preview is kept, a dead session stops the step, and the final read overrules
the calls in both directions.

**End-to-end, offline.** The same mock and headless Chrome run, extended: after the
archive, Retired (emptied) was deleted, Forms was kept for its document, Payables for
the process the tenant refused, and Finance because its subgroups were kept. One
`DeleteGroup` was sent.

**Decisions Cowork should check.**

- **The breadcrumb response shape was not recorded** beyond "root first, group last".
  `breadcrumbTitles` accepts an array or `{items|breadcrumbs|data|breadcrumb}`, takes
  `name`/`title`/`Name`/`Title`/`text`, and drops the first entry as the tenant. A
  captured response would let me pin it.
- `group.documents` uses `ListType=All`, from the task. The API notes only show
  `ListType=Archived`. If `All` isn't valid, the read fails and every group is kept,
  which is safe but would make cleanup useless. Worth one call to confirm.
- A shortcut (`linked-process`) in a group keeps it. Nobody has measured what
  `DeleteGroup` does to a shortcut, and deleting through one is the risk W1 avoided.
- Cleanup isn't offered when the archive stopped early or its final read failed. The
  candidates and orphan lists both come from that read.

---

## W2. Bulk Archive

Commits `2f9832a`, then two follow-ups for requirements added while W2 was in flight:
`5f36abf` (`PublishMessage` on every publish) and `6bbf48b` (siblings from
`variationSetData`). All on `claude/web-w2-archive`, stacked on W1. `c8bda99` and
`2745a6f` commit Cowork's spike results and variation findings as written.

**What changed.**

- Proxy: `process.archive` (id plus comment), `process.publishNow` (id, revision,
  `publishMessage`) and a read, `process.archiveState`. `WRITE_OPERATIONS` is exactly the
  first two. All three go through `singleProcessId`: the id must be one GUID, and **a
  body with any field the operation doesn't name is refused**, so a second id can't ride
  along under another key.
- `pm/processes.ts`: `archiveProcess` (write retry policy, so 5xx isn't resent),
  `getArchiveState` (isArchived from the model, then the envelope, case-insensitive;
  absent reads as null; 404 is `found: false`). `publishProcess` now always sends
  `PublishMessage`.
- `pm/client.ts`: `tenantMessage`, a port of `Get-NpmErrorDetail` (first text field of
  message/Message/error/errorMessage/title/detail, capped at 500).
- Proxy route: errors carry `status` and `message` (the tenant's words). **A 403 is no
  longer treated as a dead session**; see below.
- `archive/outcome.ts`: `archiveOne`, a branch-for-branch port of
  `Set-NpmProcessArchived`. Same outcome names (`Archived`, `PendingApproval`,
  `Overridden`, `Refused`, `Failed`) and messages, same status mapping, with "no
  response" instead of "HTTP 0".
- `archive/plan.ts`: `buildArchivePlan`, `findVariationSiblings` (every
  `variationSetData.OtherVariedProcesses` entry that isn't a target, read at planning
  time for each target the tree marks with a `variationSetId`), `findVariationMasters`
  (the script's name heuristic, still run alongside), `previewRows`. A set that can't be
  read is listed in the preview as unread, not silently skipped.
- Proxy read `process.variationSet` (one id) and `pm/processes.ts` `getVariationSet`.
- `archive/run.ts`: `runArchive`, `settleFromFinalRead`, `collateralRows`,
  `manualReviewCsvRows`, `processLink`.
- `tenant/state.ts`: `loadProcessIndex` and `compareTenantState`, ported from
  `Get-NpmProcessIndex` and `Compare-TenantState`. W5 will reuse both.
- `/archive` page: select, preview (downloadable), one change description, the approval
  override checkbox (on by default), variation acceptance, a confirm step, cancel
  between batches, results with counts, a needs-attention table linking each process,
  results CSV, and the manual review CSV.
- `/api/auth` GET now returns `siteUrl` so a refusal can link to the process.

**Results-file operations and statuses.** `Archive`, `VariationWarning` and `Select`
(a shortcut or other excluded item, Skipped with the reason) are new, plus
**`Collateral`/`Unreversed`**. Statuses follow the script's vocabulary plus `Accepted`
(as the script uses it) and `Unreversed`.

**Tests.** 197 tests, 197 pass (55 new). `outcome.test.ts` covers every branch of the
port, including the two the task names: **a 200 that's still pending** (overridden with
the post-archive revision, or reported Pending when the override is withheld or fails),
and in `run.test.ts`, **a call that reports failure but took effect**, which the final
read settles as Success. Allowlist tests cover one id only, no second id under another
key, and the exact request bodies.

**End-to-end, offline.** I ran the built app against a local mock Process Manager
(not a tenant) and drove it through headless Chrome: sign in, check a group, preview,
apply. The plan resolved the subgroup and left out the unselected group. The pending
process was overridden with the post-archive revision as a string. The 400 came out
Blocked with the tenant's message. The 500 that still took effect came out Success. Each
archive was sent exactly once. The mock and driver are in my scratchpad, not the repo;
say if you want them committed as a dev tool.

**Deviations from the script, and why.**

- **The final read checks every sent row, not just successes.** The script only
  re-checked rows the calls called successful, but the API notes record failed calls
  that took effect, and the spec says every final status comes from a fresh read.
- **Collateral is reported, not reversed.** The script restores unwanted archives
  (`Restore-CollateralState`). That needs a restore operation, which isn't in W2's
  allowlist. Collateral rows say so and point to Process Manager. Given that S-results
  and R-rounds place the coupling on delete rather than archive, I expect these to be
  rare. W5 adds restore anyway, and archive can use it then.
- **The baseline is re-read just before the first write**, not reused from the preview,
  so another operator's edits between preview and apply aren't blamed on this run, and
  a target archived meanwhile is skipped rather than sent.
- **403 is a refusal, not a sign-out.** PGM signed the operator out on 401 or 403. For a
  bulk archive, a 403 on one process is much more likely to be a permission refusal than
  a dead token, and signing out would stop the run. **Cowork: worth checking what an
  expired token returns on this tenant.** If it's 403, I'll treat N consecutive 403s as
  fatal.
- **Variation warnings use two signals**: `variationSetData` siblings, plus the
  script's name heuristic. Both need explicit acceptance on screen before Apply is
  enabled. The set is read only for targets the tree marks with a `variationSetId`.
  Reading every target's full process document would cost one GET each, and the tree
  marked all 13 variation records Cowork found. If a variation can turn up without a set
  id, that trigger needs widening.
- **Resume is by re-planning.** If the tab dies mid-run, the journal stays in
  sessionStorage and the page says how many archives are in doubt on the next visit.
  Re-planning lists anything already archived as skipped, which is naturally idempotent
  for archive. There's no plan-file upload for archive.
- The manual review CSV gains a `Link` column. The spec asked for the tenant's message
  and a link.

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
