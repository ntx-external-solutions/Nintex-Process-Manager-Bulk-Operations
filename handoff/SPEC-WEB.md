# Bulk Operations web app: architecture spec

Written by the Cowork session, 18 Oct 2026. This replaces the PowerShell script as the
product. The script stays in the repo, frozen at v4.11, as the reference implementation
for the delete engine (see "What happens to the PowerShell" below).

## What we're building

A web app on Vercel. A user signs in to their Process Manager site with username and
password, then picks one of four operations:

1. **Bulk Archive.** Browse the group tree with its processes, select whole groups
   (with subgroups) or individual processes, and archive them.
2. **Bulk Delete.** Select from the group tree or from the archived list, and delete.
   The app handles dependency removal.
3. **Bulk Move.** Select processes or groups from the tree and choose a destination group.
4. **Bulk Update Ownership.** CSV upload, same format as `Update-ProcessOwnership.ps1`.

## Start from process-group-manager, don't start from scratch

`ntx-external-solutions/process-group-manager` (PGM) is already a Next.js 16 app on
Vercel that solves the hard platform problems for this exact API. Lift these modules
into `web/` in this repo and adapt them, rather than re-deriving them:

| PGM module | What it gives us |
|---|---|
| `src/app/api/auth/route.ts`, `src/lib/auth/*` | Sign-in via `POST /oauth2/token` (password grant). Password is exchanged and dropped; the bearer token is sealed into an httpOnly cookie with `AUTH_SECRET`. No server-side store. |
| `src/app/api/pm/route.ts`, `src/lib/pm/operations.ts` | The proxy. Exists because Process Manager sends no CORS headers. The browser can only name an operation from an allowlist; the tenant comes from the cookie, never the caller. |
| `src/lib/pm/client.ts`, `types.ts` | Request helper, error typing, a 401 that signs the user out instead of hammering on. |
| `src/lib/pm/groups.ts` | Tree read (`GetChildProcessGroupTreeItems`), `ValidateGroupAction`, `ReorderTreeNodes` move, viewer counts. |
| `src/lib/pm/scim.ts` | SCIM user lookup, key supplied per call and never stored. Needed for ownership. |
| `src/lib/exec/journal.ts`, `runner.ts`, `report.ts` | Append-only run journal (begin, commit, fail, skip per step), idempotent resume, results export. |
| `src/lib/ui/treeCache.ts`, `src/lib/plan/tree.ts`, `revalidate.ts` | Five-minute tree cache with visible age, re-read of the touched levels right before applying. |
| `src/lib/plan/groupPlan.ts` | Move validation: no cycles, no moving a group into its own subtree, no document-group destinations. |

Two PGM rules change on purpose. PGM's allowlist has no delete or archive operation, and
that is a structural safety property. This app adds them, so the allowlist entries for
archive, delete and group delete each need a server-side check that the request names
exactly one id, and the proxy still never offers a generic pass-through. PGM's
`GroupBrowser` filters processes out of the tree; ours keeps them.

Use PGM's stack as-is: Node 24, TypeScript, `node --test`, no UI framework beyond React.

## Where things run, and why no database

Every operation is a **browser-driven run**: the page holds the plan and calls the proxy
once per Process Manager request. No proxy call does more than one or two tenant
requests, so nothing comes near Vercel's 300s function limit, and a 17-minute delete is
just a long series of short calls.

State lives in three places, none of them a database:

- **Session:** the sealed cookie. Expires with the token.
- **Run state:** the journal and the plan ledger, in the browser. PGM keeps its journal in
  `sessionStorage`, which is fine for PGM's small plans. The delete planner's ledger held
  659 process models in R3, which can blow past the ~5 MB storage limit, so use
  IndexedDB for the ledger and keep the journal small.
- **Durable record:** downloadable files. The results CSV (same columns as the script's)
  and the plan file. The plan file can be re-uploaded to resume or unwind an interrupted
  run, the same way the script's `Delete_Plan_*.json` works today.

What we give up without a database, and why that's acceptable for v1:

- **No cross-device resume.** A run is tied to the tab. Closing it mid-run is recoverable
  from the plan file, not automatically.
- **No run history in the app.** The downloaded results files are the audit trail.
- **No lock between two operators on the same tenant.** Two people running deletes at once
  could collide. `revalidate.ts` catches a plan that's gone stale before writing; it does
  not prevent the race. If this turns out to matter, a small KV store holding a per-tenant
  run lock is the smallest fix.

Vercel notes: response bodies cap at 4.5 MB, so process models go through the proxy one
at a time (they already do). Hobby is limited to non-commercial use, so this should
deploy to a Nintex Vercel team on Pro.

## Auth

Password grant only, exactly as PGM and the script do it. That means **SSO-only tenants
cannot sign in**, because their users have no Process Manager password. PGM recorded that
as accepted on 10 Aug. The sign-in page should say so up front.

## The tree browser (shared by Archive, Delete and Move)

One component used by all three operations:

- Lazy-loads one level at a time from `GetChildProcessGroupTreeItems`, showing groups,
  document groups and processes, like Manage Groups.
- Tri-state checkboxes. Checking a group means "everything under it as of planning time",
  not a snapshot of what was expanded. The planner walks the full subtree.
- Document groups are shown but not selectable for Archive or Delete.
- `linked-process` items are shortcuts: same `uniqueId` as a process homed in another
  group (measured, S2). They're shown but never selectable, and never resolve into a
  plan, or selecting a group would act on a process homed somewhere nobody selected.
- The plan screen shows the resolved list (every process, with its path) before anything
  is written. Dry run is the default and applying is a separate, explicit action.

Bulk Delete also needs the **archived view**: the paginated archived listing
(`/Bff/Process/api/v1/processes`, archived list type), grouped by original group path,
with a separate bucket for processes whose group no longer exists (`groupExists: false`).
On the demo tenant that bucket is large: 178 of 465 archived processes when measured.
Rows carry only the immediate group, so paths come from
`/bff/navigation/api/v1/breadcrumb?type=ProcessGroup&id=<uuid>`, one call per distinct
group (S3: 47 groups, about 4 seconds).

## Bulk Archive

**Flow.** Select in the tree, preview, apply, download results.

**What the port must carry over** (all in `API_ARCHITECTURE.md` and the script):

- `ArchiveProcess` archives in place and takes a comment. Use one change description per
  run, entered once.
- On an approvals-enabled tenant, HTTP 200 means pending, not archived. Read back
  `isArchived`; if it's false, re-read the revision id and call `Publish` with
  `IsPublishNow: true` (id sent as a string). Never decide this from a setting. R11
  measured both outcomes on one tenant.
- A 400 is usually the process data, not the request, and fails the same way in the UI.
  Report it with the tenant's message and a link; don't retry.
- A call that reports failure can still have worked. The final status of every process
  comes from a fresh read at the end of the run, not from what the calls returned.
- Process variations are coupled (R3). Show the operator any variation siblings of
  selected processes in the preview.

**Step 3, "delete the left-behind folders".** Spike S1 settled what the API does:

- `DeleteGroup` **deletes a group that holds archived processes**, with no prompt and no
  refusal. The processes survive as orphans (`groupExists: false`) and can't be restored
  to that group again, exactly the warning you described.
- It **refuses** a group holding documents, archived or not: HTTP 409,
  `AssociatedContents`, naming each document.
- The server's validation gate says nothing either way.

So step 3 ships as you asked for it, with the app doing the checking the server doesn't:

- Offered only after the archive run has finished and been re-read.
- Candidate groups are the ones the selection fully emptied of active processes,
  deepest first. A group with any active process left, or any document, is listed as
  kept, with the reason.
- The warning names every archived process in each group that would become unrestorable
  to it. It needs its own explicit confirmation, separate from the archive's.
- One results row per group: deleted, kept (and why), or failed with the tenant's 409
  detail.

Orphans are what blocked R11's delete, so W5's handling of orphaned holders (old T2) is
what keeps this from making Bulk Delete harder later.

## Bulk Delete

**Two ways in.** Pick from the tree (whole groups or processes), or pick from the archived
view. Selecting active processes means "archive, then delete" in one plan, shown as two
phases in the preview.

**Delete by group.** The target set is every process in the selected subtree plus every
archived process whose original group is in that subtree. This is the case that kept
hitting dead ends. The dead end in R11 was orphaned dependency holders (T2), not the
target selection.

**The engine is a port of `NintexProcessDependencies.ps1`** (4,275 lines) into
`web/src/lib/delete/`. It's the riskiest part of the project, because most of its
behavior is learned from the tenant, not documented. Port it phase by phase with the
offline tests coming over first:

1. Discovery: claims from `CheckProcessDependencies`, location fetches, reconciliation.
2. Hold phase: restore archived participants so their Input/Output edges show, orphaned
   targets into a temporary holding group.
3. Reference removal: read-modify-write `PUT /Api/v1/Processes/{id}` with `ProcessJson`
   as a string, `SuppressChangeNotification: true`, `LinkedStakeholders` preserved.
4. Collateral checkpoints: baseline, compare after each mutating phase, the
   `-AcceptCollateral` gate as an explicit on-screen confirmation.
5. Delete, then the post-delete checkpoint (never yet exercised live).
6. Unwind: re-archive everything this run restored, remove the holding group only if
   empty.

**T1 and T2 from R11 are folded into the port.** Implement them in TypeScript, not in
the PowerShell:

- **T1:** the unwind must put back every process the run un-archived, holders and
  targets, with a results row each, on every exit path.
- **T2:** orphaned holders go through the holding group the way orphaned targets
  already do, re-archived before the group is removed, with their own results operation.

## Bulk Move

`POST /Process/Edit/ReorderTreeNodes`, with `NodeType` passed straight through from the
tree item's `itemType`. Spike S2 measured what a move costs:

| Moving | Effect |
|---|---|
| A group | Reparented. Nothing inside it gets a new revision. |
| An in-progress process | Moved, with a minor version bump. |
| A published process | Moved, and **a new major version is published** (1.0 to 2.0). |

So the preview has to say, per process, what will happen. A published process selected
on its own will be republished, which may notify its stakeholders (not measured). Rules:

- Selecting a whole group moves the group, not each process in it. That's the cheap,
  revision-free path, and the resolver should prefer it.
- For each individually selected process, call `ValidateProcessAction` (action type 11,
  destination group, `isShortcut=false`). When it returns `isPrompt`, show its message in
  the preview ("Publish New Version?") and count those processes in the confirmation.
- One node per call, journaled, as PGM does.
- A process with an open draft gets that draft published by the move (measured on a
  real variation set). Those go in their own preview section, unselected by default.
- A variation set moves as one: the tree shows one node, and its siblings (listed in
  `variationSetData`, not in the tree) move with it. The preview names them.
- `linked-process` (shortcut) items aren't movable here.
- Show the viewer delta (`GetTotalSpecifiedGroupRoleAndUserViewers`) for source and
  destination.
- Reuse PGM's cycle and document-group checks for group moves.

## Bulk Update Ownership

CSV upload, same columns and rules as `Update-ProcessOwnership.ps1`: blank leaves a role
unchanged, an unassign keyword sets user id 2, usernames resolved through SCIM (PGM's
`scim.ts`, key entered per run). Preview every row before writing.

Two things the script does that the web version should not copy without a decision:

- It saves with `DoPublish: false`. On a published process that creates a new in-progress
  revision, so the live version keeps the old owner until someone publishes. Offer PGM's
  "save only" vs "match current state" choice.
- It sends `SuppressChangeNotification: false`, so every row notifies stakeholders. Default
  it to true, as PGM does.
- On a tenant in "Publish Only mode", `Publish` needs a `PublishMessage` or it returns 400
  (measured). Send the run's change description as `PublishMessage` on every publish.

## Spikes (run 18 Oct 2026)

| # | Question | Answer |
|---|---|---|
| S1 | Does `DeleteGroup` delete a group holding archived content? | Archived processes: yes, and they become orphans. Documents: no, 409 `AssociatedContents`. |
| S2 | Does `ReorderTreeNodes` move single processes? | Yes. Never-published in-progress gets a minor bump; anything with a published version is republished, open drafts included. Groups move with no revision change. A variation set moves as one. |
| S3 | Where does the archived view get group paths? | Rows have the immediate group only; the breadcrumb endpoint gives the full chain per group. |

Details are in `API_ARCHITECTURE.md`, "Spike results, 18 Oct 2026". All three were run
from a browser session; the breadcrumb call still needs a bearer-token check.

## What happens to the PowerShell

Frozen at v4.11. No more fixes, including T1 and T2, which move into the port. It stays in
the repo as the reference for the delete engine and its tests, and is deleted once the web
delete has passed the same live rounds.

## Decisions

Confirmed by JB, 18 Oct 2026:

1. **Separate app in this repo, foundation lifted from PGM**, not new operations added to
   PGM. PGM's "nothing is ever deleted" guarantee stays intact.
2. **Selecting active processes in Delete archives them first.** Required, not optional.
3. **SSO-only tenants are unsupported.** Password grant only.

Made by Cowork, not yet revisited:

4. **Folder deletion after Archive ships**, behind its own warning and confirmation,
   now that S1 shows the API allows it. (Was "not in v1, pending S1".)
5. **PowerShell frozen at v4.11**, with T1 and T2 implemented only in TypeScript.
