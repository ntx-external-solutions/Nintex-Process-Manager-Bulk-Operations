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
 * archived view's own bucket, once the model check has confirmed it (groups.ts).
 */

import { findVariationMasters, findVariationSiblings, type VariationMatch } from '../archive/plan.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import type { Placement } from '../plan/revalidate.ts';
import type { VariationSet } from '../pm/processes.ts';
import type { ModelGroup } from './groups.ts';
import type { DependencyPlan, DraftHolder } from './ledger.ts';
import { planProcessName } from './planner.ts';
import type { CoveredGroup, Resolution } from '../select/resolve.ts';
import type { IndexEntry } from '../tenant/state.ts';
import type { DeleteIndex, DeleteIndexEntry } from './model.ts';
import { resolveTargetIds } from './targets.ts';

export type DeletePhase = 'archive-then-delete' | 'delete';

/** How a target got into the selection. */
export type DeleteSourceKind = 'tree' | 'group' | 'archived' | 'ids' | 'variation';

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
  /**
   * Archived processes the listing called orphaned whose model names a group the tree
   * has, keyed by lower-case process id (`confirmArchivedOrphans`). Each is placed in
   * that group, so a checked group takes it in like any other.
   */
  corrections?: ReadonlyMap<string, ModelGroup> | undefined;
}

const lower = (value: string) => value.toLowerCase();

export function resolveDeleteSelection(input: DeleteSelectionInput): DeleteSelection {
  const index = corrected(input.index, input.corrections);
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

/** The index with each overturned orphan placed in the group its model names. */
function corrected(index: DeleteIndex, corrections: DeleteSelectionInput['corrections']): DeleteIndex {
  if (!corrections || corrections.size === 0) return index;
  const out = new Map<string, DeleteIndexEntry>(index);
  for (const [key, group] of corrections) {
    const entry = out.get(key);
    if (entry) out.set(key, { ...entry, groupExists: true, groupId: group.id, groupUniqueId: group.uniqueId, groupName: group.name || entry.groupName });
  }
  return out;
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
 * deleted nothing from, or one nobody checked, from being offered at all (W6). Delete
 * documents (W8b) passes its documents as the targets, with their primary group.
 */
export function groupsTheRunDeletedFrom(
  selection: { groups: readonly CoveredGroup[]; targets: ReadonlyArray<{ uniqueId: string; groupUniqueId: string | null }> },
  deletedUniqueIds: Iterable<string>,
  holdingGroupUniqueId: string | null = null,
): CoveredGroup[] {
  // Never the holding group, even one an earlier run left behind and somebody checked:
  // the engine removes its own, and offering it here would race that (W6).
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
  return selection.groups.filter((g) => hit.has(lower(g.uniqueId)) && (!holdingGroupUniqueId || lower(g.uniqueId) !== lower(holdingGroupUniqueId)));
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

// ---------------------------------------------------------------- variation sets (W6)

export interface VariationSetMember {
  uniqueId: string;
  name: string;
  isArchived: boolean;
  /** In the selection before this decision. */
  selected: boolean;
}

export interface VariationSetReview {
  setId: number;
  name: string;
  /** Every variation in the set, the selected ones first, each named in the preview. */
  members: VariationSetMember[];
  /** Every member was selected already, so there is nothing to decide. */
  whole: boolean;
  /** Partial, and the operator ticked it in: the members not selected are now targets. */
  included: boolean;
}

/**
 * Deletes a variation set whole or not at all. R3 showed that deleting a variation can
 * archive its master, and the collateral checkpoint after the delete has never fired
 * live, so by default a target whose set is not entirely in the selection is left out,
 * with a row saying which siblings are missing. A set the operator ticks (`include`, by
 * set id) is pulled in whole instead. Sets are read from each tree target's
 * `variationSetData`, keyed by the target's lower-case id.
 */
export function applyVariationSets(
  selection: DeleteSelection,
  index: DeleteIndex,
  sets: ReadonlyMap<string, VariationSet>,
  include: ReadonlySet<number> = new Set(),
): { selection: DeleteSelection; reviews: VariationSetReview[] } {
  const selected = new Set(selection.targets.map((t) => lower(t.uniqueId)));
  const drop = new Set<string>();
  const added: DeleteTarget[] = [];
  const skipped: ResultRow[] = [];
  const reviews: VariationSetReview[] = [];
  const decided = new Set<number>();

  for (const target of selection.targets) {
    const set = sets.get(lower(target.uniqueId));
    if (!set || decided.has(set.id)) continue;
    decided.add(set.id);

    const members: VariationSetMember[] = [];
    const named = new Set<string>();
    const addMember = (uniqueId: string, fallbackName: string, isArchived: boolean) => {
      if (named.has(lower(uniqueId))) return;
      named.add(lower(uniqueId));
      const entry = index.get(lower(uniqueId));
      members.push({ uniqueId, name: entry?.name || fallbackName || uniqueId, isArchived: entry?.isArchived ?? isArchived, selected: selected.has(lower(uniqueId)) });
    };
    addMember(target.uniqueId, target.name, target.isArchived);
    for (const other of set.others) addMember(other.uniqueId, [set.name, other.variationName].filter((part) => part !== '').join(' :: '), other.isArchived === true);
    members.sort((a, b) => Number(b.selected) - Number(a.selected) || a.name.localeCompare(b.name));

    const missing = members.filter((m) => !m.selected);
    const whole = missing.length === 0;
    const included = !whole && include.has(set.id);
    reviews.push({ setId: set.id, name: set.name, members, whole, included });
    if (whole) continue;

    if (included) {
      for (const m of missing) {
        const entry = index.get(lower(m.uniqueId));
        added.push({
          uniqueId: entry?.uniqueId ?? m.uniqueId,
          name: m.name,
          isArchived: m.isArchived,
          phase: m.isArchived ? 'delete' : 'archive-then-delete',
          source: 'variation',
          groupUniqueId: entry?.groupUniqueId ?? set.group?.uniqueId ?? null,
          groupId: entry?.groupId ?? set.group?.id ?? null,
          location: entry?.groupExists === false ? '' : entry?.groupName || set.group?.name || '',
          groupExists: entry?.groupExists ?? true,
        });
      }
      continue;
    }

    const names = missing.map((m) => `'${m.name}'`).join(', ');
    for (const m of members.filter((x) => x.selected)) {
      drop.add(lower(m.uniqueId));
      skipped.push(
        resultRow({
          objectId: m.uniqueId,
          name: m.name,
          operation: 'Select',
          status: 'Skipped',
          message:
            `Not deleted: a variation in set '${set.name}', and ${names} in the same set ${missing.length === 1 ? 'is' : 'are'} not selected. ` +
            'Deleting one variation can archive its master, so a set is deleted whole or not at all. Tick the set in the plan to delete it whole.',
        }),
      );
    }
  }

  return {
    selection: {
      ...selection,
      targets: [...selection.targets.filter((t) => !drop.has(lower(t.uniqueId))), ...added],
      skipped: [...selection.skipped, ...skipped],
    },
    reviews,
  };
}

// ---------------------------------------------------------------- holders in the preview (W6)

export interface HolderPreview {
  /** Holders whose references to the targets will be removed, one save and publish each. */
  edited: Array<{ uniqueId: string; name: string; sites: number }>;
  /** Holders with an open draft: skipped unless ticked when the run asks. */
  skipped: Array<DraftHolder & { displayName: string }>;
  /** Targets a skipped holder keeps, each with the first holder keeping it. */
  heldBack: Array<{ uniqueId: string; name: string; holderUniqueId: string; holderName: string }>;
}

/**
 * The holders the plan will edit, the ones it will skip for an open draft (unticked, as
 * the run's own question starts), and the targets held back because of them. The run
 * reads every holder again before editing, so this is the plan's view, not a promise.
 */
export function previewHolders(plan: DependencyPlan, index: DeleteIndex | null): HolderPreview {
  const drafts = plan.draftHolders ?? [];
  const draftIds = new Set(drafts.map((d) => lower(d.holderUniqueId)));
  const name = (id: string) => planProcessName(plan, index, id);
  const heldBack: HolderPreview['heldBack'] = [];
  const held = new Set<string>();
  for (const d of drafts) {
    for (const t of d.targetsBlocked) {
      if (held.has(lower(t))) continue;
      held.add(lower(t));
      heldBack.push({ uniqueId: t, name: name(t), holderUniqueId: d.holderUniqueId, holderName: d.name || name(d.holderUniqueId) });
    }
  }
  return {
    edited: plan.workItems
      .filter((w) => !draftIds.has(lower(w.holderUniqueId)))
      .map((w) => ({ uniqueId: w.holderUniqueId, name: name(w.holderUniqueId), sites: w.sites.length })),
    skipped: drafts.map((d) => ({ ...d, displayName: d.name || name(d.holderUniqueId) })),
    heldBack,
  };
}

/**
 * The holder count for the plan summary. R15: the summary said "2 process(es) to edit"
 * over a Holders panel showing 1 to edit and 1 skipped for an open draft, because the
 * plan's work items include the draft holders the run will not edit unless ticked.
 */
export function holderCountLine(holders: Pick<HolderPreview, 'edited' | 'skipped'>): string {
  const edited = holders.edited.length;
  const skipped = holders.skipped.length;
  const noun = (n: number) => (n === 1 ? 'holder' : 'holders');
  if (skipped === 0) return `${edited} ${noun(edited)} to edit`;
  return `${edited + skipped} ${noun(edited + skipped)}: ${edited} to edit, ${skipped} skipped (open draft)`;
}

/**
 * What the run re-reads before its first write (plan/revalidate.ts): every checked group
 * in its parent, and every target picked from the tree in its group. Archived targets
 * are not in the tree, and the engine reads both process lists again for them.
 */
export function deletePlacements(selection: Pick<DeleteSelection, 'groups' | 'targets'>): Placement[] {
  const placements: Placement[] = selection.groups.map((g) => ({
    uniqueId: g.uniqueId,
    parentUniqueId: g.parentUniqueId,
    display: g.title,
    parentDisplay: g.path.length > 0 ? g.path.join(' / ') : 'the top level',
  }));
  for (const t of selection.targets) {
    if (t.source !== 'tree' || !t.groupUniqueId) continue;
    placements.push({ uniqueId: t.uniqueId, parentUniqueId: t.groupUniqueId, display: t.name, parentDisplay: t.location || 'its group' });
  }
  return placements;
}
