/**
 * Reading the group tree from the tenant.
 *
 * Lifted from process-group-manager's orchestrate.ts, which also held its CSV planners.
 * Only the tree walk is needed here.
 */

import type { ChildTreeItemsResponse } from '../pm/types.ts';
import { addLevel, emptyTree, type GroupTree } from './tree.ts';

/** The reads planning needs. The browser's implementation goes over the proxy. */
export interface PlanGateway {
  groupsTree(parentUniqueId: string | null): Promise<ChildTreeItemsResponse>;
}

export interface Progress {
  (event: { phase: 'tree'; done: number; total: number | null }): void;
}

export async function loadRootTree(gateway: PlanGateway): Promise<GroupTree> {
  const tree = emptyTree();
  const root = await gateway.groupsTree(null);
  addLevel(tree, null, root.treeItems ?? []);
  return tree;
}

/**
 * Every group in the tenant, breadth first.
 *
 * One request per group, because the endpoint returns one level at a time and there is
 * no "give me everything" call.
 */
export async function loadWholeTree(
  gateway: PlanGateway,
  options: { onProgress?: Progress; concurrency?: number; maxGroups?: number } = {},
): Promise<GroupTree> {
  // The tree endpoint is a cheap read and the tenant's own client fans out harder than
  // this. The cap on wall-clock here is the number of levels, not the request rate.
  const concurrency = Math.max(1, options.concurrency ?? 12);
  const maxGroups = options.maxGroups ?? 5_000;

  const tree = await loadRootTree(gateway);
  let frontier = [...tree.roots];
  let loaded = 0;

  while (frontier.length > 0) {
    loaded += frontier.length;
    if (loaded > maxGroups) {
      throw new Error(
        `This tenant has more than ${maxGroups.toLocaleString()} groups, which is more ` +
          `than one plan can hold. Select a smaller part of the tree.`,
      );
    }

    const next: typeof frontier = [];
    for (let i = 0; i < frontier.length; i += concurrency) {
      const batch = frontier.slice(i, i + concurrency);
      const levels = await Promise.all(
        batch.map(async (node) => ({
          uniqueId: node.uniqueId,
          response: await gateway.groupsTree(node.uniqueId),
        })),
      );
      for (const level of levels) {
        addLevel(tree, level.uniqueId, level.response.treeItems ?? []);
        const parent = tree.byUniqueId.get(level.uniqueId);
        if (parent) next.push(...parent.children);
      }
      options.onProgress?.({ phase: 'tree', done: loaded, total: null });
    }

    frontier = next;
  }

  return tree;
}
