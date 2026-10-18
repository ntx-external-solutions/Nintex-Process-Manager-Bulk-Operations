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

import type { DeleteIndexEntry } from './model.ts';
import { notPorted } from './phases.ts';
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
  includeSubgroups?: boolean,
): string[] {
  return notPorted('discovery');
}

/**
 * Every indexed process in one of these groups, sorted by name; archived ones only when
 * asked. The index is the enumeration, so a large group is never partly seen. Port of
 * `Select-NpmProcessInGroup`.
 */
export function processesInGroups(
  index: ProcessIndex | null,
  groupIds: ReadonlyArray<number | string | null>,
  includeArchived?: boolean,
): IndexEntry[] {
  return notPorted('discovery');
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
  return notPorted('hold');
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

export type CoverageEntry = Pick<DeleteIndexEntry, 'groupExists' | 'groupExistsReported'>;

/** Whether this tenant's listing reports `groupExists` at all. Port of `Get-NpmGroupExistsCoverage`. */
export function groupExistsCoverage(index: ReadonlyMap<string, CoverageEntry> | null): GroupExistsCoverage {
  return notPorted('hold');
}
