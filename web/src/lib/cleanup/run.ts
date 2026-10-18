/**
 * Deleting the groups an archive left empty, deepest first, one at a time.
 *
 * One at a time because order matters: a parent can only go once its children have.
 * Each group's level is read again immediately before its delete, because the server
 * would delete a group someone has just put a process in only if that process were
 * archived, and would happily orphan it.
 */

import { step, type Journal } from '../exec/journal.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import { type Controls } from '../exec/runner.ts';
import { failureOf } from '../archive/outcome.ts';
import { readAssociatedContents } from '../pm/groups.ts';
import type { TreeItem } from '../pm/types.ts';
import { describeGroupPath, type CleanupDecision } from './plan.ts';

export interface CleanupGateway {
  childItems(groupUniqueId: string | null): Promise<readonly TreeItem[]>;
  deleteGroup(groupUniqueId: string): Promise<unknown>;
}

/**
 * The cleanup statuses, following the script's group rows (`Remove-HoldingGroup`:
 * Success, Skipped, Failed) plus the archive run's Blocked for a tenant refusal and
 * Orphaned for each archived process a deleted group leaves without a home.
 */
export const CLEANUP_STATUSES = ['Success', 'Skipped', 'Blocked', 'Failed', 'Orphaned'] as const;

function groupRow(decision: CleanupDecision, status: string, message: string, statusCode = 0): ResultRow {
  return resultRow({
    objectType: 'ProcessGroup',
    objectId: decision.group.uniqueId,
    name: describeGroupPath(decision.group),
    operation: 'DeleteGroup',
    status,
    message,
    groupId: decision.group.id,
    statusCode,
  });
}

function orphanRows(decision: Extract<CleanupDecision, { action: 'delete' }>): ResultRow[] {
  return decision.orphans.map((orphan) =>
    resultRow({
      objectId: orphan.uniqueId,
      name: orphan.name,
      operation: 'GroupDeleted',
      status: 'Orphaned',
      message: `Archived in '${describeGroupPath(decision.group)}', which was deleted. It can no longer be restored to that group.`,
      groupId: decision.group.id,
    }),
  );
}

export async function runCleanup(
  gateway: CleanupGateway,
  journal: Journal,
  decisions: readonly CleanupDecision[],
  controls: Controls,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];
  /** Groups this run actually removed, so a parent's re-read can ignore them. */
  const removed = new Set<string>();
  const deletions = decisions.filter((d) => d.action === 'delete').length;
  let done = 0;

  for (const decision of decisions) {
    if (decision.action === 'keep') {
      rows.push(groupRow(decision, 'Skipped', `Kept. ${decision.reason}`));
      continue;
    }

    if (controls.cancelled()) {
      rows.push(groupRow(decision, 'Skipped', `Kept. Not attempted: ${controls.stoppedReason() ?? 'the run stopped'}`));
      continue;
    }

    done++;
    onProgress?.(done, deletions, describeGroupPath(decision.group));

    // The last look before an irreversible call.
    let children: readonly TreeItem[];
    try {
      children = await gateway.childItems(decision.group.uniqueId);
    } catch (error) {
      const fatal = controls.isFatal(error);
      if (fatal) controls.stop(fatal);
      rows.push(groupRow(decision, 'Skipped', `Kept. It could not be read again just before deleting (${failureOf(error).error}).`));
      continue;
    }
    const remaining = children.filter((item) => !removed.has(item.uniqueId));
    if (remaining.length > 0) {
      const names = remaining.slice(0, 5).map((item) => `'${item.title}'`).join(', ');
      rows.push(
        groupRow(
          decision,
          'Skipped',
          `Kept. It now holds ${remaining.length} item${remaining.length === 1 ? '' : 's'} (${names}), so it is not empty any more.`,
        ),
      );
      continue;
    }

    const deleteStep = step.deleteGroup(decision.group.uniqueId);
    if (journal.phaseOf(deleteStep) !== null) {
      rows.push(groupRow(decision, 'Skipped', 'Already attempted earlier in this run, so not sent again.'));
      continue;
    }

    journal.append({ step: deleteStep, kind: 'group.delete', phase: 'begin' });
    try {
      await gateway.deleteGroup(decision.group.uniqueId);
      journal.append({ step: deleteStep, kind: 'group.delete', phase: 'commit' });
      removed.add(decision.group.uniqueId);
      const orphans = decision.orphans.length;
      rows.push(
        groupRow(
          decision,
          'Success',
          orphans === 0
            ? 'Deleted.'
            : `Deleted. ${orphans} archived process${orphans === 1 ? '' : 'es'} can no longer be restored to it.`,
        ),
      );
      rows.push(...orphanRows(decision));
    } catch (error) {
      journal.append({ step: deleteStep, kind: 'group.delete', phase: 'fail' });
      const fatal = controls.isFatal(error);
      if (fatal) {
        controls.stop(fatal);
        rows.push(groupRow(decision, 'Failed', `Stopped while deleting: ${fatal} The final read decides whether it went.`));
        continue;
      }

      const failure = failureOf(error);
      const detail = (error as { detail?: unknown }).detail;
      const contents = readAssociatedContents(typeof detail === 'string' ? detail : null);
      if (failure.status === 409 || contents !== null) {
        const blocking = [
          ...(contents?.documents ?? []).map((d) => `document '${d}'`),
          ...(contents?.processes ?? []).map((p) => `process '${p}'`),
        ];
        rows.push(
          groupRow(
            decision,
            'Blocked',
            `HTTP ${failure.status || 409} refused by the tenant: ${contents?.caption ?? 'Unable to Delete Group'}` +
              (blocking.length > 0 ? `. It still holds ${blocking.join(', ')}.` : '.'),
            failure.status || 409,
          ),
        );
        continue;
      }

      rows.push(
        groupRow(
          decision,
          'Failed',
          `Delete failed (${failure.status > 0 ? `HTTP ${failure.status}` : 'no response'}): ${failure.detail ?? failure.error}`,
          failure.status,
        ),
      );
    }
  }

  return rows;
}

/**
 * Settle each group row against a fresh read of its parent's level.
 *
 * The same rule as the archive: a call's answer is a draft. A group the call said was
 * deleted but is still there is Failed, and the rows claiming its archived processes
 * were orphaned are dropped, since nothing happened to them. A group whose delete
 * reported failure but is gone is Success, and its orphan rows are added, because every
 * process the run changed gets a row.
 */
export function settleCleanup(
  rows: readonly ResultRow[],
  decisions: readonly CleanupDecision[],
  levels: ReadonlyMap<string, readonly TreeItem[] | null>,
): ResultRow[] {
  const byGroup = new Map(decisions.map((d) => [d.group.uniqueId, d]));
  const stillThere = (groupUniqueId: string): boolean | null => {
    const decision = byGroup.get(groupUniqueId);
    if (!decision) return null;
    const level = levels.get(decision.group.parentUniqueId ?? '');
    if (!level) return null;
    return level.some((item) => item.uniqueId === groupUniqueId);
  };

  const survivors = new Set<string>();
  const settled = rows.flatMap((row): ResultRow[] => {
    if (row.operation !== 'DeleteGroup' || row.status === 'Skipped') return [row];
    const present = stillThere(row.objectId);
    if (present === null) return [row];
    if (row.status === 'Success' && present) {
      survivors.add(row.objectId);
      return [{ ...row, status: 'Failed', message: 'DeleteGroup answered success, but the group is still there.' }];
    }
    if (row.status !== 'Success' && !present) {
      const decision = byGroup.get(row.objectId);
      return [
        { ...row, status: 'Success', message: `Deleted, confirmed by the final read, although the run reported: ${row.message}` },
        ...(decision?.action === 'delete' ? orphanRows(decision) : []),
      ];
    }
    return [row];
  });

  const orphanedBy = new Map<string, string>();
  for (const d of decisions) {
    if (d.action === 'delete') for (const o of d.orphans) orphanedBy.set(o.uniqueId, d.group.uniqueId);
  }
  return settled.filter(
    (row) => !(row.operation === 'GroupDeleted' && survivors.has(orphanedBy.get(row.objectId) ?? '')),
  );
}
