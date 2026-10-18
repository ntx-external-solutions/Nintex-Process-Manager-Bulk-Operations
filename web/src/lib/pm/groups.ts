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

/** The item types this app will move. Shortcuts and document groups are not among them. */
export const MOVABLE_NODE_TYPES = ['group', 'process', 'inprogress-process', 'vanillaprocess'] as const;
export type MovableNodeType = (typeof MOVABLE_NODE_TYPES)[number];

/**
 * One node being reparented. The server's field names and casing, not ours.
 *
 * `NodeType` is the tree item's own `itemType` passed straight through — the client
 * does no branching by type, and `"group"` reparents a group through the identical
 * call that moves a process.
 *
 * What a move costs differs by type (spike S2): a group moves with no revision change;
 * a never-published process gets a minor bump; anything with a published version is
 * republished as a new major version, open draft included.
 */
export interface TreeNodeMove {
  NodeType: MovableNodeType;
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
 * Reparent nodes. Takes an array; this app always sends one, so each move is journaled
 * and attributable.
 *
 * A group keeps its id, and therefore its processes, permissions and stakeholders, and
 * touches no process revision. A process move is not free: see `TreeNodeMove`.
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

export const ProcessActionType = {
  /** Move a process to another group. */
  Move: 11,
} as const;

/**
 * The server's own pre-flight for a process move.
 *
 * For a published process it prompts "Publish New Version?"; for one with an open draft
 * it warns the draft will be published too; for a never-published one it is valid with
 * no prompt (spike S2). The move endpoint does not enforce any of it, so the preview has
 * to show it.
 */
export function validateProcessMove(
  ctx: PmContext,
  processUniqueId: string,
  destinationGroupUniqueId: string,
): Promise<ValidateActionResponse> {
  return pmRequest<ValidateActionResponse>(ctx, {
    path: '/Process/Edit/ValidateProcessAction',
    query: {
      processUniqueId,
      actionType: ProcessActionType.Move,
      processGroupUniqueId: destinationGroupUniqueId,
      isShortcut: 'false',
    },
  });
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
 * The response shape was captured in Cowork's review of W2b (F1):
 * `{ isChildren, breadcrumbItems: [{ id, parentId, name, position, type, url, version }] }`,
 * the tenant first and the group itself last. A deleted group's list can be empty, which
 * means "path unknown" and comes back as an empty path, not an error.
 */
export async function getGroupBreadcrumb(ctx: PmContext, groupUniqueId: string): Promise<string[]> {
  const response = await pmRequest<unknown>(ctx, {
    path: '/bff/navigation/api/v1/breadcrumb',
    query: { type: 'ProcessGroup', id: groupUniqueId },
  });
  return breadcrumbTitles(response);
}

export function breadcrumbTitles(response: unknown): string[] {
  if (typeof response !== 'object' || response === null) return [];
  const items = (response as Record<string, unknown>)['breadcrumbItems'];
  if (!Array.isArray(items)) return [];
  const titles = items.map((item) => {
    const name = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['name'] : undefined;
    return typeof name === 'string' ? name : '';
  });
  // The first entry is the tenant itself, which no group path in this app includes.
  return titles.slice(1).filter((title) => title !== '');
}
