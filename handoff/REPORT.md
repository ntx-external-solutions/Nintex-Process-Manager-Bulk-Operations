# Report

Written by Claude Code after each task. Newest at the top.
Per task: commit hash, what changed, functions touched, new results-file operations,
tests added and assertion count, anything deferred or disputed and why.

---

## W5 phase 2. Discovery, and a read-only plan

Commit `13fdfe5` on `claude/web-w5-2-discovery`. Stopped after this PR, as the task asks.

**What changed.**

- **Pure discovery, ported from the script:**
  - `delete/model.ts`: case-insensitive field access (`nodeValue`, `nodeHas`, `setNodeValue`, `nodeArray`, plus `nodeString`/`nodeInt`).
  - `references.ts`: `matchTarget` and the three finders.
  - `claims.ts`: parse, candidates, inversion by holder, reconciliation.
  - Ids are compared case-insensitively throughout, as PowerShell's `-eq` and hashtable keys are.
- **The planner, `delete/planner.ts`:**
  - `checkProcessDependencies` (success carried in a field).
  - `loadDeleteIndex`, which adds the numeric `id` and whether the row reported `groupExists`.
  - `readModelAnyState` with an explicit `ModelCache`.
  - `findHiddenInputOutputReferences`.
  - `buildDeletePlan`: a full port of `New-ProcessDeletePlan`, covering passes, the retry, `onFailedTargets`, unlisted participants recovered or named, the restore and park branches, the blind-spot scan, locate, filter, reconcile, and `PlannedIncomplete`.
  - `planProcessName`, and `planSummaryLines` (the text of `Show-ProcessDeletePlan`).
  - A dead session rethrows instead of being counted as a failed check.
- **Plan file** (moved into discovery per your review): `newDependencyPlan` and `ledgerToPlanRows`, plus `newLedgerEntry`, `ledgerEntryFromModel`, `serializePlan` and `parsePlan`. `parsePlan` returns null for anything without schema 1, targets and ledger, because a later phase resumes from it.
- **Targets:** `targetsFromCsv`/`idFromCsvRow` (ObjectID and the other spellings, case-insensitive), and `resolveTargetIds` (numeric ids through the listing, unknown ones reported).
- **Proxy reads** (`pm/dependencies.ts`):
  - `process.dependencies`: one GUID, `searchBehavior=31`. An empty body comes back as null.
  - `process.model`: one GUID.
  - `processes.archivedModels`: 1 to 25 GUIDs. A batch is allowed because it only reads.
  - None of them is a write.
- **The archived read, as you measured it.** `readProcessEnvelope`/`readProcess` in `pm/processes.ts` is the shared helper you asked for: a model, or `{ kind: 'archived' }` for the 200 with no `processJson`. Anything else throws. F4 will use it too.
  - The gateway's `readModel` now returns `ActiveRead`, not a model or a 404.
  - The fake tenant answers an archived process with `{ kind: 'archived' }`, and `archiveState` reads `found: true, isArchived: true` from it.
  - 404 only comes after a delete.
  - The planner's active read falls through to the batch read when told "archived". The script returned the envelope as if it were the model and walked an empty process.
- **T2.** `reArchiveOperation(role, parked)` gives `ReArchiveOrphanedHolder` for a parked holder. The skipped unwind tests now expect it, with a message containing "stays archived without a group".
- **`/delete`**, a dry run page reached by URL; the landing tile is still disabled.
  - Input: ids (GUID or numeric), or a CSV such as a results file, and an optional thorough scan.
  - It builds the plan with `allowRestore: false` through `browserPlanningGateway`, whose `restore` refuses. It then shows the summary text and downloads the plan JSON.

**Results-file operations.** New: `ReArchiveOrphanedHolder`, used from the unwind phase. Nothing writes rows yet.

**Tests.** 434 tests: 360 pass, 0 fail, 74 skipped (was 424 / 322 / 102). There are no skipped discovery tests left.
- **Now running:** every pure discovery test, plus the planner scenarios that restore nothing:
  - both active
  - archived holder classification
  - a failed check blocks planning
  - a clean check is not a failure
  - both sides deleted
  - an unlisted participant, recovered or named
  - a preview restores nothing
  - the CSV id reader
- **Split:** "a preview restores nothing and says so" now runs; "a real run says what it restored" waits for hold.
- **New:** targets (3), the parked operation (1), the delete proxy reads (4), the envelope helper (1), and the fake tenant's archived and deleted reads.
- **Still skipped:** hold 14, references 6, checkpoints 13, delete 1, unwind 40.

**End-to-end, offline.** `web/dev/drive-delete.mjs` against the mock. The mock now answers the dependency check and the batch read, and serves the measured archived envelope. Planning the deletion of a process by its numeric id found:
- the active holder through the dependency check (a ProcessLink);
- the archived holder's hidden Input through the archive scan, logged as "never reported";
- `PlannedIncomplete`, with "none restored";
- no PUT or POST sent.

The archive, move, ownership and expired-session scenarios still give their earlier results.

**For your live dry run.** Sign in on the deployed app, go to `/delete`, and paste the ids or upload a results file. Download the plan to compare with the script's R3 output. Leave "Also scan active processes" off to match the script's default. The dependency checks run one at a time, as the script's do, so a few hundred targets takes minutes.

**Decisions Cowork should check.**

- **Recovering a participant no listing returns** tries the batch read first, then the active read, as the script does. When the active read says "archived", it falls through to the batch read.
- **`parsePlan` only accepts web plans** (schema 1 with targets and a ledger).
- **Two unwind tests still opt into `activeReadServesArchived`**, the old mock's behavior, for the relocation probe. The unwind phase has to revisit them against the measured envelope.
- **`archive/outcome.ts` (W2) reads a 404 on the archive-state read as the archive having taken effect.** Measured, 404 means deleted. Archive runs never delete, so nothing is misreported today, but that comment and branch are wrong. I left W2 alone. Worth a line in F4 or later.

---

## W5 phase 1. Tests and fixtures first

Commits `9d70974` and `d09159a` on `claude/web-w5-1-tests`, stacked on F2. `9d70974` was
not mine: it was committed and pushed from outside this session partway through, with
an auto-generated message ("implement bulk delete engine…") over half-written stubs.
Squash-merge the PR so that message does not land on `claude/main`. Per the task, I
stopped after this PR for Cowork's review.

**Approach.** Every test of the three engine suites is ported to TypeScript, written
against **typed stubs**: real signatures and types, with bodies that throw
`notPorted('<phase>')` (`delete/phases.ts`). Each ported test is marked
`{ skip: PHASE.<phase> }` with its full assertions, so it typechecks now and runs when
that phase removes the skip. Skip rather than todo: a failing todo prints its stack, and
a hundred of those would bury a real failure. Where the app already has the port
(`compareTenantState`, `findVariationMasters`, `readGroupExists`, `resultRow` naming,
the archive path), the test runs now against it.

**Fixtures.** `Tests/Fixtures` holds real captured tenant payloads. They are read in
place by `delete/testing/fixtures.ts`, never copied. Ids and names come from the fixture
objects at run time, and test titles say "the holder" and "the target". The PowerShell
suites also inline tenant ids and names (dependency responses, variation names, group
names). Those are rebuilt from fixture values or replaced with synthetic ones. A grep of
`web/src` for the known ids and names is empty.

**What was built.**

- Pure-function stubs, from `Test-Dependencies.ps1`:
  - `delete/model.ts`: models, the delete index, case-insensitive field access.
  - `references.ts`: the reference finders and removers. Its bucket tables are real
    data.
  - `claims.ts`: dependency claims, holder work items, reconciliation.
  - `ledger.ts`: ledger entries, snapshots, plan ledger rows, plan serialize/parse.
  - `collateral.ts`, `groups.ts`, `names.ts`.
- `delete/gateway.ts`: `DeleteGateway`, one method per proxy operation the engine
  needs. It extends `ArchiveGateway` with listing, dependency check, batch and single
  model reads, save, publish, restore (with a no-retry option for the relocation probe),
  delete, and the holding-group calls. Failures carry status and tenant message, as
  `PmRequestError` does.
- Planner, executor and orchestrator stubs: `planner.ts`, `executor.ts`,
  `runOutcome.ts`, `holdingGroup.ts`, `targets.ts`, `bulkDelete.ts`, plus `events.ts`.
  The console output becomes typed events, so tests check what was said and in what
  order. Prompts and switches (`-AcceptCollateral`, `-AllowUnheldTargets`, the
  collateral gate, `OnFailedTargets`) become explicit options and `decisions`
  callbacks. Module globals (the model cache, the relocation probe, the last-restore
  status) become explicit values. `resumeUnwind` finishes a run from an uploaded plan.
  `planStore.ts`: the plan must be saved before the first mutation.
- Working test infrastructure (not stubs, with 8 passing tests of their own):
  - `testing/fakeTenant.ts`: implements `DeleteGateway` with state, a call log and
    per-scenario hooks (`fail`, `noEffect`, `after`, `restoreActive`,
    `missingGroupIds`, and more).
  - `testing/planStore.ts`: records what was saved at the first mutation.
- `archive/parity.test.ts`: the uncovered assertions of `Test-BulkArchive.ps1` against
  the existing archive code. All pass.

**Assertion accounting.**

| PowerShell suite | Assertions | Ported | TS assertions | Run now | Skipped (phase) |
|---|---|---|---|---|---|
| Test-Dependencies | 194 | 194 (2 disk checks as 1 serialize check) | 195 | 47 | discovery 56, references 35, hold 30, checkpoints 26 |
| Test-Executor | 156 | 156 | 163 | 0 | tests: discovery 5, hold 11, references 1, checkpoints 1, delete 1, unwind 14 |
| Test-BulkDelete | 170 | 170 | 190 | 3 tests | tests: discovery 1, hold 1, checkpoints 1, unwind 26 |
| Test-BulkArchive | 150 | 53 already covered, 67 added, 21 not applicable (console and menu), 9 differ | 92 | all | none |

Disk and console checks are ported by intent: "plan on disk before the first restore" is
"plan saved to the store before the first mutation", and console order is event order.

**Tests.** 424 tests: 322 pass, 0 fail, 102 skipped until their phase (was 281). About
680 TS assertions added. Typecheck and production build are clean.

**New tests for T1 and T2** (skipped, unwind phase), marked `// NEW (T1)` / `// NEW (T2)`:

- **T1:** an uploaded plan alone puts back every process the run un-archived.
- **T1:** declining the final confirmation puts them all back.
- **T1:** every process that took a successful mutating call has a row.
- **T1:** a fatal 401 leaves a saved plan that `resumeUnwind` finishes.
- **T2:** the parked holder is restored into the holding group, discovery runs again
  while it is held, and it is re-archived before the group is removed.

**Decisions Cowork should check.**

- **Phase boundaries.** The planner's scenario tests are tagged `hold`, not
  `discovery`, because `buildDeletePlan` returns its plan through `newDependencyPlan`
  and `ledgerToPlanRows`, which are tagged `hold`. If the discovery PR should prove the
  planner, those two move into discovery. Every orchestrator scenario is tagged `unwind`,
  because `runBulkDelete` runs the end-of-run re-check on every exit path.
- **T2's "own results operation".** The script writes `ReArchiveHolder` for ordinary
  and parked holders alike. The tests keep that. Say if parked holders should get a
  distinct operation (e.g. `ReArchiveOrphanedHolder`).
- **The plan file is camelCase**, so it will not read the script's `Delete_Plan_*.json`.
  I assumed web plans only need to round-trip with the web app.
- **The fake tenant follows the tenant as measured** where the PowerShell mocks were
  loose: the active read 404s for archived processes, and `StateId` follows state. Two
  executor tests opt into the mocks' looser behaviour.
- **Fatal errors reject `runBulkDelete`** rather than returning a stopped result. The
  T1 resume test relies on the plan saved before that.

**Found in the archive parity check** (not fixed: outside W5; your call):

- **`resolveSelection` overflows the stack** if the tenant ever lists a group as its own
  descendant. The PowerShell test expects a cycle to finish. It fails before any write,
  so it is safe, but it is an exception, not an answer. W1 did not document it.
- **The `/archive` variation warning** does not say that a dragged-in master lands in the
  archived list, which is where a later Delete takes targets from. The script said so.
- Smaller documented differences remain as W2 recorded them: collateral reported, not
  reversed; a link column in the review file; a checked group always means its whole
  subtree.

---

## F2. Fixes from live round R12

Commit `809966c` on `claude/web-f2-r12`, stacked on W4.

**What changed.**

- **Dead session.** `pmRequest` (`pm/client.ts`) calls `fetch` with `redirect: 'manual'`.
  A 3xx (or a browser's opaque redirect) throws a `PmError` with `sessionEnded: true`
  and is never retried. A 401 sets `sessionEnded` too. A 2xx body that should be JSON
  and isn't raises a `PmError` with the status and a 200-character excerpt instead of a
  `SyntaxError`. If it is HTML (the sign-in page), it also ends the session. New
  `isSessionEnded()`. A 403 is unchanged: a refusal of that call.
- **Proxy mapping.** The route's error handling moved to `pm/proxyError.ts`
  (`proxyError`), so it can be tested without Next.js. It now signs out on
  `isSessionEnded`, not `status === 401`.
- **Picker layout.** `globals.css`: the checkbox rule now covers radios too
  (`width: auto; flex: none`). The full-width text input rule was reaching the
  destination picker's radios. Checked in headless Chrome: the radio computes to 13px
  and the names sit beside it.
- **Move results.** `describeOutcome` (`move/run.ts`) says what happened from the model
  read after the run: "Published as 2.0; the open draft went live.", "Published as
  4.0.", "Now at 0.4, in progress and not published.", "Now at 2.1, awaiting
  approval.", or "Its version could not be re-read." `settleMoves` takes those reads,
  and `/move` makes one `process.summary` per moved process after the run. Groups
  still say "No process revision changed." The preview wording is unchanged.
- Fixed in passing: the archive run's "Stopped while archiving" message ended in "..".

**Results-file operations.** None new. `UpdateLocation` messages for moved processes now
carry the version.

**Tests.** 281 tests, 281 pass (12 new). `client.test.ts`: a 302 is a dead session,
sent once, with `redirect: 'manual'`; an opaque redirect; a sign-in page; a non-JSON
body that is not HTML keeps the session; a 403 keeps it. `proxyError.test.ts` runs
browser gateway, route mapping and client in one process against a tenant answering as
R12 measured. For **a 302 and for a 2xx HTML page**, an archive run mid-flight signs out
and stops: one tenant call, then a Failed row and Skipped "Not attempted" rows. A read
reaches the browser as `signedOut`. A 403 keeps the tenant's words, and a refused SCIM
key stays a 400. `move.test.ts`: `describeOutcome` for each state, and the settle
messages.

**End-to-end, offline.** `web/dev/drive-expired.mjs`: the mock's new `/_expire` makes
`GET /Api/v1/Processes/{id}` and `ArchiveProcess` answer 302, as R12 measured. Expiring
between preview and run: the page says "Your session ended. Sign in again and resume.",
every process has a row (the batch already in flight Failed, the rest Skipped), and no
"Unexpected error" appears. The move scenario makes one version read per moved process
after the run.

**Decisions Cowork should check.**

- **Any 3xx from the tenant is treated as a dead session**, as the task says. If some
  endpoint legitimately redirects (http to https, say), it would now sign the operator
  out instead of following. Sign-in itself uses its own `fetch` and still follows
  redirects.
- **A non-JSON 2xx that is not HTML** is an error for that call, not a sign-out.
- The batch in flight when the session dies still gets sent (up to four archives), as
  before: a sent request cannot be recalled. Those rows are Failed "Stopped while
  archiving", and the final read settles them.

---

## W4. Bulk Update Ownership

Commit `d0062e7` on `claude/web-w4-ownership`, stacked on F1.

**What changed.**

- `ownership/csv.ts`: `parseOwnershipCsv` takes the script's column names, in any case,
  BOM stripped, the first non-blank matching column winning (`Get-RowValue`). It refuses a
  file with no id column, naming the columns it found, and lists non-GUID ids for a
  warning.
- `ownership/plan.ts`: `resolveCell` follows the script's cell rules: blank leaves the role
  unchanged, the five unassign keywords set id 2 "Needs to be reassigned N/A", a number is
  a user id, anything else a logon. Logons are matched case-insensitively against the
  SCIM directory, and a logon two accounts share is refused, not guessed (`scim.ts`).
  `buildOwnershipPlan` applies the script's row rules with its wording, reads each
  process once, and picks a `WritePath` with PGM's rules (`chooseWritePath`).
  `describeChange` uses the script's "Owner: Old (id 7) -> New (id 101)".
- `ownership/run.ts`: `runOwnership` sends one `process.setOwnership` per process and,
  when the path publishes, one `process.publishNow` with the change description as
  `PublishMessage`. Both steps are journaled and never resent. Two at a time.
  `settleOwnership` settles every written row from a fresh read of the process.
- `pm/ownership.ts`: `getOwnership` (compact: roles, revision, permissions) and
  `setOwnership`, the read-modify-write on the server. It refuses if
  `ProcessRevisionEditId` moved since the preview, saves through PGM's
  `buildUpdateEnvelope`/`updateProcess` (now in `pm/processes.ts`: `ProcessJson` as a
  string, `DoPublish: false`, `SuppressChangeNotification: true`), then reads the new
  revision for the publish.
- `pm/scim.ts`: the display name now prefers SCIM `displayName`, as the script does, so
  the name written into `Owner`/`Expert` matches the script's.
- Proxy: `process.setOwnership` (write: one GUID, a positive revision, each role null or
  exactly `{ id, name }`, at least one role, a change description, `submitForApproval`
  boolean, and no other field, including `suppressChangeNotification`).
  `process.ownership` and `users.directory` (the SCIM key and nothing else) are reads.
  `WRITE_OPERATIONS` is now archive, publishNow, group.delete, node.move and
  setOwnership.
- UI: `/ownership`, enabled on the landing page. Upload, SCIM key, publish choice
  (default "Save only", the script's behavior), then preview, change description and
  confirm.

**Decisions from the spec.** `SuppressChangeNotification` is always true, and there is no
switch to turn notifications on, as PGM did. "Save only" and "Match current state" are
PGM's. Under either, a process in progress is only saved, a process awaiting approval is
Blocked, and a published process the user can neither publish nor submit is Blocked
under "Match current state".

**Results-file operations.** `UpdateOwnership` (the script's Mode 4 name), `ObjectType`
`Process`, in the shared columns, not the standalone script's
`ProcessID,ProcessName,Status,Message,ActionUrl`. Statuses: `Success`, `Preview`,
`Skipped` (the script's reasons, plus already set, archived, and changed since the
preview), `Pending` (published but awaiting approval), `Blocked` (permission, awaiting
approval, or a 4xx), `Failed`, `Unverified`. Messages carry the CSV line numbers.

**Tests.** 269 tests, 269 pass (25 new). Covered: column aliases, case, BOM, first
non-blank match, the refusals, every cell rule including ids, inactive users and shared
logons, each script row rule, folding rows, already set and stale names, 404/5xx/archived
reads, a dead session in planning, every write path, the preview wording, the save and
publish calls and their arguments, a conflict, a 4xx, a failed publish, a missing
revision, a dead session mid-run, journal replay, and each settle outcome. Proxy tests:
the parse refusals above, and the PUT body (model as a string, only named roles changed,
everything else passed through, suppression on), the conflict check, and the compact
read.

**End-to-end, offline.** `web/dev/drive-ownership.mjs` against the extended mock, with
"Match current state": a published process saved and published (one PUT, one Publish
with the description), one in progress saved only, one set to the placeholder and
published, and rows skipped for an unknown username, a non-GUID id and an empty row. All
three settled Success from the final read. The archive and move scenarios still give
their earlier results against the extended mock.

**Decisions Cowork should check.**

- **Several rows for one process are folded into one write**, the last non-blank cell
  per role winning. The script saved once per row, so the end state is the same with
  fewer revisions.
- **Rows that change nothing are not saved** ("Already set"). The script saved them
  anyway, bumping a version.
- **Non-GUID ids are skipped without a call.** The script tried them and failed on the
  read.
- **An archived process is skipped** when its model says `isArchived`. If the tenant
  answers 404 for archived processes instead, the row is Failed "Process not found ...
  An archived process cannot be read this way". Not measured.
- **The SCIM directory is read whole** (`scim.ts`), not one filter query per username as
  the script does. One paged read per run. `SCIM_BASE_URL` overrides the host.
- **Submit-then-publish is one PUT with `DoSubmitForApproval: true`, then Publish**,
  as PGM's code does. PGM's design notes describe save, then submit, then publish as
  three writes. Worth one live check on a process where `CanPublishAfterEdit` is false.
- **Not measured live:** whether a 200 Publish after an ownership save can still be
  queued for approval. The final read reports that as Pending.

---

## F1. Answers to the W2 to W3 questions, and one cleanup bug

Commit `c1667ad` on `claude/web-f1-fixes`.

**What changed.**

- **Cleanup and archived documents.** `getGroupDocuments` (`pm/processes.ts`) now reads
  `ListType=All` and `ListType=Archived` and adds them up, so a group whose only
  document is archived is kept and reported, not offered for deletion. Archived names
  carry "(archived)" in the reason. I made the change in the read rather than in
  `gatherFacts`, so `group.documents` stays one proxy operation (two tenant calls) and the
  planner and its tests are unchanged.
- **Breadcrumb.** `breadcrumbTitles` (`pm/groups.ts`) reads only the captured shape,
  `breadcrumbItems[].name`, dropping the first item (the tenant). An empty list is an
  empty path. The guessed shapes are gone.
- **Group links.** `groupLink` gives `{siteUrl}/Process/Group/{uuid}`. `itemLink` moved
  from the results component into `archive/run.ts` beside `processLink`. It links
  `ProcessGroup` rows as well as processes, on screen and in the manual review file.
  Documents still get no link.
- **Draft detection.** `isDraftOverPublished` (`move/plan.ts`): revision state 1 at a
  major version of 1 or more. `buildMovePlan` reads the model through `process.summary`
  (new `revision` read on `MovePlanReads`) **only for moves the pre-flight prompted on
  whose wording didn't already say "outstanding changes"**. Either signal puts the process
  in "Tick to move". If that read fails, the process goes there as `unknown`, with a note.
- **Dev tools.** `web/dev/`: `mock-pm.mjs` (stand-in Process Manager, all names made up),
  `cdp.mjs` (headless Chrome driver), `drive-archive.mjs`, `drive-move.mjs`, and a
  README. Nothing in `src/` imports them, and they sit outside the build and the
  typecheck. I extended the mock with archived documents, the breadcrumb and a full
  process model.

**Results-file operations.** None new or renamed.

**Tests.** 244 tests, 244 pass (5 new, 1 rewritten). Covered: both document lists
read and summed, a group with only an archived document has documents, the captured
breadcrumb shape (and an empty one, and the old shapes no longer read), group and
document links, the revision rule, a draft the wording misses caught by its revision
(with only that one model read sent), and a failed revision read setting the process
aside.

**End-to-end, offline.** Against the mock, production build, headless Chrome. Archive
then cleanup: Retired deleted (one `DeleteGroup`), and Forms, Policies (archived
document only), Payables and Finance kept. Before this fix Policies would have been
offered for deletion. Move: two `ReorderTreeNodes` calls, the draft left unticked, and
one model read, for the published process.

**Decisions Cowork should check.**

- **The structured check costs one extra GET per published process moved**, not zero.
  The move plan never called `process.summary`, and it reads `variationSetData` only for
  processes the tree marks with a set. For a large move of published processes this
  roughly doubles the pre-flight calls. I could fold both into one read later if it
  matters.
- A move the pre-flight doesn't prompt on is never model-read. S2 says every process with
  a published version prompts, so a draft over a published version always prompts.
- `group.documents` makes two tenant calls. If the archived document list is ever
  refused for a permission reason, the read fails and the group is kept, which is safe.

---

## W3. Bulk Move

Commit `5ebca76` on `claude/web-w3-move`, stacked on W2b.

**What changed.**

- `move/select.ts`: `resolveMoveSelection` picks the fewest, highest nodes. A fully
  checked group moves as one node. A checked group with exceptions inside is opened and
  its included children considered one by one. A checked process moves on its own.
  Shortcuts, document groups and unmeasured types are excluded with the reason.
  `destinationOf` builds the destination with its ancestry (document groups are refused).
  `destinationProblem` holds PGM's checks: never into itself or its own subtree, never a
  process at the top level, and no call for something already there.
- `move/plan.ts`: `buildMovePlan` pre-flights each individually moved process with
  `ValidateProcessAction` (action 11). `classifyValidation` sorts each into `clean`,
  `republish` (prompt), `draft` (prompt mentioning "outstanding changes"), `refused`
  (Blocked, with the tenant's words) or `unknown` (the pre-flight couldn't be read). It
  reads `variationSetData` for any process the tree marks with a set id and lists every
  sibling. Viewer counts come from one `GetTotalSpecifiedGroupRoleAndUserViewers` call
  for both ends of every move (advisory; failure is reported, not a gate).
- `move/run.ts`: `runMoves` sends one node per call, journaled, and passes `nodeType`
  through. `settleMoves` settles each from fresh reads of the destination and source
  levels, and gives each variation sibling its own row from the listing.
- Proxy: `node.move` (write) takes one node GUID, a movable `nodeType` (`group`,
  `process`, `inprogress-process`, `vanillaprocess`), and parents that are each one GUID
  or null. It refuses a shortcut, a document group, a node as its own parent, a process
  at the top level, and any extra field. `process.validateMove` and `groups.viewers`
  (up to 200 numeric ids) are reads.
- `select/resolve.ts`: the level-reading loop is now `readUntilResolved`, shared by
  Archive and Move.
- UI: `/move` with `DestinationPicker` (groups only, top level allowed for groups).
  `components/ResultsSummary.tsx` and `components/SessionGate.tsx` are now shared by
  Archive and Move.

**The preview, per S2.** "Would move" lists groups ("No process revision changes"),
never-published processes ("minor version bump") and published ones ("A new major
version will be published", with the tenant's message). **"Tick to move"** lists
processes whose draft would go live, and any whose pre-flight couldn't be read. These
are unticked by default, each with the tenant's message. The confirmation button counts
the republishes. Variation siblings are named under the process they move with.

**Results-file operations.** `UpdateLocation`, the script's Mode 3 name, with
`ObjectType` `Process` or `ProcessGroup`. Statuses: `Success`, `Preview`, `Skipped`
(already there, not ticked, not attempted), `Blocked` (refused, in the pre-flight or by a
4xx), `Failed`, `Unverified`. One row per variation sibling that moved with a process.

**Tests.** 239 tests, 239 pass (19 new). Covered: whole group vs per-child resolution,
the three destination checks, document-group destinations refused, every pre-flight
classification, drafts set aside and only sent when ticked, refused and unreadable
pre-flights, siblings named from the set, one viewer call for both ends, one call per
node with the type passed through, `success: false`, 4xx and a dead session, and the
final read in both directions with sibling rows. The allowlist tests cover every refusal
listed above.

**End-to-end, offline.** Against the mock: moving a group, a published process and a
process with an open draft into another group sent two `ReorderTreeNodes` calls (one
node each, `NodeType` passed through). The published process was flagged and counted as
republished. The draft was left unticked and recorded as Skipped with the tenant's
message.

**Decisions Cowork should check.**

- **"Draft goes live" is detected by the words "outstanding changes"** in the
  pre-flight message, as the task describes. If the tenant words it differently in
  another language or version, those processes would land in "Would move" as ordinary
  republishes, still flagged and counted, but ticked. A field that says so would be
  better if one exists.
- **The variation set is read only for processes the tree marks with a
  `variationSetId`**, the same trigger as Archive.
- A group moved whole is never pre-flighted, because the task and S2 say a group move
  changes no revision. Groups have no `ValidateProcessAction` equivalent with a
  destination (S2).
- Viewer "before" for a group is the group's own count and for a process its group's,
  as PGM did. "After" is the destination's count. Both are the product's numbers.
- No link for group rows: the group URL format isn't recorded.

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
