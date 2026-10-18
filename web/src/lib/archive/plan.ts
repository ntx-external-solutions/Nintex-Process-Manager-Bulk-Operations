/**
 * What a Bulk Archive will do, built before anything is written.
 *
 * The operator approves this object on the preview screen, and the run walks exactly it.
 * Inputs are the resolved tree selection (lib/select/resolve.ts) and the tenant index
 * (lib/tenant/state.ts).
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { BrowseTree } from '../select/browse.ts';
import type { ExcludedItem, ResolvedProcess } from '../select/resolve.ts';
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
 *  - `set`: the tree reports `variationSetId`. Another process in a loaded level with the
 *    same set id that is not a target. Only sees levels the tree has read.
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
  /** Rows for processes the plan will not touch, so they are not lost from the results. */
  skipped: ResultRow[];
  excluded: ExcludedItem[];
  variations: VariationMatch[];
}

export const VARIATION_SEPARATOR = '::';

/** Ported from `Find-VariationMaster`. Names are not unique, so every match is reported. */
export function findVariationMasters(
  index: ProcessIndex,
  targets: readonly { uniqueId: string; name: string }[],
  separator: string = VARIATION_SEPARATOR,
): VariationMatch[] {
  const targetIds = new Set(targets.map((t) => t.uniqueId.toLowerCase()));
  const byName = new Map<string, Array<{ uniqueId: string; name: string; groupId: number | null; isArchived: boolean }>>();
  for (const entry of index.values()) {
    if (!entry.name) continue;
    const key = entry.name.trim().toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(entry);
    byName.set(key, list);
  }

  const found: VariationMatch[] = [];
  for (const target of targets) {
    const name = indexEntry(index, target.uniqueId)?.name || target.name;
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
      });
    }
  }
  return found;
}

/** Siblings by `variationSetId`, among the levels the tree has read. */
export function findVariationSiblings(
  tree: BrowseTree,
  index: ProcessIndex,
  targets: readonly ResolvedProcess[],
): VariationMatch[] {
  const targetIds = new Set(targets.map((t) => t.uniqueId.toLowerCase()));
  const bySet = new Map<number, Array<{ uniqueId: string; title: string }>>();
  for (const node of tree.nodes.values()) {
    if (node.kind !== 'process' || node.variationSetId === null) continue;
    const list = bySet.get(node.variationSetId) ?? [];
    if (!list.some((n) => n.uniqueId === node.uniqueId)) list.push({ uniqueId: node.uniqueId, title: node.title });
    bySet.set(node.variationSetId, list);
  }

  const found: VariationMatch[] = [];
  for (const target of targets) {
    if (target.variationSetId === null) continue;
    for (const sibling of bySet.get(target.variationSetId) ?? []) {
      if (targetIds.has(sibling.uniqueId.toLowerCase())) continue;
      const entry = indexEntry(index, sibling.uniqueId);
      found.push({
        targetUniqueId: target.uniqueId,
        targetName: target.title,
        relativeUniqueId: sibling.uniqueId,
        relativeName: entry?.name || sibling.title,
        relativeGroupId: entry?.groupId ?? null,
        relativeIsArchived: entry?.isArchived ?? null,
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
  resolved: { processes: readonly ResolvedProcess[]; excluded: readonly ExcludedItem[] },
  index: ProcessIndex,
  tree: BrowseTree,
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

  const live = resolved.processes.filter((p) => targets.some((t) => t.uniqueId === p.uniqueId));
  const variations = dedupeMatches([
    ...findVariationMasters(index, targets),
    ...findVariationSiblings(tree, index, live),
  ]);

  return { targets, skipped, excluded: [...resolved.excluded], variations };
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

export function variationMessage(m: VariationMatch): string {
  const why =
    m.signal === 'name'
      ? `master of target '${m.targetName}' by name`
      : `in the same variation set as target '${m.targetName}'`;
  return `Possibly ${why}, and not itself a target`;
}
