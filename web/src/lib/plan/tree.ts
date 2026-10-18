/**
 * In-memory model of the existing group tree, and path resolution against it.
 *
 * The tree is read one level at a time from GetChildProcessGroupTreeItems, so this
 * model is built incrementally and knows which nodes have had their children loaded.
 */

import type { TreeItem } from '../pm/types.ts';

export interface GroupNode {
  id: number;
  uniqueId: string;
  /** Exactly as stored in Process Manager, including any stray whitespace. */
  title: string;
  /** null for a top-level group. */
  parentUniqueId: string | null;
  isDocumentGroup: boolean;
  childrenLoaded: boolean;
  /**
   * What the server said about children, before any were fetched. Lets a preview say
   * "there is more below here" instead of drawing an empty group it never looked at.
   */
  hasChild: boolean;
  children: GroupNode[];
}

export interface GroupTree {
  roots: GroupNode[];
  byUniqueId: Map<string, GroupNode>;
}

/** Only these item types participate in group-path resolution. */
function isGroupLike(item: TreeItem): boolean {
  return item.itemType === 'group' || item.itemType === 'documentgroup';
}

export function emptyTree(): GroupTree {
  return { roots: [], byUniqueId: new Map() };
}

function toNode(item: TreeItem, parentUniqueId: string | null): GroupNode {
  return {
    id: item.id,
    uniqueId: item.uniqueId,
    title: item.title,
    parentUniqueId,
    isDocumentGroup: item.itemType === 'documentgroup',
    childrenLoaded: false,
    hasChild: item.hasChild === true,
    children: [],
  };
}

/**
 * Attach a loaded level to the tree. `parentUniqueId` is null for the root level.
 * Non-group items (processes and friends) are discarded — this model is only ever
 * asked about groups.
 */
export function addLevel(
  tree: GroupTree,
  parentUniqueId: string | null,
  items: readonly TreeItem[],
): GroupTree {
  const nodes = items.filter(isGroupLike).map((item) => toNode(item, parentUniqueId));

  for (const node of nodes) tree.byUniqueId.set(node.uniqueId, node);

  if (parentUniqueId === null) {
    tree.roots = nodes;
  } else {
    const parent = tree.byUniqueId.get(parentUniqueId);
    if (!parent) {
      throw new Error(`Cannot attach children to unknown group ${parentUniqueId}`);
    }
    parent.children = nodes;
    parent.childrenLoaded = true;
  }

  return tree;
}

/** Direct children of a node, or the roots when `node` is null. */
export function childrenOf(tree: GroupTree, node: GroupNode | null): GroupNode[] {
  return node === null ? tree.roots : node.children;
}

/**
 * Where a group currently sits, walked up from the node itself.
 *
 * Only meaningful on a fully-loaded tree: every ancestor has to have been read for the
 * chain to be complete. Returns null when it is not, rather than a truncated path that
 * would read as a real location.
 */
export function pathOf(tree: GroupTree, node: GroupNode): string[] | null {
  const path: string[] = [];
  let current: GroupNode | undefined = node;

  // Bounded by the tree's depth; the guard is against a parent chain that loops, which
  // would otherwise hang the browser tab.
  for (let hops = 0; current && hops <= 64; hops++) {
    path.unshift(current.title);
    if (current.parentUniqueId === null) return path;
    current = tree.byUniqueId.get(current.parentUniqueId);
  }

  return null;
}

/** True when `maybeAncestor` is at or above `node` in the tree. */
export function isAncestorOf(
  tree: GroupTree,
  maybeAncestor: GroupNode,
  node: GroupNode,
): boolean {
  let current: GroupNode | undefined = node;
  for (let hops = 0; current && hops <= 64; hops++) {
    if (current.uniqueId === maybeAncestor.uniqueId) return true;
    if (current.parentUniqueId === null) return false;
    current = tree.byUniqueId.get(current.parentUniqueId);
  }
  return false;
}

/** A group and where it sits, which is everything the exporter needs. */
export interface GroupWithPath {
  uniqueId: string;
  path: string[];
}

/**
 * Every group in the tree with its full path, in tree order.
 *
 * Order matters to the exported file: a parent always precedes its children, so a row
 * carrying an id can anchor the rows nested beneath it.
 */
export function allGroups(tree: GroupTree): GroupWithPath[] {
  const out: GroupWithPath[] = [];
  const walk = (node: GroupNode, prefix: string[]): void => {
    const path = [...prefix, node.title];
    out.push({ uniqueId: node.uniqueId, path });
    for (const child of node.children) walk(child, path);
  };
  for (const root of tree.roots) walk(root, []);
  return out;
}
