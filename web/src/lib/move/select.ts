/**
 * What a move selection means: which nodes get one ReorderTreeNodes call each.
 *
 * A move is not an archive. Moving a group moves everything in it and changes no process
 * revision, while moving a process with a published version republishes it, open draft
 * and all (spike S2). So the cheapest correct reading of a selection is the one with the
 * fewest, highest nodes:
 *
 *  - a checked group with nothing unchecked inside it moves as one node;
 *  - a checked group with exceptions inside it cannot move whole, so its included
 *    children are considered one by one, by the same rules;
 *  - a checked process moves on its own;
 *  - a shortcut, document group or unmeasured item is excluded with the reason.
 *
 * Like the archive resolver, this never answers about a level it has not read.
 */

import { childrenOf, groupPathOf, isWithin, type BrowseNode, type BrowseTree } from '../select/browse.ts';
import { cycleExclusion, type ExcludedItem } from '../select/resolve.ts';
import { effectiveMark, type Selection } from '../select/selection.ts';

export interface MoveCandidate {
  node: BrowseNode;
  /** Titles of the groups above it, top first. */
  path: string[];
}

export type MoveResolution =
  | { status: 'complete'; groups: MoveCandidate[]; processes: MoveCandidate[]; excluded: ExcludedItem[] }
  | { status: 'incomplete'; unloaded: string[] };

function marksBelow(tree: BrowseTree, selection: Selection, group: BrowseNode, mark: 'include' | 'exclude'): boolean {
  for (const [key, value] of selection) {
    if (value !== mark || key === group.key) continue;
    const node = tree.nodes.get(key);
    if (node && isWithin(tree, node, group.key)) return true;
  }
  return false;
}

export function resolveMoveSelection(tree: BrowseTree, selection: Selection): MoveResolution {
  if (tree.roots === null) return { status: 'incomplete', unloaded: [] };

  const groups: MoveCandidate[] = [];
  const processes: MoveCandidate[] = [];
  const excluded: ExcludedItem[] = [];
  const unloaded: string[] = [];
  const seen = new Set<string>();
  const walked = new Set<string>();

  const exclude = (node: BrowseNode, reason: string): void => {
    excluded.push({ uniqueId: node.uniqueId, title: node.title, itemType: node.itemType, path: groupPathOf(tree, node), reason });
  };

  const visit = (node: BrowseNode): void => {
    const included = effectiveMark(tree, selection, node) === 'include';

    if (node.kind === 'group') {
      if (included && !marksBelow(tree, selection, node, 'exclude')) {
        groups.push({ node, path: groupPathOf(tree, node) });
        return;
      }
      if (!included && !marksBelow(tree, selection, node, 'include')) return;
      // A tenant that lists a group inside its own subtree closes a loop (F3).
      if (walked.has(node.key)) {
        excluded.push(cycleExclusion(tree, node));
        return;
      }
      walked.add(node.key);
      if (!node.childrenLoaded) {
        unloaded.push(node.uniqueId);
        return;
      }
      for (const child of childrenOf(tree, node.key)) visit(child);
      return;
    }

    if (!included) return;

    if (node.kind === 'documentGroup') {
      exclude(node, 'Document group. It stays where it is, because its group is not moving as a whole.');
      return;
    }
    if (node.kind === 'other') {
      exclude(
        node,
        node.itemType === 'linked-process'
          ? 'Shortcut to a process that lives in another group. Moving it would move that process.'
          : `Listed as "${node.itemType}", which this app does not move.`,
      );
      return;
    }
    if (seen.has(node.uniqueId)) {
      exclude(node, 'Listed more than once. It is moved once.');
      return;
    }
    seen.add(node.uniqueId);
    processes.push({ node, path: groupPathOf(tree, node) });
  };

  for (const root of childrenOf(tree, null)) visit(root);

  if (unloaded.length > 0) return { status: 'incomplete', unloaded };
  return { status: 'complete', groups, processes, excluded };
}

/** Where things are going: a group, or the top level (groups only). */
export interface Destination {
  /** null for the top level. */
  uniqueId: string | null;
  id: number | null;
  title: string;
  /** Titles from the top down, including the destination itself. */
  path: string[];
  /**
   * Group ids from the top down, including the destination itself. Carried with it so a
   * move into a group's own subtree can be refused whichever tree the destination was
   * picked from.
   */
  ancestry: string[];
}

export function destinationOf(tree: BrowseTree, key: string | null): Destination | null {
  if (key === null) return { uniqueId: null, id: null, title: 'the top level', path: [], ancestry: [] };
  const node = tree.nodes.get(key);
  if (!node || node.kind !== 'group') return null;
  const ancestry: string[] = [];
  let current: BrowseNode | undefined = node;
  for (let hops = 0; current && hops <= 64; hops++) {
    ancestry.unshift(current.uniqueId);
    current = current.parentUniqueId === null ? undefined : tree.nodes.get(current.parentUniqueId);
  }
  return {
    uniqueId: node.uniqueId,
    id: node.id,
    title: node.title,
    path: [...groupPathOf(tree, node), node.title],
    ancestry,
  };
}

export function describeDestination(destination: Destination): string {
  return destination.uniqueId === null ? 'the top level' : destination.path.join(' / ');
}

export type DestinationProblem = { kind: 'skip' | 'refuse'; reason: string } | null;

/**
 * PGM's structural checks for one move (plan/groupPlan.ts there): never into itself or
 * its own subtree, never a process at the top level, and no call for something already
 * where it is going. A document group can never be chosen as the destination
 * (`destinationOf` returns null for one).
 */
export function destinationProblem(candidate: MoveCandidate, destination: Destination): DestinationProblem {
  const { node } = candidate;

  if (destination.uniqueId !== null) {
    if (node.kind === 'group' && destination.ancestry.includes(node.uniqueId)) {
      // Reparenting a group under itself or a descendant detaches the whole subtree.
      return { kind: 'refuse', reason: 'A group cannot be moved into itself or one of its own subgroups.' };
    }
  } else if (node.kind !== 'group') {
    return { kind: 'refuse', reason: 'A process has to be in a group, so it cannot be moved to the top level.' };
  }

  if (node.parentUniqueId === destination.uniqueId) {
    return { kind: 'skip', reason: `Already in ${describeDestination(destination)}.` };
  }
  return null;
}
