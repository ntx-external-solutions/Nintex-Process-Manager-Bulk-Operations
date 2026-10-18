/**
 * Checking a plan against the tenant one last time, immediately before writing.
 *
 * A plan can be built from a cached tree (ui/treeCache.ts), and planning from a cache
 * does not authorise writing from one. So before Apply, this reads only what the plan
 * touches: the level each planned item was seen in. One request per distinct parent,
 * bounded by the size of the plan rather than the size of the tenant.
 *
 * Lifted from process-group-manager, where it checked group creates, renames and moves.
 * Every operation here acts on things that already exist, so the question reduces to
 * one: is each item still where the preview said it was?
 *
 * It reads. It never writes and it never repairs. A plan that no longer matches the
 * tenant is one the operator has to look at again, because the preview they approved
 * described a tree that no longer exists. It also does not prevent a race with another
 * operator; it narrows the window to the time between this read and the first write.
 */

import type { TreeItem } from '../pm/types.ts';
import type { PlanGateway } from './load.ts';

/** Something the plan acts on, and where the preview saw it. */
export interface Placement {
  uniqueId: string;
  /** null for the top level. */
  parentUniqueId: string | null;
  /** What the operator calls it, for the finding. */
  display: string;
  /** Where the operator saw it, for the finding. */
  parentDisplay: string;
}

export interface StaleFinding {
  uniqueId: string;
  display: string;
  message: string;
}

/**
 * Read one level, tolerating failure.
 *
 * A parent we cannot read is not evidence of a conflict, and refusing to apply because
 * a check could not run would make the safety net worse than not having one. Returns
 * null, and the caller skips that comparison.
 */
async function childrenOf(
  gateway: PlanGateway,
  parentUniqueId: string | null,
): Promise<TreeItem[] | null> {
  try {
    const response = await gateway.groupsTree(parentUniqueId);
    return response.treeItems ?? [];
  } catch {
    return null;
  }
}

/** Map key for the root level, which has no uniqueId of its own. */
const ROOT = ' root';

const keyOf = (parentUniqueId: string | null): string => parentUniqueId ?? ROOT;
const idOf = (key: string): string | null => (key === ROOT ? null : key);

/**
 * What has moved or gone since the plan was built.
 *
 * An empty array means the tenant still looks the way the preview said it did.
 */
export async function revalidatePlacements(
  gateway: PlanGateway,
  placements: readonly Placement[],
  options: { concurrency?: number } = {},
): Promise<StaleFinding[]> {
  const concurrency = Math.max(1, options.concurrency ?? 6);

  // Every level gathered first so each is read exactly once however many items share it.
  const keys = [...new Set(placements.map((p) => keyOf(p.parentUniqueId)))];

  const levels = new Map<string, TreeItem[] | null>();
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);
    const read = await Promise.all(
      batch.map(async (key) => ({ key, items: await childrenOf(gateway, idOf(key)) })),
    );
    for (const { key, items } of read) levels.set(key, items);
  }

  const findings: StaleFinding[] = [];
  for (const placement of placements) {
    const items = levels.get(keyOf(placement.parentUniqueId));
    if (!items) continue;

    if (!items.some((item) => item.uniqueId === placement.uniqueId)) {
      findings.push({
        uniqueId: placement.uniqueId,
        display: placement.display,
        message:
          `"${placement.display}" is not in ${placement.parentDisplay} any more. Somebody ` +
          `has moved, archived or deleted it since this plan was built. Plan again from ` +
          `the current tree.`,
      });
    }
  }

  return findings;
}
