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
