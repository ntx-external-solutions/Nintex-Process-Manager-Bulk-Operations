/**
 * Process read/write endpoints.
 *
 * Lifted from process-group-manager without its shortcut editing and its process PUT.
 * The PUT comes back with Bulk Update Ownership (W4) and reference removal (W5), and
 * when it does, two of PGM's rules come with it: `ProcessJson` is sent as a JSON
 * *string* (an object returns HTTP 500), and `SuppressChangeNotification` defaults to
 * true.
 */

import { isPmError, pmRequest, type PmContext } from './client.ts';
import type { LatestRevisionResponse, ProcessResponse, PublishRequest } from './types.ts';

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
