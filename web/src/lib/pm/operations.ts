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
 * exactly one process id, checked here on the server: the id must be a single GUID,
 * and a body carrying any field the operation does not name is refused outright, so
 * the proxy can never be asked to act on a list.
 */

import type { PmContext } from './client.ts';
import { getChildGroups } from './groups.ts';
import {
  archiveProcess,
  getArchiveState,
  getProcess,
  listProcesses,
  publishProcess,
} from './processes.ts';
import type { ProcessRevisionStateId } from './types.ts';

export type Operation =
  | { op: 'groups.tree'; parentUniqueId: string | null }
  | { op: 'process.summary'; processUniqueId: string }
  | { op: 'processes.list'; page: number; listType: number }
  /** Is it archived yet, and what revision would the approval override publish? */
  | { op: 'process.archiveState'; processUniqueId: string }
  /** One process. The comment is the run's change description. */
  | { op: 'process.archive'; processUniqueId: string; comment: string }
  /**
   * The approval override: "Archive now" under the cog in the UI. Publishes the given
   * revision with IsPublishNow, the revision id sent as a string.
   */
  | { op: 'process.publishNow'; processUniqueId: string; processRevisionEditId: number };

export type OperationName = Operation['op'];

export const OPERATION_NAMES: readonly OperationName[] = [
  'groups.tree',
  'process.summary',
  'processes.list',
  'process.archiveState',
  'process.archive',
  'process.publishNow',
];

/**
 * Operations that change something on the tenant, asserted in tests, so adding a write
 * is a visible decision rather than a side effect of adding a case to the switch below.
 */
export const WRITE_OPERATIONS: readonly OperationName[] = ['process.archive', 'process.publishNow'];

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

    case 'process.summary':
      return summarise(ctx, operation.processUniqueId);

    case 'processes.list':
      return listProcesses(ctx, operation.page, undefined, operation.listType);

    case 'process.archiveState':
      return getArchiveState(ctx, operation.processUniqueId);

    case 'process.archive':
      await archiveProcess(ctx, operation.processUniqueId, operation.comment);
      return { accepted: true };

    case 'process.publishNow':
      return publishProcess(ctx, operation.processUniqueId, operation.processRevisionEditId);
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
      const processUniqueId = singleProcessId(body, op, ['processUniqueId', 'processRevisionEditId']);
      if (typeof processUniqueId !== 'string') return processUniqueId;
      const processRevisionEditId = body['processRevisionEditId'];
      if (
        typeof processRevisionEditId !== 'number' ||
        !Number.isInteger(processRevisionEditId) ||
        processRevisionEditId <= 0
      ) {
        return { ok: false, error: `${op}: "processRevisionEditId" must be a positive integer.` };
      }
      return { ok: true, operation: { op, processUniqueId, processRevisionEditId } };
    }

    default:
      return { ok: false, error: `Unknown operation "${op}".` };
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const extra = Object.keys(body).filter((key) => key !== 'op' && !allowed.includes(key));
  if (extra.length > 0) {
    return { ok: false, error: `${op}: unexpected field${extra.length === 1 ? '' : 's'} ${extra.map((k) => `"${k}"`).join(', ')}.` };
  }
  const value = body['processUniqueId'];
  if (typeof value !== 'string' || !GUID.test(value)) {
    return { ok: false, error: `${op}: "processUniqueId" must be exactly one process id.` };
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
