/**
 * Tri-state selection over the browse tree.
 *
 * A selection is a set of explicit marks, not a set of checked boxes. Checking a group
 * marks that group `include`, and means "everything under it", including levels nobody
 * has expanded and processes added after the tree was read. Unchecking something inside
 * it marks that node `exclude`. A node's effective state is the nearest mark at or
 * above it, and nothing is selected by default.
 *
 * That is what lets a checked group resolve to its whole subtree at plan time
 * (resolve.ts) rather than to whatever happened to be on screen.
 */

import { isWithin, parentOf, type BrowseNode, type BrowseTree } from './browse.ts';

export type Mark = 'include' | 'exclude';
export type Selection = ReadonlyMap<string, Mark>;
export type CheckState = 'checked' | 'unchecked' | 'mixed';

export const EMPTY_SELECTION: Selection = new Map();

/**
 * Whether a node can carry a mark at all.
 *
 * Document groups hold documents, which no operation here acts on. Items of a type that
 * is not a plain process (browse.ts, PROCESS_TYPES) are shown so the tree matches what
 * the operator sees in Process Manager, but they are never resolved into a plan, so a
 * checkbox on them would promise something the plan will not do.
 */
export function isSelectable(node: BrowseNode): boolean {
  return node.kind === 'group' || node.kind === 'process';
}

/** The nearest mark at or above the node; `exclude` when there is none. */
export function effectiveMark(tree: BrowseTree, selection: Selection, node: BrowseNode): Mark {
  let current: BrowseNode | null = node;
  for (let hops = 0; current && hops <= 64; hops++) {
    const mark = selection.get(current.key);
    if (mark) return mark;
    current = parentOf(tree, current);
  }
  return 'exclude';
}

/**
 * Checked, unchecked, or mixed when something below a group disagrees with the group.
 *
 * Only marks are consulted, never loaded children, so a checked group whose subtree was
 * never expanded is checked, not mixed.
 */
export function checkState(tree: BrowseTree, selection: Selection, node: BrowseNode): CheckState {
  const own = effectiveMark(tree, selection, node);
  if (node.kind === 'group') {
    for (const [key, mark] of selection) {
      if (key === node.key || mark === own) continue;
      const marked = tree.nodes.get(key);
      if (marked && isWithin(tree, marked, node.key)) return 'mixed';
    }
  }
  return own === 'include' ? 'checked' : 'unchecked';
}

/**
 * Click a checkbox.
 *
 * A mixed or unchecked node becomes checked, a checked one unchecked, and every mark
 * beneath it is cleared, because a click on a group is a statement about the whole
 * group. A mark that only restates what the node would inherit anyway is dropped, so the
 * selection stays the smallest description of what the operator chose.
 */
export function toggle(tree: BrowseTree, selection: Selection, node: BrowseNode): Selection {
  if (!isSelectable(node)) return selection;

  const target: Mark = checkState(tree, selection, node) === 'checked' ? 'exclude' : 'include';
  const next = new Map(selection);

  for (const key of selection.keys()) {
    if (key === node.key) continue;
    const marked = tree.nodes.get(key);
    // A mark on a node that is no longer in the tree can never apply again.
    if (!marked || isWithin(tree, marked, node.key)) next.delete(key);
  }

  next.delete(node.key);
  const parent = parentOf(tree, node);
  const inherited = parent ? effectiveMark(tree, next, parent) : 'exclude';
  if (inherited !== target) next.set(node.key, target);

  return next;
}

/** True when anything at all is marked include. */
export function hasSelection(selection: Selection): boolean {
  for (const mark of selection.values()) if (mark === 'include') return true;
  return false;
}
