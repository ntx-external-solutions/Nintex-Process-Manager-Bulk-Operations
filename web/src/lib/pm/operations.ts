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
  createTopLevelGroup,
  deleteGroup,
  getChildGroups,
  getGroupProcesses,
  getGroupBreadcrumb,
  getGroupViewerCounts,
  MOVABLE_NODE_TYPES,
  reorderTreeNodes,
  validateProcessMove,
  type MovableNodeType,
} from './groups.ts';
import {
  archiveProcess,
  buildUpdateEnvelope,
  deleteProcess,
  getArchiveState,
  getGroupDocuments,
  getProcess,
  getVariationSet,
  listProcesses,
  publishProcess,
  restoreProcess,
  updateProcess,
} from './processes.ts';
import { ARCHIVED_BATCH_SIZE, checkDependencies, readActiveModel, readArchivedModels } from './dependencies.ts';
import { getOwnership, setOwnership, type UserRef } from './ownership.ts';
import { listDirectoryUsers, scimBaseUrl } from './scim.ts';
import type { ProcessJson, ProcessRevisionStateId } from './types.ts';

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
   * Every user in the SCIM directory, for resolving owner and expert usernames. The key
   * is the operator's, entered per run, and used for this one call only: never stored.
   */
  | { op: 'users.directory'; scimApiKey: string }
  /** `CheckProcessDependencies` for one process, body as sent (null for none). */
  | { op: 'process.dependencies'; processUniqueId: string }
  /** One process's whole model, or that it is archived. Bulk Delete walks models in the browser. */
  | { op: 'process.model'; processUniqueId: string }
  /** Archived models in one batch read, up to 25 ids. A read, so the one-id rule is for writes. */
  | { op: 'processes.archivedModels'; processUniqueIds: string[] }
  /** One process's owner, expert, revision and permissions. */
  | { op: 'process.ownership'; processUniqueId: string }
  /**
   * Set one process's owner and/or expert: a read-modify-write of its model, refused
   * if the revision has moved since the preview. Never publishes; that is a separate
   * `process.publishNow`.
   */
  | {
      op: 'process.setOwnership';
      processUniqueId: string;
      expectedRevisionEditId: number;
      owner: UserRef | null;
      expert: UserRef | null;
      changeDescription: string;
      submitForApproval: boolean;
    }
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
    }
  /**
   * Save one process's model, edited in the browser (Bulk Delete removes references
   * there). The model's own UniqueId must be the id named, so one call can only ever
   * write the process it says. Never publishes; that is `process.publishNow`.
   */
  | {
      op: 'process.save';
      processUniqueId: string;
      processJson: string;
      changeDescription: string;
      submitForApproval: boolean;
      suppressChangeNotification: boolean;
    }
  /** Un-archive one process into one group. `once`: no retry (the relocation probe). */
  | { op: 'process.restore'; processUniqueId: string; processGroupId: number; once: boolean }
  /** Delete one process, permanently. The group is sent when the run knows it. */
  | { op: 'process.delete'; processUniqueId: string; processGroupUniqueId: string | null }
  /** Make one group at the top level: the delete run's holding group. Takes no id. */
  | { op: 'group.create' }
  /** The live processes directly in one group. */
  | { op: 'group.processes'; groupUniqueId: string };

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
  'users.directory',
  'process.ownership',
  'process.setOwnership',
  'process.dependencies',
  'process.model',
  'processes.archivedModels',
  'process.save',
  'process.restore',
  'process.delete',
  'group.create',
  'group.processes',
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
  'process.setOwnership',
  // W5 phase 7: the delete run. Kept off until the unwind existed, so nothing could
  // un-archive or delete a process without a way to put it back (Cowork, phase 3).
  'process.save',
  'process.restore',
  'process.delete',
  'group.create',
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

    case 'users.directory':
      return listDirectoryUsers({
        baseUrl: scimBaseUrl(process.env['SCIM_BASE_URL']),
        apiKey: operation.scimApiKey,
        fetch: ctx.fetch,
      });

    case 'process.ownership':
      return getOwnership(ctx, operation.processUniqueId);

    case 'process.dependencies':
      return checkDependencies(ctx, operation.processUniqueId);

    case 'process.model':
      return readActiveModel(ctx, operation.processUniqueId);

    case 'processes.archivedModels':
      return readArchivedModels(ctx, operation.processUniqueIds);

    case 'process.setOwnership':
      return setOwnership(ctx, operation);

    case 'process.publishNow':
      return publishProcess(
        ctx,
        operation.processUniqueId,
        operation.processRevisionEditId,
        operation.publishMessage,
      );

    case 'process.save':
      await updateProcess(
        ctx,
        operation.processUniqueId,
        buildUpdateEnvelope(JSON.parse(operation.processJson) as ProcessJson, {
          changeDescription: operation.changeDescription,
          submitForApproval: operation.submitForApproval,
          suppressChangeNotification: operation.suppressChangeNotification,
        }),
      );
      return { saved: true };

    case 'process.restore':
      await restoreProcess(ctx, operation.processUniqueId, operation.processGroupId, { once: operation.once });
      return { restored: true };

    case 'process.delete':
      await deleteProcess(ctx, operation.processUniqueId, operation.processGroupUniqueId);
      return { deleted: true };

    case 'group.create':
      return createTopLevelGroup(ctx);

    case 'group.processes':
      return getGroupProcesses(ctx, operation.groupUniqueId);
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
    case 'group.processes':
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

    case 'users.directory': {
      const extra = Object.keys(body).filter((key) => key !== 'op' && key !== 'scimApiKey');
      const scimApiKey = requiredString(body['scimApiKey']);
      if (extra.length > 0 || !scimApiKey || scimApiKey.length > MAX_KEY_LENGTH) {
        return { ok: false, error: `${op}: "scimApiKey" is required, and nothing else.` };
      }
      return { ok: true, operation: { op, scimApiKey: scimApiKey.trim() } };
    }

    case 'process.dependencies':
    case 'process.model':
    case 'process.ownership': {
      const processUniqueId = singleProcessId(body, op, ['processUniqueId']);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      return { ok: true, operation: { op, processUniqueId } };
    }

    case 'processes.archivedModels': {
      const extra = Object.keys(body).filter((key) => key !== 'op' && key !== 'processUniqueIds');
      const ids = body['processUniqueIds'];
      if (
        extra.length > 0 ||
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > ARCHIVED_BATCH_SIZE ||
        !ids.every((id) => typeof id === 'string' && GUID.test(id))
      ) {
        return { ok: false, error: `${op}: "processUniqueIds" must be 1 to ${ARCHIVED_BATCH_SIZE} process ids, and nothing else.` };
      }
      return { ok: true, operation: { op, processUniqueIds: ids as string[] } };
    }

    case 'process.setOwnership': {
      const processUniqueId = singleProcessId(body, op, [
        'processUniqueId',
        'expectedRevisionEditId',
        'owner',
        'expert',
        'changeDescription',
        'submitForApproval',
      ]);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const expectedRevisionEditId = body['expectedRevisionEditId'];
      if (typeof expectedRevisionEditId !== 'number' || !Number.isInteger(expectedRevisionEditId) || expectedRevisionEditId <= 0) {
        return { ok: false, error: `${op}: "expectedRevisionEditId" must be a positive integer.` };
      }
      const owner = userRef(body['owner']);
      const expert = userRef(body['expert']);
      if (owner === undefined || expert === undefined) {
        return { ok: false, error: `${op}: "owner" and "expert" must each be null or { id, name } with a positive integer id.` };
      }
      if (owner === null && expert === null) {
        return { ok: false, error: `${op}: nothing to set. Give an owner, an expert, or both.` };
      }
      const changeDescription = requiredString(body['changeDescription']);
      if (!changeDescription) {
        return { ok: false, error: `${op}: "changeDescription" is required. It is the run's change description.` };
      }
      const submitForApproval = body['submitForApproval'];
      if (typeof submitForApproval !== 'boolean') {
        return { ok: false, error: `${op}: "submitForApproval" must be true or false.` };
      }
      return {
        ok: true,
        operation: {
          op,
          processUniqueId,
          expectedRevisionEditId,
          owner,
          expert,
          changeDescription: changeDescription.trim(),
          submitForApproval,
        },
      };
    }

    case 'process.save': {
      const processUniqueId = singleProcessId(body, op, [
        'processUniqueId',
        'processJson',
        'changeDescription',
        'submitForApproval',
        'suppressChangeNotification',
      ]);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const processJson = body['processJson'];
      if (typeof processJson !== 'string' || processJson.length > MAX_PROCESS_JSON_LENGTH) {
        return { ok: false, error: `${op}: "processJson" must be the model as a string.` };
      }
      let model: unknown;
      try {
        model = JSON.parse(processJson);
      } catch {
        return { ok: false, error: `${op}: "processJson" is not JSON.` };
      }
      const modelId = typeof model === 'object' && model !== null ? (model as Record<string, unknown>)['UniqueId'] : undefined;
      if (typeof modelId !== 'string' || modelId.toLowerCase() !== processUniqueId.toLowerCase()) {
        // The one-id rule for a body that carries a whole model: it may only be the model
        // of the process named.
        return { ok: false, error: `${op}: the model's UniqueId must be the process named.` };
      }
      const changeDescription = requiredString(body['changeDescription']);
      if (!changeDescription) {
        return { ok: false, error: `${op}: "changeDescription" is required. It is the run's change description.` };
      }
      const submitForApproval = body['submitForApproval'];
      const suppressChangeNotification = body['suppressChangeNotification'];
      if (typeof submitForApproval !== 'boolean' || typeof suppressChangeNotification !== 'boolean') {
        return { ok: false, error: `${op}: "submitForApproval" and "suppressChangeNotification" must be true or false.` };
      }
      return {
        ok: true,
        operation: { op, processUniqueId, processJson, changeDescription: changeDescription.trim(), submitForApproval, suppressChangeNotification },
      };
    }

    case 'process.restore': {
      const processUniqueId = singleProcessId(body, op, ['processUniqueId', 'processGroupId', 'once']);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const processGroupId = body['processGroupId'];
      if (typeof processGroupId !== 'number' || !Number.isInteger(processGroupId) || processGroupId <= 0) {
        return { ok: false, error: `${op}: "processGroupId" must be one positive integer.` };
      }
      const once = body['once'] ?? false;
      if (typeof once !== 'boolean') return { ok: false, error: `${op}: "once" must be true or false.` };
      return { ok: true, operation: { op, processUniqueId, processGroupId, once } };
    }

    case 'process.delete': {
      const processUniqueId = singleProcessId(body, op, ['processUniqueId', 'processGroupUniqueId']);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const processGroupUniqueId = nullableGuid(body['processGroupUniqueId']);
      if (processGroupUniqueId === undefined) {
        return { ok: false, error: `${op}: "processGroupUniqueId" must be one group id or null.` };
      }
      return { ok: true, operation: { op, processUniqueId, processGroupUniqueId } };
    }

    case 'group.create': {
      const extra = Object.keys(body).filter((key) => key !== 'op');
      if (extra.length > 0) return { ok: false, error: `${op}: takes nothing; it makes one group at the top level.` };
      return { ok: true, operation: { op } };
    }

    default:
      return { ok: false, error: `Unknown operation "${op}".` };
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A large process model is a few hundred KB; this is well past any measured one. */
const MAX_PROCESS_JSON_LENGTH = 8_000_000;

/** Longer than any real key, short enough that a body cannot smuggle much in. */
const MAX_KEY_LENGTH = 4_096;

/** Longer than any display name a directory holds. */
const MAX_USER_NAME_LENGTH = 256;

/**
 * null, `{ id, name }`, or undefined for "invalid". Nothing else may ride along, for the
 * same reason as the one-id rule: a field nobody reads today is one somebody reads later.
 */
function userRef(value: unknown): UserRef | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'id' && key !== 'name')) return undefined;
  const id = record['id'];
  const name = record['name'];
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return undefined;
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_USER_NAME_LENGTH) return undefined;
  return { id, name: name.trim() };
}

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
