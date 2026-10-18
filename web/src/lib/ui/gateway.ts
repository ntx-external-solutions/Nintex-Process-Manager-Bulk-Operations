/**
 * The browser's half of the proxy.
 *
 * Everything the UI does against Process Manager goes through here, which keeps the
 * fetch plumbing — and, more importantly, the handling of a dead session — in one
 * place. Long runs outlive their token, so "signed out" is a normal outcome of any
 * call, not an exception.
 */

import type { ArchiveGateway, ArchiveState } from '../archive/outcome.ts';
import type { FactsGateway } from '../cleanup/facts.ts';
import type { CleanupGateway } from '../cleanup/run.ts';
import type { PlanningGateway } from '../delete/planner.ts';
import type { MovePlanReads } from '../move/plan.ts';
import type { MoveGateway } from '../move/run.ts';
import type { OwnershipGateway } from '../ownership/run.ts';
import type { OwnershipRead, SetOwnershipResult } from '../pm/ownership.ts';
import type { ActiveRead } from '../pm/dependencies.ts';
import type { DirectoryUser } from '../pm/scim.ts';
import type { GroupViewerCount, MovableNodeType } from '../pm/groups.ts';
import type { TreeItem, ValidateActionResponse } from '../pm/types.ts';
import type { PlanGateway } from '../plan/load.ts';
import type { Operation, ProcessSummary } from '../pm/operations.ts';
import type { ProcessListPage, VariationSet } from '../pm/processes.ts';
import type { ChildTreeItemsResponse } from '../pm/types.ts';

export class PmRequestError extends Error {
  /** The session is gone. Stop the run and send them back to sign in. */
  readonly signedOut: boolean;
  /** The tenant's HTTP status, when Process Manager answered at all. */
  readonly status: number | null;
  /** The tenant's own reason, extracted from its response body. */
  readonly tenantMessage: string | null;
  /** The tenant's raw response, when there was one. */
  readonly detail: string | null;

  constructor(
    message: string,
    options: {
      signedOut?: boolean;
      status?: number | null;
      tenantMessage?: string | null;
      detail?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'PmRequestError';
    this.signedOut = options.signedOut ?? false;
    this.status = options.status ?? null;
    this.tenantMessage = options.tenantMessage ?? null;
    this.detail = options.detail ?? null;
  }
}

interface ProxyResponse {
  ok?: boolean;
  result?: unknown;
  error?: string;
  status?: number | null;
  message?: string | null;
  detail?: string;
  signedOut?: boolean;
}

export async function callPm<T>(operation: Operation): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/pm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation),
    });
  } catch {
    // Offline, or the tab lost the network mid-run. Not a Process Manager problem.
    throw new PmRequestError('Could not reach the server.');
  }

  const payload = (await response.json().catch(() => ({}))) as ProxyResponse;

  if (!response.ok) {
    throw new PmRequestError(payload.error ?? `Request failed (${response.status}).`, {
      signedOut: payload.signedOut === true,
      status: typeof payload.status === 'number' ? payload.status : null,
      tenantMessage: typeof payload.message === 'string' ? payload.message : null,
      detail: payload.detail ?? null,
    });
  }

  return payload.result as T;
}

/** The reads the planners need, over the proxy. */
export interface BrowserGateway extends PlanGateway {
  processSummary(processUniqueId: string): Promise<ProcessSummary>;
  processesList(page: number, listType: number): Promise<ProcessListPage>;
  variationSet(processUniqueId: string): Promise<VariationSet | null>;
}

export function browserGateway(): BrowserGateway {
  return {
    groupsTree: (parentUniqueId) =>
      callPm<ChildTreeItemsResponse>({ op: 'groups.tree', parentUniqueId }),
    processSummary: (processUniqueId) =>
      callPm<ProcessSummary>({ op: 'process.summary', processUniqueId }),
    processesList: (page, listType) =>
      callPm<ProcessListPage>({ op: 'processes.list', page, listType }),
    variationSet: (processUniqueId) =>
      callPm<VariationSet | null>({ op: 'process.variationSet', processUniqueId }),
  };
}

/**
 * The archive writes, over the same proxy. Each names one process; the proxy refuses
 * anything else (lib/pm/operations.ts).
 */
export function browserArchiveGateway(): ArchiveGateway {
  return {
    archive: (processUniqueId, comment) => callPm({ op: 'process.archive', processUniqueId, comment }),
    archiveState: (processUniqueId) =>
      callPm<ArchiveState>({ op: 'process.archiveState', processUniqueId }),
    publishNow: (processUniqueId, processRevisionEditId, publishMessage) =>
      callPm({ op: 'process.publishNow', processUniqueId, processRevisionEditId, publishMessage }),
  };
}

/** Reading and deleting groups for folder cleanup. Each call names one group. */
export function browserCleanupGateway(): CleanupGateway & FactsGateway {
  const childItems = async (groupUniqueId: string | null): Promise<readonly TreeItem[]> =>
    (await callPm<ChildTreeItemsResponse>({ op: 'groups.tree', parentUniqueId: groupUniqueId })).treeItems ?? [];
  return {
    childItems,
    groupDocuments: (groupUniqueId) =>
      callPm<{ total: number; names: string[] }>({ op: 'group.documents', groupUniqueId }),
    deleteGroup: (groupUniqueId) => callPm({ op: 'group.delete', groupUniqueId }),
  };
}

/** Moving nodes, and the reads a move plan needs. Each call names one node. */
export function browserMoveGateway(): MoveGateway & Omit<MovePlanReads, 'isFatal' | 'onProgress'> {
  return {
    move: (item) =>
      callPm<{ success: boolean; errors: unknown[] | null }>({
        op: 'node.move',
        uniqueId: item.uniqueId,
        nodeType: item.nodeType as MovableNodeType,
        newParentUniqueId: item.newParentUniqueId,
        oldParentUniqueId: item.oldParentUniqueId,
      }),
    validateMove: (processUniqueId, destinationGroupUniqueId) =>
      callPm<ValidateActionResponse>({ op: 'process.validateMove', processUniqueId, destinationGroupUniqueId }),
    revision: (processUniqueId) => callPm<ProcessSummary>({ op: 'process.summary', processUniqueId }),
    variationSet: (processUniqueId) =>
      callPm<VariationSet | null>({ op: 'process.variationSet', processUniqueId }),
    viewers: (groupIds) => callPm<GroupViewerCount[]>({ op: 'groups.viewers', groupIds }),
  };
}

/**
 * Setting owners and experts, and the reads around it. Each write names one process. The
 * SCIM key goes to the server for one directory read and is kept nowhere.
 */
export function browserOwnershipGateway(): OwnershipGateway & {
  ownership(processUniqueId: string): Promise<OwnershipRead>;
  processesList(page: number, listType: number): Promise<ProcessListPage>;
  directory(scimApiKey: string): Promise<DirectoryUser[]>;
} {
  return {
    setOwnership: (request) => callPm<SetOwnershipResult>({ op: 'process.setOwnership', ...request }),
    publishNow: (processUniqueId, processRevisionEditId, publishMessage) =>
      callPm({ op: 'process.publishNow', processUniqueId, processRevisionEditId, publishMessage }),
    ownership: (processUniqueId) => callPm<OwnershipRead>({ op: 'process.ownership', processUniqueId }),
    processesList: (page, listType) => callPm<ProcessListPage>({ op: 'processes.list', page, listType }),
    directory: (scimApiKey) => callPm<DirectoryUser[]>({ op: 'users.directory', scimApiKey }),
  };
}

/**
 * The reads a Bulk Delete plan is built from. Phase 2 of W5 plans without writing, so
 * `restore` refuses: a dry run that restored a process would not be a dry run.
 */
export function browserPlanningGateway(): PlanningGateway {
  return {
    listProcesses: (page, listType) => callPm<ProcessListPage>({ op: 'processes.list', page, listType }),
    checkDependencies: (processUniqueId) => callPm<unknown>({ op: 'process.dependencies', processUniqueId }),
    readModel: (processUniqueId) => callPm<ActiveRead>({ op: 'process.model', processUniqueId }),
    readArchivedModels: (processUniqueIds) =>
      callPm<Record<string, unknown>[]>({ op: 'processes.archivedModels', processUniqueIds: [...processUniqueIds] }),
    restore: async () => {
      throw new Error('A dry run does not restore anything.');
    },
  };
}

/** A group's path, top first, without the tenant. */
export function groupBreadcrumb(groupUniqueId: string): Promise<string[]> {
  return callPm<string[]>({ op: 'group.breadcrumb', groupUniqueId });
}

// -------------------------------------------------------------- session

export interface SessionInfo {
  tenant: string;
  /** Origin and tenant, e.g. https://demo.promapp.com/tenant. Empty when unknown. */
  siteUrl: string;
  username: string;
  expiresAt: number;
}

/**
 * Who, if anyone, is signed in.
 *
 * The session cookie is httpOnly, so the page cannot read it and has to ask. Returns
 * null rather than throwing: "not signed in" is an answer, not a failure.
 */
export async function currentSession(): Promise<SessionInfo | null> {
  try {
    const response = await fetch('/api/auth', { method: 'GET' });
    if (!response.ok) return null;
    const payload = (await response.json()) as { signedIn?: boolean } & Partial<SessionInfo>;
    if (payload.signedIn !== true) return null;
    return {
      tenant: payload.tenant ?? '',
      siteUrl: payload.siteUrl ?? '',
      username: payload.username ?? '',
      expiresAt: payload.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}
