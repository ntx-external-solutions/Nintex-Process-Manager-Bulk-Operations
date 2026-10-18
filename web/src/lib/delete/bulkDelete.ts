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

import type { ResultRow } from '../exec/report.ts';
import type { Reconciliation } from './claims.ts';
import type { VariationWarning } from './collateral.ts';
import type { DeleteEventSink } from './events.ts';
import type { CollateralGate, EngineOptions, VerificationFailure } from './executor.ts';
import type { DeleteGateway } from './gateway.ts';
import type { DependencyPlan, FailedTarget, UnresolvedParticipant } from './ledger.ts';
import { notPorted } from './phases.ts';
import type { PlanStore } from './planStore.ts';
import type { TargetSource } from './targets.ts';

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
  mismatches?: Decision<readonly Reconciliation[]> | undefined;
  verificationFailed?: Decision<readonly VerificationFailure[]> | undefined;
  /** The typed DELETE. Absent: confirmed, on the preview, before the run began. */
  confirmDelete?: Decision<number> | undefined;
}

/**
 * Who let a collateral change through, for its `Accepted` row. The file distinguishes an
 * approval given in advance, on the preview, from one given at the gate with the list on
 * screen, as the script's distinguishes `-AcceptCollateral` from a typed YES.
 */
export const ACCEPTANCE_AUTHORITY = {
  inAdvance: 'accepted in advance on the preview',
  atGate: 'accepted at the on-screen confirmation',
} as const;

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
  onEvent?: DeleteEventSink | undefined;
  now?: (() => Date) | undefined;
}

export interface BulkDeleteRun {
  /** Every row, after the end-of-run re-check: what the results file holds. Empty when nothing was attempted. */
  results: ResultRow[];
  /** The plan as last saved, or null when the run stopped before it had one. */
  plan: DependencyPlan | null;
}

/** Runs Mode 5. Port of `Invoke-BulkDeleteProcesses`. */
export function runBulkDelete(gateway: DeleteGateway, options: BulkDeleteOptions): Promise<BulkDeleteRun> {
  return notPorted('unwind');
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
 */
export function resumeUnwind(gateway: DeleteGateway, plan: DependencyPlan, options: ResumeOptions): Promise<BulkDeleteRun> {
  return notPorted('unwind');
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
  return notPorted('unwind');
}
