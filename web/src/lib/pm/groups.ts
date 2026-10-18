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

/**
 * Delete one group.
 *
 * Measured in spike S1 (API_ARCHITECTURE.md): the server **deletes a group that holds
 * archived processes**, with no prompt and no refusal, and those processes become orphans
 * that cannot be restored to it. It **refuses a group holding any document**, archived or
 * not, with 409 `AssociatedContents` naming each document. `ValidateGroupAction` says
 * nothing either way. So every check that matters is the caller's (lib/cleanup/plan.ts).
 */
export function deleteGroup(ctx: PmContext, processGroupUniqueId: string): Promise<unknown> {
  return pmRequest<unknown>(ctx, {
    path: '/Process/Edit/DeleteGroup',
    method: 'POST',
    body: { processGroupUniqueId },
    // A 409 is the tenant's answer, not a transient fault, and a dropped connection may
    // have deleted the group. Neither is sent twice; the final read settles it.
    retry: 'write',
  });
}

/** The tenant's 409 when a group still holds content. */
export interface AssociatedContents {
  caption: string;
  documents: string[];
  processes: string[];
}

/**
 * Read a DeleteGroup refusal: `errorCode: "AssociatedContents"`, a caption, and the
 * blocking items in `additionalInfos`. Returns null for anything else.
 */
export function readAssociatedContents(bodyText: string | null): AssociatedContents | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['errorCode'] !== 'AssociatedContents') return null;
  const infos = (record['additionalInfos'] ?? {}) as Record<string, unknown>;
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    caption: typeof record['caption'] === 'string' ? record['caption'] : 'Unable to Delete Group',
    documents: names(infos['documents']),
    processes: names(infos['processes']),
  };
}

/**
 * Titles of a group's ancestors and the group itself, top first, without the tenant.
 *
 * The breadcrumb endpoint returns the chain root first (the tenant) and the group last
 * (spike S3). Its item shape was recorded only loosely, so the title is taken from
 * whichever of the usual fields carries one. A deleted group's chain is sometimes empty,
 * which comes back as an empty path rather than a guess.
 */
export async function getGroupBreadcrumb(ctx: PmContext, groupUniqueId: string): Promise<string[]> {
  const response = await pmRequest<unknown>(ctx, {
    path: '/bff/navigation/api/v1/breadcrumb',
    query: { type: 'ProcessGroup', id: groupUniqueId },
  });
  return breadcrumbTitles(response);
}

export function breadcrumbTitles(response: unknown): string[] {
  let items: unknown = response;
  if (!Array.isArray(items) && typeof items === 'object' && items !== null) {
    const record = items as Record<string, unknown>;
    items = record['items'] ?? record['breadcrumbs'] ?? record['data'] ?? record['breadcrumb'] ?? [];
  }
  if (!Array.isArray(items)) return [];
  const titles = items
    .map((item) => {
      if (typeof item !== 'object' || item === null) return '';
      const record = item as Record<string, unknown>;
      const title = record['name'] ?? record['title'] ?? record['Name'] ?? record['Title'] ?? record['text'];
      return typeof title === 'string' ? title : '';
    })
    .filter((title) => title !== '');
  // The first entry is the tenant itself, which no group path in this app includes.
  return titles.slice(1);
}
