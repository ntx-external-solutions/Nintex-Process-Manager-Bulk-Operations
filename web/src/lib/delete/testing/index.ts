/**
 * Synthetic process indexes for tests. Port of the PowerShell suite's `New-MockIndex`.
 *
 * The mock rows carry no `groupExists`, so each entry reads as "group is there" and
 * "flag not reported", which is what the script's index makes of such a row.
 */

import type { DeleteIndexEntry } from '../model.ts';

export interface MockRow {
  uniqueId: string;
  numericId?: number | null;
  name: string;
  isArchived: boolean;
  groupId: number | null;
  groupExists?: boolean;
  groupExistsReported?: boolean;
}

export function mockEntry(row: MockRow): DeleteIndexEntry {
  return {
    uniqueId: row.uniqueId,
    numericId: row.numericId ?? null,
    name: row.name,
    isArchived: row.isArchived,
    groupId: row.groupId,
    groupUniqueId: null,
    groupName: '',
    groupExists: row.groupExists ?? true,
    groupExistsReported: row.groupExistsReported ?? row.groupExists !== undefined,
  };
}

export function mockIndex(rows: readonly MockRow[]): Map<string, DeleteIndexEntry> {
  return new Map(rows.map((row) => [row.uniqueId.toLowerCase(), mockEntry(row)]));
}

/**
 * The suite's orphaned-group index: the measured tenant in miniature. Most orphaned rows
 * report groupId 1 with the tenant's own name, but some report a real numeric group that
 * has since gone, which is why everything keys on the flag and not the id. Ids are
 * upper-case and keys lower-case, as a tenant's are.
 */
export function orphanedGroupIndex(): Map<string, DeleteIndexEntry> {
  return mockIndex([
    { uniqueId: 'AAAAAAAA-0000-0000-0000-000000000001', numericId: 11, name: 'Placeholder group', isArchived: true, groupId: 1, groupExists: false },
    { uniqueId: 'AAAAAAAA-0000-0000-0000-000000000002', numericId: 12, name: 'Real group, since deleted', isArchived: true, groupId: 832, groupExists: false },
    { uniqueId: 'AAAAAAAA-0000-0000-0000-000000000003', numericId: 13, name: 'Group is fine', isArchived: true, groupId: 1, groupExists: true },
    { uniqueId: 'AAAAAAAA-0000-0000-0000-000000000004', numericId: 14, name: 'Flag not reported', isArchived: false, groupId: 493 },
  ]);
}
