/**
 * Process read/write endpoints.
 *
 * Lifted from process-group-manager without its shortcut editing. The process PUT came
 * back with Bulk Update Ownership (W4), and reference removal (W5) will use it too, with
 * two of PGM's rules: `ProcessJson` is sent as a JSON *string* (an object returns HTTP
 * 500), and `SuppressChangeNotification` defaults to true.
 */

import { isPmError, pmRequest, type PmContext } from './client.ts';
import type {
  LatestRevisionResponse,
  ProcessJson,
  ProcessResponse,
  ProcessUpdateEnvelope,
  PublishRequest,
} from './types.ts';

/** Subset of /EditPermissions we act on. */
export interface EditPermissions {
  CanEdit: boolean;
  IsArchived: boolean;
  ProcessName: string;
  [key: string]: unknown;
}

export function getProcess(ctx: PmContext, processUniqueId: string): Promise<ProcessResponse> {
  return pmRequest<ProcessResponse>(ctx, { path: `/Api/v1/Processes/${processUniqueId}` });
}

/** What `GET /Api/v1/Processes/{id}` said: the process, or that it is archived. */
export type ProcessRead = { kind: 'model'; response: ProcessResponse } | { kind: 'archived' };

/**
 * Reading the process GET's envelope.
 *
 * For an archived process the tenant answers **200** with only
 * `{"success": true, "isArchived": true}` and no `processJson` (measured in S1, again
 * in the S2 cleanup, and in the W4 live test). 404 is for a deleted process. Code that
 * took "not found" to mean "archived", or read the envelope as if it were the model,
 * got both wrong, so every caller goes through here.
 */
export function readProcessEnvelope(wrapper: unknown): ProcessRead {
  const model = readField(wrapper, 'processJson').value;
  if (typeof model === 'object' && model !== null) return { kind: 'model', response: wrapper as ProcessResponse };
  const archived = readField(wrapper, 'isArchived').value;
  if (archived === true || String(archived).toLowerCase() === 'true') return { kind: 'archived' };
  throw new Error('Process Manager answered the process read with neither a process nor an archived flag.');
}

export async function readProcess(ctx: PmContext, processUniqueId: string): Promise<ProcessRead> {
  return readProcessEnvelope(await pmRequest<unknown>(ctx, { path: `/Api/v1/Processes/${processUniqueId}` }));
}

export function getEditPermissions(
  ctx: PmContext,
  processUniqueId: string,
): Promise<EditPermissions> {
  return pmRequest<EditPermissions>(ctx, {
    path: `/Api/v1/Processes/${processUniqueId}/EditPermissions`,
  });
}

/**
 * Cheap concurrency pre-check — a few bytes instead of a whole process document.
 * Call immediately before writing and compare against the value you planned against.
 */
export function getLatestRevision(
  ctx: PmContext,
  processUniqueId: string,
): Promise<LatestRevisionResponse> {
  return pmRequest<LatestRevisionResponse>(ctx, {
    path: `/bff/Process/api/v1/processes/${processUniqueId}/revisions/latest`,
  });
}

/**
 * Archive one process, in place, with a comment.
 *
 * Takes no group: it archives the process wherever it currently sits
 * (API_ARCHITECTURE.md, "ArchiveProcess archives in place"). On an approvals-enabled
 * tenant a 200 here means *pending*, not archived; whether it is archived is read back
 * separately (`getArchiveState`), never inferred from this call.
 */
export function archiveProcess(
  ctx: PmContext,
  processUniqueId: string,
  comment: string,
): Promise<unknown> {
  return pmRequest<unknown>(ctx, {
    path: '/Process/Edit/ArchiveProcess',
    method: 'POST',
    body: { processUniqueId, comment },
    // Write policy: a 5xx or a dropped connection leaves the outcome unknown, and an
    // archive can report failure and still take effect. The final read settles it.
    retry: 'write',
  });
}

export interface ArchiveState {
  /** False when the active-process read answers 404. */
  found: boolean;
  /** null when the payload does not report the field. Absent is not false. */
  isArchived: boolean | null;
  /** The revision the approval override has to publish. null when not returned. */
  revisionEditId: number | null;
}

function readField(source: unknown, name: string): { present: boolean; value: unknown } {
  if (typeof source !== 'object' || source === null) return { present: false, value: undefined };
  const record = source as Record<string, unknown>;
  // The script looks fields up case-insensitively, because PowerShell does. Matching that
  // here means a tenant that sends `IsArchived` is not read as one that sends nothing.
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? { present: false, value: undefined } : { present: true, value: record[key] };
}

/**
 * Whether a process is archived, and its current revision, from one fresh read.
 *
 * `isArchived` may sit on the model or on the envelope around it, so both are tried,
 * model first. A 404 means the process has left the active side, which immediately
 * after an accepted archive is the archive having taken effect.
 */
export async function getArchiveState(ctx: PmContext, processUniqueId: string): Promise<ArchiveState> {
  let wrapper: unknown;
  try {
    wrapper = await pmRequest<unknown>(ctx, { path: `/Api/v1/Processes/${processUniqueId}` });
  } catch (error) {
    if (isPmError(error) && error.status === 404) {
      return { found: false, isArchived: null, revisionEditId: null };
    }
    throw error;
  }

  const modelField = readField(wrapper, 'processJson');
  const model = modelField.present && modelField.value ? modelField.value : wrapper;

  let isArchived: boolean | null = null;
  for (const source of [model, wrapper]) {
    const field = readField(source, 'isArchived');
    if (field.present && field.value !== null && field.value !== undefined) {
      isArchived = field.value === true || String(field.value).toLowerCase() === 'true';
      break;
    }
  }

  let revisionEditId: number | null = null;
  for (const source of [model, wrapper]) {
    const value = Number(readField(source, 'ProcessRevisionEditId').value);
    if (Number.isInteger(value) && value > 0) {
      revisionEditId = value;
      break;
    }
  }

  return { found: true, isArchived, revisionEditId };
}

export interface VariationMember {
  uniqueId: string;
  /** The variation's own name, e.g. "Partner". The set carries the process name. */
  variationName: string;
  isArchived: boolean | null;
}

export interface VariationSet {
  id: number;
  name: string;
  group: { id: number | null; name: string; uniqueId: string | null } | null;
  self: VariationMember | null;
  others: VariationMember[];
}

function member(value: unknown): VariationMember | null {
  const uniqueId = readField(value, 'ProcessUniqueId').value;
  if (typeof uniqueId !== 'string' || uniqueId === '') return null;
  const name = readField(value, 'VariationName').value;
  const archived = readField(value, 'IsArchived').value;
  return {
    uniqueId,
    variationName: typeof name === 'string' ? name : '',
    isArchived: typeof archived === 'boolean' ? archived : null,
  };
}

/**
 * The variation set a process belongs to, or null when it belongs to none.
 *
 * `variationSetData` sits at the top level of the process GET, beside `processJson`, not
 * inside it, which is why the R3 notes said no read names a variation's relatives. It
 * names every sibling, and the siblings are not in the tree at all: the tree shows one
 * node per set (API_ARCHITECTURE.md, "Variations").
 */
export async function getVariationSet(ctx: PmContext, processUniqueId: string): Promise<VariationSet | null> {
  const wrapper = await pmRequest<unknown>(ctx, { path: `/Api/v1/Processes/${processUniqueId}` });
  const data = readField(wrapper, 'variationSetData').value;
  if (typeof data !== 'object' || data === null) return null;

  const id = Number(readField(data, 'Id').value);
  const name = readField(data, 'Name').value;
  const group = readField(data, 'Group').value;
  const others = readField(data, 'OtherVariedProcesses').value;
  const groupId = Number(readField(group, 'Id').value);
  const groupName = readField(group, 'Name').value;
  const groupUniqueId = readField(group, 'UniqueId').value;

  return {
    id: Number.isInteger(id) ? id : 0,
    name: typeof name === 'string' ? name : '',
    group:
      typeof group === 'object' && group !== null
        ? {
            id: Number.isInteger(groupId) ? groupId : null,
            name: typeof groupName === 'string' ? groupName : '',
            uniqueId: typeof groupUniqueId === 'string' ? groupUniqueId : null,
          }
        : null,
    self: member(readField(data, 'VariedProcess').value),
    others: Array.isArray(others) ? others.map(member).filter((m): m is VariationMember => m !== null) : [],
  };
}

export interface UpdateOptions {
  changeDescription: string;
  submitForApproval?: boolean;
  /** Opt out only with an explicit, confirmed decision. */
  suppressChangeNotification?: boolean;
}

/**
 * The PUT envelope, lifted from process-group-manager.
 *
 * Exported separately from the request so the exact bytes can be asserted in tests.
 * `DoPublish` is always false: the UI never publishes through it, it saves and then
 * calls Publish. `SuppressChangeNotification` defaults to true, where the PowerShell sent
 * false and notified every stakeholder once per row (SPEC-WEB.md, Bulk Update Ownership).
 */
export function buildUpdateEnvelope(processJson: ProcessJson, options: UpdateOptions): ProcessUpdateEnvelope {
  return {
    // Double-serialised: the server rejects a plain object with a 500.
    ProcessJson: JSON.stringify(processJson),
    ChangeDescription: options.changeDescription,
    DoSubmitForApproval: options.submitForApproval ?? false,
    DoPublish: false,
    SuppressChangeNotification: options.suppressChangeNotification ?? true,
    SharedActivityCollectionEditModel: {
      ActivitiesToDelete: [],
      ActivitiesToShare: [],
      ActivitiesToUnlink: [],
    },
    VariantConnectionChangeStates: [],
  };
}

/** Save one process. Returns 204 with no body on success. */
export function updateProcess(
  ctx: PmContext,
  processUniqueId: string,
  envelope: ProcessUpdateEnvelope,
): Promise<void> {
  return pmRequest<void>(ctx, {
    path: `/Api/v1/Processes/${processUniqueId}`,
    method: 'PUT',
    body: envelope,
    // A dropped connection may have saved it. Not sent twice; the final read settles it.
    retry: 'write',
  });
}

export interface PublishResponse {
  actionUrl: string;
}

/**
 * Publish, producing the major version bump (2.x -> 3.0).
 *
 * Note the revision id is sent as a *string* here, unlike the number carried in
 * processJson. That asymmetry is the server's, and it is load-bearing.
 *
 * The message is always sent. Whether a tenant demands one is a setting nobody can read
 * in advance, and the R11 override that succeeded without one may have predated it.
 */
export function publishProcess(
  ctx: PmContext,
  processUniqueId: string,
  processRevisionEditId: number,
  publishMessage: string,
): Promise<PublishResponse> {
  const body: PublishRequest = {
    ProcessRevisionEditId: String(processRevisionEditId),
    IsPublishNow: true,
    PublishMessage: publishMessage,
  };
  return pmRequest<PublishResponse>(ctx, {
    path: `/Api/v1/Processes/${processUniqueId}/Publish`,
    method: 'POST',
    body,
    retry: 'write',
  });
}

// --------------------------------------------------------------- listing

/** A row from the process list endpoint. */
export interface ProcessListItem {
  processId: number;
  processName: string;
  processUniqueId: string;
  processState: string;
  groupId: number;
  groupUniqueId: string;
  groupName: string;
  processOwner: string;
  processExpert: string;
  /**
   * False when the row's group was deleted while the process sat in the archive. Not
   * always present; absent means "not reported", never "deleted"
   * (API_ARCHITECTURE.md, "groupExists").
   */
  groupExists?: boolean;
}

export interface ProcessListPage {
  items: ProcessListItem[];
  totalItemCount: number;
}

/**
 * List types accepted by the process list endpoint.
 * Values taken from Nintex's own bulk-operations script.
 */
export const ProcessListType = {
  Active: 0,
  Archived: 7,
} as const;

/** Matches the page size that script uses; the endpoint is 1-indexed. */
export const LIST_PAGE_SIZE = 200;

export function listProcesses(
  ctx: PmContext,
  page: number,
  pageSize: number = LIST_PAGE_SIZE,
  listType: number = ProcessListType.Active,
): Promise<ProcessListPage> {
  return pmRequest<ProcessListPage>(ctx, {
    path: '/Bff/Process/api/v1/processes',
    query: { Page: page, PageSize: pageSize, ListType: listType },
  });
}

/**
 * Walk every page of the process list.
 *
 * Termination follows the reference script: a short page means the end. Relying on
 * totalItemCount alone would loop forever if the count and the pages ever disagreed,
 * so a hard page cap backstops it.
 */
export async function listAllProcesses(
  ctx: PmContext,
  options: {
    pageSize?: number;
    listType?: number;
    onPage?: (loaded: number, total: number) => void;
    maxPages?: number;
  } = {},
): Promise<ProcessListItem[]> {
  const pageSize = options.pageSize ?? LIST_PAGE_SIZE;
  const listType = options.listType ?? ProcessListType.Active;
  const maxPages = options.maxPages ?? 500;

  const all: ProcessListItem[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const result = await listProcesses(ctx, page, pageSize, listType);
    const items = result?.items ?? [];
    all.push(...items);
    options.onPage?.(all.length, result?.totalItemCount ?? all.length);
    if (items.length < pageSize) break;
  }

  return all;
}

// --------------------------------------------------------------- documents

export interface GroupDocuments {
  /** Every document whose primary group this is, archived or not. */
  total: number;
  /** Names from the first page of each list, for the report. Archived ones say so. */
  names: string[];
}

/**
 * The documents in one group, archived or not.
 *
 * Documents block DeleteGroup (409, spike S1), so cleanup checks for them first and
 * keeps the group rather than sending a delete it knows will be refused. One page of
 * each list is enough: the question is "any?", and the names are for the report.
 *
 * Two reads, because `ListType=All` does not include archived documents. Measured in S1
 * and raised in Cowork's review of W2b (F1): with the test document archived, `All`
 * returned 0 rows, `Archived` returned 1, and that document still made DeleteGroup
 * answer 409. Reading `All` alone called that group deletable.
 */
export async function getGroupDocuments(ctx: PmContext, groupUniqueId: string): Promise<GroupDocuments> {
  const read = (listType: 'All' | 'Archived') =>
    pmRequest<{ items?: Array<{ documentName?: string }> | null; totalItemCount?: number }>(ctx, {
      path: '/bff/document/api/v1/documents',
      query: { Page: 1, PageSize: 200, ListType: listType, DocumentType: 'All', ProcessGroupId: groupUniqueId },
    });
  const count = (response: Awaited<ReturnType<typeof read>>) => {
    const items = response?.items ?? [];
    return {
      total: typeof response?.totalItemCount === 'number' ? Math.max(response.totalItemCount, items.length) : items.length,
      names: items.map((item) => item.documentName ?? '').filter((name) => name !== ''),
    };
  };
  const live = count(await read('All'));
  const archived = count(await read('Archived'));
  return {
    total: live.total + archived.total,
    names: [...live.names, ...archived.names.map((name) => `${name} (archived)`)],
  };
}
