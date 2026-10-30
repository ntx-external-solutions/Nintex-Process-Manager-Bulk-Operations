/**
 * Groups as the delete engine sees them: what a group selection covers, and which
 * processes belong to a group that is no longer there.
 *
 * A process archived before its group was deleted points at a group that is gone. It can
 * be archived but not restored anywhere: RestoreProcess answers HTTP 500 for a group that
 * does not exist. The listing says so per row as `groupExists`, and only an explicit
 * false counts (`readGroupExists`, select/archived.ts). Never test `groupId === 1`: two
 * measured orphans carry a real numeric id.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import { defaultIsFatal } from '../exec/runner.ts';
import { ARCHIVED_BATCH_SIZE, type DeleteGateway } from './gateway.ts';
import { nodeInt, nodeString, nodeValue, type DeleteIndexEntry, type ProcessModel } from './model.ts';
import { readGroupExists, type ArchivedProcess } from '../select/archived.ts';
import type { IndexEntry, ProcessIndex } from '../tenant/state.ts';

/** The part of a tree group the descendant walk reads. */
export interface GroupTreeNode {
  id: number | string;
  parentId: number | string | null;
}

/**
 * A group's numeric id, then every group beneath it when asked, as strings ("493" and
 * 493 must compare equal). Guards against a malformed tree with a cycle. Port of
 * `Get-NpmGroupDescendantId`.
 */
export function groupDescendantIds(
  groups: readonly GroupTreeNode[],
  rootGroupId: number | string | null,
  includeSubgroups = true,
): string[] {
  if (rootGroupId === null) return [];
  const rootKey = String(rootGroupId);
  if (!includeSubgroups) return [rootKey];

  const childrenOf = new Map<string, string[]>();
  for (const group of groups) {
    if (group.parentId === null || String(group.parentId) === '') continue;
    const parent = String(group.parentId);
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), String(group.id)]);
  }

  // Breadth first, each group once: a malformed parentId would otherwise hang the run
  // before it changed anything, which is a confusing way to fail.
  const found = new Set([rootKey]);
  const queue = [rootKey];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()!) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

/**
 * Every indexed process in one of these groups, sorted by name; archived ones only when
 * asked. The index is the enumeration, so a large group is never partly seen. Port of
 * `Select-NpmProcessInGroup`.
 */
export function processesInGroups(
  index: ProcessIndex | null,
  groupIds: ReadonlyArray<number | string | null>,
  includeArchived = false,
): IndexEntry[] {
  const wanted = new Set(groupIds.filter((id) => id !== null).map(String));
  if (wanted.size === 0 || index === null) return [];
  return [...index.values()]
    .filter((e) => e.groupId !== null && wanted.has(String(e.groupId)) && (includeArchived || !e.isArchived))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface OrphanedGroupProcess {
  uniqueId: string;
  name: string;
  /** The group it points at, which no longer exists. */
  originalGroupId: number | null;
  isArchived: boolean;
}

/** The given processes whose group is gone, keyed on the flag, not the id. Port of `Find-OrphanedGroupProcess`. */
export function findOrphanedGroupProcesses(
  index: ProcessIndex | null,
  uniqueIds: readonly string[],
): OrphanedGroupProcess[] {
  if (index === null) return [];
  const orphans: OrphanedGroupProcess[] = [];
  for (const id of uniqueIds) {
    if (!id) continue;
    const entry = index.get(id.toLowerCase());
    if (!entry || readGroupExists(entry.groupExists).exists) continue;
    orphans.push({ uniqueId: entry.uniqueId, name: entry.name, originalGroupId: entry.groupId, isArchived: entry.isArchived });
  }
  return orphans;
}

/** `None` when no row reports the flag (or there are no rows), `Mixed` when only some do. */
export type GroupExistsCoverageState = 'Full' | 'None' | 'Mixed';

export interface GroupExistsCoverage {
  total: number;
  reported: number;
  missing: number;
  /** Among the rows that reported the flag. A zero under `None` is unmeasured, not clean. */
  orphans: number;
  state: GroupExistsCoverageState;
}

export type CoverageEntry = Pick<DeleteIndexEntry, 'groupExists' | 'groupExistsReported'> & { isArchived?: boolean | undefined };

/**
 * Whether this tenant's listing reports `groupExists` at all, over archived rows only.
 * Port of `Get-NpmGroupExistsCoverage`. Active rows never carry the field, so counting
 * them made every run warn "194 of 673 listing row(s) do not report groupExists" (R13).
 * An entry with no `isArchived` is counted, as the script counted every row.
 */
export function groupExistsCoverage(index: ReadonlyMap<string, CoverageEntry> | null): GroupExistsCoverage {
  let total = 0;
  let reported = 0;
  let orphans = 0;
  for (const entry of index?.values() ?? []) {
    if (entry.isArchived === false) continue;
    total++;
    if (!entry.groupExistsReported) continue;
    reported++;
    if (!readGroupExists(entry.groupExists).exists) orphans++;
  }
  // Mixed is the one to alarm on: absent on some rows only is less likely an omission
  // than the vanished-group case arriving in another shape.
  const state: GroupExistsCoverageState = total === 0 || reported === 0 ? 'None' : reported < total ? 'Mixed' : 'Full';
  return { total, reported, missing: total - reported, orphans, state };
}

/** Says when a zero-orphan result means "none" and when it means "unknown". Port of `Show-GroupExistsCoverage`'s text. */
export function groupExistsCoverageLines(coverage: GroupExistsCoverage | null): string[] {
  if (coverage?.state === 'None') {
    return [
      "This tenant's process listing does not report groupExists. Orphan detection is unavailable here: a process whose group was deleted cannot be told apart from one whose group is fine, so this run reports no orphans because it cannot see them, not because there are none.",
      'A restore into a vanished group will fail with HTTP 500 and fall back.',
    ];
  }
  if (coverage?.state === 'Mixed') {
    return [
      `${coverage.missing} of ${coverage.total} archived listing row(s) do not report groupExists, while ${coverage.reported} do. Those rows are treated as though their group exists, which is the safe default but may be wrong: on a listing that reports the field everywhere else, a missing one is more likely to mean the group is gone than that the field was omitted. Check those processes before relying on this run's orphan count.`,
    ];
  }
  return [];
}

// ------------------------------------------------------------ confirming an orphan (F6)

/** The group a process model names (`ProcessGroupItems.ProcessGroup`), or null when it names none. */
export interface ModelGroup {
  id: number | null;
  uniqueId: string;
  name: string;
}

export function modelGroupOf(model: ProcessModel | null | undefined): ModelGroup | null {
  const group = nodeValue(nodeValue(model, 'ProcessGroupItems'), 'ProcessGroup');
  const uniqueId = nodeString(group, 'UniqueId');
  if (!uniqueId) return null;
  return { id: nodeInt(group, 'Id'), uniqueId, name: nodeString(group, 'Name') };
}

/**
 * Whether the listing's "group is gone" holds for this process. Measured once in R13: a
 * row said `groupExists: false` (group id 1) while the model named a group that was in
 * the tree, and the run parked the process, archived it in the holding group and deleted
 * that group, which made the orphan real. So the listing alone is not enough to park.
 *
 *  - `gone`: the model names no group, or the group it names is not found. Today's
 *    behavior, which is right for a real orphan.
 *  - `present`: the group the model names was found. Treat it as in that group.
 *  - `unknown`: the lookup could not be made. The caller tries that group first and
 *    falls back to parking only if the tenant refuses it.
 */
export type OrphanCheck = { kind: 'gone' } | { kind: 'present'; group: ModelGroup } | { kind: 'unknown'; group: ModelGroup };

export async function confirmOrphan(
  gateway: Pick<DeleteGateway, 'groupFound'>,
  model: ProcessModel | null | undefined,
  isFatal: (error: unknown) => string | null = defaultIsFatal,
): Promise<OrphanCheck> {
  const group = modelGroupOf(model);
  if (!group || group.id === null) return { kind: 'gone' };
  try {
    return (await gateway.groupFound(group.uniqueId)) ? { kind: 'present', group } : { kind: 'gone' };
  } catch (error) {
    if (isFatal(error)) throw error;
    return { kind: 'unknown', group };
  }
}

/** The warning row for a listing that called a group gone when the model's group is there. */
export function groupDisagreementRow(
  process: { uniqueId: string; name: string },
  listedGroupId: number | null,
  group: ModelGroup,
  confirmed: boolean,
): ResultRow {
  const named = `${group.name ? `'${group.name}' ` : ''}(id ${group.id ?? 'unknown'})`;
  return resultRow({
    objectId: process.uniqueId,
    name: process.name,
    operation: 'GroupCheck',
    status: 'Warning',
    message: confirmed
      ? `The process listing says its group ${listedGroupId ?? 'unknown'} no longer exists, but its model names group ${named}, which is in the tree. Treated as in that group, not as an orphan.`
      : `The process listing says its group ${listedGroupId ?? 'unknown'} no longer exists, but its model names group ${named}, and the tree could not be checked. Restored into that group, which the tenant accepted, so it is not an orphan.`,
    groupId: group.id,
  });
}

// ------------------------------------------------------------ the archived view's orphans (W6)

/** A `groupExists: false` row the model check overturned: the group its model names, found in the tree. */
export interface ArchivedGroupCorrection {
  uniqueId: string;
  name: string;
  listedGroupId: number | null;
  group: ModelGroup;
}

export interface ArchivedOrphanCheck {
  /** The rows, with each overturned one moved to the group its model names. */
  processes: ArchivedProcess[];
  corrections: ArchivedGroupCorrection[];
  /** One `GroupCheck` `Warning` row per correction, for the results file. */
  rows: ResultRow[];
  /** Rows left in the orphaned bucket because the tree could not be checked. */
  unchecked: number;
}

/**
 * The archived view's "group no longer exists" bucket, confirmed one row at a time with
 * the F6 check before anything is labelled orphaned. R13 measured a row that said
 * `groupExists: false` while its model named a group that was in the tree. Such a row is
 * moved to that group, under its real path, and logged; a row whose model names no group,
 * or a group the tree does not have, stays an orphan. A row whose group could not be
 * looked up stays where the listing put it, and is counted, since that is not proof
 * either way.
 */
export async function confirmArchivedOrphans(
  gateway: Pick<DeleteGateway, 'readArchivedModels' | 'groupFound'>,
  processes: readonly ArchivedProcess[],
  isFatal: (error: unknown) => string | null = defaultIsFatal,
): Promise<ArchivedOrphanCheck> {
  const listedGone = processes.filter((p) => !p.groupExists);
  const models = new Map<string, ProcessModel>();
  const ids = listedGone.map((p) => p.uniqueId);
  for (let i = 0; i < ids.length; i += ARCHIVED_BATCH_SIZE) {
    try {
      for (const model of await gateway.readArchivedModels(ids.slice(i, i + ARCHIVED_BATCH_SIZE))) {
        const id = nodeString(model, 'UniqueId');
        if (id) models.set(id.toLowerCase(), model);
      }
    } catch (error) {
      if (isFatal(error)) throw error;
      // Unread: the listing's word stands, as in the run (bulkDelete.ts).
    }
  }

  const moved = new Map<string, ModelGroup>();
  const corrections: ArchivedGroupCorrection[] = [];
  let unchecked = 0;
  for (const process of listedGone) {
    const check = await confirmOrphan(gateway, models.get(process.uniqueId.toLowerCase()), isFatal);
    if (check.kind === 'unknown') unchecked++;
    if (check.kind !== 'present') continue;
    moved.set(process.uniqueId.toLowerCase(), check.group);
    corrections.push({ uniqueId: process.uniqueId, name: process.name, listedGroupId: process.groupId, group: check.group });
  }

  return {
    processes: processes.map((p) => {
      const group = moved.get(p.uniqueId.toLowerCase());
      return group ? { ...p, groupExists: true, groupId: group.id, groupUniqueId: group.uniqueId, groupName: group.name || p.groupName } : p;
    }),
    corrections,
    rows: corrections.map((c) => groupDisagreementRow(c, c.listedGroupId, c.group, true)),
    unchecked,
  };
}
