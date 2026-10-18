/**
 * Process read/write endpoints.
 *
 * Lifted from process-group-manager without its shortcut editing and its process PUT.
 * The PUT comes back with Bulk Update Ownership (W4) and reference removal (W5), and
 * when it does, two of PGM's rules come with it: `ProcessJson` is sent as a JSON
 * *string* (an object returns HTTP 500), and `SuppressChangeNotification` defaults to
 * true.
 */

import { pmRequest, type PmContext } from './client.ts';
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

export interface PublishResponse {
  actionUrl: string;
}

/**
 * Publish, producing the major version bump (2.x -> 3.0).
 *
 * Note the revision id is sent as a *string* here, unlike the number carried in
 * processJson. That asymmetry is the server's, and it is load-bearing.
 */
export function publishProcess(
  ctx: PmContext,
  processUniqueId: string,
  processRevisionEditId: number,
): Promise<PublishResponse> {
  const body: PublishRequest = {
    ProcessRevisionEditId: String(processRevisionEditId),
    IsPublishNow: true,
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
