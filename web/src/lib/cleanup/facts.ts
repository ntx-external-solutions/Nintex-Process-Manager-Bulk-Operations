/**
 * Reading what cleanup needs to decide about each candidate group.
 *
 * Three reads per group: its level of the tree, its documents, and (from the index the
 * archive run already re-read) the archived processes whose group it is. A read that
 * fails is recorded as unknown, which the planner treats as a reason to keep the group.
 */

import type { TreeItem } from '../pm/types.ts';
import type { CoveredGroup } from '../select/resolve.ts';
import type { ProcessIndex } from '../tenant/state.ts';
import type { GroupFacts } from './plan.ts';

export interface FactsGateway {
  childItems(groupUniqueId: string): Promise<readonly TreeItem[]>;
  groupDocuments(groupUniqueId: string): Promise<{ total: number; names: string[] }>;
}

export async function gatherFacts(
  gateway: FactsGateway,
  candidates: readonly CoveredGroup[],
  index: ProcessIndex,
  options: { isFatal?: (error: unknown) => string | null; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, GroupFacts>> {
  const facts = new Map<string, GroupFacts>();
  let done = 0;

  for (const group of candidates) {
    const read = async <T>(call: () => Promise<T>): Promise<T | null> => {
      try {
        return await call();
      } catch (error) {
        // A dead session is not "unknown contents"; it ends the step.
        if (options.isFatal?.(error)) throw error;
        return null;
      }
    };

    const children = await read(() => gateway.childItems(group.uniqueId));
    const documents = await read(() => gateway.groupDocuments(group.uniqueId));
    const archived = [...index.values()]
      .filter((entry) => entry.isArchived && entry.groupUniqueId?.toLowerCase() === group.uniqueId.toLowerCase())
      .map((entry) => ({ uniqueId: entry.uniqueId, name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    facts.set(group.uniqueId, { children, documents, archived });
    options.onProgress?.(++done, candidates.length);
  }

  return facts;
}
