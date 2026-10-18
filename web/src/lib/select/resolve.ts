/**
 * Turning a selection into the list of processes a plan will act on.
 *
 * `resolveSelection` is pure. It never guesses about a level it has not seen: if a
 * checked group, or a group with something checked inside it, has not had its children
 * read, it says which groups it needs and returns nothing else. `loadForSelection` reads
 * those levels and asks again until the answer is complete. So a checked group always
 * resolves to everything under it as of planning time, never to what was expanded.
 */

import type { PlanGateway } from '../plan/load.ts';
import { addBrowseLevel, childrenOf, groupPathOf, type BrowseNode, type BrowseTree } from './browse.ts';
import { effectiveMark, type Selection } from './selection.ts';

export interface ResolvedProcess {
  uniqueId: string;
  id: number;
  title: string;
  itemType: string;
  /** The group the process was found in. */
  groupUniqueId: string | null;
  groupId: number | null;
  /** Titles of the groups above it, top first. */
  path: string[];
  variationSetId: number | null;
}

/** A group the selection covers: checked itself, or inside a checked group. */
export interface CoveredGroup {
  uniqueId: string;
  id: number;
  title: string;
  parentUniqueId: string | null;
  /** Titles of the groups above it, top first. */
  path: string[];
  /** 0 at the top level. */
  depth: number;
}

export interface ExcludedItem {
  uniqueId: string;
  title: string;
  itemType: string;
  path: string[];
  reason: string;
}

export type Resolution =
  | {
      status: 'complete';
      processes: ResolvedProcess[];
      excluded: ExcludedItem[];
      /** Parents before children. Folder cleanup after Archive picks from these. */
      groups: CoveredGroup[];
    }
  /** Group ids whose children must be read before the selection can be resolved. */
  | { status: 'incomplete'; unloaded: string[] };

/** True when any mark at or below this group is `include`. */
function includesAnythingBelow(tree: BrowseTree, selection: Selection, group: BrowseNode): boolean {
  if (effectiveMark(tree, selection, group) === 'include') return true;
  for (const [key, mark] of selection) {
    if (mark !== 'include') continue;
    let current = tree.nodes.get(key);
    for (let hops = 0; current && hops <= 64; hops++) {
      if (current.key === group.key) return true;
      current = current.parentUniqueId === null ? undefined : tree.nodes.get(current.parentUniqueId);
    }
  }
  return false;
}

export function resolveSelection(tree: BrowseTree, selection: Selection): Resolution {
  if (tree.roots === null) return { status: 'incomplete', unloaded: [] };

  const processes: ResolvedProcess[] = [];
  const excluded: ExcludedItem[] = [];
  const unloaded: string[] = [];
  const groups: CoveredGroup[] = [];
  /** First placement of each process, so a second appearance can say where the first was. */
  const seen = new Map<string, string[]>();

  const visit = (node: BrowseNode): void => {
    if (node.kind === 'group') {
      if (!includesAnythingBelow(tree, selection, node)) return;
      if (effectiveMark(tree, selection, node) === 'include') {
        const path = groupPathOf(tree, node);
        groups.push({
          uniqueId: node.uniqueId,
          id: node.id,
          title: node.title,
          parentUniqueId: node.parentUniqueId,
          path,
          depth: path.length,
        });
      }
      if (!node.childrenLoaded) {
        // Even when the server says hasChild is false: that flag has not been shown to
        // count processes as well as subgroups, and reading one empty level is cheap.
        unloaded.push(node.uniqueId);
        return;
      }
      for (const child of childrenOf(tree, node.key)) visit(child);
      return;
    }

    if (effectiveMark(tree, selection, node) !== 'include') return;
    const path = groupPathOf(tree, node);

    if (node.kind === 'documentGroup') {
      excluded.push({
        uniqueId: node.uniqueId,
        title: node.title,
        itemType: node.itemType,
        path,
        reason: 'Document group. Documents are not archived, deleted or moved by this app.',
      });
      return;
    }

    if (node.kind === 'other') {
      excluded.push({
        uniqueId: node.uniqueId,
        title: node.title,
        itemType: node.itemType,
        path,
        reason:
          `Listed as "${node.itemType}", which may be a shortcut to a process that lives ` +
          `in another group. It is left out so nothing is acted on through a shortcut.`,
      });
      return;
    }

    const first = seen.get(node.uniqueId);
    if (first) {
      excluded.push({
        uniqueId: node.uniqueId,
        title: node.title,
        itemType: node.itemType,
        path,
        reason: `Also listed under ${first.join(' / ') || 'the top level'}. It is acted on once.`,
      });
      return;
    }
    seen.set(node.uniqueId, path);

    const group = node.parentUniqueId === null ? undefined : tree.nodes.get(node.parentUniqueId);
    processes.push({
      uniqueId: node.uniqueId,
      id: node.id,
      title: node.title,
      itemType: node.itemType,
      groupUniqueId: node.parentUniqueId,
      groupId: group?.id ?? null,
      path,
      variationSetId: node.variationSetId,
    });
  };

  for (const root of childrenOf(tree, null)) visit(root);

  if (unloaded.length > 0) return { status: 'incomplete', unloaded };
  return { status: 'complete', processes, excluded, groups };
}

/** A pathological depth guard. Each pass loads at least one more level. */
const MAX_PASSES = 64;

/**
 * Read whatever the selection needs, then resolve it.
 *
 * Returns the tree as well, with every level it read attached, so the caller can keep
 * it and the screen shows what the plan was built from.
 */
export async function loadForSelection(
  gateway: PlanGateway,
  tree: BrowseTree,
  selection: Selection,
  options: { concurrency?: number; onProgress?: (levelsRead: number) => void } = {},
): Promise<{ tree: BrowseTree; resolution: Extract<Resolution, { status: 'complete' }> }> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  let current = tree;
  let read = 0;

  if (current.roots === null) {
    const root = await gateway.groupsTree(null);
    current = addBrowseLevel(current, null, root.treeItems ?? []);
    read++;
  }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const resolution = resolveSelection(current, selection);
    if (resolution.status === 'complete') return { tree: current, resolution };

    for (let i = 0; i < resolution.unloaded.length; i += concurrency) {
      const batch = resolution.unloaded.slice(i, i + concurrency);
      const levels = await Promise.all(
        batch.map(async (uniqueId) => ({ uniqueId, response: await gateway.groupsTree(uniqueId) })),
      );
      for (const level of levels) {
        current = addBrowseLevel(current, level.uniqueId, level.response.treeItems ?? []);
      }
      read += batch.length;
      options.onProgress?.(read);
    }
  }

  throw new Error(
    `Gave up reading the group tree after ${MAX_PASSES} levels. ` +
      `This usually means the tree is far deeper than expected.`,
  );
}
