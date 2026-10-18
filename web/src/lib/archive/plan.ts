/**
 * What a Bulk Archive will do, built before anything is written.
 *
 * The operator approves this object on the preview screen, and the run walks exactly it.
 * Inputs are the resolved tree selection (lib/select/resolve.ts) and the tenant index
 * (lib/tenant/state.ts).
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { VariationSet } from '../pm/processes.ts';
import type { CoveredGroup, ExcludedItem, ResolvedProcess } from '../select/resolve.ts';
import { indexEntry, type ProcessIndex } from '../tenant/state.ts';

export interface ArchiveTarget {
  uniqueId: string;
  name: string;
  /** The group it sits in, from the tree. */
  groupUniqueId: string | null;
  groupId: number | null;
  path: string[];
  /** Neither listing returned it, so the final read will not be able to confirm it. */
  inIndex: boolean;
}

/**
 * A process that may be archived along with a target, without being one.
 *
 * Variations are coupled: acting on one can act on its master, and no field in the API
 * says so (API_ARCHITECTURE.md, "Process variations are coupled"). Two signals exist:
 *
 *  - `name`: the script's heuristic (`Find-VariationMaster`). A target named
 *    `<base>::<variant>` whose base name belongs to a process that is not a target.
 *    It had no false negatives on the only sample measured, a sample of five;
 *  - `set`: the target's `variationSetData` from the process GET names every sibling
 *    (API_ARCHITECTURE.md, "Variations", corrected 18 Oct 2026). Read for targets the
 *    tree marks with a `variationSetId`.
 */
export interface VariationMatch {
  targetUniqueId: string;
  targetName: string;
  relativeUniqueId: string;
  relativeName: string;
  relativeGroupId: number | null;
  relativeIsArchived: boolean | null;
  signal: 'name' | 'set';
}

export interface ArchivePlan {
  targets: ArchiveTarget[];
  /** Groups the selection covers, parents first: the candidates for cleanup afterwards. */
  groups: CoveredGroup[];
  /** Rows for processes the plan will not touch, so they are not lost from the results. */
  skipped: ResultRow[];
  excluded: ExcludedItem[];
  variations: VariationMatch[];
  /** Targets whose variation set could not be read, so their siblings are unknown. */
  unreadVariationSets: Array<{ uniqueId: string; name: string; error: string }>;
}

export const VARIATION_SEPARATOR = '::';

/** A name match, with what the delete engine's warning orders by (delete/collateral.ts). */
export interface NameVariationMatch extends VariationMatch {
  /** The target's name before the separator. */
  baseName: string;
  /** So a master in the target's own group can be listed first. */
  targetGroupId: number | null;
}

/** Ported from `Find-VariationMaster`. Names are not unique, so every match is reported. */
export function findVariationMasters(
  index: ProcessIndex | null,
  targets: readonly { uniqueId: string; name: string }[],
  separator: string = VARIATION_SEPARATOR,
): NameVariationMatch[] {
  if (!index) return [];
  const targetIds = new Set(targets.map((t) => t.uniqueId.toLowerCase()));
  const byName = new Map<string, Array<{ uniqueId: string; name: string; groupId: number | null; isArchived: boolean }>>();
  for (const entry of index.values()) {
    if (!entry.name) continue;
    const key = entry.name.trim().toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(entry);
    byName.set(key, list);
  }

  const found: NameVariationMatch[] = [];
  for (const target of targets) {
    const entry = indexEntry(index, target.uniqueId);
    const name = entry?.name || target.name;
    const at = name.indexOf(separator);
    if (at < 1) continue;
    const base = name.slice(0, at).trim();
    if (base === '') continue;

    for (const master of byName.get(base.toLowerCase()) ?? []) {
      // A master that is itself a target is not a surprise.
      if (targetIds.has(master.uniqueId.toLowerCase())) continue;
      found.push({
        targetUniqueId: target.uniqueId,
        targetName: name,
        relativeUniqueId: master.uniqueId,
        relativeName: master.name,
        relativeGroupId: master.groupId,
        relativeIsArchived: master.isArchived,
        signal: 'name',
        baseName: base,
        targetGroupId: entry?.groupId ?? null,
      });
    }
  }
  return found;
}

/**
 * Siblings named by each target's `variationSetData`, read at planning time.
 *
 * Siblings are not in the tree (the tree shows one node per set), so this is the only
 * way to name them before the run. Archived siblings are listed too: they are not at
 * risk of being archived, but an operator archiving one variation should know the set
 * has others.
 */
export function findVariationSiblings(
  index: ProcessIndex,
  targets: readonly { uniqueId: string; name: string }[],
  sets: ReadonlyMap<string, VariationSet>,
): VariationMatch[] {
  const targetIds = new Set(targets.map((t) => t.uniqueId.toLowerCase()));
  const found: VariationMatch[] = [];
  for (const target of targets) {
    const set = sets.get(target.uniqueId.toLowerCase());
    if (!set) continue;
    for (const sibling of set.others) {
      if (targetIds.has(sibling.uniqueId.toLowerCase())) continue;
      const entry = indexEntry(index, sibling.uniqueId);
      found.push({
        targetUniqueId: target.uniqueId,
        targetName: target.name,
        relativeUniqueId: sibling.uniqueId,
        relativeName:
          entry?.name || [set.name, sibling.variationName].filter((part) => part !== '').join(' :: '),
        relativeGroupId: entry?.groupId ?? set.group?.id ?? null,
        relativeIsArchived: entry?.isArchived ?? sibling.isArchived,
        signal: 'set',
      });
    }
  }
  return found;
}

/** One warning per target and relative, whichever signal found it first. */
function dedupeMatches(matches: readonly VariationMatch[]): VariationMatch[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const key = `${m.targetUniqueId.toLowerCase()}|${m.relativeUniqueId.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildArchivePlan(
  resolved: {
    processes: readonly ResolvedProcess[];
    excluded: readonly ExcludedItem[];
    groups?: readonly CoveredGroup[];
  },
  index: ProcessIndex,
  variationSets: ReadonlyMap<string, VariationSet> = new Map(),
  unreadVariationSets: ReadonlyMap<string, string> = new Map(),
): ArchivePlan {
  const targets: ArchiveTarget[] = [];
  const skipped: ResultRow[] = [];

  for (const process of resolved.processes) {
    const entry = indexEntry(index, process.uniqueId);
    if (entry?.isArchived) {
      skipped.push(
        resultRow({
          objectId: process.uniqueId,
          name: entry.name || process.title,
          operation: 'Archive',
          status: 'Skipped',
          message: 'Already archived',
          groupId: entry.groupId,
        }),
      );
      continue;
    }
    targets.push({
      uniqueId: process.uniqueId,
      name: entry?.name || process.title,
      groupUniqueId: process.groupUniqueId,
      groupId: entry?.groupId ?? process.groupId,
      path: process.path,
      inIndex: entry !== null,
    });
  }

  for (const item of resolved.excluded) {
    if (item.itemType === 'documentgroup') continue;
    skipped.push(
      resultRow({
        objectId: item.uniqueId,
        name: item.title,
        operation: 'Select',
        status: 'Skipped',
        message: item.reason,
      }),
    );
  }

  const variations = dedupeMatches([
    ...findVariationSiblings(index, targets, variationSets),
    ...findVariationMasters(index, targets),
  ]);

  return {
    targets,
    groups: [...(resolved.groups ?? [])],
    skipped,
    excluded: [...resolved.excluded],
    variations,
    unreadVariationSets: targets
      .filter((t) => unreadVariationSets.has(t.uniqueId.toLowerCase()))
      .map((t) => ({ uniqueId: t.uniqueId, name: t.name, error: unreadVariationSets.get(t.uniqueId.toLowerCase()) ?? '' })),
  };
}

/** "Finance / Accounts Payable", or the group id when the path is not known. */
export function describeGroup(target: Pick<ArchiveTarget, 'path' | 'groupId'>): string {
  if (target.path.length > 0) return target.path.join(' / ');
  return target.groupId === null ? 'the top level' : `group ${target.groupId}`;
}

/** The dry run's results file: what would happen, with nothing changed. */
export function previewRows(plan: ArchivePlan): ResultRow[] {
  return [
    ...plan.targets.map((t) =>
      resultRow({
        objectId: t.uniqueId,
        name: t.name,
        operation: 'Archive',
        status: 'Preview',
        message: `Would archive from ${describeGroup(t)}`,
        groupId: t.groupId,
      }),
    ),
    ...plan.variations.map((m) =>
      resultRow({
        objectId: m.relativeUniqueId,
        name: m.relativeName,
        operation: 'VariationWarning',
        status: 'Preview',
        message: variationMessage(m),
        groupId: m.relativeGroupId,
      }),
    ),
    ...plan.skipped,
  ];
}

/**
 * Why a dragged-in master matters beyond this run, in the script's words
 * (`Invoke-BulkArchiveProcesses`): once archived it is an ordinary member of the archived
 * list, and Bulk Delete takes its targets from that list, so a master nobody named can
 * end up in front of a delete. Restored to the warning by F3.
 */
export const VARIATION_ARCHIVE_LIST_NOTE =
  'A master archived this way ends up in the archived list like any other process, and that list is where a later Bulk Delete takes its targets from. Check the archived list after the run, before deleting from it.';

export function variationMessage(m: VariationMatch): string {
  return m.signal === 'name'
    ? `Possibly the master of target '${m.targetName}', going by its name, and not itself a target`
    : `In the same variation set as target '${m.targetName}', and not itself a target`;
}

/** Targets whose variation set should be read: the tree marks them with a set id. */
export function targetsInVariationSets(resolved: readonly ResolvedProcess[]): string[] {
  return resolved.filter((p) => p.variationSetId !== null).map((p) => p.uniqueId);
}
