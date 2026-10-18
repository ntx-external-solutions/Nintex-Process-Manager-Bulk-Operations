/**
 * The archived view: every archived process, grouped by the group it was archived from.
 *
 * Read from the paginated process listing with the archived list type (7). Each row
 * names its group, and carries `groupExists`, which is false when that group was deleted
 * while the process sat in the archive. Those processes go in a bucket of their own,
 * because they cannot be restored anywhere and they are what blocked R11's delete.
 *
 * Two rules from API_ARCHITECTURE.md ("groupExists") are held here:
 *
 *  - **test the flag, never the id.** The API reports a deleted group as `groupId: 1`
 *    with the tenant's own name, but two measured orphans carry a real numeric id, so
 *    `groupId === 1` misses them;
 *  - **absent is not false.** A row without the field is treated as having a group, and
 *    the view says how many rows did not report it, so "no orphans" is never claimed by
 *    a listing that could not have shown any.
 *
 * Which listing fields give the original group's full path is spike S3. Until it
 * answers, a bucket is labelled with the group's path from the tree when the tree has
 * been read that far, and with the listing's `groupName` otherwise.
 */

import type { ProcessListItem, ProcessListPage } from '../pm/processes.ts';

export const ARCHIVED_LIST_TYPE = 7;

/** Matches the PowerShell index sweep. */
export const ARCHIVED_PAGE_SIZE = 200;

export interface ArchivedProcess {
  uniqueId: string;
  name: string;
  groupId: number | null;
  groupUniqueId: string | null;
  groupName: string;
  /** False only when the listing said so explicitly. */
  groupExists: boolean;
  /** Whether the row carried the flag at all. */
  groupExistsReported: boolean;
}

/**
 * The listing's `groupExists`, read the way the script reads it
 * (`ConvertTo-NpmGroupExists`): only an explicit false, or the text "false" or "0",
 * means the group is gone.
 */
export function readGroupExists(value: unknown): { exists: boolean; reported: boolean } {
  if (value === undefined || value === null) return { exists: true, reported: false };
  if (typeof value === 'boolean') return { exists: value, reported: true };
  if (typeof value === 'number') return { exists: value !== 0, reported: true };
  const text = String(value).trim();
  if (text === '') return { exists: true, reported: false };
  return { exists: !/^(false|0)$/i.test(text), reported: true };
}

export function toArchivedProcess(row: ProcessListItem): ArchivedProcess | null {
  const record = row as unknown as Record<string, unknown>;
  const uniqueId = typeof row.processUniqueId === 'string' ? row.processUniqueId : '';
  if (uniqueId === '') return null;
  const flag = readGroupExists(record['groupExists']);
  return {
    uniqueId,
    name: typeof row.processName === 'string' ? row.processName : '',
    groupId: typeof row.groupId === 'number' ? row.groupId : null,
    groupUniqueId: typeof row.groupUniqueId === 'string' && row.groupUniqueId !== '' ? row.groupUniqueId : null,
    groupName: typeof row.groupName === 'string' ? row.groupName : '',
    groupExists: flag.exists,
    groupExistsReported: flag.reported,
  };
}

export interface ArchivedBucket {
  /** The group's unique id, or ORPHANED_BUCKET. */
  key: string;
  label: string;
  /** False for the orphaned bucket. */
  groupExists: boolean;
  processes: ArchivedProcess[];
}

export const ORPHANED_BUCKET = 'orphaned';

export interface ArchivedView {
  buckets: ArchivedBucket[];
  total: number;
  orphaned: number;
  /** Rows that did not carry groupExists, so could not have been classed as orphans. */
  unreported: number;
}

/**
 * Bucket archived processes by group, orphans last.
 *
 * `groupPath` names a group from the tree, when the tree has been read far enough to
 * know where it sits. Buckets are sorted by label so the view reads like the tree.
 */
export function groupArchived(
  processes: readonly ArchivedProcess[],
  groupPath: (groupUniqueId: string) => string[] | null = () => null,
): ArchivedView {
  const byGroup = new Map<string, ArchivedBucket>();
  const orphans: ArchivedProcess[] = [];
  let unreported = 0;

  for (const process of processes) {
    if (!process.groupExistsReported) unreported++;
    if (!process.groupExists) {
      orphans.push(process);
      continue;
    }

    const key = process.groupUniqueId ?? `id:${process.groupId ?? 'unknown'}`;
    let bucket = byGroup.get(key);
    if (!bucket) {
      const path = process.groupUniqueId ? groupPath(process.groupUniqueId) : null;
      bucket = {
        key,
        label: path && path.length > 0 ? path.join(' / ') : process.groupName || '(group not named)',
        groupExists: true,
        processes: [],
      };
      byGroup.set(key, bucket);
    }
    bucket.processes.push(process);
  }

  const buckets = [...byGroup.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const bucket of buckets) bucket.processes.sort((a, b) => a.name.localeCompare(b.name));

  if (orphans.length > 0) {
    orphans.sort((a, b) => a.name.localeCompare(b.name));
    buckets.push({
      key: ORPHANED_BUCKET,
      label: 'Group no longer exists',
      groupExists: false,
      processes: orphans,
    });
  }

  return { buckets, total: processes.length, orphaned: orphans.length, unreported };
}

/**
 * Every page of the archived listing.
 *
 * A short page ends the walk, as in the script. A hard page cap backstops a count that
 * never agrees with the pages, and the same id on two pages is kept once.
 */
export async function loadArchived(
  listPage: (page: number, listType: number) => Promise<ProcessListPage>,
  options: { maxPages?: number; onPage?: (loaded: number, total: number) => void } = {},
): Promise<ArchivedProcess[]> {
  const maxPages = options.maxPages ?? 500;
  const byId = new Map<string, ArchivedProcess>();

  for (let page = 1; page <= maxPages; page++) {
    const result = await listPage(page, ARCHIVED_LIST_TYPE);
    const items = result?.items ?? [];
    for (const item of items) {
      const process = toArchivedProcess(item);
      if (process && !byId.has(process.uniqueId.toLowerCase())) {
        byId.set(process.uniqueId.toLowerCase(), process);
      }
    }
    options.onPage?.(byId.size, result?.totalItemCount ?? byId.size);
    if (items.length < ARCHIVED_PAGE_SIZE) break;
  }

  return [...byId.values()];
}
