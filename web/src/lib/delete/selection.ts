/**
 * What a Bulk Delete is asked to delete, from its ways in (W6): the tree, the archived
 * view, and a list of ids.
 *
 * Delete by group is the case that kept hitting dead ends (SPEC-WEB, "Bulk Delete"). A
 * checked group means every process in its subtree, active ones from the tree, plus
 * every archived process whose group is in that subtree, which the tree never shows. The
 * archived ones come from the listing, so the selection is resolved against the index
 * read at planning time, not against what was on screen.
 *
 * An active target is archived before it is deleted (decision 2 in the spec), so each
 * target carries the phase it goes through, and the preview shows the two phases apart.
 * An orphan (its group is gone) can't be under a checked group; it is picked from the
 * archived view's own bucket.
 */

import { findVariationMasters, findVariationSiblings, type VariationMatch } from '../archive/plan.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import type { VariationSet } from '../pm/processes.ts';
import type { CoveredGroup, Resolution } from '../select/resolve.ts';
import type { IndexEntry } from '../tenant/state.ts';
import type { DeleteIndex } from './model.ts';
import { resolveTargetIds } from './targets.ts';

export type DeletePhase = 'archive-then-delete' | 'delete';

/** How a target got into the selection. */
export type DeleteSourceKind = 'tree' | 'group' | 'archived' | 'ids';

export interface DeleteTarget {
  uniqueId: string;
  name: string;
  isArchived: boolean;
  phase: DeletePhase;
  source: DeleteSourceKind;
  groupUniqueId: string | null;
  groupId: number | null;
  /** The group it is in, or was archived from, as a path. Empty when not known. */
  location: string;
  /** False only when the listing said its group is gone. */
  groupExists: boolean;
}

export interface DeleteSelection {
  targets: DeleteTarget[];
  /** Groups checked in the tree, parents first: the only candidates for cleanup afterwards. */
  groups: CoveredGroup[];
  /** Rows for what was selected and will not be deleted, so the results file keeps them. */
  skipped: ResultRow[];
}

export interface DeleteSelectionInput {
  /** The tree selection, resolved with every level it needs read. */
  tree?: Extract<Resolution, { status: 'complete' }> | null | undefined;
  /** Process ids ticked in the archived view. */
  archived?: Iterable<string> | undefined;
  /** Ids typed or read from a CSV. */
  ids?: readonly string[] | undefined;
  index: DeleteIndex;
  /**
   * A group's full path, where the caller has read it (the archived view's breadcrumbs).
   * Listing rows name only the immediate group (spike S3).
   */
  groupPath?: ((groupUniqueId: string) => string | null) | undefined;
}

const lower = (value: string) => value.toLowerCase();

export function resolveDeleteSelection(input: DeleteSelectionInput): DeleteSelection {
  const { index } = input;
  const targets: DeleteTarget[] = [];
  const skipped: ResultRow[] = [];
  const seen = new Set<string>();
  const groups = [...(input.tree?.groups ?? [])];

  const add = (target: Omit<DeleteTarget, 'phase'>) => {
    if (seen.has(lower(target.uniqueId))) return;
    seen.add(lower(target.uniqueId));
    targets.push({ ...target, phase: target.isArchived ? 'delete' : 'archive-then-delete' });
  };

  for (const process of input.tree?.processes ?? []) {
    const entry = index.get(lower(process.uniqueId));
    add({
      uniqueId: process.uniqueId,
      name: entry?.name || process.title,
      isArchived: entry?.isArchived ?? false,
      source: 'tree',
      groupUniqueId: process.groupUniqueId,
      groupId: entry?.groupId ?? process.groupId,
      location: process.path.join(' / '),
      groupExists: true,
    });
  }

  // The archived half of delete by group. Matched on the group's UniqueId, or its numeric
  // id where a row carries no UniqueId; a row whose group is gone matches neither.
  const byUniqueId = new Map(groups.map((g) => [lower(g.uniqueId), g]));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const archivedInGroups: Array<{ entry: IndexEntry; group: CoveredGroup }> = [];
  for (const entry of index.values()) {
    if (!entry.isArchived || !entry.groupExists) continue;
    const group = (entry.groupUniqueId ? byUniqueId.get(lower(entry.groupUniqueId)) : undefined) ?? (entry.groupId !== null ? byId.get(entry.groupId) : undefined);
    if (group) archivedInGroups.push({ entry, group });
  }
  archivedInGroups.sort((a, b) => groupLabel(a.group).localeCompare(groupLabel(b.group)) || a.entry.name.localeCompare(b.entry.name));
  for (const { entry, group } of archivedInGroups) {
    add({
      uniqueId: entry.uniqueId,
      name: entry.name,
      isArchived: true,
      source: 'group',
      groupUniqueId: group.uniqueId,
      groupId: group.id,
      location: groupLabel(group),
      groupExists: true,
    });
  }

  for (const id of input.archived ?? []) {
    const entry = index.get(lower(id));
    if (!entry) {
      skipped.push(resultRow({ objectId: id, operation: 'Resolve', status: 'Skipped', message: 'Ticked in the archived view, but neither process list returns it now' }));
      continue;
    }
    add(fromIndex(entry, 'archived', input.groupPath));
  }

  if (input.ids && input.ids.length > 0) {
    const resolved = resolveTargetIds(input.ids, index);
    for (const uniqueId of resolved.uniqueIds) {
      const entry = index.get(lower(uniqueId));
      if (entry) add(fromIndex(entry, 'ids', input.groupPath));
    }
    for (const id of resolved.unknown) {
      skipped.push(resultRow({ objectId: id, operation: 'Resolve', status: 'Skipped', message: 'Process not found in active or archived lists' }));
    }
  }

  for (const item of input.tree?.excluded ?? []) {
    if (item.itemType === 'documentgroup') continue;
    skipped.push(resultRow({ objectId: item.uniqueId, name: item.title, operation: 'Select', status: 'Skipped', message: item.reason }));
  }

  return { targets, groups, skipped };
}

function fromIndex(entry: IndexEntry, source: DeleteSourceKind, groupPath: DeleteSelectionInput['groupPath']): Omit<DeleteTarget, 'phase'> {
  const path = entry.groupExists && entry.groupUniqueId ? groupPath?.(entry.groupUniqueId) : null;
  return {
    uniqueId: entry.uniqueId,
    name: entry.name,
    isArchived: entry.isArchived,
    source,
    groupUniqueId: entry.groupUniqueId,
    groupId: entry.groupId,
    location: entry.groupExists ? path || entry.groupName : '',
    groupExists: entry.groupExists,
  };
}

function groupLabel(group: CoveredGroup): string {
  return [...group.path, group.title].join(' / ');
}

/** The ids the run is given. The engine resolves them again against its own fresh read. */
export function selectionIds(selection: DeleteSelection): string[] {
  return selection.targets.map((t) => t.uniqueId);
}

/**
 * The groups a finished run may offer to delete: checked in the tree, and either the
 * group a deleted target was in or a checked group above one. Whether each is now empty
 * is for the cleanup's own reads to decide (lib/cleanup); this only keeps a group the run
 * deleted nothing from, or one nobody checked, from being offered at all (W6).
 */
export function groupsTheRunDeletedFrom(
  selection: Pick<DeleteSelection, 'groups' | 'targets'>,
  deletedUniqueIds: Iterable<string>,
): CoveredGroup[] {
  const covered = new Map(selection.groups.map((g) => [lower(g.uniqueId), g]));
  const deleted = new Set([...deletedUniqueIds].map(lower));
  const hit = new Set<string>();
  for (const target of selection.targets) {
    if (!deleted.has(lower(target.uniqueId)) || !target.groupUniqueId) continue;
    let group = covered.get(lower(target.groupUniqueId));
    for (let hops = 0; group && hops <= 64 && !hit.has(lower(group.uniqueId)); hops++) {
      hit.add(lower(group.uniqueId));
      group = group.parentUniqueId ? covered.get(lower(group.parentUniqueId)) : undefined;
    }
  }
  return selection.groups.filter((g) => hit.has(lower(g.uniqueId)));
}

/** The preview's count line: how many go through each phase. */
export function selectionSummary(selection: DeleteSelection): string {
  const active = selection.targets.filter((t) => t.phase === 'archive-then-delete').length;
  const archived = selection.targets.length - active;
  const inGroups = selection.targets.filter((t) => t.source === 'group').length;
  const parts = [`${selection.targets.length} process(es) to delete: ${active} active, archived first; ${archived} already archived`];
  if (inGroups > 0) parts.push(`${inGroups} archived process(es) come from the checked groups, which the tree does not show`);
  return `${parts.join('. ')}.`;
}

/**
 * Processes that may go with a target without being one, for the preview (Cowork's
 * review of W5 phase 7): every sibling in a target's variation set, read from the
 * process because siblings are not in the tree, and the script's name match for a
 * master. Archive's two signals, one warning per target and relative. The run's own
 * variation pre-flight and collateral checkpoints stay as the backstop.
 */
export function deleteVariations(
  index: DeleteIndex,
  targets: readonly Pick<DeleteTarget, 'uniqueId' | 'name'>[],
  sets: ReadonlyMap<string, VariationSet>,
): VariationMatch[] {
  const seen = new Set<string>();
  return [...findVariationSiblings(index, targets, sets), ...findVariationMasters(index, targets)].filter((m) => {
    const key = `${lower(m.targetUniqueId)}|${lower(m.relativeUniqueId)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
