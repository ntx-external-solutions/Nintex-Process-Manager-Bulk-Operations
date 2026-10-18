/**
 * Carrying out a delete plan: restore, remove references, verify, archive, delete, and
 * put back what the run restored. Port of the execution half of
 * NintexProcessDependencies.ps1.
 *
 * Phase order is load-bearing (`Invoke-ProcessDeletePlan`):
 *
 *  - Remove: one read, one save and one publish per holder, carrying every target at
 *    once. Saving per target would publish a holder repeatedly.
 *  - Verify: before anything is re-archived, by walking each holder's saved model, not by
 *    asking the dependency API, which an archive blinds.
 *  - Delete: targets only, with a collateral check between the archive pass and the
 *    deletes (the last point where stopping costs nothing) and another after them.
 *  - Restore: everything the ledger says this run un-archived, back to its own group and
 *    archived, saved after each so an interrupted unwind can be finished.
 *
 * The script kept the last restore's failure and status, and whether RestoreProcess
 * relocates an active process, in module globals. Here each is returned or passed.
 */

import { archiveOne, type ArchiveOptions } from '../archive/outcome.ts';
import type { ResultRow } from '../exec/report.ts';
import type { ProcessIndex } from '../tenant/state.ts';
import type { CollateralChange, CollateralGateway } from './collateral.ts';
import type { DeleteEventSink } from './events.ts';
import type { DeleteGateway } from './gateway.ts';
import type { DependencyPlan } from './ledger.ts';
import type { ProcessModel } from './model.ts';
import { notPorted } from './phases.ts';
import type { ReferenceSite } from './references.ts';

export interface EngineOptions {
  /** Permission to override a pending approval, read back per process (`-ApprovalsEnabled`). Default true. */
  approvalsEnabled?: boolean | undefined;
  /** An error that ends the run (a dead session) is rethrown rather than reported. */
  isFatal?: ((error: unknown) => string | null) | undefined;
}

/** Why a restore did not happen. `MissingGroup`: never sent, because the group is known to be gone. */
export type RestoreFailure = 'MissingGroup' | 'Endpoint';

export interface RestoreOutcome {
  ok: boolean;
  failure: RestoreFailure | null;
  /** The failing call's HTTP status; 0 when it succeeded or was never sent. */
  statusCode: number;
}

export interface RestoreOptions {
  /** False when the caller already knows the destination is gone: RestoreProcess would answer 500, four times. */
  destinationGroupExists?: boolean | undefined;
  retry?: boolean | undefined;
}

/**
 * Un-archives one process into one group. Returns the failure rather than recording it
 * in `$script:NpmLastRestoreFailure` and `NpmLastRestoreStatus`. Port of
 * `Restore-NpmProcess`.
 */
export function restoreProcess(
  gateway: Pick<DeleteGateway, 'restore'>,
  processUniqueId: string,
  processGroupId: number | null,
  options?: RestoreOptions,
): Promise<RestoreOutcome> {
  return notPorted('hold');
}

export type SaveStage = 'Save' | 'SavedUnpublished' | 'Publish' | 'Published';

export interface SaveOutcome {
  success: boolean;
  /** Where it got to, or where it failed. */
  stage: SaveStage;
  error: string | null;
  statusCode: number;
}

export interface SaveModelOptions {
  changeDescription?: string | undefined;
  approvalsEnabled?: boolean | undefined;
  /** Default true: these edits publish a version the owner never asked for. */
  suppressChangeNotification?: boolean | undefined;
}

/**
 * Saves a model (ProcessJson as a string: an object returns 200 and drops the edit), then
 * re-reads it and publishes the new revision when the process had been published. Port
 * of `Save-NpmProcessModel`.
 */
export function saveProcessModel(
  gateway: Pick<DeleteGateway, 'saveModel' | 'readModel' | 'publishNow' | 'publishRevisionEdit'>,
  processUniqueId: string,
  model: ProcessModel,
  options?: SaveModelOptions,
): Promise<SaveOutcome> {
  return notPorted('references');
}

export interface VerificationFailure {
  holderUniqueId: string;
  remaining: ReferenceSite[];
}

export interface ReferenceRemovalRun {
  /** One `RemoveReferences` row per holder. */
  results: ResultRow[];
  verificationFailed: VerificationFailure[];
}

/**
 * Removes every reference the plan found, one save per holder, then re-reads each holder
 * and walks it for anything left. Port of `Invoke-ProcessDeletePlan`.
 */
export function removePlanReferences(
  gateway: DeleteGateway,
  plan: DependencyPlan,
  options?: EngineOptions & { skipVerification?: boolean | undefined },
): Promise<ReferenceRemovalRun> {
  return notPorted('references');
}

/**
 * The collateral gate: true carries on to the delete, false stops before it. The script's
 * `-OnCollateral` scriptblock. No gate means stop.
 */
export type CollateralGate = (collateral: readonly CollateralChange[], phase: string) => boolean | Promise<boolean>;

export interface TargetDeletionOptions extends EngineOptions {
  /** The whole tenant before the run. Without it neither checkpoint runs, as in the script. */
  tenantBaseline?: ProcessIndex | null | undefined;
  onCollateral?: CollateralGate | undefined;
  observedUniqueIds?: readonly string[] | undefined;
  /**
   * Read at each checkpoint, not before: what the delete strands in the holding group is
   * not there until the delete has happened (W3).
   */
  getObservedUniqueIds?: (() => Promise<readonly string[]>) | undefined;
  /** How the gate was answered, for the Accepted rows. */
  acceptanceAuthority?: string | undefined;
  onEvent?: DeleteEventSink | undefined;
}

/**
 * Archives the targets this run did not already find archived, checks the tenant, deletes
 * them, and checks again: a variation's master moves when the variation is deleted, which
 * the last check can report and partly reverse but never prevent. Marks each deleted
 * target on the ledger so the unwind does not try to re-archive it. Port of
 * `Invoke-ProcessTargetDeletion`.
 */
export function deletePlanTargets(
  gateway: DeleteGateway,
  plan: DependencyPlan,
  options?: TargetDeletionOptions,
): Promise<ResultRow[]> {
  return notPorted('delete');
}

/**
 * Whether RestoreProcess also relocates a process that is already active. Undocumented,
 * so asked once per run and then remembered: on the measured tenant the answer was no,
 * and asking it per process was close to two hours of backoff on a 479-target run. Port
 * of `$script:NpmRestoreRelocatesActive`, held by the run instead of the module.
 */
export type RelocationProbeState = 'Unknown' | 'Yes' | 'No';

export interface RelocationProbe {
  state: RelocationProbeState;
}

/** A probe that has not been asked yet. Port of `Reset-NpmRelocationProbe`. */
export function newRelocationProbe(): RelocationProbe {
  return { state: 'Unknown' };
}

export interface MoveOutcome {
  moved: boolean;
  /** Where a read after the move found it, which the row reports, not where it was sent. */
  actualGroupId: number | null;
  verified: boolean;
}

export interface MoveOptions extends EngineOptions {
  probe: RelocationProbe;
  targetGroupExists?: boolean | undefined;
  onEvent?: DeleteEventSink | undefined;
}

/**
 * Puts an active process into a group and reads where it landed: RestoreProcess with no
 * retries while the probe allows, otherwise archive and restore into the group. Port of
 * `Move-NpmProcessToGroup`.
 */
export function moveProcessToGroup(
  gateway: DeleteGateway,
  processUniqueId: string,
  targetGroupId: number | null,
  options: MoveOptions,
): Promise<MoveOutcome> {
  return notPorted('unwind');
}

export interface RestorePlanStateOptions extends EngineOptions {
  probe: RelocationProbe;
  /** Saves the plan after each entry, so an interrupted unwind can be finished from it. */
  persist?: (() => Promise<void>) | undefined;
  onEvent?: DeleteEventSink | undefined;
}

/**
 * Everything the ledger says this run un-archived and did not delete, holders and targets
 * alike, returned to its own group and archived: one `ReArchive` or `ReArchiveHolder` row
 * each, naming the group it verifiably landed in. A process whose group is gone, a parked
 * holder among them, is archived where it sits. Idempotent: an entry marked denormalised
 * is skipped. Port of `Restore-ProcessPlanState`.
 */
export function restorePlanState(
  gateway: DeleteGateway,
  plan: Pick<DependencyPlan, 'ledger'>,
  options: RestorePlanStateOptions,
): Promise<ResultRow[]> {
  return notPorted('unwind');
}

/**
 * The two calls `restoreCollateral` (collateral.ts) makes, over this gateway: a restore
 * that skips a group known to be gone, and the archive with its approval override.
 */
export function collateralGateway(gateway: DeleteGateway, options: EngineOptions = {}): CollateralGateway {
  const archiveOptions: ArchiveOptions = {
    approvalOverride: options.approvalsEnabled ?? true,
    isFatal: options.isFatal ?? (() => null),
  };
  return {
    restore: async (uniqueId, groupId, destinationGroupExists) => {
      const outcome = await restoreProcess(gateway, uniqueId, groupId, { destinationGroupExists });
      return { ok: outcome.ok, statusCode: outcome.statusCode > 0 ? outcome.statusCode : null };
    },
    archive: async (uniqueId, comment) => {
      const outcome = await archiveOne(gateway, uniqueId, comment, archiveOptions);
      return {
        ok: outcome.success,
        message: outcome.message,
        statusCode: outcome.statusCode > 0 ? outcome.statusCode : null,
      };
    },
  };
}
