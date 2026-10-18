/**
 * What a Bulk Update Ownership run will do, row by row, before anything is written.
 *
 * Ported from `Update-ProcessOwnership.ps1`: the same row rules (a row with no id, no
 * owner or expert, or a username SCIM cannot resolve is skipped with the script's
 * reason), the same unassign keywords and placeholder user, and the same id-plus-name
 * write. Three things differ, each for a reason:
 *
 *  - **Publishing is the operator's choice** (SPEC-WEB.md). The script saved with
 *    `DoPublish: false`, which on a published process leaves the live version showing
 *    the old owner until someone publishes. PGM's two choices are offered: "save only"
 *    and "match current state", which republishes what was published. A process already
 *    in progress is only ever saved, under either choice, because its draft may hold
 *    edits that are not ours to publish.
 *  - **A process named on several rows is written once.** The script saved once per row,
 *    so the last non-blank cell for each role won; folding the rows gives the same end
 *    state with one revision instead of several.
 *  - **A row that would change nothing is not saved.** The script saved anyway, which
 *    bumps a version for no change.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import { UNASSIGNED_USER, type OwnershipRead, type OwnershipState, type UserRef } from '../pm/ownership.ts';
import { indexUsersByLogon, type DirectoryLookup, type DirectoryUser } from '../pm/scim.ts';
import { isGuid, type OwnershipCsvRow } from './csv.ts';

export const OPERATION = 'UpdateOwnership';

/** Case-insensitive, as in the script. */
export const UNASSIGN_KEYWORDS = ['unassigned', 'unassign', 'none', 'n/a', 'na'] as const;

/**
 * - `match-state`: a published process is republished, so the change is live; one in
 *   progress is saved and left unpublished.
 * - `save-only`: nothing is published. A published process gets a draft, and readers go
 *   on seeing the old owner until someone publishes it.
 */
export type PublishChoice = 'match-state' | 'save-only';

/** How the change is written, from the process state, the choice and the permissions. */
export type WritePath = 'save-only' | 'publish-direct' | 'submit-then-publish';

export interface Directory {
  byLogon: ReadonlyMap<string, DirectoryLookup>;
  byId: ReadonlyMap<number, DirectoryUser>;
}

export function directoryOf(users: readonly DirectoryUser[]): Directory {
  return { byLogon: indexUsersByLogon(users), byId: new Map(users.map((u) => [u.userId, u])) };
}

export type Cell =
  | { kind: 'unchanged' }
  | { kind: 'set'; user: UserRef; inactive: boolean }
  | { kind: 'invalid'; value: string; reason: string };

export function isUnassignKeyword(value: string): boolean {
  return (UNASSIGN_KEYWORDS as readonly string[]).includes(value.trim().toLowerCase());
}

/**
 * One owner or expert cell. A purely numeric value is a user id, as the script's SCIM
 * lookup treats it; anything else is a logon.
 */
export function resolveCell(value: string | null, directory: Directory): Cell {
  if (value === null || value.trim() === '') return { kind: 'unchanged' };
  const term = value.trim();
  if (isUnassignKeyword(term)) return { kind: 'set', user: { ...UNASSIGNED_USER }, inactive: false };

  if (/^\d+$/.test(term)) {
    const user = directory.byId.get(Number(term));
    return user
      ? { kind: 'set', user: { id: user.userId, name: user.displayName }, inactive: !user.active }
      : { kind: 'invalid', value: term, reason: 'no user has that id' };
  }

  const found = directory.byLogon.get(term.toLowerCase());
  if (found === 'ambiguous') return { kind: 'invalid', value: term, reason: 'more than one account has that username' };
  if (!found) return { kind: 'invalid', value: term, reason: 'not found' };
  return { kind: 'set', user: { id: found.userId, name: found.displayName }, inactive: !found.active };
}

/** Every distinct username in the file that cannot be resolved, for the up-front warning. */
export function unresolvedUsernames(rows: readonly OwnershipCsvRow[], directory: Directory): Array<{ value: string; reason: string }> {
  const seen = new Map<string, { value: string; reason: string }>();
  for (const row of rows) {
    for (const value of [row.owner, row.expert]) {
      const cell = resolveCell(value, directory);
      const key = cell.kind === 'invalid' ? cell.value.toLowerCase() : null;
      if (cell.kind === 'invalid' && key !== null && !seen.has(key)) seen.set(key, { value: cell.value, reason: cell.reason });
    }
  }
  return [...seen.values()];
}

export interface RoleChange {
  before: UserRef | null;
  after: UserRef;
  /** The directory marks the new user inactive. Allowed, and worth saying. */
  inactive: boolean;
}

export interface OwnershipChange {
  lines: number[];
  uniqueId: string;
  name: string;
  version: string;
  revisionEditId: number;
  /** Published today, so a save alone leaves the live version unchanged. */
  fromPublished: boolean;
  writePath: WritePath;
  owner: RoleChange | null;
  expert: RoleChange | null;
}

export interface OwnershipPlan {
  changes: OwnershipChange[];
  /** Rows for what will not be written, so nothing in the file is lost from the results. */
  skipped: ResultRow[];
  publish: PublishChoice;
}

export interface OwnershipReads {
  ownership(processUniqueId: string): Promise<OwnershipRead>;
  isFatal?: ((error: unknown) => string | null) | undefined;
  onProgress?: ((done: number, total: number, label: string) => void) | undefined;
}

function at(lines: readonly number[]): string {
  return lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`;
}

/** Returns a WritePath, or the reason the process cannot be written. PGM's rules. */
export function chooseWritePath(state: OwnershipState, publish: PublishChoice): WritePath | string {
  if (!state.canSave) return 'You do not have permission to save changes to this process.';
  // Someone else is mid-review. Editing underneath them is not ours to do.
  if (state.revisionStateId === 2) return 'Awaiting approval, so it was not modified.';
  if (state.revisionStateId === 1) return 'save-only';
  if (publish === 'save-only') return 'save-only';
  if (state.canPublishAfterEdit) return 'publish-direct';
  if (state.canSubmitForApprovalAfterEdit) return 'submit-then-publish';
  return 'Published, but you can neither publish it nor submit it for approval. Choose "Save only" to leave the change as a draft instead.';
}

function roleChange(before: UserRef | null, cell: Cell): RoleChange | null {
  if (cell.kind !== 'set') return null;
  // A matching id with a stale name is still worth writing: the name is what readers see.
  if (before && before.id === cell.user.id && before.name === cell.user.name) return null;
  return { before, after: cell.user, inactive: cell.inactive };
}

function errorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

function errorText(error: unknown): string {
  const record = (error ?? {}) as { tenantMessage?: unknown };
  if (typeof record.tenantMessage === 'string' && record.tenantMessage.trim() !== '') return record.tenantMessage;
  return error instanceof Error ? error.message : String(error);
}

export async function buildOwnershipPlan(
  rows: readonly OwnershipCsvRow[],
  directory: Directory,
  reads: OwnershipReads,
  options: {
    publish: PublishChoice;
    /**
     * Names from both process listings, keyed by lowercased id. Every row that is not
     * written takes its name from here, so a skipped or failed process is named. The W4
     * live test found every one of them reading "(name unavailable; not in any process
     * list)", for processes that were in a list (F4).
     */
    names?: ReadonlyMap<string, { name: string }> | undefined;
  },
): Promise<OwnershipPlan> {
  const skipped: ResultRow[] = [];
  const named = (id: string, known = ''): string => known || options.names?.get(id.toLowerCase())?.name || '';
  const skip = (objectId: string, name: string, status: string, message: string, statusCode = 0): ResultRow =>
    resultRow({ objectId, name: objectId === '' ? name : named(objectId, name), operation: OPERATION, status, message, statusCode });
  /** Keyed by lowercased id, in the order the file first names each process. */
  const pending = new Map<string, { processId: string; lines: number[]; owner: Cell; expert: Cell }>();

  for (const row of rows) {
    if (row.processId === null) {
      skipped.push(skip('', `Line ${row.line}`, 'Skipped', `Missing ProcessID (line ${row.line})`));
      continue;
    }
    const owner = resolveCell(row.owner, directory);
    const expert = resolveCell(row.expert, directory);

    if (owner.kind === 'unchanged' && expert.kind === 'unchanged') {
      skipped.push(skip(row.processId, '', 'Skipped', `No owner/expert provided (line ${row.line})`));
      continue;
    }
    const invalid = [
      owner.kind === 'invalid' ? `owner '${owner.value}' ${owner.reason}` : null,
      expert.kind === 'invalid' ? `expert '${expert.value}' ${expert.reason}` : null,
    ].filter((note): note is string => note !== null);
    if (invalid.length > 0) {
      // The script skips the whole row: setting one role and not the other is not what
      // the row asked for.
      skipped.push(skip(row.processId, '', 'Skipped', `${invalid.join('; ')} (line ${row.line})`));
      continue;
    }
    if (!isGuid(row.processId)) {
      // The script tried these and failed on the read. Nothing is sent for them here.
      skipped.push(
        skip(
          row.processId,
          '',
          'Skipped',
          `Not a process UniqueId (GUID), so it was not looked up. Use the id in a process URL (.../Process/View/{guid}), not the short number (line ${row.line})`,
        ),
      );
      continue;
    }

    const key = row.processId.toLowerCase();
    const folded = pending.get(key);
    if (!folded) {
      pending.set(key, { processId: row.processId, lines: [row.line], owner, expert });
    } else {
      folded.lines.push(row.line);
      if (owner.kind === 'set') folded.owner = owner;
      if (expert.kind === 'set') folded.expert = expert;
    }
  }

  const changes: OwnershipChange[] = [];
  let done = 0;
  for (const entry of pending.values()) {
    reads.onProgress?.(++done, pending.size, entry.processId);

    let read: OwnershipRead;
    try {
      read = await reads.ownership(entry.processId);
    } catch (error) {
      if (reads.isFatal?.(error)) throw error;
      const status = errorStatus(error);
      skipped.push(
        skip(
          entry.processId,
          '',
          'Failed',
          status === 404
            ? `Process not found. It may have been deleted (${at(entry.lines)})`
            : `Could not be read (${status > 0 ? `HTTP ${status}` : 'no response'}): ${errorText(error)} (${at(entry.lines)})`,
          status,
        ),
      );
      continue;
    }

    // The tenant answers an archived process with 200 and no model (F4). The model's own
    // flag is kept as a second signal.
    if (read.kind === 'archived' || read.state.isArchived === true) {
      const name = read.kind === 'process' ? read.state.name : '';
      skipped.push(skip(entry.processId, name, 'Skipped', `The process is archived. Restore it before changing its owner or expert (${at(entry.lines)})`));
      continue;
    }
    const state = read.state;

    const owner = roleChange(state.owner, entry.owner);
    const expert = roleChange(state.expert, entry.expert);
    if (!owner && !expert) {
      skipped.push(skip(entry.processId, state.name, 'Skipped', `Already set: ${describeCurrent(state, entry)} (${at(entry.lines)})`));
      continue;
    }

    const writePath = chooseWritePath(state, options.publish);
    if (!isWritePath(writePath)) {
      skipped.push(skip(entry.processId, state.name, 'Blocked', `${writePath} (${at(entry.lines)})`));
      continue;
    }

    changes.push({
      lines: entry.lines,
      uniqueId: state.uniqueId || entry.processId,
      name: state.name,
      version: state.version,
      revisionEditId: state.revisionEditId,
      fromPublished: state.revisionStateId === 3,
      writePath,
      owner,
      expert,
    });
  }

  return { changes, skipped, publish: options.publish };
}

function isWritePath(value: WritePath | string): value is WritePath {
  return value === 'save-only' || value === 'publish-direct' || value === 'submit-then-publish';
}

/** "Ann (id 7)", or the script's "(none)". */
export function describeUser(user: UserRef | null): string {
  return user ? `${user.name || '(none)'} (id ${user.id})` : '(none) (id (none))';
}

function describeCurrent(state: OwnershipState, entry: { owner: Cell; expert: Cell }): string {
  return [entry.owner.kind === 'set' ? `Owner ${describeUser(state.owner)}` : null, entry.expert.kind === 'set' ? `Expert ${describeUser(state.expert)}` : null]
    .filter((p): p is string => p !== null)
    .join('; ');
}

/** The script's wording: "Owner: Old (id 1) -> New (id 2); Expert: ...". */
export function describeChange(change: OwnershipChange): string {
  const part = (label: string, role: RoleChange | null) =>
    role ? `${label}: ${describeUser(role.before)} -> ${describeUser(role.after)}${role.inactive ? ' (inactive in the directory)' : ''}` : null;
  return [part('Owner', change.owner), part('Expert', change.expert)].filter((p): p is string => p !== null).join('; ');
}

/** What the write does to the process, in words for the preview and the results. */
export function describeWrite(change: OwnershipChange): string {
  switch (change.writePath) {
    case 'save-only':
      return change.fromPublished
        ? 'Saved as a draft. The published version shows the old owner and expert until someone publishes it.'
        : 'Saved. It was already in progress, so it is not published.';
    case 'publish-direct':
      return 'Saved and published as a new major version.';
    case 'submit-then-publish':
      return 'Saved, submitted for approval and published as a new major version.';
  }
}

export function publishCount(plan: OwnershipPlan): number {
  return plan.changes.filter((c) => c.writePath !== 'save-only').length;
}

/** The dry run's results file. */
export function ownershipPreviewRows(plan: OwnershipPlan): ResultRow[] {
  return [
    ...plan.changes.map((change) =>
      resultRow({
        objectId: change.uniqueId,
        name: change.name,
        operation: OPERATION,
        status: 'Preview',
        message: `Would update '${change.name}' - ${describeChange(change)}. ${describeWrite(change)}`,
      }),
    ),
    ...plan.skipped,
  ];
}
