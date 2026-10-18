/**
 * Applying an ownership plan, one process per call, then settling every row from a
 * fresh read of each process.
 *
 * Per process: one `process.setOwnership` (a read-modify-write on the server, refused if
 * the revision moved since the preview) and, when the plan publishes it, one
 * `process.publishNow` with the run's change description as `PublishMessage` (a tenant
 * in "Publish Only mode" refuses a publish without one, spike S2). Both steps are
 * journaled, and neither is ever sent twice: a second save stacks another revision and a
 * second publish burns another major version.
 */

import { failureOf } from '../archive/outcome.ts';
import { step, type Journal } from '../exec/journal.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import { forEachBatched, type Controls } from '../exec/runner.ts';
import type { OwnershipState, SetOwnershipRequest, SetOwnershipResult, UserRef } from '../pm/ownership.ts';
import { describeChange, describeUser, describeWrite, OPERATION, type OwnershipChange, type OwnershipPlan } from './plan.ts';

export interface OwnershipGateway {
  setOwnership(request: SetOwnershipRequest): Promise<SetOwnershipResult>;
  publishNow(processUniqueId: string, processRevisionEditId: number, publishMessage: string): Promise<unknown>;
}

/** The script's vocabulary, plus Blocked for a refusal, Pending for an approval queue, and Unverified. */
export const OWNERSHIP_STATUSES = ['Success', 'Preview', 'Skipped', 'Pending', 'Blocked', 'Failed', 'Unverified'] as const;

/**
 * The script throttled itself with a one-second pause because a busy tenant answered
 * saves with intermittent 500s. Two at a time is the compromise: a save is a whole-model
 * PUT, far heavier than an archive.
 */
export const OWNERSHIP_CONCURRENCY = 2;

function row(change: OwnershipChange, status: string, message: string, statusCode = 0): ResultRow {
  return resultRow({ objectId: change.uniqueId, name: change.name, operation: OPERATION, status, message, statusCode });
}

function refusedOrFailed(error: unknown, what: string): { status: string; message: string; statusCode: number } {
  const failure = failureOf(error);
  const refused = failure.status >= 400 && failure.status <= 499;
  return {
    status: refused ? 'Blocked' : 'Failed',
    message: refused
      ? `HTTP ${failure.status} refused by the tenant: ${failure.detail ?? failure.error}`
      : `${what} failed (${failure.status > 0 ? `HTTP ${failure.status}` : 'no response'}): ${failure.detail ?? failure.error}`,
    statusCode: failure.status,
  };
}

export async function runOwnership(
  gateway: OwnershipGateway,
  journal: Journal,
  plan: OwnershipPlan,
  controls: Controls,
  options: { changeDescription: string; concurrency?: number; onProgress?: (done: number, total: number, label: string) => void },
): Promise<ResultRow[]> {
  const changeDescription = options.changeDescription.trim();
  if (changeDescription === '') throw new Error('A change description is required before anything is saved.');

  const rows: ResultRow[] = [...plan.skipped];

  const { results, notAttempted } = await forEachBatched(
    plan.changes,
    controls,
    async (change): Promise<ResultRow> => {
      const saveStep = step.update(change.uniqueId);
      const publishStep = step.publish(change.uniqueId);
      if (journal.phaseOf(saveStep) !== null) {
        return row(change, 'Skipped', 'Already attempted earlier in this run, so not sent again.');
      }

      const what = describeChange(change);
      journal.append({ step: saveStep, kind: 'process.update', phase: 'begin', data: { revisionEditId: change.revisionEditId } });
      let revisionEditId: number | null;
      try {
        const result = await gateway.setOwnership({
          processUniqueId: change.uniqueId,
          expectedRevisionEditId: change.revisionEditId,
          owner: change.owner?.after ?? null,
          expert: change.expert?.after ?? null,
          changeDescription,
          submitForApproval: change.writePath === 'submit-then-publish',
        });
        if (!result.ok) {
          journal.append({ step: saveStep, kind: 'process.update', phase: 'skip' });
          return row(
            change,
            'Skipped',
            `Changed by someone else since the preview (revision ${result.conflict.expected}, now ${result.conflict.actual}), so it was not saved. Build the plan again to pick up their edit.`,
          );
        }
        revisionEditId = result.revisionEditId;
        journal.append({ step: saveStep, kind: 'process.update', phase: 'commit', data: { revisionEditId } });
      } catch (error) {
        journal.append({ step: saveStep, kind: 'process.update', phase: 'fail' });
        const fatal = controls.isFatal(error);
        if (fatal) {
          controls.stop(fatal);
          return row(change, 'Failed', `Stopped while saving: ${fatal} The final read decides whether it was saved.`);
        }
        const failed = refusedOrFailed(error, 'Save');
        return row(change, failed.status, failed.message, failed.statusCode);
      }

      if (change.writePath === 'save-only') return row(change, 'Success', `${what}. ${describeWrite(change)}`);

      if (revisionEditId === null) {
        return row(change, 'Failed', `${what}. Saved, but the new revision id could not be read, so it was not published.`);
      }
      journal.append({ step: publishStep, kind: 'process.publish', phase: 'begin', data: { revisionEditId } });
      try {
        await gateway.publishNow(change.uniqueId, revisionEditId, changeDescription);
        journal.append({ step: publishStep, kind: 'process.publish', phase: 'commit' });
        return row(change, 'Success', `${what}. ${describeWrite(change)}`);
      } catch (error) {
        journal.append({ step: publishStep, kind: 'process.publish', phase: 'fail' });
        const fatal = controls.isFatal(error);
        if (fatal) controls.stop(fatal);
        const failed = refusedOrFailed(error, 'Publish');
        return row(
          change,
          'Failed',
          `${what}. Saved, but not published: ${fatal ?? failed.message}. The change is in a draft; the published version shows the old owner and expert.`,
          failed.statusCode,
        );
      }
    },
    {
      concurrency: options.concurrency ?? OWNERSHIP_CONCURRENCY,
      label: (change) => change.name,
      onProgress: (p) => options.onProgress?.(p.done, p.total, p.label),
    },
  );

  rows.push(...results);
  for (const change of notAttempted) {
    rows.push(row(change, 'Skipped', `Not attempted: ${controls.stoppedReason() ?? 'the run stopped'}`));
  }
  return rows;
}

const SENT: ReadonlySet<string> = new Set(['Success', 'Blocked', 'Failed']);

function sameUser(a: UserRef | null, b: UserRef): boolean {
  return a !== null && a.id === b.id;
}

/**
 * Settle every written row against a fresh read of its process.
 *
 *  - the roles are what the plan set: the save landed. If the call reported failure it is
 *    a success after all, unless a publish was due and never sent (Failed, saying so).
 *    If a publish was sent and the process is still not published, it is Pending: on a
 *    tenant with approvals the publish can queue;
 *  - the roles are not what the plan set after a call that said yes: Failed;
 *  - the process could not be re-read: Unverified for a reported success, otherwise the
 *    call's status stands.
 */
export function settleOwnership(
  rows: readonly ResultRow[],
  plan: OwnershipPlan,
  journal: Journal,
  after: ReadonlyMap<string, OwnershipState | null>,
): ResultRow[] {
  const changes = new Map(plan.changes.map((c) => [c.uniqueId.toLowerCase(), c]));

  return rows.map((r) => {
    const change = changes.get(r.objectId.toLowerCase());
    if (r.operation !== OPERATION || !change || !SENT.has(r.status)) return r;

    const now = after.get(change.uniqueId.toLowerCase()) ?? null;
    if (now === null) {
      return r.status === 'Success'
        ? { ...r, status: 'Unverified', message: `${r.message} The final read could not re-read the process to confirm it.` }
        : r;
    }

    const landed = (!change.owner || sameUser(now.owner, change.owner.after)) && (!change.expert || sameUser(now.expert, change.expert.after));
    const shows = [change.owner ? `Owner ${describeUser(now.owner)}` : null, change.expert ? `Expert ${describeUser(now.expert)}` : null]
      .filter((p): p is string => p !== null)
      .join('; ');

    if (!landed) {
      return r.status === 'Success' ? { ...r, status: 'Failed', message: `The save was accepted, but the final read shows ${shows}.` } : r;
    }

    const publishes = change.writePath !== 'save-only';
    const published = journal.isCommitted(step.publish(change.uniqueId));
    if (r.status !== 'Success') {
      // The save was confirmed and the publish is what failed: the row already says so.
      if (journal.isCommitted(step.update(change.uniqueId))) return r;
      if (publishes && !published) {
        return { ...r, status: 'Failed', message: `Saved (the final read shows ${shows}), but not published, because the run reported: ${r.message}` };
      }
      return { ...r, status: 'Success', message: `${describeChange(change)}. Confirmed by the final read, although the run reported: ${r.message}` };
    }
    if (publishes && published && now.revisionStateId !== 3) {
      return {
        ...r,
        status: 'Pending',
        message: `${describeChange(change)}. Saved and the publish was accepted, but it is not published yet; it may be awaiting approval.`,
      };
    }
    return r;
  });
}
