# Tasks

Written by the Cowork session. The product is now a web app; read `handoff/SPEC-WEB.md`
before starting any task here. Work every task marked `Status: Ready`, in order, one PR
per task against `claude/main`. Tasks marked `Queued` are waiting on a spike or an
earlier task; don't start them.

The R11 tasks for the PowerShell (old T1 and T2) are superseded. They're folded into W5.
The PowerShell is frozen at v4.11: don't change it.

---

## W0. Scaffold `web/` from process-group-manager

Status: Done (624b9ae)

Create a Next.js app in `web/`, lifting the foundation from
`github.com/ntx-external-solutions/process-group-manager` (public): auth route and
`lib/auth/*`, the proxy route, `lib/pm/client.ts`, `types.ts`, `groups.ts`, `scim.ts`,
`lib/exec/journal.ts`, `runner.ts`, `report.ts`, `lib/ui/treeCache.ts`,
`lib/plan/tree.ts`, `revalidate.ts`, security headers in `next.config.mjs`, and their
tests. Keep PGM's stack (Node 24, TypeScript, `node --test`). Note the source commit in
`web/README.md`.

Strip what this app doesn't do (shortcuts, champions, group create and rename, CSV group
import). The operation allowlist starts **read-only**: `groups.tree`, `processes.list`,
`process.summary`, `auth`. A landing page after sign-in lists the four operations as
disabled tiles. The sign-in page says SSO-only tenants are not supported.

Add `vercel.json` with the project rooted at `web/`, and a root README section on running
it locally.

**Done when:** `npm test` and `npm run typecheck` pass in `web/`, sign-in works locally
against a tenant, and the allowlist has no write operation.

---

## W1. Tree browser with processes, and the archived view

Status: Done (7e97808)

Build the shared selector described in the spec:

- Lazy tree from `GetChildProcessGroupTreeItems` showing groups, document groups and
  processes (PGM's `GroupBrowser` filters processes out; ours keeps them).
- Tri-state selection. A checked group resolves to its full subtree at plan time, not to
  what's expanded on screen.
- `resolveSelection(tree, selection)` returns every selected process with its group path,
  as a pure function with tests (nested groups, partial selection, document groups
  excluded, a group checked and then one child unchecked).
- The archived view: paginated archived listing, grouped by original group, with a
  separate "group no longer exists" bucket driven by `groupExists === false`. Test the
  flag, never `groupId === 1` (see `API_ARCHITECTURE.md`, "groupExists"). Absent is not
  false.

Still read-only. No writes in this task.

**Done when:** the selector resolves correctly in tests, and both views render against a
recorded fixture.

---

## W2. Bulk Archive

Status: Ready

Port the archive path from `Nintex-BulkOperations.ps1` (`Invoke-BulkArchiveProcesses`)
and `Set-NpmProcessArchived` in `NintexProcessDependencies.ps1`. Add `process.archive`
and `process.publishNow` to the allowlist, each taking exactly one process id.

Must carry over, all covered in `API_ARCHITECTURE.md`:

- One change description per run, required before Apply is enabled.
- Read back `isArchived` after every archive. If false, re-read the revision id and call
  `Publish` with `IsPublishNow: true`, id as a string. Use the script's outcome names
  (`Archived`, `PendingApproval`, `Overridden`), and report refusals and failures with
  the tenant's status code and message, as `New-NpmArchiveOutcome` does.
- A 400 is reported with the tenant's message and a link, and not retried.
- Final status for every process comes from a fresh read at the end of the run.
- The preview lists variation siblings of selected processes.
- Results CSV with the script's columns.

**Not in this task:** deleting groups afterwards. That waits on spike S1.

**Done when:** offline tests cover each outcome, including a 200 that's still pending
and a call that reports failure but took effect.

---

## W3. Bulk Move

Status: Queued (group moves can go once W1 is done; process moves wait on spike S2)

`ReorderTreeNodes`, one node per call, `NodeType` from the item's `itemType`. Destination
picker from the same tree. Reuse PGM's `groupPlan.ts` checks (no cycles, not into its
own subtree, not into a document group). Pre-flight `ValidateProcessAction` with action
type 11 for processes. Show viewer deltas from `GetTotalSpecifiedGroupRoleAndUserViewers`
in the preview.

---

## W4. Bulk Update Ownership

Status: Queued (after W2)

Port `Update-ProcessOwnership.ps1`: same CSV columns and cell rules, SCIM lookup via
`scim.ts` with the key entered per run. Two changes from the script, both explained in
the spec: `SuppressChangeNotification` defaults to true, and the operator chooses "save
only" or "match current state" for published processes, the way PGM does it.

---

## W5. Bulk Delete engine

Status: Queued (after W2; start by porting the tests)

Port `NintexProcessDependencies.ps1` into `web/src/lib/delete/`, phase by phase as the
spec lists them, with the offline tests and `Tests/Fixtures` ported first so behavior
equivalence is checked as you go. Includes, as new behavior:

- **Old T1.** The unwind puts back every process the run un-archived, holders and
  targets, one results row each, on every exit path including a resumed run. A results
  file never omits a process the run changed.
- **Old T2.** An orphaned dependency holder (its group is gone) is restored into the
  holding group, read there, and re-archived before `Remove-HoldingGroup`, with its own
  results operation.

The plan ledger goes in IndexedDB. The plan file is downloadable and can be re-uploaded
to resume or unwind.

---

## W6. Bulk Delete UI, and folder cleanup

Status: Queued (after W5 and spike S1)

Both entry points (tree and archived view), delete-by-group target resolution, the
collateral confirmation on screen, and the optional "delete now-empty groups" step,
deepest first, offered only for groups the run actually emptied.
