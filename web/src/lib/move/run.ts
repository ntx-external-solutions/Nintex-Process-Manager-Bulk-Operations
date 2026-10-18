/**
 * Applying a move plan, one ReorderTreeNodes call per node, then settling every outcome
 * from a fresh read of the tree and the process listing.
 */

import { failureOf } from '../archive/outcome.ts';
import { step, type Journal } from '../exec/journal.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import { forEachBatched, type Controls } from '../exec/runner.ts';
import type { TreeItem } from '../pm/types.ts';
import { indexEntry, type ProcessIndex } from '../tenant/state.ts';
import { describeCost, type MoveItem, type MovePlan } from './plan.ts';
import { describeDestination } from './select.ts';

export interface MoveGateway {
  move(item: {
    uniqueId: string;
    nodeType: string;
    newParentUniqueId: string | null;
    oldParentUniqueId: string | null;
  }): Promise<{ success: boolean; errors: unknown[] | null }>;
}

/** The script's Mode 3 vocabulary, plus Blocked for a tenant refusal and Unverified. */
export const MOVE_STATUSES = ['Success', 'Preview', 'Skipped', 'Blocked', 'Failed', 'Unverified'] as const;

function describeErrors(errors: unknown[] | null): string | null {
  if (!errors || errors.length === 0) return null;
  return errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
}

function moveRow(plan: MovePlan, item: MoveItem, status: string, message: string, statusCode = 0): ResultRow {
  return resultRow({
    objectType: item.kind === 'group' ? 'ProcessGroup' : 'Process',
    objectId: item.uniqueId,
    name: item.title,
    operation: 'UpdateLocation',
    status,
    message,
    groupId: plan.destination.id,
    statusCode,
  });
}

/** The items a run will send: every move, plus the needs-choice items the operator ticked. */
export function itemsToMove(plan: MovePlan, chosen: ReadonlySet<string>): MoveItem[] {
  return [...plan.moves, ...plan.needsChoice.filter((item) => chosen.has(item.uniqueId))];
}

export async function runMoves(
  gateway: MoveGateway,
  journal: Journal,
  plan: MovePlan,
  chosen: ReadonlySet<string>,
  controls: Controls,
  options: { concurrency?: number; onProgress?: (done: number, total: number, label: string) => void } = {},
): Promise<ResultRow[]> {
  const toDisplay = describeDestination(plan.destination);
  const rows: ResultRow[] = [...plan.skipped];

  for (const item of plan.needsChoice) {
    if (chosen.has(item.uniqueId)) continue;
    rows.push(
      moveRow(plan, item, 'Skipped', `Not chosen. ${describeCost(item)}${item.tenantMessage ? ` The tenant said: ${item.tenantMessage}` : ''}`),
    );
  }

  const { results, notAttempted } = await forEachBatched(
    itemsToMove(plan, chosen),
    controls,
    async (item): Promise<ResultRow> => {
      const moveStep = step.move(item.uniqueId);
      if (journal.phaseOf(moveStep) !== null) {
        return moveRow(plan, item, 'Skipped', 'Already attempted earlier in this run, so not sent again.');
      }
      journal.append({ step: moveStep, kind: 'node.move', phase: 'begin' });
      try {
        const response = await gateway.move({
          uniqueId: item.uniqueId,
          nodeType: item.nodeType,
          newParentUniqueId: plan.destination.uniqueId,
          oldParentUniqueId: item.fromParentUniqueId,
        });
        if (response?.success !== true) {
          journal.append({ step: moveStep, kind: 'node.move', phase: 'fail' });
          return moveRow(
            plan,
            item,
            'Failed',
            `The tenant did not confirm the move${describeErrors(response?.errors ?? null) ? `: ${describeErrors(response?.errors ?? null)}` : '.'}`,
          );
        }
        journal.append({ step: moveStep, kind: 'node.move', phase: 'commit' });
        return moveRow(plan, item, 'Success', `Moved from ${item.fromDisplay} to ${toDisplay}. ${describeCost(item)}`);
      } catch (error) {
        journal.append({ step: moveStep, kind: 'node.move', phase: 'fail' });
        const fatal = controls.isFatal(error);
        if (fatal) {
          controls.stop(fatal);
          return moveRow(plan, item, 'Failed', `Stopped while moving: ${fatal} The final read decides whether it moved.`);
        }
        const failure = failureOf(error);
        const refused = failure.status >= 400 && failure.status <= 499;
        return moveRow(
          plan,
          item,
          refused ? 'Blocked' : 'Failed',
          refused
            ? `HTTP ${failure.status} refused by the tenant: ${failure.detail ?? failure.error}`
            : `Move failed (${failure.status > 0 ? `HTTP ${failure.status}` : 'no response'}): ${failure.detail ?? failure.error}`,
          failure.status,
        );
      }
    },
    {
      concurrency: options.concurrency,
      label: (item) => item.title,
      onProgress: (p) => options.onProgress?.(p.done, p.total, p.label),
    },
  );

  rows.push(...results);
  for (const item of notAttempted) {
    rows.push(moveRow(plan, item, 'Skipped', `Not attempted: ${controls.stoppedReason() ?? 'the run stopped'}`));
  }
  return rows;
}

const SENT: ReadonlySet<string> = new Set(['Success', 'Blocked', 'Failed']);

/**
 * Settle each move against fresh reads: the destination's level and every source level,
 * and the process listing for variation siblings, which are not in the tree.
 *
 *  - in the destination now: Success, whatever the call said;
 *  - still in its old group after a call that said yes: Failed;
 *  - in neither level after a call that said yes: Unverified;
 *  - a sibling of a variation that moved gets its own row, because the move changed it
 *    too: Success if the listing puts it in the destination, Unverified otherwise.
 */
export function settleMoves(
  rows: readonly ResultRow[],
  plan: MovePlan,
  levels: ReadonlyMap<string, readonly TreeItem[] | null>,
  after: ProcessIndex | null,
): ResultRow[] {
  const destKey = plan.destination.uniqueId ?? '';
  const items = new Map([...plan.moves, ...plan.needsChoice].map((item) => [item.uniqueId, item]));
  const toDisplay = describeDestination(plan.destination);
  const out: ResultRow[] = [];

  for (const row of rows) {
    const item = items.get(row.objectId);
    if (row.operation !== 'UpdateLocation' || !item || !SENT.has(row.status)) {
      out.push(row);
      continue;
    }

    const destination = levels.get(destKey);
    const source = levels.get(item.fromParentUniqueId ?? '');
    const inDestination = destination ? destination.some((i) => i.uniqueId === item.uniqueId) : null;
    const inSource = source ? source.some((i) => i.uniqueId === item.uniqueId) : null;
    let settled = row;

    if (inDestination === true) {
      if (row.status !== 'Success') {
        settled = { ...row, status: 'Success', message: `Moved to ${toDisplay}, confirmed by the final read, although the run reported: ${row.message}` };
      }
    } else if (row.status === 'Success' && inDestination === false) {
      settled =
        inSource === true
          ? { ...row, status: 'Failed', message: `The move was accepted but it is still in ${item.fromDisplay}.` }
          : { ...row, status: 'Unverified', message: `The move was accepted but the final read finds it in neither ${item.fromDisplay} nor ${toDisplay}.` };
    }
    out.push(settled);

    if (settled.status === 'Success') {
      for (const sibling of item.siblings) {
        const entry = after ? indexEntry(after, sibling.uniqueId) : null;
        const moved = entry !== null && plan.destination.uniqueId !== null && entry.groupUniqueId?.toLowerCase() === plan.destination.uniqueId.toLowerCase();
        out.push(
          resultRow({
            objectId: sibling.uniqueId,
            name: entry?.name || sibling.name,
            operation: 'UpdateLocation',
            status: moved ? 'Success' : 'Unverified',
            message: moved
              ? `Moved to ${toDisplay} with its variation set, as a sibling of '${item.title}'.`
              : `Expected to move with its variation set ('${item.title}'), but the final read ${entry ? `shows it in group ${entry.groupId ?? 'unknown'}` : 'does not list it'}.`,
            groupId: entry?.groupId ?? null,
          }),
        );
      }
    }
  }

  return out;
}
