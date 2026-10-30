/**
 * What the tree browser draws, as plain data.
 *
 * The component only maps these rows to elements, so everything that decides what is
 * shown, indented, checkable or expandable is tested here without a DOM.
 */

import { childrenOf, type BrowseNode, type BrowseTree } from './browse.ts';
import { checkState, isSelectable, type CheckState, type Selection } from './selection.ts';

export interface TreeRow {
  node: BrowseNode;
  depth: number;
  check: CheckState;
  selectable: boolean;
  /** Groups only: whether a disclosure control is drawn. */
  expandable: boolean;
  expanded: boolean;
  /** Expanded, but the level has not been read yet. */
  loading: boolean;
  /** Shown next to the title for anything that is not a plain group or process. */
  tag: string | null;
}

function tagFor(node: BrowseNode): string | null {
  if (node.kind === 'documentGroup') return 'documents';
  if (node.kind === 'other') return node.itemType;
  if (node.itemType === 'inprogress-process') return 'in progress';
  return null;
}

export function visibleRows(
  tree: BrowseTree,
  selection: Selection,
  expanded: ReadonlySet<string>,
  /** The document pages choose groups only (W8); processes are not drawn. */
  options: { groupsOnly?: boolean } = {},
): TreeRow[] {
  const rows: TreeRow[] = [];
  // A tenant can list a group inside its own subtree (F3); drawn once, it is not opened again.
  const opened = new Set<string>();

  const walk = (nodes: readonly BrowseNode[], depth: number): void => {
    for (const node of nodes) {
      const isGroup = node.kind === 'group';
      if (options.groupsOnly === true && !isGroup) continue;
      const open = isGroup && expanded.has(node.key) && !opened.has(node.key);
      if (open) opened.add(node.key);
      rows.push({
        node,
        depth,
        check: isSelectable(node) ? checkState(tree, selection, node) : 'unchecked',
        selectable: isSelectable(node),
        // A document group's documents are not something this app lists.
        expandable: isGroup,
        expanded: open,
        loading: open && !node.childrenLoaded,
        tag: tagFor(node),
      });
      if (open && node.childrenLoaded) walk(childrenOf(tree, node.key), depth + 1);
    }
  };

  walk(childrenOf(tree, null), 0);
  return rows;
}
