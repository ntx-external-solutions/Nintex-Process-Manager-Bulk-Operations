/**
 * The proxy's operation allowlist.
 *
 * Process Manager will not send CORS headers for our origin, so the browser cannot
 * call it directly and everything goes through a server route. That route must not
 * become an open relay: there is no generic pass-through, no caller-supplied URL, and
 * the tenant always comes from the session cookie. The browser can only name one of
 * the operations below.
 *
 * Lifted from process-group-manager, whose allowlist has no archive or delete operation
 * and treats that as a structural safety property. This app needs both. Each write
 * arrives with the task that uses it (archive in W2, delete in W5), and each takes
 * exactly one process or group id, checked here on the server: the id must be a single GUID,
 * and a body carrying any field the operation does not name is refused outright, so
 * the proxy can never be asked to act on a list.
 */

import type { PmContext } from './client.ts';
import {
  deleteGroup,
  getChildGroups,
  getGroupBreadcrumb,
  getGroupViewerCounts,
  MOVABLE_NODE_TYPES,
  reorderTreeNodes,
  validateProcessMove,
  type MovableNodeType,
} from './groups.ts';
import {
  archiveProcess,
  getArchiveState,
  getGroupDocuments,
  getProcess,
  getVariationSet,
  listProcesses,
  publishProcess,
} from './processes.ts';
import type { ProcessRevisionStateId } from './types.ts';

export type Operation =
  | { op: 'groups.tree'; parentUniqueId: string | null }
  /** Titles from the top level down to this group. */
  | { op: 'group.breadcrumb'; groupUniqueId: string }
  /** Documents in one group, which block its deletion. */
  | { op: 'group.documents'; groupUniqueId: string }
  /**
   * Delete one group. The server does not refuse a group holding archived processes
   * (spike S1), so the checks are the caller's; this only ever names one group.
   */
  | { op: 'group.delete'; groupUniqueId: string }
  /** Viewer counts for a handful of groups, by numeric id: the audience of a move. */
  | { op: 'groups.viewers'; groupIds: number[] }
  /** The server's pre-flight for moving one process into one group. */
  | { op: 'process.validateMove'; processUniqueId: string; destinationGroupUniqueId: string }
  /**
   * Move one node. Deliberately one at a time even though the endpoint takes an array:
   * each move is journaled, and a batch answering only `success: false` cannot be
   * attributed to a particular node.
   */
  | {
      op: 'node.move';
      uniqueId: string;
      nodeType: MovableNodeType;
      /** null moves a group to the top level. A process always needs a group. */
      newParentUniqueId: string | null;
      oldParentUniqueId: string | null;
    }
  | { op: 'process.summary'; processUniqueId: string }
  | { op: 'processes.list'; page: number; listType: number }
  /** The variation set a process belongs to, and every sibling in it. */
  | { op: 'process.variationSet'; processUniqueId: string }
  /** Is it archived yet, and what revision would the approval override publish? */
  | { op: 'process.archiveState'; processUniqueId: string }
  /** One process. The comment is the run's change description. */
  | { op: 'process.archive'; processUniqueId: string; comment: string }
  /**
   * The approval override: "Archive now" under the cog in the UI. Publishes the given
   * revision with IsPublishNow, the revision id sent as a string, and the run's change
   * description as PublishMessage.
   */
  | {
      op: 'process.publishNow';
      processUniqueId: string;
      processRevisionEditId: number;
      publishMessage: string;
    };

export type OperationName = Operation['op'];

export const OPERATION_NAMES: readonly OperationName[] = [
  'groups.tree',
  'group.breadcrumb',
  'group.documents',
  'group.delete',
  'groups.viewers',
  'process.validateMove',
  'node.move',
  'process.summary',
  'processes.list',
  'process.variationSet',
  'process.archiveState',
  'process.archive',
  'process.publishNow',
];

/**
 * Operations that change something on the tenant, asserted in tests, so adding a write
 * is a visible decision rather than a side effect of adding a case to the switch below.
 */
export const WRITE_OPERATIONS: readonly OperationName[] = [
  'process.archive',
  'process.publishNow',
  'group.delete',
  'node.move',
];

/**
 * Compact view of a process: everything a planner needs and nothing else. Returning
 * this instead of the full document keeps process bodies off the wire and out of the
 * browser.
 */
export interface ProcessSummary {
  uniqueId: string;
  name: string;
  version: string;
  revisionEditId: number;
  revisionStateId: ProcessRevisionStateId;
  homeGroupUniqueId: string;
  homeGroupName: string;
  canSave: boolean;
}

export async function execute(ctx: PmContext, operation: Operation): Promise<unknown> {
  switch (operation.op) {
    case 'groups.tree':
      return getChildGroups(ctx, operation.parentUniqueId);

    case 'group.breadcrumb':
      return getGroupBreadcrumb(ctx, operation.groupUniqueId);

    case 'group.documents':
      return getGroupDocuments(ctx, operation.groupUniqueId);

    case 'group.delete':
      await deleteGroup(ctx, operation.groupUniqueId);
      return { deleted: true };

    case 'groups.viewers':
      return getGroupViewerCounts(ctx, operation.groupIds);

    case 'process.validateMove':
      return validateProcessMove(ctx, operation.processUniqueId, operation.destinationGroupUniqueId);

    case 'node.move':
      return reorderTreeNodes(ctx, [
        {
          NodeType: operation.nodeType,
          // The server reads an empty string as "top level"; there is no null form.
          ParentUniqueId: operation.newParentUniqueId ?? '',
          OriginalParentUniqueId: operation.oldParentUniqueId ?? '',
          ChildUniqueId: operation.uniqueId,
          // Append. Ordering siblings is not something this app sets.
          Position: -1,
          SiblingUniqueId: null,
        },
      ]);

    case 'process.summary':
      return summarise(ctx, operation.processUniqueId);

    case 'processes.list':
      return listProcesses(ctx, operation.page, undefined, operation.listType);

    case 'process.variationSet':
      return getVariationSet(ctx, operation.processUniqueId);

    case 'process.archiveState':
      return getArchiveState(ctx, operation.processUniqueId);

    case 'process.archive':
      await archiveProcess(ctx, operation.processUniqueId, operation.comment);
      return { accepted: true };

    case 'process.publishNow':
      return publishProcess(
        ctx,
        operation.processUniqueId,
        operation.processRevisionEditId,
        operation.publishMessage,
      );
  }
}

async function summarise(ctx: PmContext, processUniqueId: string): Promise<ProcessSummary> {
  const { processJson, processActions } = await getProcess(ctx, processUniqueId);
  return {
    uniqueId: processJson.UniqueId,
    name: processJson.Name,
    version: processJson.Version,
    revisionEditId: processJson.ProcessRevisionEditId,
    revisionStateId: processJson.ProcessRevisionStateId,
    homeGroupUniqueId: processJson.ProcessGroupItems.ProcessGroup.UniqueId,
    homeGroupName: processJson.ProcessGroupItems.ProcessGroup.Name,
    canSave: processActions.CanSave === true,
  };
}

// ------------------------------------------------------------------ parsing

export type ParseResult =
  | { ok: true; operation: Operation }
  | { ok: false; error: string };

/**
 * Validate a request body from the browser.
 *
 * Everything crossing this boundary is untrusted, so each field is checked rather
 * than cast. An unrecognised `op` is rejected outright; that is what makes this an
 * allowlist rather than a suggestion.
 */
export function parseOperation(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Request body must be an object.' };
  }
  const body = input as Record<string, unknown>;
  const op = body['op'];
  if (typeof op !== 'string') return { ok: false, error: 'Missing "op".' };

  switch (op) {
    case 'groups.tree': {
      const parentUniqueId = nullableString(body['parentUniqueId']);
      if (parentUniqueId === undefined) {
        return { ok: false, error: `${op}: "parentUniqueId" must be a string or null.` };
      }
      return { ok: true, operation: { op, parentUniqueId } };
    }

    case 'group.breadcrumb':
    case 'group.documents':
    case 'group.delete': {
      const groupUniqueId = singleId(body, op, 'groupUniqueId', ['groupUniqueId']);
      if (typeof groupUniqueId !== 'string') return groupUniqueId;
      return { ok: true, operation: { op, groupUniqueId } };
    }

    case 'groups.viewers': {
      const extra = Object.keys(body).filter((key) => key !== 'op' && key !== 'groupIds');
      const groupIds = body['groupIds'];
      if (
        extra.length > 0 ||
        !Array.isArray(groupIds) ||
        groupIds.length > MAX_VIEWER_GROUPS ||
        !groupIds.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)
      ) {
        return { ok: false, error: `${op}: "groupIds" must be up to ${MAX_VIEWER_GROUPS} positive integers.` };
      }
      return { ok: true, operation: { op, groupIds: groupIds as number[] } };
    }

    case 'process.validateMove': {
      const processUniqueId = singleProcessId(body, op, ['processUniqueId', 'destinationGroupUniqueId']);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const destination = body['destinationGroupUniqueId'];
      if (typeof destination !== 'string' || !GUID.test(destination)) {
        return { ok: false, error: `${op}: "destinationGroupUniqueId" must be exactly one group id.` };
      }
      return { ok: true, operation: { op, processUniqueId, destinationGroupUniqueId: destination } };
    }

    case 'node.move': {
      const uniqueId = singleId(body, op, 'uniqueId', ['uniqueId', 'nodeType', 'newParentUniqueId', 'oldParentUniqueId']);
      if (typeof uniqueId !== 'string') return uniqueId;
      const nodeType = body['nodeType'];
      if (typeof nodeType !== 'string' || !(MOVABLE_NODE_TYPES as readonly string[]).includes(nodeType)) {
        // Shortcuts and document groups are not movable here: moving a shortcut would
        // act on a process homed somewhere nobody selected.
        return { ok: false, error: `${op}: "nodeType" must be one of ${MOVABLE_NODE_TYPES.join(', ')}.` };
      }
      const newParent = nullableGuid(body['newParentUniqueId']);
      const oldParent = nullableGuid(body['oldParentUniqueId']);
      if (newParent === undefined || oldParent === undefined) {
        return { ok: false, error: `${op}: parent ids must each be one group id or null.` };
      }
      if (newParent === uniqueId) {
        // The server would detach the group from the tree entirely.
        return { ok: false, error: `${op}: a group cannot be its own parent.` };
      }
      if (nodeType !== 'group' && newParent === null) {
        return { ok: false, error: `${op}: a process has to be moved into a group.` };
      }
      return {
        ok: true,
        operation: {
          op,
          uniqueId,
          nodeType: nodeType as MovableNodeType,
          newParentUniqueId: newParent,
          oldParentUniqueId: oldParent,
        },
      };
    }

    case 'process.summary': {
      const processUniqueId = requiredString(body['processUniqueId']);
      if (!processUniqueId) {
        return { ok: false, error: 'process.summary: "processUniqueId" is required.' };
      }
      return { ok: true, operation: { op, processUniqueId } };
    }

    case 'processes.list': {
      const page = body['page'];
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
        return { ok: false, error: 'processes.list: "page" must be a positive integer.' };
      }
      const listType = body['listType'];
      if (listType !== undefined && typeof listType !== 'number') {
        return { ok: false, error: 'processes.list: "listType" must be a number.' };
      }
      return { ok: true, operation: { op, page, listType: (listType as number) ?? 0 } };
    }

    case 'process.variationSet':
    case 'process.archiveState': {
      const processUniqueId = singleProcessId(body, op, ['processUniqueId']);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      return { ok: true, operation: { op, processUniqueId } };
    }

    case 'process.archive': {
      const processUniqueId = singleProcessId(body, op, ['processUniqueId', 'comment']);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const comment = requiredString(body['comment']);
      if (!comment) {
        return { ok: false, error: `${op}: "comment" is required. It is the run's change description.` };
      }
      return { ok: true, operation: { op, processUniqueId, comment: comment.trim() } };
    }

    case 'process.publishNow': {
      const processUniqueId = singleProcessId(body, op, [
        'processUniqueId',
        'processRevisionEditId',
        'publishMessage',
      ]);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const processRevisionEditId = body['processRevisionEditId'];
      if (
        typeof processRevisionEditId !== 'number' ||
        !Number.isInteger(processRevisionEditId) ||
        processRevisionEditId <= 0
      ) {
        return { ok: false, error: `${op}: "processRevisionEditId" must be a positive integer.` };
      }
      // A tenant in "Publish Only mode" refuses a publish without one (spike S2).
      const publishMessage = requiredString(body['publishMessage']);
      if (!publishMessage) {
        return { ok: false, error: `${op}: "publishMessage" is required. It is the run's change description.` };
      }
      return {
        ok: true,
        operation: { op, processUniqueId, processRevisionEditId, publishMessage: publishMessage.trim() },
      };
    }

    default:
      return { ok: false, error: `Unknown operation "${op}".` };
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A move's preview reads both ends of every move in one call. */
const MAX_VIEWER_GROUPS = 200;

/** A GUID, null, or undefined for "invalid". */
function nullableGuid(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && GUID.test(value) ? value : undefined;
}

/**
 * The one-id rule for operations that act on a process.
 *
 * The id must be one GUID: not an array, not a comma-separated list, not a GUID with
 * something appended. And the body may carry only the fields the operation names, so a
 * caller cannot slip a second id in under another key and rely on some later change to
 * start reading it.
 */
function singleProcessId(
  body: Record<string, unknown>,
  op: string,
  allowed: readonly string[],
): string | { ok: false; error: string } {
  return singleId(body, op, 'processUniqueId', allowed);
}

/** The same rule for whichever field names the one object. */
function singleId(
  body: Record<string, unknown>,
  op: string,
  field: string,
  allowed: readonly string[],
): string | { ok: false; error: string } {
  const extra = Object.keys(body).filter((key) => key !== 'op' && !allowed.includes(key));
  if (extra.length > 0) {
    return { ok: false, error: `${op}: unexpected field${extra.length === 1 ? '' : 's'} ${extra.map((k) => `"${k}"`).join(', ')}.` };
  }
  const value = body[field];
  if (typeof value !== 'string' || !GUID.test(value)) {
    return { ok: false, error: `${op}: "${field}" must be exactly one id.` };
  }
  return value;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Returns undefined for "invalid", distinct from a legitimate null. */
function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}
