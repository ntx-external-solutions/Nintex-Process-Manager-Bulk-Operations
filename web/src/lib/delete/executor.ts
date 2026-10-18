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

import { archiveOne, failureOf, type ArchiveOptions } from '../archive/outcome.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import { defaultIsFatal } from '../exec/runner.ts';
import { buildUpdateEnvelope } from '../pm/processes.ts';
import type { ProcessActions } from '../pm/types.ts';
import { chooseWritePath, isWritePath, writeStateOf, type WriteRefusal } from '../pm/writePath.ts';
import { loadProcessIndex, type ProcessIndex } from '../tenant/state.ts';
import {
  ACCEPTANCE_AUTHORITY,
  collateralAcceptanceRows,
  collateralFailureRows,
  decideCollateral,
  newCollateral,
  restoreCollateral,
  type CollateralChange,
  type CollateralGate,
  type CollateralGateway,
} from './collateral.ts';
import type { DeleteEventSink } from './events.ts';
import type { DeleteGateway } from './gateway.ts';
import type { DependencyPlan } from './ledger.ts';
import { nodeInt, type ProcessModel } from './model.ts';
import { resolveClaimName } from './names.ts';
import { notPorted } from './phases.ts';
import { findProcessReferenceSites, removeProcessReferences, type ReferenceSite } from './references.ts';

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
  /** A dead session is rethrown rather than reported as a refused restore. */
  isFatal?: ((error: unknown) => string | null) | undefined;
}

/**
 * Un-archives one process into one group. Returns the failure rather than recording it
 * in `$script:NpmLastRestoreFailure` and `NpmLastRestoreStatus`. Port of
 * `Restore-NpmProcess`.
 */
export async function restoreProcess(
  gateway: Pick<DeleteGateway, 'restore'>,
  processUniqueId: string,
  processGroupId: number | null,
  options: RestoreOptions = {},
): Promise<RestoreOutcome> {
  // The listing already said the group is gone, and that answer is definitive: the call
  // would be four 500s and 14 seconds of backoff to learn it again. A null group is the
  // same case, since there is nowhere to send it. Distinct from an endpoint failure, so a
  // caller can pick somewhere real instead of retrying.
  if (options.destinationGroupExists === false || processGroupId === null) {
    return { ok: false, failure: 'MissingGroup', statusCode: 0 };
  }
  try {
    await gateway.restore(processUniqueId, processGroupId, options.retry === false ? { retry: false } : {});
    return { ok: true, failure: null, statusCode: 0 };
  } catch (error) {
    if (options.isFatal?.(error)) throw error;
    return { ok: false, failure: 'Endpoint', statusCode: failureOf(error).status };
  }
}

/** `Refused`: never sent, because the process says this account cannot write it as needed. */
export type SaveStage = 'Refused' | 'Save' | 'SavedUnpublished' | 'Publish' | 'Published';

export interface SaveOutcome {
  success: boolean;
  /** Where it got to, or where it failed. */
  stage: SaveStage;
  error: string | null;
  statusCode: number;
  /** Why it was refused, when `stage` is `Refused`. */
  refusal?: WriteRefusal | undefined;
  /** The save went out over an open draft and published it: the draft's changes are live. */
  draftPublished?: boolean | undefined;
}

export interface SaveModelOptions {
  /** From the same read the model came from. Decides the publish route (pm/writePath.ts). */
  processActions: Partial<ProcessActions> | null;
  changeDescription?: string | undefined;
  /** Permission to edit a revision awaiting approval, and publish over it. Default false. */
  approvalsEnabled?: boolean | undefined;
  /**
   * Publish an open draft over a published version along with the edit. Default false:
   * the save is refused, because saving into the draft leaves the reference in the live
   * version, and publishing puts someone else's unfinished work live (Cowork's review of
   * W5 phase 5). The operator ticks each holder this applies to.
   */
  publishOpenDraft?: boolean | undefined;
  /** Default true: these edits publish a version the owner never asked for. */
  suppressChangeNotification?: boolean | undefined;
  /** A dead session is rethrown rather than reported as a failed save. */
  isFatal?: ((error: unknown) => string | null) | undefined;
}

/** The script's change description for a reference removal, used when the run gives none. */
export const REFERENCE_REMOVAL_DESCRIPTION = 'Automated dependency removal';

const SAVE_REFUSALS: Record<WriteRefusal, string> = {
  'cannot-save': 'This account cannot save changes to this process',
  'awaiting-approval': 'It is awaiting approval, and this run is not allowed to override a pending approval',
  'open-draft': 'It has an unpublished draft; removing the reference would publish it',
  'cannot-publish': 'It is published, and cannot be republished by this account: it can neither publish it nor submit it for approval',
};

/**
 * Saves a model (ProcessJson as a string: an object returns 200 and drops the edit), then
 * re-reads it for the new revision and publishes it. Port of `Save-NpmProcessModel`.
 *
 * DIFFERS: the route comes from the process (Cowork's review of phase 4). The script
 * chose `DoSubmitForApproval` and the publish call from `-ApprovalsEnabled`, and decided
 * whether to publish from the version number. Here `chooseWritePath` reads the revision
 * state and `processActions`, as ownership does: a published process is saved with
 * `DoSubmitForApproval` only when submitting is all this account may do, and is always
 * published through `publishNow` (S2, W4). A process the account cannot republish is
 * refused before anything is saved, rather than left as a draft that still holds the
 * reference. `PublishProcessRevisionEdit` is not used: it was never measured from the
 * web app, and one publish route is easier to trust than two.
 *
 * The script slept a second before the re-read; the ownership save (pm/ownership.ts) reads
 * straight after its save and matched the tenant in the W4 live test, so this does too.
 */
export async function saveProcessModel(
  gateway: Pick<DeleteGateway, 'saveModel' | 'readModel' | 'publishNow'>,
  processUniqueId: string,
  model: ProcessModel,
  options: SaveModelOptions,
): Promise<SaveOutcome> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const description = options.changeDescription ?? REFERENCE_REMOVAL_DESCRIPTION;
  const failed = (stage: SaveStage, error: unknown): SaveOutcome => {
    if (isFatal(error)) throw error;
    const failure = failureOf(error);
    return { success: false, stage, error: failure.detail ?? failure.error, statusCode: failure.status };
  };

  const state = writeStateOf(model, options.processActions);
  const path = chooseWritePath(state, {
    publish: 'match-state',
    overridePendingApproval: options.approvalsEnabled ?? false,
    openDraft: options.publishOpenDraft === true ? 'publish' : 'refuse',
  });
  if (!isWritePath(path)) {
    return { success: false, stage: 'Refused', error: SAVE_REFUSALS[path.refused], statusCode: 0, refusal: path.refused };
  }
  const draftPublished = path !== 'save-only' && state.revisionStateId === 1;

  try {
    await gateway.saveModel(
      processUniqueId,
      buildUpdateEnvelope(model as Parameters<typeof buildUpdateEnvelope>[0], {
        changeDescription: description,
        submitForApproval: path === 'submit-then-publish',
        suppressChangeNotification: options.suppressChangeNotification ?? true,
      }),
    );
  } catch (error) {
    return failed('Save', error);
  }
  if (path === 'save-only') return { success: true, stage: 'SavedUnpublished', error: null, statusCode: 200 };

  // Re-read for the revision id the save produced.
  let updated: ProcessModel | null = null;
  try {
    const read = await gateway.readModel(processUniqueId);
    if (read.kind === 'model') updated = read.model;
  } catch (error) {
    if (isFatal(error)) throw error;
  }

  // The script reported a failed re-read as SavedUnpublished and left the new draft
  // unpublished. That draft is a published process's live version gone stale, so it fails.
  const revisionId = nodeInt(updated, 'ProcessRevisionEditId');
  if (revisionId === null) {
    return {
      success: false,
      stage: 'Publish',
      error: 'Saved, but the new revision could not be read back, so it was not published',
      statusCode: 0,
    };
  }

  try {
    // The change description is the publish message: a tenant in "Publish Only mode"
    // answers 400 without one (S2).
    await gateway.publishNow(processUniqueId, revisionId, description);
  } catch (error) {
    return failed('Publish', error);
  }
  return { success: true, stage: 'Published', error: null, statusCode: 200, draftPublished };
}

export interface VerificationFailure {
  holderUniqueId: string;
  remaining: ReferenceSite[];
  /** Set when the holder could not be read back, so nothing about it was verified. */
  unreadReason?: string | undefined;
}

/** A target the delete must leave alone, because a holder of it could not be edited safely. */
export interface HeldBackTarget {
  targetUniqueId: string;
  holderUniqueId: string;
  /** For the target's `Delete` row. */
  reason: string;
}

export interface ReferenceRemovalRun {
  /** One `RemoveReferences` row per holder. */
  results: ResultRow[];
  verificationFailed: VerificationFailure[];
  /**
   * Targets of a holder refused for its open draft. Left out of the delete with the reason,
   * rather than stopping the run at verification: the refusal is a known, deliberate
   * outcome, not a missed reference (Cowork's review of W5 phase 5).
   */
  heldBack: HeldBackTarget[];
}

/**
 * Removes every reference the plan found, one save per holder, then re-reads each holder
 * and walks it for anything left. Port of `Invoke-ProcessDeletePlan`.
 */
export async function removePlanReferences(
  gateway: DeleteGateway,
  plan: DependencyPlan,
  options: EngineOptions & {
    skipVerification?: boolean | undefined;
    /** The run's change description, sent on every save and publish. */
    changeDescription?: string | undefined;
    /** Holders with an open draft the operator ticked: their draft is published with the removal. */
    publishDrafts?: readonly string[] | undefined;
    onEvent?: DeleteEventSink | undefined;
  } = {},
): Promise<ReferenceRemovalRun> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const results: ResultRow[] = [];
  const heldBack: HeldBackTarget[] = [];
  const ticked = new Set((options.publishDrafts ?? []).map((id) => id.toLowerCase()));
  const workItems = plan.workItems;
  const nameOf = (uniqueId: string) =>
    plan.ledger.find((r) => r.uniqueId.toLowerCase() === uniqueId.toLowerCase())?.name || resolveClaimName(plan.claims, uniqueId);

  // Read fresh for the edit, never from the plan: planning may be minutes old, and saving a
  // stale model would discard whatever changed since.
  const readForEdit = async (
    uniqueId: string,
  ): Promise<{ model: ProcessModel | null; processActions: Partial<ProcessActions> | null; reason: string; status: number }> => {
    try {
      const read = await gateway.readModel(uniqueId);
      if (read.kind === 'model') return { model: read.model, processActions: read.processActions, reason: '', status: 0 };
      return { model: null, processActions: null, reason: 'it is archived', status: 0 };
    } catch (error) {
      if (isFatal(error)) throw error;
      const failure = failureOf(error);
      return { model: null, processActions: null, reason: failure.detail ?? failure.error, status: failure.status };
    }
  };

  options.onEvent?.({ kind: 'stage', stage: 'removing-references' });
  for (const [i, item] of workItems.entries()) {
    options.onEvent?.({ kind: 'progress', label: 'Removing references', done: i + 1, total: workItems.length });
    const holderId = item.holderUniqueId;
    const name = nameOf(holderId);
    const { model, processActions, reason, status } = await readForEdit(holderId);
    if (!model) {
      results.push(
        resultRow({
          objectId: holderId,
          name,
          operation: 'RemoveReferences',
          status: 'Failed',
          message: `Could not fetch process for editing (${reason})`,
          statusCode: status,
        }),
      );
      continue;
    }

    // Every target at once: one save and one publish per holder.
    const removal = removeProcessReferences(model, item.targetsAffected);
    if (removal.referencesRemoved === 0 || !removal.cleaned) {
      results.push(
        resultRow({
          objectId: holderId,
          name,
          operation: 'RemoveReferences',
          status: 'Skipped',
          message: 'No references found at edit time (already removed?)',
        }),
      );
      continue;
    }

    // Decided from this read, not the plan's: a draft opened since planning is refused
    // just the same, and one published since needs no tick.
    const save = await saveProcessModel(gateway, holderId, removal.cleaned, {
      processActions,
      changeDescription: options.changeDescription,
      approvalsEnabled: options.approvalsEnabled ?? true,
      publishOpenDraft: ticked.has(holderId.toLowerCase()),
      suppressChangeNotification: true,
      isFatal,
    });
    const openDraft = save.refusal === 'open-draft';
    if (openDraft) {
      const reason = `${name} has an unpublished draft; removing its reference would publish it`;
      for (const target of item.targetsAffected) heldBack.push({ targetUniqueId: target, holderUniqueId: holderId, reason });
    }
    results.push(
      resultRow({
        objectId: holderId,
        name,
        operation: 'RemoveReferences',
        status: save.success ? 'Success' : 'Failed',
        message: save.success
          ? `Removed ${removal.referencesRemoved} reference(s), ${save.stage}${save.draftPublished ? '; its open draft went live with the removal' : ''}`
          : openDraft
            ? `Not saved: ${save.error ?? ''}. Its references remain, so ${item.targetsAffected.length === 1 ? 'the target it holds is' : `the ${item.targetsAffected.length} targets it holds are`} left out of the delete. Tick it to publish the draft with the removal.`
            : save.stage === 'Refused'
              ? `Not saved: ${save.error ?? ''}. Its references to the targets remain.`
              : `${save.stage} failed: ${save.error ?? ''}`.trimEnd(),
        statusCode: save.success ? null : save.statusCode,
      }),
    );
  }
  const heldBackIds = new Set(heldBack.map((h) => h.targetUniqueId.toLowerCase()));
  const refusedHolders = new Set(heldBack.map((h) => h.holderUniqueId.toLowerCase()));

  // Verify while everything is still active, by walking each holder's saved model:
  // archiving suppresses the very rows that would reveal a missed reference, so asking the
  // dependency API afterwards reports success either way.
  const verificationFailed: VerificationFailure[] = [];
  if (!options.skipVerification) {
    options.onEvent?.({ kind: 'stage', stage: 'verifying' });
    for (const [i, item] of workItems.entries()) {
      options.onEvent?.({ kind: 'progress', label: 'Verifying', done: i + 1, total: workItems.length });
      // A target that is not being deleted needs no check: a reference left to it dangles
      // nowhere. So a refused draft holder is not read again at all.
      const deleting = item.targetsAffected.filter((t) => !heldBackIds.has(t.toLowerCase()));
      if (refusedHolders.has(item.holderUniqueId.toLowerCase()) || deleting.length === 0) continue;
      const { model, reason } = await readForEdit(item.holderUniqueId);
      // The script skipped a holder it could not read here, so a holder unreadable at both
      // reads went to the delete with its references unchecked. Unread is unverified.
      if (!model) {
        verificationFailed.push({ holderUniqueId: item.holderUniqueId, remaining: [], unreadReason: reason });
        continue;
      }
      const remaining = findProcessReferenceSites(model, deleting).filter((s) => s.action !== 'Report');
      if (remaining.length > 0) verificationFailed.push({ holderUniqueId: item.holderUniqueId, remaining });
    }
  }

  return { results, verificationFailed, heldBack };
}

export type { CollateralGate } from './collateral.ts';

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
  /** From `removePlanReferences`: targets neither archived nor deleted, each with its reason. */
  heldBack?: readonly HeldBackTarget[] | undefined;
  onEvent?: DeleteEventSink | undefined;
}

export const PRE_DELETE_ARCHIVE_COMMENT = 'Pre-delete archive';
const PRE_DELETE_PHASE = 'after archiving targets, before deleting';
const POST_DELETE_PHASE = 'after deleting targets';

/**
 * Archives the targets this run did not already find archived, checks the tenant, deletes
 * them, and checks again: a variation's master moves when the variation is deleted, which
 * the last check can report and partly reverse but never prevent. Marks each deleted
 * target on the ledger so the unwind does not try to re-archive it. Port of
 * `Invoke-ProcessTargetDeletion`.
 */
export async function deletePlanTargets(
  gateway: DeleteGateway,
  plan: DependencyPlan,
  options: TargetDeletionOptions = {},
): Promise<ResultRow[]> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const results: ResultRow[] = [];
  const targets = plan.targetUniqueIds;
  const recordOf = (uniqueId: string) => plan.ledger.find((r) => r.uniqueId.toLowerCase() === uniqueId.toLowerCase());
  const nameOf = (uniqueId: string) => recordOf(uniqueId)?.name || resolveClaimName(plan.claims, uniqueId);
  const heldBack = new Map((options.heldBack ?? []).map((h) => [h.targetUniqueId.toLowerCase(), h]));
  const archiveOptions: ArchiveOptions = { approvalOverride: options.approvalsEnabled ?? true, isFatal };
  const log = (line: string) => {
    plan.log.push(line);
    options.onEvent?.({ kind: 'log', line });
  };

  options.onEvent?.({ kind: 'stage', stage: 'archiving-targets' });
  for (const [i, target] of targets.entries()) {
    options.onEvent?.({ kind: 'progress', label: 'Archiving targets', done: i + 1, total: targets.length });
    const record = recordOf(target);
    if (heldBack.has(target.toLowerCase())) continue;
    if (record?.wasArchived && !record.restoredByThisRun) continue;
    const archive = await archiveOne(gateway, target, PRE_DELETE_ARCHIVE_COMMENT, archiveOptions);
    // An unwind path is where a silent failure does the most damage, so the reason is
    // logged. The delete still goes ahead and the checkpoint reads the tenant, because
    // ArchiveProcess can report failure and take effect anyway.
    if (!archive.success) log(`${nameOf(target)} (${target}) could not be archived before deletion: ${archive.message}`);
  }

  // Everything the run changed on purpose: the targets, and every holder it restored.
  const expected = [...targets, ...plan.ledger.filter((r) => r.restoredByThisRun).map((r) => r.uniqueId)];
  const checkpoint = async (label: string, observedFailure: (error: unknown) => void): Promise<CollateralChange[]> => {
    const fresh = await loadProcessIndex((page, listType) => gateway.listProcesses(page, listType));
    const observed = [...(options.observedUniqueIds ?? [])];
    if (options.getObservedUniqueIds) {
      try {
        observed.push(...(await options.getObservedUniqueIds()));
      } catch (error) {
        if (isFatal(error)) throw error;
        observedFailure(error);
      }
    }
    const found = newCollateral({ baseline: options.tenantBaseline ?? null, fresh, expected, observed, alreadyRaised: plan.collateral });
    plan.collateral.push(...found);
    for (const c of found) log(`COLLATERAL ${label}: ${c.uniqueId} (${c.name}) - ${c.change}`);
    return found;
  };

  if (options.tenantBaseline) {
    options.onEvent?.({ kind: 'stage', stage: 'checking-collateral' });
    // The script dropped a failed holding-group read here without a word. Logged now.
    const collateral = await checkpoint('after archive phase', (error) =>
      log(`Could not list what the run left in the holding group before deleting: ${failureOf(error).error}`),
    );
    if (collateral.length > 0) {
      options.onEvent?.({ kind: 'collateral', phase: PRE_DELETE_PHASE, collateral });
      const decision = await decideCollateral(collateral, PRE_DELETE_PHASE, { gate: options.onCollateral });
      const authority = options.acceptanceAuthority ?? ACCEPTANCE_AUTHORITY.atGate;
      options.onEvent?.({
        kind: 'collateralDecision',
        phase: PRE_DELETE_PHASE,
        accepted: decision.proceed,
        authority: decision.proceed ? authority : null,
        count: collateral.length,
      });
      // An unwanted archive can be undone; a delete cannot. So no gate means stop.
      if (!decision.proceed) return [...results, ...decision.rows];
      results.push(...collateralAcceptanceRows(collateral, PRE_DELETE_PHASE, authority));
    }
  }

  options.onEvent?.({ kind: 'stage', stage: 'deleting-targets' });
  for (const [i, target] of targets.entries()) {
    options.onEvent?.({ kind: 'progress', label: 'Deleting targets', done: i + 1, total: targets.length });
    const record = recordOf(target);
    const row = (status: string, message: string, statusCode?: number | null) =>
      resultRow({ objectId: target, name: nameOf(target), operation: 'Delete', status, message, groupId: record?.originalGroupId ?? null, statusCode });

    const held = heldBack.get(target.toLowerCase());
    if (held) {
      results.push(row('Skipped', `Not deleted: ${held.reason}`));
      continue;
    }
    try {
      await gateway.deleteProcess(target, record?.originalGroupUniqueId || null);
    } catch (error) {
      if (isFatal(error)) throw error;
      const status = failureOf(error).status;
      results.push(row('Failed', `Delete failed (HTTP ${status})`, status > 0 ? status : null));
      continue;
    }
    // So the unwind does not try to re-archive something that no longer exists: before
    // the Hold phase a target IS an archived process this run restored.
    if (record) record.deleted = true;
    results.push(row('Success', 'Deleted'));
  }

  // The variation coupling fires on DELETE, not on restore or archive (measured), so the
  // earlier checkpoints are clean because nothing has happened yet. This one cannot
  // prevent anything: it reports what the delete did and puts back what can be proved.
  if (options.tenantBaseline) {
    options.onEvent?.({ kind: 'stage', stage: 'checking-collateral-after-delete' });
    // Observed ids collected now, not before the deletes: what the delete strands in the
    // holding group is not there until it has happened (W3).
    const collateral = await checkpoint('after delete phase', (error) =>
      log(`Could not list what the run left behind: ${failureOf(error).error}`),
    );
    if (collateral.length > 0) {
      options.onEvent?.({ kind: 'collateral', phase: POST_DELETE_PHASE, collateral });
      results.push(...collateralFailureRows(collateral, 'detected after deletion'));
      options.onEvent?.({ kind: 'stage', stage: 'reversing-collateral' });
      results.push(...(await restoreCollateral(collateralGateway(gateway, options), collateral)));
    }
  }
  return results;
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
 * alike, returned to its own group and archived: one `ReArchive`, `ReArchiveHolder` or `ReArchiveOrphanedHolder` row
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
      // A dead session ends the reversal as it ends everything else, rather than reading
      // as a refused restore.
      const outcome = await restoreProcess(gateway, uniqueId, groupId, { destinationGroupExists, isFatal: options.isFatal });
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
