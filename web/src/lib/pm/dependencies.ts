/**
 * The reads Bulk Delete plans with: the dependency check, and process models in either
 * state.
 *
 * Ported from `Get-ProcessDependencyClaim`, `Get-NpmProcessModel` and
 * `Get-NpmArchivedProcessModel` in NintexProcessDependencies.ps1. Every one is a read;
 * the delete engine (lib/delete) runs in the browser and calls them through the proxy.
 */

import { pmRequest, type PmContext } from './client.ts';
import { readProcess } from './processes.ts';

/** Both directions, every category (API_ARCHITECTURE.md, "Dependency Checking APIs"). */
export const DEPENDENCY_SEARCH_BEHAVIOR = 31;

/**
 * The archived batch read's limit. The tenant refuses 21 or more ids with 400 "The
 * processUniqueIds parameter maximum size is 20." It is a count, not URL length
 * (API_ARCHITECTURE.md, measured after W5 phase 3). The script and this port both used
 * 25, so every full batch was refused.
 */
export const ARCHIVED_BATCH_SIZE = 20;

/**
 * `CheckProcessDependencies`, body as sent. The tenant answers 200 with an empty body for
 * a process with no dependencies, which arrives here as undefined and goes back as null:
 * a clean check, not a failed one.
 */
export async function checkDependencies(ctx: PmContext, processUniqueId: string): Promise<unknown> {
  const body = await pmRequest<unknown>(ctx, {
    path: `/Api/v1/Processes/${processUniqueId}/CheckProcessDependencies`,
    query: { searchBehavior: DEPENDENCY_SEARCH_BEHAVIOR },
  });
  return body ?? null;
}

/** The active read: the model, or that the process is archived (`readProcessEnvelope`). */
export type ActiveRead = { kind: 'model'; model: Record<string, unknown> } | { kind: 'archived' };

export async function readActiveModel(ctx: PmContext, processUniqueId: string): Promise<ActiveRead> {
  const read = await readProcess(ctx, processUniqueId);
  return read.kind === 'model' ? { kind: 'model', model: read.response.processJson } : { kind: 'archived' };
}

/**
 * The mobile batch read, which serves archived processes and some processes neither
 * listing returns. An id it does not serve is simply absent from the result.
 */
export async function readArchivedModels(ctx: PmContext, processUniqueIds: readonly string[]): Promise<Record<string, unknown>[]> {
  if (processUniqueIds.length === 0) return [];
  // Repeated `processUniqueIds` parameters, which the generic query builder (one value per
  // key) cannot express.
  const params = new URLSearchParams();
  for (const id of processUniqueIds) params.append('processUniqueIds', id);
  const response = await pmRequest<{ data?: Array<{ ProcessModel?: unknown }> | null } | null>(ctx, {
    path: `/mobile/api/v1/processes?${params.toString()}`,
  });
  const data = response?.data;
  const items = Array.isArray(data) ? data : data ? [data] : [];
  return items
    .map((item) => item?.ProcessModel)
    .filter((model): model is Record<string, unknown> => typeof model === 'object' && model !== null);
}
