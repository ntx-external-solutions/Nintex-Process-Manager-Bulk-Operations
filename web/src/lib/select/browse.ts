/**
 * The tree the operator selects from: groups, document groups and processes, loaded one
 * level at a time from GetChildProcessGroupTreeItems.
 *
 * PGM's tree model (plan/tree.ts) discards everything that is not a group. This one keeps
 * every item, because Archive, Delete and Move all select processes.
 *
 * Nodes are keyed by placement, not by id. A group appears once, so its key is its id.
 * A process can appear more than once, under its home group and again wherever it has
 * a shortcut, so its key is `parent>id`. Keying processes by id alone would let the
 * second appearance overwrite the first, and a selection made on one would silently
 * apply to the other.
 *
 * Functions here return a new tree rather than mutating, so React state can hold it.
 */

import type { TreeItem } from '../pm/types.ts';

export type NodeKind = 'group' | 'documentGroup' | 'process' | 'other';

/**
 * Item types that are a process in its own right, in the group it is listed under.
 *
 * The rest of the enum (handoff/SPEC-WEB.md, PGM DESIGN.md) is shown but never resolved
 * into a plan. `linked-process` is the strongest candidate for a shortcut, which must not
 * be archived or deleted as if it lived here; `embeddedprocess` and `suggested-process`
 * have never been measured. Until a spike says what each one is, the safe reading is
 * "not ours to act on", and the resolution says so per item rather than dropping it.
 */
const PROCESS_TYPES: ReadonlySet<string> = new Set([
  'process',
  'vanillaprocess',
  'inprogress-process',
]);

export function kindOf(itemType: string): NodeKind {
  if (itemType === 'group') return 'group';
  if (itemType === 'documentgroup') return 'documentGroup';
  if (PROCESS_TYPES.has(itemType)) return 'process';
  return 'other';
}

export interface BrowseNode {
  key: string;
  id: number;
  uniqueId: string;
  title: string;
  itemType: string;
  kind: NodeKind;
  /** null at the top level. */
  parentUniqueId: string | null;
  /** Groups only. */
  childrenLoaded: boolean;
  hasChild: boolean;
  /** Keys, in the server's order. */
  children: string[];
  variationSetId: number | null;
}

export interface BrowseTree {
  /** null until the top level has been read. */
  roots: string[] | null;
  nodes: ReadonlyMap<string, BrowseNode>;
}

export function emptyBrowseTree(): BrowseTree {
  return { roots: null, nodes: new Map() };
}

export function nodeKey(item: Pick<TreeItem, 'itemType' | 'uniqueId'>, parentUniqueId: string | null): string {
  // Groups and document groups are unique in the tree, and their id is what a child
  // names as its parent.
  const kind = kindOf(item.itemType);
  if (kind === 'group' || kind === 'documentGroup') return item.uniqueId;
  return `${parentUniqueId ?? ''}>${item.uniqueId}`;
}

/**
 * Attach one level. `parentUniqueId` is null for the top level.
 *
 * Replaces whatever was loaded for that level before, which is what a refresh needs.
 * Grandchildren already loaded under a group that is still present are kept.
 */
export function addBrowseLevel(
  tree: BrowseTree,
  parentUniqueId: string | null,
  items: readonly TreeItem[],
): BrowseTree {
  const nodes = new Map(tree.nodes);

  if (parentUniqueId !== null && !nodes.has(parentUniqueId)) {
    throw new Error(`Cannot attach children to unknown group ${parentUniqueId}`);
  }

  const keys: string[] = [];
  for (const item of items) {
    const key = nodeKey(item, parentUniqueId);
    if (!keys.includes(key)) keys.push(key);
  }

  // Whatever the previous read of this level had and this one does not is gone from the
  // tenant, and must not stay selectable.
  const previousKeys = parentUniqueId === null ? (tree.roots ?? []) : (nodes.get(parentUniqueId)?.children ?? []);
  for (const key of previousKeys) {
    if (!keys.includes(key)) nodes.delete(key);
  }

  const seen = new Set<string>();
  for (const item of items) {
    const key = nodeKey(item, parentUniqueId);
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = nodes.get(key);
    nodes.set(key, {
      key,
      id: item.id,
      uniqueId: item.uniqueId,
      title: item.title,
      itemType: item.itemType,
      kind: kindOf(item.itemType),
      parentUniqueId,
      childrenLoaded: previous?.childrenLoaded ?? false,
      hasChild: item.hasChild === true,
      children: previous?.children ?? [],
      variationSetId: item.variationSetId ?? null,
    });
  }

  if (parentUniqueId === null) return { roots: keys, nodes };

  const parent = nodes.get(parentUniqueId) as BrowseNode;
  nodes.set(parentUniqueId, { ...parent, children: keys, childrenLoaded: true });
  return { roots: tree.roots, nodes };
}

export function childrenOf(tree: BrowseTree, key: string | null): BrowseNode[] {
  const keys = key === null ? (tree.roots ?? []) : (tree.nodes.get(key)?.children ?? []);
  return keys.map((k) => tree.nodes.get(k)).filter((n): n is BrowseNode => n !== undefined);
}

/** The group a node sits in, as a node, or null at the top level. */
export function parentOf(tree: BrowseTree, node: BrowseNode): BrowseNode | null {
  return node.parentUniqueId === null ? null : (tree.nodes.get(node.parentUniqueId) ?? null);
}

/**
 * Titles of the groups above a node, top first, not including the node itself.
 *
 * Complete by construction: a node can only be in the tree if every level above it was
 * loaded to reach it. The hop limit guards against a parent chain that loops.
 */
export function groupPathOf(tree: BrowseTree, node: BrowseNode): string[] {
  const path: string[] = [];
  let current = parentOf(tree, node);
  for (let hops = 0; current && hops <= 64; hops++) {
    path.unshift(current.title);
    current = parentOf(tree, current);
  }
  return path;
}

/** True when `ancestorKey` is a group at or above `node`. */
export function isWithin(tree: BrowseTree, node: BrowseNode, ancestorKey: string): boolean {
  let current: BrowseNode | null = node;
  for (let hops = 0; current && hops <= 64; hops++) {
    if (current.key === ancestorKey) return true;
    current = parentOf(tree, current);
  }
  return false;
}
