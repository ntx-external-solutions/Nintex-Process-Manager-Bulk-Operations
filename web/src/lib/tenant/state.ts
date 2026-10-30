/**
 * What the tenant looks like, from the two process listings, and what changed.
 *
 * Ported from the script's `Get-NpmProcessIndex` and `Compare-TenantState`. The index is
 * one sweep of the active listing (ListType 0) and one of the archived listing (7),
 * keyed by process id. It is the run's name source, its baseline, and the fresh read
 * every final status comes from.
 *
 * Neither listing is complete: some processes appear in neither (API_ARCHITECTURE.md,
 * "Some processes are in no list"). So a process missing from the index is "unknown",
 * never "gone", and anything reporting coverage says it is partial.
 */

import type { ProcessListPage } from '../pm/processes.ts';
import { toArchivedProcess } from '../select/archived.ts';

export const ACTIVE_LIST_TYPE = 0;
export const ARCHIVED_LIST_TYPE = 7;
export const INDEX_PAGE_SIZE = 200;

export interface IndexEntry {
  uniqueId: string;
  name: string;
  isArchived: boolean;
  groupId: number | null;
  groupUniqueId: string | null;
  groupName: string;
  /** False only when the listing said so explicitly. */
  groupExists: boolean;
  /** The listing's number for the process, so an id typed as a number resolves (W7). */
  numericId?: number | null;
}

/** Keyed by lowercased process id. */
export type ProcessIndex = ReadonlyMap<string, IndexEntry>;

export type ListPage = (page: number, listType: number) => Promise<ProcessListPage>;

export function indexEntry(index: ProcessIndex, uniqueId: string): IndexEntry | null {
  return index.get(uniqueId.toLowerCase()) ?? null;
}

/**
 * Both listings, active first, so a process both return is recorded as archived, as the
 * script records it. A short page ends each sweep; a page cap backstops a listing that
 * never returns one.
 */
export async function loadProcessIndex(
  listPage: ListPage,
  options: { maxPages?: number; onProgress?: (loaded: number) => void } = {},
): Promise<ProcessIndex> {
  const maxPages = options.maxPages ?? 500;
  const index = new Map<string, IndexEntry>();

  for (const listType of [ACTIVE_LIST_TYPE, ARCHIVED_LIST_TYPE]) {
    for (let page = 1; page <= maxPages; page++) {
      const result = await listPage(page, listType);
      const items = result?.items ?? [];
      for (const item of items) {
        const row = toArchivedProcess(item);
        if (!row) continue;
        index.set(row.uniqueId.toLowerCase(), {
          uniqueId: row.uniqueId,
          name: row.name,
          isArchived: listType === ARCHIVED_LIST_TYPE,
          groupId: row.groupId,
          groupUniqueId: row.groupUniqueId,
          groupName: row.groupName,
          groupExists: row.groupExists,
          numericId: listingNumber(item),
        });
      }
      options.onProgress?.(index.size);
      if (items.length < INDEX_PAGE_SIZE) break;
    }
  }

  return index;
}

/** The script reads `id`; the typed listing calls it `processId` (as delete/planner.ts reads it). */
function listingNumber(item: unknown): number | null {
  const record = item as Record<string, unknown>;
  for (const field of ['id', 'processId']) {
    const n = Number(record[field]);
    if (record[field] !== null && record[field] !== undefined && record[field] !== '' && Number.isInteger(n)) return n;
  }
  return null;
}

export type StateChange =
  | 'Archived'
  | 'Unarchived'
  | 'Moved'
  | 'ArchivedAndMoved'
  | 'Disappeared'
  | 'NotInBaseline';

export interface Collateral {
  uniqueId: string;
  name: string;
  change: StateChange;
  wasArchived: boolean | null;
  isArchivedNow: boolean | null;
  originalGroupId: number | null;
  /**
   * The baseline's `groupExists`, so a reversal knows the group it would restore into is
   * gone before it asks. True for NotInBaseline, which has no baseline to say otherwise.
   */
  originalGroupExists: boolean;
  currentGroupId: number | null;
}

/**
 * Processes that changed without being asked to.
 *
 * `expected` is everything the run deliberately changed, which must be passed in or the
 * run reports its own work as damage. `observed` is everything the run came across: any
 * of those missing from the baseline is reported as NotInBaseline, because whether it
 * changed cannot be known, only that the run touched it.
 */
export function compareTenantState(
  baseline: ProcessIndex | null,
  after: ProcessIndex | null,
  expected: readonly string[],
  observed: readonly string[] = [],
): Collateral[] {
  // No before-state or no after-state is nothing to compare, as in the script.
  if (!baseline || !after) return [];
  const expectedKeys = new Set(expected.map((id) => id.toLowerCase()));
  const out: Collateral[] = [];

  for (const [key, before] of baseline) {
    if (expectedKeys.has(key)) continue;
    const now = after.get(key);

    if (!now) {
      out.push({
        uniqueId: before.uniqueId,
        name: before.name,
        change: 'Disappeared',
        wasArchived: before.isArchived,
        isArchivedNow: null,
        originalGroupId: before.groupId,
        originalGroupExists: before.groupExists !== false,
        currentGroupId: null,
      });
      continue;
    }

    const archiveChanged = before.isArchived !== now.isArchived;
    const groupChanged = before.groupId !== now.groupId;
    if (!archiveChanged && !groupChanged) continue;

    let change: StateChange = 'Moved';
    if (archiveChanged && groupChanged) change = 'ArchivedAndMoved';
    else if (archiveChanged) change = now.isArchived ? 'Archived' : 'Unarchived';

    out.push({
      uniqueId: before.uniqueId,
      name: before.name,
      change,
      wasArchived: before.isArchived,
      isArchivedNow: now.isArchived,
      originalGroupId: before.groupId,
      originalGroupExists: before.groupExists !== false,
      currentGroupId: now.groupId,
    });
  }

  const reported = new Set(out.map((c) => c.uniqueId.toLowerCase()));
  for (const id of observed) {
    const key = id.toLowerCase();
    if (expectedKeys.has(key) || baseline.has(key) || reported.has(key)) continue;
    reported.add(key);
    const now = after.get(key);
    out.push({
      uniqueId: id,
      name: now?.name ?? '',
      change: 'NotInBaseline',
      wasArchived: null,
      isArchivedNow: now?.isArchived ?? null,
      originalGroupId: null,
      originalGroupExists: true,
      currentGroupId: now?.groupId ?? null,
    });
  }

  return out;
}
