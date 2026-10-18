/**
 * Bulk Delete, end to end. Port of `Invoke-BulkDeleteProcesses` (Mode 5,
 * Nintex-BulkOperations.ps1), the orchestrator over the engine.
 *
 * What lives here rather than in any one engine function is the order of things, and that
 * is where the defects this file's tests cover were:
 *
 *  - the plan ledger records the targets as they were before the Hold phase un-archived
 *    them and moved them into the holding group, and it is saved before the first call
 *    that changes a process (B4);
 *  - the variation pre-flight and the orphaned-target warning come before that call;
 *  - each mutating phase is followed by a collateral checkpoint, and the gate is an
 *    explicit decision: stopping is the default, and the only unattended answer;
 *  - every exit ends the same way: put back what the run changed unasked, re-check both
 *    manual-attention lists against the tenant, and return the rows. The unwind puts back
 *    every process the run un-archived, targets and holders, with a row each, on every
 *    exit path (old T1);
 *  - the holding group is removed only when it lists nothing.
 *
 * The script's prompts and switches are options here. `-Force` has no counterpart: the
 * operator confirms on the preview before the run starts, and a gate with no callback
 * answers the way `-Force` did, by stopping.
 */

import { failureOf } from '../archive/outcome.ts';
import { findVariationMasters } from '../archive/plan.ts';
import { resultRow, UNKNOWN_NAME, type ResultRow } from '../exec/report.ts';
import { defaultIsFatal } from '../exec/runner.ts';
import { reconciliationGate, type Reconciliation } from './claims.ts';
import {
  ACCEPTANCE_AUTHORITY,
  decideCollateral,
  newCollateral,
  restoreCollateral,
  variationWarning,
  type CollateralChange,
  type VariationWarning,
} from './collateral.ts';
import type { DeleteEvent, DeleteEventSink } from './events.ts';
import {
  collateralGateway,
  deletePlanTargets,
  newRelocationProbe,
  removePlanReferences,
  restorePlanState,
  restoreProcess,
  type CollateralGate,
  type EngineOptions,
  type VerificationFailure,
} from './executor.ts';
import { HOLDING_GROUP_NAME, type DeleteGateway, type GroupRef } from './gateway.ts';
import { findOrphanedGroupProcesses, groupExistsCoverage } from './groups.ts';
import { removeHoldingGroup } from './holdingGroup.ts';
import {
  markSnapshotRestored,
  mergePlanLedger,
  newDependencyPlan,
  processStateSnapshot,
  snapshotToPlanLedger,
  tenantStateSnapshot,
  type DependencyPlan,
  type DraftHolder,
  type FailedTarget,
  type PlanLedgerRow,
  type UnresolvedParticipant,
} from './ledger.ts';
import { selectDisplayName } from './names.ts';
import { buildDeletePlan, loadDeleteIndex } from './planner.ts';
import type { PlanStore } from './planStore.ts';
import { RE_ARCHIVE_OPERATIONS, resolveRunOutcome } from './runOutcome.ts';
import { CSV_ID_COLUMNS, resolveTargetIds, targetsFromCsv, type TargetSource } from './targets.ts';

type Decision<T> = (subject: T) => boolean | Promise<boolean>;

/**
 * The run's questions, answered on screen. Each is the script's `Read-Host` at that point.
 * Absent means no, except `confirmDelete`, which the preview has already asked.
 */
export interface DeleteDecisions {
  /** Something changed that was not a target. The script's "Type 'YES' to accept these changes". */
  collateral?: CollateralGate | undefined;
  /** A target looks like a variation whose master is not a target. */
  variation?: Decision<VariationWarning> | undefined;
  /** Proceed with the targets whose dependency check passed. */
  failedTargets?: Decision<readonly FailedTarget[]> | undefined;
  unresolved?: Decision<readonly UnresolvedParticipant[]> | undefined;
  /**
   * `reconciliationGate(...).blocking`: pairs with nothing located. The script's "Continue
   * anyway?", and asked only for these.
   */
  mismatches?: Decision<readonly Reconciliation[]> | undefined;
  /**
   * `reconciliationGate(...).overClaims`: located, but fewer than claimed. An on-screen
   * acknowledgement, not a stop (Cowork's live check after W5 phase 3). Double-counted
   * links are never asked about.
   */
  overClaims?: Decision<readonly Reconciliation[]> | undefined;
  verificationFailed?: Decision<readonly VerificationFailure[]> | undefined;
  /**
   * Holders with an unpublished draft, asked after planning: the ids the operator ticks
   * have their draft published with the removal. Absent, or an empty answer, ticks none,
   * so their targets are kept (Cowork's review of W5 phase 5).
   */
  publishDrafts?: ((holders: readonly DraftHolder[]) => readonly string[] | Promise<readonly string[]>) | undefined;
  /** The typed DELETE. Absent: confirmed, on the preview, before the run began. */
  confirmDelete?: Decision<number> | undefined;
}

export { ACCEPTANCE_AUTHORITY };

export interface BulkDeleteOptions extends EngineOptions {
  siteUrl: string;
  source: TargetSource;
  /** Saved before the first call that changes a process, and after every step that changes the ledger. */
  planStore: PlanStore;
  /** Default `HOLDING_GROUP_NAME`. */
  holdingGroupName?: string | undefined;
  /** A preview: reads only, restores nothing, and says its plan understates the work. */
  dryRun?: boolean | undefined;
  /** Also read every active process for Input/Output references. Slow and complete. */
  thoroughScan?: boolean | undefined;
  /** Delete a target that could not be restored out of the archive, references unchecked. */
  allowUnheldTargets?: boolean | undefined;
  /**
   * Approves the collateral gate and the variation pre-flight, and nothing else. Approval
   * is permission to carry on, not to leave the tenant changed: the collateral is still
   * put back.
   */
  acceptCollateral?: boolean | undefined;
  decisions?: DeleteDecisions | undefined;
  /** Sent on every save, publish and archive. Default `REFERENCE_REMOVAL_DESCRIPTION`. */
  changeDescription?: string | undefined;
  onEvent?: DeleteEventSink | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Why a real run must not start on this plan, or null when it may. A `PlannedIncomplete`
 * plan stops the run with no override (Cowork's review of phase 4): an unread scan batch
 * means an archived holder's Input or Output to a target is unknown, and deleting past it
 * is how a reference is left dangling. The message names every unread process.
 * `runBulkDelete` (ported with the unwind) calls this before its first change.
 */
export function incompletePlanStop(plan: Pick<DependencyPlan, 'status' | 'unreadByScan' | 'incompleteReasons'>): string | null {
  if (plan.status !== 'PlannedIncomplete') return null;
  const parts = ['This plan is incomplete, so the run stops before changing anything.'];
  parts.push(...(plan.incompleteReasons ?? ['It was built as a preview, which does not restore archived processes.']));
  const unread = plan.unreadByScan ?? [];
  if (unread.length > 0) {
    const named = unread.map((u) => `${u.name || UNKNOWN_NAME} (${u.uniqueId}${u.status > 0 ? `, HTTP ${u.status}` : ''})`);
    parts.push(`Not read: ${named.join('; ')}.`, 'Build the plan again once they can be read.');
  }
  return parts.join(' ');
}

export interface BulkDeleteRun {
  /** Every row, after the end-of-run re-check: what the results file holds. Empty when nothing was attempted. */
  results: ResultRow[];
  /** The plan as last saved, or null when the run stopped before it had one. */
  plan: DependencyPlan | null;
}

/** Runs Mode 5. Port of `Invoke-BulkDeleteProcesses`. */
export async function runBulkDelete(gateway: DeleteGateway, options: BulkDeleteOptions): Promise<BulkDeleteRun> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const approvalsEnabled = options.approvalsEnabled ?? true;
  const engine: EngineOptions = { approvalsEnabled, isFatal };
  const decisions = options.decisions ?? {};
  const emit = (event: DeleteEvent) => options.onEvent?.(event);
  const now = () => options.now?.() ?? new Date();
  const holdingGroupName = options.holdingGroupName ?? HOLDING_GROUP_NAME;
  const dryRun = options.dryRun === true;
  const acceptCollateral = options.acceptCollateral === true;
  const acceptanceAuthority = acceptCollateral ? ACCEPTANCE_AUTHORITY.inAdvance : ACCEPTANCE_AUTHORITY.atGate;

  const results: ResultRow[] = [];
  const runCollateral: CollateralChange[] = [];
  let runLedger: PlanLedgerRow[] = [];
  let lastSaved: DependencyPlan | null = null;
  const save = async (plan: DependencyPlan) => {
    lastSaved = plan;
    await options.planStore.save(plan);
  };
  const stop = (reason: string) => emit({ kind: 'stopped', reason });

  // Every exit after the first change ends here: put back collateral nothing has reversed
  // yet, then re-check both manual-attention lists against the tenant (`$finishRun`).
  const finish = async (): Promise<BulkDeleteRun> => {
    const reversed = new Set(results.filter((r) => r.operation === 'ReverseCollateral').map((r) => r.objectId.toLowerCase()));
    const pending = dedupeCollateral(runCollateral).filter((c) => !reversed.has(c.uniqueId.toLowerCase()));
    if (pending.length > 0) {
      emit({ kind: 'stage', stage: 'reversing-collateral' });
      results.push(...(await restoreCollateral(collateralGateway(gateway, engine), pending)));
    }
    const rows = await resolveRunOutcome(gateway, dedupeCollateral(runCollateral), runLedger, results, { onEvent: options.onEvent });
    return { results: rows, plan: lastSaved };
  };

  const addRow = (row: ResultRow) => {
    results.push(row);
  };

  try {
    // ---- Gather ----
    emit({ kind: 'stage', stage: 'gathering' });
    let index = await loadDeleteIndex(gateway);
    let raw: string[];
    if (options.source.kind === 'ids') {
      raw = [...options.source.ids];
    } else if (options.source.kind === 'archived') {
      raw = [...index.values()].filter((e) => e.isArchived).map((e) => e.uniqueId);
    } else {
      const csv = targetsFromCsv(options.source.text);
      raw = csv.ids;
      if (csv.idColumnMissing) emit({ kind: 'csvNoIdColumn', rowCount: csv.rowCount, headers: csv.headers, accepted: CSV_ID_COLUMNS });
    }
    if (raw.length === 0) {
      emit({ kind: 'noTargets', reason: 'No processes to delete' });
      return { results, plan: null };
    }
    const resolved = resolveTargetIds(raw, index);
    for (const id of resolved.unknown) {
      results.push(resultRow({ objectId: id, operation: 'Resolve', status: 'Failed', message: 'Process not found in active or archived lists' }));
    }
    let targets = resolved.uniqueIds;
    if (targets.length === 0) {
      emit({ kind: 'noTargets', reason: 'No resolvable processes to delete' });
      return { results, plan: null };
    }
    const nameOf = (id: string) => index.get(id.toLowerCase())?.name ?? '';

    // ---- Snapshot: before anything moves ----
    emit({ kind: 'stage', stage: 'snapshot' });
    const groupUniqueIds = new Map<string, string>();
    try {
      for (const g of await gateway.listGroups()) groupUniqueIds.set(String(g.id), g.uniqueId);
    } catch (error) {
      if (isFatal(error)) throw error;
      // The plan still records numeric group ids.
    }
    const snapshot = processStateSnapshot(index, targets, groupUniqueIds);
    const tenantBaseline = tenantStateSnapshot(index);

    // ---- The variation pre-flight, before any change ----
    const warning = variationWarning(findVariationMasters(index, targets.map((id) => ({ uniqueId: id, name: nameOf(id) }))));
    if (warning) {
      emit({ kind: 'variationWarning', warning });
      const proceed = acceptCollateral || dryRun || (decisions.variation ? (await decisions.variation(warning)) === true : false);
      if (!dryRun) {
        for (const target of warning.targets) {
          for (const m of target.masters) {
            results.push(
              resultRow({
                objectId: m.relativeUniqueId,
                name: m.relativeName,
                operation: 'VariationWarning',
                status: proceed ? 'Accepted' : 'Failed',
                message: `Master of target '${target.targetName}' and not itself a target; ${proceed ? `risk ${acceptanceAuthority}` : 'run stopped before any change'}`,
                groupId: m.relativeGroupId,
              }),
            );
          }
        }
      }
      if (!proceed) {
        stop('A target looks like a variation whose master is not a target. Nothing has been changed.');
        return finish();
      }
    }

    const orphans = findOrphanedGroupProcesses(index, targets);
    if (orphans.length > 0) emit({ kind: 'orphanedTargets', orphans, totalTargets: targets.length, holdingGroupName });
    emit({ kind: 'groupExistsCoverage', coverage: groupExistsCoverage(index) });

    // ---- Hold: a real run makes the holding group, then restores archived targets into it ----
    let tempGroup: GroupRef | null = null;
    const holdLog: string[] = [];
    let holdCollateral: CollateralChange[] = [];
    const cleanup = async (plan: DependencyPlan) => {
      if (!tempGroup) return;
      emit({ kind: 'stage', stage: 'cleanup' });
      const rows = await removeHoldingGroup(
        gateway,
        tempGroup,
        { groupName: holdingGroupName, targetUniqueIds: targets, reportedUniqueIds: plan.collateral.map((c) => c.uniqueId), nameLookup: tenantBaseline },
        isFatal,
      );
      results.push(...rows);
      plan.holdingGroupRemoved = rows.some((r) => r.operation === 'Cleanup' && r.status === 'Success');
      await save(plan);
    };
    const unwind = async (plan: DependencyPlan) => {
      await restorePlanState(gateway, plan, { ...engine, onRow: addRow, probe, persist: () => save(plan), onEvent: options.onEvent });
    };
    const probe = newRelocationProbe();

    if (!dryRun) {
      emit({ kind: 'stage', stage: 'holding-group' });
      // DIFFERS: made for every real run, not only one with archived targets. A holder
      // whose group is gone can only be read from the holding group, and the script
      // blocked on one whenever every target was active. An empty group is deleted at
      // cleanup.
      try {
        tempGroup = await gateway.createGroup(holdingGroupName, null);
      } catch (error) {
        if (isFatal(error)) throw error;
        stop(`Could not create the holding group (${failureOf(error).error}). Nothing has been changed.`);
        return { results, plan: null };
      }
      const archivedTargets = targets.filter((id) => index.get(id.toLowerCase())?.isArchived === true);
      const preliminary = newDependencyPlan(options.siteUrl, targets, now());
      preliminary.status = 'Holding';
      preliminary.holdingGroup = tempGroup;
      preliminary.ledger = snapshotToPlanLedger(snapshot);
      runLedger = preliminary.ledger;
      holdLog.push(`Holding group '${holdingGroupName}' created: id ${tempGroup.id}, uniqueId ${tempGroup.uniqueId}`);
      holdLog.push(`About to restore ${archivedTargets.length} archived target(s) into the holding group`);
      preliminary.log = [...holdLog];
      // B4: on record before the first call that changes a process.
      await save(preliminary);

      const failedHolds: string[] = [];
      for (const [i, target] of archivedTargets.entries()) {
        emit({ kind: 'progress', label: 'Restoring archived targets into the holding group', done: i + 1, total: archivedTargets.length });
        const outcome = await restoreProcess(gateway, target, tempGroup.id, { isFatal });
        if (outcome.ok) {
          markSnapshotRestored(snapshot, target, tempGroup.id);
        } else {
          failedHolds.push(target);
          const stuckGroup = index.get(target.toLowerCase())?.groupId ?? null;
          holdLog.push(`FAILED to restore target ${target} into the holding group (HTTP ${outcome.statusCode})`);
          results.push(
            resultRow({
              objectId: target,
              name: nameOf(target),
              operation: 'Hold',
              status: 'Failed',
              message: `Could not restore into the holding group (HTTP ${outcome.statusCode}); still archived in group ${stuckGroup ?? 'unknown'}`,
              groupId: stuckGroup,
              statusCode: outcome.statusCode,
            }),
          );
        }
        preliminary.ledger = snapshotToPlanLedger(snapshot);
        runLedger = preliminary.ledger;
        preliminary.log = [...holdLog];
        await save(preliminary);
      }

      if (failedHolds.length > 0) {
        if (options.allowUnheldTargets) {
          for (const id of failedHolds) holdLog.push(`UNCHECKED DELETE allowed by allowUnheldTargets: ${id}`);
        } else {
          // Never checked, so never deleted: archiving hides the Input and Output rows a
          // dangling reference would be found by.
          const excluded = new Set(failedHolds.map((id) => id.toLowerCase()));
          for (const id of failedHolds) {
            results.push(
              resultRow({
                objectId: id,
                name: nameOf(id),
                operation: 'Delete',
                status: 'Skipped',
                message: 'NOT deleted: could not be restored out of the archive, so its Input/Output references were never checked',
              }),
            );
            holdLog.push(`Excluded ${id} from the delete set: Hold failed, references unchecked`);
          }
          targets = targets.filter((id) => !excluded.has(id.toLowerCase()));
          if (targets.length === 0) {
            stop('No target could be restored out of the archive, so nothing will be deleted.');
            preliminary.status = 'AbortedNoHeldTargets';
            preliminary.log = [...holdLog];
            await save(preliminary);
            await cleanup(preliminary);
            return finish();
          }
        }
      }

      // ---- Checkpoint after the Hold ----
      index = await loadDeleteIndex(gateway);
      if (archivedTargets.length > 0) {
        emit({ kind: 'stage', stage: 'checking-collateral' });
        let heldNow: string[] = [];
        try {
          heldNow = (await gateway.groupProcesses(tempGroup)).map((p) => p.processUniqueId).filter(Boolean);
        } catch (error) {
          if (isFatal(error)) throw error;
        }
        holdCollateral = newCollateral({ baseline: tenantBaseline, fresh: index, expected: targets, observed: heldNow });
        runCollateral.push(...holdCollateral);
        if (holdCollateral.length > 0) {
          const phase = 'after holding archived targets';
          emit({ kind: 'collateral', phase, collateral: holdCollateral });
          const decision = await decideCollateral(holdCollateral, phase, { gate: decisions.collateral, acceptCollateral });
          emit({ kind: 'collateralDecision', phase, accepted: decision.proceed, authority: decision.proceed ? acceptanceAuthority : null, count: holdCollateral.length });
          results.push(...decision.rows);
          if (!decision.proceed) {
            stop('Processes that were not targets changed when the archived targets were restored. Nothing has been deleted.');
            const aborted = newDependencyPlan(options.siteUrl, targets, now());
            aborted.status = 'AbortedCollateral';
            aborted.holdingGroup = tempGroup;
            aborted.ledger = snapshotToPlanLedger(snapshot);
            runLedger = aborted.ledger;
            aborted.collateral = [...holdCollateral];
            aborted.log = [...holdLog, ...holdCollateral.map((c) => `COLLATERAL after hold phase: ${c.uniqueId} (${c.name}) - ${c.change}`)];
            await save(aborted);
            await unwind(aborted);
            emit({ kind: 'stage', stage: 'reversing-collateral' });
            results.push(...(await restoreCollateral(collateralGateway(gateway, engine), holdCollateral)));
            await cleanup(aborted);
            return finish();
          }
        }
      }
    }

    // ---- Plan ----
    emit({ kind: 'stage', stage: 'building-plan' });
    const plan = await buildDeletePlan(gateway, {
      siteUrl: options.siteUrl,
      targetUniqueIds: targets,
      index,
      holdingGroupId: tempGroup?.id ?? null,
      allowRestore: !dryRun,
      scanActiveForInputOutput: options.thoroughScan,
      preHoldSnapshot: snapshot,
      // A preview proceeds past nothing; a run asks.
      onFailedTargets: dryRun ? () => false : decisions.failedTargets,
      onEvent: options.onEvent,
      isFatal,
      now: now(),
    });
    plan.log = [...holdLog, ...plan.log];
    plan.holdingGroup = tempGroup;
    if (holdCollateral.length > 0) {
      plan.collateral.push(...holdCollateral);
      plan.log.push(...holdCollateral.map((c) => `COLLATERAL after hold phase (accepted): ${c.uniqueId} (${c.name}) - ${c.change}`));
    }
    runLedger = plan.ledger;

    if (plan.status === 'Blocked') {
      stop(`Planning was blocked. Nothing has been deleted. ${plan.log.at(-1) ?? ''}`.trim());
      // The snapshot folded in, never assigned over: that is what lost eleven holders (R11).
      plan.ledger = mergePlanLedger(plan.ledger, snapshot);
      runLedger = plan.ledger;
      await save(plan);
      if (dryRun) return { results, plan };
      await unwind(plan);
      await cleanup(plan);
      return finish();
    }

    for (const failed of plan.failedTargets) {
      results.push(
        resultRow({
          objectId: failed.uniqueId,
          name: nameOf(failed.uniqueId),
          operation: 'DependencyCheck',
          status: 'Failed',
          message: `Excluded from the run: HTTP ${failed.status} ${failed.error ?? ''}`.trimEnd(),
          statusCode: failed.status,
        }),
      );
    }
    targets = [...plan.targetUniqueIds];
    await save(plan);
    if (dryRun) return { results, plan };

    // Each stop from here is the same: put back what the run un-archived, then clean up.
    const stopAndUnwind = async (reason: string): Promise<BulkDeleteRun> => {
      stop(reason);
      await save(plan);
      await unwind(plan);
      await cleanup(plan);
      return finish();
    };

    const incomplete = incompletePlanStop(plan);
    if (incomplete) return stopAndUnwind(incomplete);

    if (plan.unresolved.length > 0) {
      const go = decisions.unresolved ? (await decisions.unresolved(plan.unresolved)) === true : false;
      if (!go) return stopAndUnwind(`${plan.unresolved.length} participant(s) could not be resolved. Nothing has been deleted.`);
    }
    const gate = reconciliationGate(plan.reconciliation);
    if (gate.blocking.length > 0) {
      const go = decisions.mismatches ? (await decisions.mismatches(gate.blocking)) === true : false;
      if (!go) return stopAndUnwind(`${gate.blocking.length} reconciliation mismatch(es). Nothing has been deleted.`);
    }
    if (gate.overClaims.length > 0) {
      const go = decisions.overClaims ? (await decisions.overClaims(gate.overClaims)) === true : false;
      if (!go) return stopAndUnwind(`${gate.overClaims.length} pair(s) claimed more than was found, and were not acknowledged. Nothing has been deleted.`);
    }

    // ---- Remove references ----
    const drafts = plan.draftHolders ?? [];
    const publishDrafts = drafts.length > 0 && decisions.publishDrafts ? await decisions.publishDrafts(drafts) : [];
    const removal = await removePlanReferences(gateway, plan, {
      ...engine,
      onRow: addRow,
      changeDescription: options.changeDescription,
      publishDrafts,
      onEvent: options.onEvent,
    });
    await save(plan);
    if (removal.verificationFailed.length > 0) {
      const go = decisions.verificationFailed ? (await decisions.verificationFailed(removal.verificationFailed)) === true : false;
      if (!go) {
        return stopAndUnwind(`Verification failed: references remain on ${removal.verificationFailed.length} process(es). Deleting now would leave them broken.`);
      }
    }

    // ---- Delete ----
    const toDelete = targets.length - new Set(removal.heldBack.map((h) => h.targetUniqueId.toLowerCase())).size;
    const confirmed = decisions.confirmDelete ? (await decisions.confirmDelete(toDelete)) === true : true;
    if (!confirmed) return stopAndUnwind('Deletion cancelled. Nothing has been deleted.');

    const holdingGroupNow = tempGroup;
    const deletion = await deletePlanTargets(gateway, plan, {
      ...engine,
      tenantBaseline,
      onCollateral: acceptCollateral ? () => true : decisions.collateral,
      acceptanceAuthority,
      getObservedUniqueIds: holdingGroupNow
        ? async () => (await gateway.groupProcesses(holdingGroupNow)).map((p) => p.processUniqueId).filter(Boolean)
        : undefined,
      heldBack: removal.heldBack,
      onRow: addRow,
      onEvent: options.onEvent,
    });
    runCollateral.push(...plan.collateral);

    if (!deletion.some((r) => r.operation === 'Delete')) {
      // The archive pass moved something that was not a target, and nobody accepted it.
      plan.status = 'AbortedCollateral';
      stop('Processes that were not targets changed when the targets were archived. Nothing has been deleted.');
      await save(plan);
      await unwind(plan);
      emit({ kind: 'stage', stage: 'reversing-collateral' });
      results.push(...(await restoreCollateral(collateralGateway(gateway, engine), dedupeCollateral(plan.collateral))));
      await cleanup(plan);
      return finish();
    }

    // ---- Put back what the run restored, then clean up ----
    await unwind(plan);
    await cleanup(plan);
    plan.status = 'Completed';
    await save(plan);
    return finish();
  } catch (error) {
    // A run that dies (a session that ends) can do nothing more against the tenant. Its
    // saved plan carries the rows made so far, so the resumed unwind reports them too.
    if (lastSaved) {
      const saved: DependencyPlan = lastSaved;
      saved.interruptedResults = [...results];
      await options.planStore.save(saved).catch(() => undefined);
    }
    throw error;
  }
}

/** One entry per process, first seen wins: the checkpoints and the plan can both carry one. */
function dedupeCollateral(collateral: readonly CollateralChange[]): CollateralChange[] {
  const seen = new Map<string, CollateralChange>();
  for (const c of collateral) if (c.uniqueId && !seen.has(c.uniqueId.toLowerCase())) seen.set(c.uniqueId.toLowerCase(), c);
  return [...seen.values()];
}

export interface ResumeOptions extends EngineOptions {
  planStore: PlanStore;
  onEvent?: DeleteEventSink | undefined;
}

/**
 * Finishes an interrupted run from its plan file: every process the ledger says the run
 * un-archived and did not delete goes back, one row each, then the holding group is
 * removed if it lists nothing, then the rows are re-checked against the tenant. The
 * script's recovery was to import `Delete_Plan_*.json` and call `Restore-ProcessPlanState`
 * by hand; here it is the "unwind" action for an uploaded plan (old T1).
 *
 * Collateral the plan recorded is reversed only where a fresh read shows it still differs
 * from its before-state: the interrupted run may already have put some of it back, and
 * restoring an active process is not a no-op on the measured tenant.
 */
export async function resumeUnwind(gateway: DeleteGateway, plan: DependencyPlan, options: ResumeOptions): Promise<BulkDeleteRun> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const engine: EngineOptions = { approvalsEnabled: options.approvalsEnabled ?? true, isFatal };
  const save = () => options.planStore.save(plan);
  const results: ResultRow[] = [];

  results.push(...(await restorePlanState(gateway, plan, { ...engine, probe: newRelocationProbe(), persist: save, onEvent: options.onEvent })));

  const collateral = dedupeCollateral(plan.collateral);
  if (collateral.length > 0) {
    const fresh = await loadDeleteIndex(gateway);
    const stillChanged = collateral.filter((c) => {
      const now = fresh.get(c.uniqueId.toLowerCase());
      return now !== undefined && c.wasArchived !== null && now.isArchived !== c.wasArchived;
    });
    if (stillChanged.length > 0) {
      options.onEvent?.({ kind: 'stage', stage: 'reversing-collateral' });
      results.push(...(await restoreCollateral(collateralGateway(gateway, engine), stillChanged)));
    }
  }

  if (plan.holdingGroup && !plan.holdingGroupRemoved) {
    options.onEvent?.({ kind: 'stage', stage: 'cleanup' });
    const rows = await removeHoldingGroup(
      gateway,
      plan.holdingGroup,
      {
        groupName: plan.holdingGroup.name || HOLDING_GROUP_NAME,
        targetUniqueIds: plan.targetUniqueIds,
        reportedUniqueIds: collateral.map((c) => c.uniqueId),
      },
      isFatal,
    );
    results.push(...rows);
    plan.holdingGroupRemoved = rows.some((r) => r.operation === 'Cleanup' && r.status === 'Success');
  }
  plan.log.push(`Unwound from the saved plan on ${new Date().toISOString()}`);
  await save();
  // The interrupted run's rows first: together they name every process the run changed.
  const rows = await resolveRunOutcome(gateway, collateral, plan.ledger, [...(plan.interruptedResults ?? []), ...results], {
    onEvent: options.onEvent,
  });
  return { results: rows, plan };
}

export interface CollateralSummaryEntry {
  uniqueId: string;
  /** The fullest real name any row gave it (`selectDisplayName`). */
  label: string;
  messages: string[];
}

export interface DeleteResultsSummary {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** Collateral an operator authorised: a record of a decision, not damage still to review. */
  accepted: number;
  /** Changed without being a target, one entry per process however many producers raised it. */
  collateral: CollateralSummaryEntry[];
  /**
   * Everything the run changed and could not put back, target, holder or collateral: the
   * "STILL NEEDS MANUAL ATTENTION" list, raised with no collateral needed to trigger it.
   */
  needsAttention: ResultRow[];
  /** The summary as the operator reads it. */
  lines: string[];
}

/** What the run did, in the terms an operator acts on. Port of `Show-DeleteResultsSummary`. */
export function deleteResultsSummary(rows: readonly ResultRow[]): DeleteResultsSummary {
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const summary: DeleteResultsSummary = {
    total: rows.length,
    succeeded: count('Success'),
    skipped: count('Skipped'),
    failed: count('Failed'),
    accepted: count('Accepted'),
    collateral: [],
    needsAttention: [],
    lines: [],
  };
  const lines = summary.lines;
  lines.push(`Total operations: ${summary.total}`, `Successful: ${summary.succeeded}`, `Skipped: ${summary.skipped}`, `Failed: ${summary.failed}`);
  if (summary.accepted > 0) lines.push(`Accepted: ${summary.accepted} (collateral change(s) an operator authorised)`);

  // A run that changed processes nobody asked it to is not clean, and the counts alone let
  // it read as one. Accepted rows are a decision already reviewed, so they are left out.
  const byProcess = new Map<string, ResultRow[]>();
  for (const r of rows) {
    if (r.operation !== 'Collateral' || r.status === 'Accepted') continue;
    const key = r.objectId.toLowerCase();
    byProcess.set(key, [...(byProcess.get(key) ?? []), r]);
  }
  for (const group of byProcess.values()) {
    const id = group[0]!.objectId;
    summary.collateral.push({ uniqueId: id, label: selectDisplayName(group, id) || UNKNOWN_NAME, messages: [...new Set(group.map((r) => r.message))] });
  }
  if (summary.collateral.length > 0) {
    lines.push('', 'THIS RUN CHANGED PROCESSES IT WAS NOT ASKED TO', `${summary.collateral.length} process(es) affected without being targets:`);
    for (const c of summary.collateral) {
      lines.push(`  ${c.label}  (${c.uniqueId})`);
      for (const m of c.messages) lines.push(`      ${m}`);
    }
  }

  summary.needsAttention = rows.filter(
    (r) => (r.operation === 'ReverseCollateral' || (RE_ARCHIVE_OPERATIONS as readonly string[]).includes(r.operation)) && r.status !== 'Success',
  );
  if (summary.needsAttention.length > 0) {
    lines.push('', 'STILL NEEDS MANUAL ATTENTION', `${summary.needsAttention.length} process(es) this run changed and could not put back:`);
    for (const u of summary.needsAttention) {
      lines.push(`  ${u.name}  (${u.objectId})`);
      lines.push(`      ${u.message}`);
    }
  }
  return summary;
}
