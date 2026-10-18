/**
 * Group endpoints.
 *
 * These are the MVC-style `/Process/Edit/*` and `/Process/View/*` routes, a different
 * surface from the `/Api/v1/*` process endpoints.
 *
 * Lifted from process-group-manager without its create and rename calls: this app
 * never makes a group, and the only group write it will gain is a move (W3) and a
 * delete of a group it has emptied (W6).
 */

import { pmRequest, type PmContext } from './client.ts';
import type { ChildTreeItemsResponse, ValidateActionResponse } from './types.ts';

/**
 * Operation codes for Validate*Action. Only the ones we use are named; the enum is
 * the server's and is not otherwise documented.
 */
export const GroupActionType = {
  /** Add a group / add a subgroup. */
  Create: 1,
} as const;

/**
 * One level of the tree. Pass null for the root level.
 * The tree loads lazily — there is no "give me everything" call.
 */
export function getChildGroups(
  ctx: PmContext,
  parentUniqueId: string | null,
): Promise<ChildTreeItemsResponse> {
  return pmRequest<ChildTreeItemsResponse>(ctx, {
    path: '/Process/View/GetChildProcessGroupTreeItems',
    query: { uniqueId: parentUniqueId ?? '' },
  });
}

/**
 * Server-side gate, called before acting.
 *
 * `isPrompt` means the server wants the user asked something first. Honour it —
 * for destructive operations the confirmation is client-side only, so ignoring it
 * removes the sole safety check.
 */
export function validateGroupAction(
  ctx: PmContext,
  processGroupUniqueId: string | null,
  actionType: number = GroupActionType.Create,
): Promise<ValidateActionResponse> {
  return pmRequest<ValidateActionResponse>(ctx, {
    path: '/Process/Edit/ValidateGroupAction',
    query: { processGroupUniqueId: processGroupUniqueId ?? '', actionType },
  });
}

/**
 * One node being reparented. The server's field names and casing, not ours.
 *
 * `NodeType` is the tree item's own `itemType` passed straight through — the client
 * does no branching by type, and `"group"` reparents a group through the identical
 * call that moves a process.
 */
export interface TreeNodeMove {
  NodeType: 'group';
  /** Empty string moves the node to the top level. */
  ParentUniqueId: string;
  OriginalParentUniqueId: string;
  ChildUniqueId: string;
  /** -1 appends. Ordering within the destination is not something v1 sets. */
  Position: number;
  SiblingUniqueId: string | null;
}

export interface ReorderResponse {
  success: boolean;
  errors: unknown[] | null;
}

/**
 * Reparent groups. Takes an array, so many moves commit in one request.
 *
 * The group keeps its id, and therefore its processes, permissions, and stakeholders —
 * which is what makes matching-and-moving strictly better than creating a new group and
 * re-homing everything into it. It touches no process revision, so it publishes nothing
 * and notifies nobody.
 */
export function reorderTreeNodes(
  ctx: PmContext,
  moves: readonly TreeNodeMove[],
): Promise<ReorderResponse> {
  return pmRequest<ReorderResponse>(ctx, {
    path: '/Process/Edit/ReorderTreeNodes',
    method: 'POST',
    body: moves,
    // Write policy: retried only when the server says it never looked at the request
    // (429/408). A 5xx or a dropped connection leaves the outcome unknown, and a
    // reparent is not idempotent enough to send twice on a guess.
    retry: 'write',
  });
}

export interface ActionPermission {
  actionPermissionType: string;
  value: boolean;
}

export interface GroupPermissions {
  groupUniqueId: string;
  permissions: ActionPermission[];
}

/** Batch permission lookup — one call for the whole plan, not one per group. */
export async function getGroupPermissions(
  ctx: PmContext,
  groupIds: readonly number[],
): Promise<GroupPermissions[]> {
  if (groupIds.length === 0) return [];
  // Repeated `groupIds` parameters, which URLSearchParams handles but our generic
  // query builder (one value per key) does not.
  const params = new URLSearchParams();
  for (const id of groupIds) params.append('groupIds', String(id));

  const response = await pmRequest<{ success: boolean; data: GroupPermissions[] }>(ctx, {
    path: `/Process/View/GetUserActionPermissionsByGroups?${params.toString()}`,
  });
  return response.data ?? [];
}

export interface GroupViewerCount {
  groupId: number;
  totalUsers: number;
  totalRoles: number;
}

/**
 * Viewer counts for a set of groups — the product's own visibility-impact check.
 * Used to show who gains or loses sight of a process before anything is applied.
 */
export async function getGroupViewerCounts(
  ctx: PmContext,
  groupIds: readonly number[],
): Promise<GroupViewerCount[]> {
  if (groupIds.length === 0) return [];
  const params = new URLSearchParams();
  for (const id of groupIds) params.append('groupIds', String(id));

  const response = await pmRequest<{ success: boolean; data: GroupViewerCount[] }>(ctx, {
    path: `/Process/View/GetTotalSpecifiedGroupRoleAndUserViewers?${params.toString()}`,
  });
  return response.data ?? [];
}
