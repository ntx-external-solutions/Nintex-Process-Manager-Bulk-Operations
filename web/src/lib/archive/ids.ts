/**
 * Bulk Archive by id or CSV (W7): the ids the operator brought, resolved against the
 * index Archive already loads, so they can join the tree's targets.
 *
 * Resolution is in memory. The only calls are one breadcrumb per distinct group (for the
 * path the plan shows, as the archived view does), one tree read per distinct group (to
 * see which targets are variations), and a variation-set read for each target that is
 * one or that its group's level does not show.
 *
 * - An active process is a target.
 * - An archived one is not: `Select` `Skipped`, "Already archived".
 * - An id neither listing returns, or a value that is not an id: `Resolve` `Skipped`.
 * - A shortcut's id is its home process's id, so it resolves to the home process.
 *
 * Ids never make a group a cleanup candidate. Only groups checked in the tree are offered
 * after the run, even if the ids emptied one.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { StaleFinding } from '../plan/revalidate.ts';
import type { TreeItem } from '../pm/types.ts';
import { looksLikeId } from '../select/ids.ts';
import type { CoveredGroup, ExcludedItem, ResolvedProcess } from '../select/resolve.ts';
import type { IndexEntry, ProcessIndex } from '../tenant/state.ts';

export const CHOSEN_FROM_TREE = 'From the tree';
export const CHOSEN_BY_ID = 'By id';

/** A target and how the operator chose it, for the plan's "Chosen" column. */
export type PickedProcess = ResolvedProcess & { chosen: string };

export interface ArchiveIdResolution {
  /** Active processes, each once, in the order first given. Paths are filled by `withGroupPaths`. */
  processes: PickedProcess[];
  /** `Select` rows for archived processes, `Resolve` rows for ids that matched nothing. */
  skipped: ResultRow[];
  /** The values that matched no process, as typed. */
  unknown: string[];
}

export const NOT_AN_ID = 'Not a process id. Ids are GUIDs, or the number the process list gives a process';
export const NOT_FOUND = 'Process not found in active or archived lists';
export const ALREADY_ARCHIVED = 'Already archived';

/**
 * `chosenOf` labels a raw value: "By id", or "From <file name>" for an id the uploaded file
 * supplied.
 */
export function resolveArchiveIds(
  raw: readonly string[],
  index: ProcessIndex,
  chosenOf: (value: string) => string = () => CHOSEN_BY_ID,
): ArchiveIdResolution {
  const byNumber = new Map<number, IndexEntry>();
  for (const entry of index.values()) if (entry.numericId != null) byNumber.set(entry.numericId, entry);

  const processes: PickedProcess[] = [];
  const skipped: ResultRow[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const value of raw.map((v) => v.trim()).filter((v) => v !== '')) {
    if (!looksLikeId(value)) {
      unknown.push(value);
      skipped.push(resultRow({ objectId: value, operation: 'Resolve', status: 'Skipped', message: NOT_AN_ID }));
      continue;
    }
    const entry = /^\d+$/.test(value) ? byNumber.get(Number(value)) : index.get(value.toLowerCase());
    if (!entry) {
      if (seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      unknown.push(value);
      skipped.push(resultRow({ objectId: value, operation: 'Resolve', status: 'Skipped', message: NOT_FOUND }));
      continue;
    }
    const key = entry.uniqueId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.isArchived) {
      skipped.push(
        resultRow({ objectId: entry.uniqueId, name: entry.name, operation: 'Select', status: 'Skipped', message: ALREADY_ARCHIVED, groupId: entry.groupId }),
      );
      continue;
    }
    processes.push({
      uniqueId: entry.uniqueId,
      id: entry.numericId ?? 0,
      title: entry.name,
      itemType: 'process',
      groupUniqueId: entry.groupUniqueId,
      groupId: entry.groupId,
      // Until the breadcrumb is read: the listing's own group name, as the archived view starts.
      path: entry.groupName ? [entry.groupName] : [],
      variationSetId: null,
      chosen: chosenOf(value),
    });
  }

  return { processes, skipped, unknown };
}

/** The groups whose breadcrumb and level the ids need, each once. */
export function groupsOfPicked(processes: readonly PickedProcess[]): string[] {
  return [...new Set(processes.map((p) => p.groupUniqueId).filter((g): g is string => g !== null))];
}

/** Each target's path from its group's breadcrumb. A group whose path could not be read keeps the listing's name. */
export function withGroupPaths(processes: readonly PickedProcess[], paths: ReadonlyMap<string, string[]>): PickedProcess[] {
  return processes.map((p) => {
    const path = p.groupUniqueId ? paths.get(p.groupUniqueId) : undefined;
    return path && path.length > 0 ? { ...p, path } : p;
  });
}

/**
 * Which id targets need their variation set read, from one tree read per group.
 *
 * Cheaper than one process GET per target, and as complete. The tree shows one node per
 * variation set and gives it a `variationSetId`, which is all a tree target is judged by.
 * So a target shown with a set id is read, as a tree target would be; one shown with none
 * is not in a set; and one its group's level does not show (a variation other than the one
 * the tree shows, or a level that could not be read) is read, because nothing else says.
 */
export function idTargetsNeedingSetReads(
  processes: readonly PickedProcess[],
  levels: ReadonlyMap<string, readonly TreeItem[] | null>,
): string[] {
  const out: string[] = [];
  for (const p of processes) {
    const level = p.groupUniqueId ? levels.get(p.groupUniqueId) : null;
    const node = level?.find((item) => item.uniqueId.toLowerCase() === p.uniqueId.toLowerCase());
    if (!node || node.variationSetId !== null) out.push(p.uniqueId);
  }
  return out;
}

export interface CombinedSelection {
  processes: PickedProcess[];
  excluded: ExcludedItem[];
  /** The tree's covered groups only: ids never make a group a cleanup candidate. */
  groups: CoveredGroup[];
  skipped: ResultRow[];
}

/** The tree's targets and the ids', each process once. The tree's placement wins. */
export function combineSelections(
  tree: { processes: readonly ResolvedProcess[]; excluded: readonly ExcludedItem[]; groups: readonly CoveredGroup[] } | null,
  ids: ArchiveIdResolution | null,
): CombinedSelection {
  const processes: PickedProcess[] = (tree?.processes ?? []).map((p) => ({ ...p, chosen: CHOSEN_FROM_TREE }));
  const seen = new Set(processes.map((p) => p.uniqueId.toLowerCase()));
  for (const p of ids?.processes ?? []) {
    if (seen.has(p.uniqueId.toLowerCase())) continue;
    seen.add(p.uniqueId.toLowerCase());
    processes.push(p);
  }
  return { processes, excluded: [...(tree?.excluded ?? [])], groups: [...(tree?.groups ?? [])], skipped: [...(ids?.skipped ?? [])] };
}

/**
 * The id targets checked against the fresh read taken just before the first write: still
 * active, still in the group the plan showed. The tree targets are checked by their tree
 * level (plan/revalidate.ts); the id targets are too when their group is known, and this
 * catches what a level read cannot say, such as a process archived since.
 */
export function idTargetFindings(
  targets: readonly { uniqueId: string; name: string; groupId: number | null; chosen?: string | undefined; path: string[] }[],
  baseline: ProcessIndex,
): StaleFinding[] {
  const findings: StaleFinding[] = [];
  for (const t of targets) {
    if (t.chosen === undefined || t.chosen === CHOSEN_FROM_TREE) continue;
    const now = baseline.get(t.uniqueId.toLowerCase());
    const where = t.path.length > 0 ? t.path.join(' / ') : t.groupId === null ? 'its group' : `group ${t.groupId}`;
    let message: string | null = null;
    if (!now) message = `"${t.name}" is in neither process list any more. Somebody may have deleted it since this plan was built.`;
    else if (now.isArchived) message = `"${t.name}" has been archived since this plan was built.`;
    else if (now.groupId !== t.groupId) message = `"${t.name}" is not in ${where} any more. Somebody has moved it since this plan was built.`;
    if (message) findings.push({ uniqueId: t.uniqueId, display: t.name, message: `${message} Plan again from the current lists.` });
  }
  return findings;
}

/**
 * One tree level per group, a few at a time. A level that cannot be read is null, which
 * `idTargetsNeedingSetReads` answers by reading each of its targets' sets.
 */
export async function readGroupLevels(
  groupUniqueIds: readonly string[],
  readLevel: (groupUniqueId: string) => Promise<readonly TreeItem[]>,
  options: { concurrency?: number; isFatal?: (error: unknown) => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, readonly TreeItem[] | null>> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const levels = new Map<string, readonly TreeItem[] | null>();
  for (let i = 0; i < groupUniqueIds.length; i += concurrency) {
    await Promise.all(
      groupUniqueIds.slice(i, i + concurrency).map(async (id) => {
        try {
          levels.set(id, await readLevel(id));
        } catch (error) {
          if (options.isFatal?.(error)) throw error;
          levels.set(id, null);
        }
      }),
    );
    options.onProgress?.(levels.size, groupUniqueIds.length);
  }
  return levels;
}

/** Above this many ids the page says how many and asks before building the plan (W7). */
export const LARGE_ID_LIST = 500;
