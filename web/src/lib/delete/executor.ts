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

import { archiveOne, failureOf, type ArchiveOptions, type ArchiveOutcome } from '../archive/outcome.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import { defaultIsFatal } from '../exec/runner.ts';
import { buildUpdateEnvelope } from '../pm/processes.ts';
import type { ProcessActions } from '../pm/types.ts';
import { chooseWritePath, isOpenDraft, isWritePath, writeStateOf, type WriteRefusal } from '../pm/writePath.ts';
import { readGroupExists } from '../select/archived.ts';
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
import type { ActiveRead, DeleteGateway } from './gateway.ts';
import type { DependencyPlan, RevisionBeforeRestore } from './ledger.ts';
import { nodeInt, nodeString, type ProcessModel } from './model.ts';
import { resolveClaimName } from './names.ts';
import { reArchiveOperation } from './runOutcome.ts';
import { findProcessReferenceSites, removeProcessReferences, type ReferenceSite } from './references.ts';

export interface EngineOptions {
  /** Permission to override a pending approval, read back per process (`-ApprovalsEnabled`). Default true. */
  approvalsEnabled?: boolean | undefined;
  /** An error that ends the run (a dead session) is rethrown rather than reported. */
  isFatal?: ((error: unknown) => string | null) | undefined;
  /**
   * Each results row as it is made, not only in the array returned at the end: a run that
   * dies part-way still knows every process it changed (old T1, found by the offline
   * resume in W5 phase 7).
   */
  onRow?: ((row: ResultRow) => void) | undefined;
}

/** Rows that also go to `onRow` as each is added. */
function reportingRows(onRow: ((row: ResultRow) => void) | undefined): ResultRow[] {
  const rows: ResultRow[] = [];
  if (!onRow) return rows;
  const push = rows.push.bind(rows);
  rows.push = (...items: ResultRow[]) => {
    for (const item of items) onRow(item);
    return push(...items);
  };
  return rows;
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
  /**
   * Set for a holder this run restored whose archived model had no open draft: the
   * in-progress revision the live read shows is the restore's own (R13), so the path is
   * chosen as for a clean holder. Published before, it is published; never published, it
   * is saved only. Absent, the live read decides.
   */
  restoredWithoutDraft?: RevisionBeforeRestore | undefined;
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

  const restored = options.restoredWithoutDraft;
  const live = writeStateOf(model, options.processActions);
  // What was published before the restore is what the restore's revision sits over.
  const state = restored && restored.publishedVersionExists !== null ? { ...live, publishedVersionExists: restored.publishedVersionExists } : live;
  const path = chooseWritePath(state, {
    publish: restored?.publishedVersionExists === false ? 'save-only' : 'match-state',
    overridePendingApproval: options.approvalsEnabled ?? false,
    openDraft: restored || options.publishOpenDraft === true ? 'publish' : 'refuse',
  });
  if (!isWritePath(path)) {
    return { success: false, stage: 'Refused', error: SAVE_REFUSALS[path.refused], statusCode: 0, refusal: path.refused };
  }
  // The restore's own revision going live is not someone's draft going live.
  const draftPublished = !restored && path !== 'save-only' && state.revisionStateId === 1;

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

/** Which holders an open draft keeps from being edited, decided before anything is saved. */
export interface DraftCheck {
  /** Each target a refused holder keeps alive, once, with the first such holder and why. */
  heldBack: HeldBackTarget[];
  /** Holders refused for an open draft the operator did not tick. */
  refusedHolderIds: string[];
}

const draftReason = (name: string) => `${name} has an unpublished draft; removing its reference would publish it`;

/**
 * Every holder's write state, reads only (Cowork's review of W5 phase 6). Deciding at
 * edit time meant a clean holder earlier in the list lost its link to a target that a
 * draft holder later kept alive: a published change for nothing, and nothing puts
 * references back. Run before the final confirmation, so it can say what will be kept
 * and why (F6, R13); the save re-checks each holder and reports a draft opened since.
 */
export async function checkHolderDrafts(
  gateway: Pick<DeleteGateway, 'readModel'>,
  plan: Pick<DependencyPlan, 'workItems' | 'ledger' | 'claims'>,
  options: EngineOptions & { publishDrafts?: readonly string[] | undefined; onEvent?: DeleteEventSink | undefined } = {},
): Promise<DraftCheck> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const ticked = new Set((options.publishDrafts ?? []).map((id) => id.toLowerCase()));
  const recordOf = (uniqueId: string) => plan.ledger.find((r) => r.uniqueId.toLowerCase() === uniqueId.toLowerCase());
  const nameOf = (uniqueId: string) => recordOf(uniqueId)?.name || resolveClaimName(plan.claims, uniqueId);
  const heldBack: HeldBackTarget[] = [];
  const held = new Set<string>();
  const refused: string[] = [];
  for (const [i, item] of plan.workItems.entries()) {
    options.onEvent?.({ kind: 'progress', label: 'Checking holders for open drafts', done: i + 1, total: plan.workItems.length });
    if (ticked.has(item.holderUniqueId.toLowerCase())) continue;
    // A holder this run restored is judged from its archived model, read before the
    // restore: the live read shows the restore's own in-progress revision, which R13
    // took for a draft on every restored holder and held back all their targets. That
    // model never shows a draft, because archiving publishes it (R14), so a restored
    // holder found with one here is a guard for a tenant that behaves otherwise.
    const record = recordOf(item.holderUniqueId);
    const before = record?.restoredByThisRun ? record.revisionBeforeRestore : undefined;
    let openDraft: boolean;
    if (before) {
      openDraft = before.openDraft;
    } else {
      let read: ActiveRead | null = null;
      try {
        read = await gateway.readModel(item.holderUniqueId);
      } catch (error) {
        if (isFatal(error)) throw error;
        // Unreadable here is left to the edit, which reports it.
      }
      openDraft = read?.kind === 'model' && isOpenDraft(writeStateOf(read.model, read.processActions));
    }
    if (!openDraft) continue;
    refused.push(item.holderUniqueId);
    for (const target of item.targetsAffected) {
      if (held.has(target.toLowerCase())) continue;
      held.add(target.toLowerCase());
      heldBack.push({ targetUniqueId: target, holderUniqueId: item.holderUniqueId, reason: draftReason(nameOf(item.holderUniqueId)) });
    }
  }
  return { heldBack, refusedHolderIds: refused };
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
    /** From `checkHolderDrafts`, when the run already made it for the confirmation. Absent: made here. */
    draftCheck?: DraftCheck | undefined;
    onEvent?: DeleteEventSink | undefined;
  } = {},
): Promise<ReferenceRemovalRun> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const results = reportingRows(options.onRow);
  const heldBack: HeldBackTarget[] = [];
  const ticked = new Set((options.publishDrafts ?? []).map((id) => id.toLowerCase()));
  const workItems = plan.workItems;
  const recordOf = (uniqueId: string) => plan.ledger.find((r) => r.uniqueId.toLowerCase() === uniqueId.toLowerCase());
  const nameOf = (uniqueId: string) => recordOf(uniqueId)?.name || resolveClaimName(plan.claims, uniqueId);
  // As in `checkHolderDrafts`: a restored holder's open revision is the restore's own.
  const beforeRestore = (uniqueId: string) => {
    const record = recordOf(uniqueId);
    return record?.restoredByThisRun ? record.revisionBeforeRestore : undefined;
  };

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

  const heldBackIds = new Set<string>();
  const refusedHolders = new Set<string>();
  const holdBack = (holderId: string, targets: readonly string[], reason: string) => {
    refusedHolders.add(holderId.toLowerCase());
    for (const target of targets) {
      if (heldBackIds.has(target.toLowerCase())) continue;
      heldBackIds.add(target.toLowerCase());
      heldBack.push({ targetUniqueId: target, holderUniqueId: holderId, reason });
    }
  };
  const keptOut = (n: number) => (n === 1 ? 'the target it holds is' : `the ${n} targets it holds are`);

  // Every holder's write state before the first save (`checkHolderDrafts`). The run makes
  // it earlier, for the confirmation, and has raised the stage already.
  if (!options.draftCheck) options.onEvent?.({ kind: 'stage', stage: 'removing-references' });
  const check = options.draftCheck ?? (await checkHolderDrafts(gateway, plan, { isFatal, publishDrafts: options.publishDrafts, onEvent: options.onEvent }));
  for (const holderId of check.refusedHolderIds) refusedHolders.add(holderId.toLowerCase());
  for (const h of check.heldBack) {
    if (heldBackIds.has(h.targetUniqueId.toLowerCase())) continue;
    heldBackIds.add(h.targetUniqueId.toLowerCase());
    heldBack.push({ ...h });
  }

  /** Target to the holders whose references to it were removed, for the backstop's log line. */
  const editedFor = new Map<string, string[]>();
  for (const [i, item] of workItems.entries()) {
    options.onEvent?.({ kind: 'progress', label: 'Removing references', done: i + 1, total: workItems.length });
    const holderId = item.holderUniqueId;
    const name = nameOf(holderId);
    const row = (status: string, message: string, statusCode?: number | null) =>
      resultRow({ objectId: holderId, name, operation: 'RemoveReferences', status, message, statusCode });

    if (refusedHolders.has(holderId.toLowerCase())) {
      // Skipped, not Failed: left unticked, it did what the operator asked (R13). Failed
      // is kept for errors, including the backstop below, which nobody chose.
      results.push(
        row(
          'Skipped',
          `Not saved: ${SAVE_REFUSALS['open-draft']}. Its references remain, so ${keptOut(item.targetsAffected.length)} left out of the delete. Tick it to publish the draft with the removal.`,
        ),
      );
      continue;
    }
    // Only references to targets still being deleted: a link to a kept target still works.
    const deleting = item.targetsAffected.filter((t) => !heldBackIds.has(t.toLowerCase()));
    if (deleting.length === 0) {
      results.push(row('Skipped', 'Not edited: every target it references is being kept'));
      continue;
    }

    const { model, processActions, reason, status } = await readForEdit(holderId);
    if (!model) {
      results.push(row('Failed', `Could not fetch process for editing (${reason})`, status));
      continue;
    }

    // Every target at once: one save and one publish per holder.
    const removal = removeProcessReferences(model, deleting);
    if (removal.referencesRemoved === 0 || !removal.cleaned) {
      results.push(row('Skipped', 'No references found at edit time (already removed?)'));
      continue;
    }

    // Decided again from this read: the pre-pass is the decision, this is the backstop
    // for a draft opened since. A restored holder has no backstop: its draft is ours.
    const before = beforeRestore(holderId);
    const restoredWithoutDraft = before && !before.openDraft ? before : undefined;
    const save = await saveProcessModel(gateway, holderId, removal.cleaned, {
      processActions,
      changeDescription: options.changeDescription,
      approvalsEnabled: options.approvalsEnabled ?? true,
      publishOpenDraft: ticked.has(holderId.toLowerCase()),
      restoredWithoutDraft,
      suppressChangeNotification: true,
      isFatal,
    });
    if (save.refusal === 'open-draft') {
      holdBack(holderId, deleting, draftReason(name));
      for (const target of deleting) {
        const already = editedFor.get(target.toLowerCase()) ?? [];
        if (already.length === 0) continue;
        const line = `${name} opened a draft after the check, so ${nameOf(target)} (${target}) is kept, but its references were already removed from: ${already.join(', ')}`;
        plan.log.push(line);
        options.onEvent?.({ kind: 'log', line });
      }
      results.push(
        row(
          'Failed',
          `Not saved: ${save.error ?? ''}. A draft was opened after the check; its references remain, so ${keptOut(deleting.length)} left out of the delete.`,
          save.statusCode,
        ),
      );
      continue;
    }
    if (save.success) {
      for (const target of deleting) editedFor.set(target.toLowerCase(), [...(editedFor.get(target.toLowerCase()) ?? []), name]);
    }
    results.push(
      row(
        save.success ? 'Success' : 'Failed',
        save.success
          ? `Removed ${removal.referencesRemoved} reference(s), ${save.stage}${save.draftPublished ? '; its open draft went live with the removal' : ''}${before ? '; restored from the archive for the edit, and archived again at the end of the run' : ''}`
          : save.stage === 'Refused'
            ? `Not saved: ${save.error ?? ''}. Its references to the targets remain.`
            : `${save.stage} failed: ${save.error ?? ''}`.trimEnd(),
        save.success ? null : save.statusCode,
      ),
    );
  }

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
  const results = reportingRows(options.onRow);
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
    // An active target gets its own row for the archive (R14: it had only a Delete row,
    // and archiving publishes a new major version). A target the Hold restored is going
    // back to the state the run found it in, so its Delete row is the whole story.
    if (record && !record.wasArchived) results.push(preDeleteArchiveRow(target, nameOf(target), record.originalGroupId, archive));
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
      if (!decision.proceed) {
        results.push(...decision.rows);
        return results;
      }
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
      // Never resent (the write policy): a refusal is the tenant's answer, not a fault.
      const status = failureOf(error).status;
      const refusal = deleteRefusalText(error);
      let message = `Delete failed (HTTP ${status})${refusal ? `: ${refusal}` : ''}`;
      // The tenant answered, so it is still there. An archived target goes home with the
      // unwind as a held-back one does; an active one the archive pass archived is made
      // active again in its own group, which is where a held-back active target stays.
      if (status > 0 && record && !record.wasArchived) message += await returnActiveTarget(gateway, target, record.originalGroupId, isFatal);
      results.push(row('Failed', message, status > 0 ? status : null));
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
 * Why the tenant refused a delete, in words for the row. A still-referenced target is
 * answered HTTP 500 "Process Cannot Be Deleted" with `additionalInfos` naming what holds
 * it (R13, measured from the browser; shape not captured). So the names are read from
 * any strings under `additionalInfos`, or the `name`/`Name`/`title` of objects there,
 * with the raw body as the fallback and the tenant's message before both.
 */
export function deleteRefusalText(error: unknown): string {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const message = failureOf(error).detail ?? '';
  const raw = typeof record['detail'] === 'string' ? record['detail'].trim() : '';
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  const infos = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['additionalInfos'] : undefined;
  const names: string[] = [];
  const collect = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.trim()) names.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
    } else if (typeof value === 'object') {
      const item = value as Record<string, unknown>;
      const label = ['name', 'Name', 'title', 'processName'].map((k) => item[k]).find((v) => typeof v === 'string' && v.trim());
      if (typeof label === 'string') names.push(label.trim());
      else for (const v of Object.values(item)) collect(v, depth + 1);
    }
  };
  collect(infos, 0);
  const unique = [...new Set(names)].filter((n) => n !== message);
  if (unique.length > 0) return `${message || 'refused'}. Still referenced by: ${unique.join('; ')}`;
  if (message) return message;
  return raw.slice(0, 500);
}

/** The archive pass's row for an active target: archived before its delete, or why not. */
function preDeleteArchiveRow(target: string, name: string, groupId: number | null, archive: ArchiveOutcome): ResultRow {
  const overridden = archive.outcome === 'Overridden' ? ', after the pending-approval override' : '';
  return resultRow({
    objectId: target,
    name,
    operation: 'Archive',
    status: archive.success ? 'Success' : 'Failed',
    message: archive.success
      ? `Archived before the delete${overridden}`
      : `Could not be archived before the delete: ${archive.message}. The delete was still sent; its row says what happened`,
    groupId,
    statusCode: archive.statusCode > 0 ? archive.statusCode : null,
  });
}

/**
 * Makes an active target the archive pass archived active again in its own group; the
 * row's suffix. R14 measured what that leaves: archiving publishes a new major version
 * (1.0 becomes 2.0) and the restore opens an in-progress revision on top (2.1), so the
 * row says both, or the owner finds a version and a draft nobody made. Each version is
 * read, the archived one before the restore and the restored one after; one that can't
 * be read is described rather than guessed.
 */
async function returnActiveTarget(
  gateway: DeleteGateway,
  target: string,
  groupId: number | null,
  isFatal: (error: unknown) => string | null,
): Promise<string> {
  if (groupId === null) return '. It was archived before the delete and no original group was recorded, so it stays archived';
  const versionFrom = async (read: () => Promise<ProcessModel | null | undefined>): Promise<string> => {
    try {
      return nodeString(await read(), 'Version');
    } catch (error) {
      if (isFatal(error)) throw error;
      return '';
    }
  };
  const archived = await versionFrom(async () => (await gateway.readArchivedModels([target]))[0]);
  const restored = await restoreProcess(gateway, target, groupId, { isFatal });
  if (!restored.ok) {
    return `. It was archived before the delete${archived ? `, which published it as ${archived},` : ''} and could not be made active again in group ${groupId} (HTTP ${restored.statusCode}); restore it manually`;
  }
  const opened = await versionFrom(async () => {
    const read = await gateway.readModel(target);
    return read.kind === 'model' ? read.model : null;
  });
  return `. Not deleted, so made active again in group ${groupId}. ${archiveAndRestoreVersions(archived, opened)}`;
}

/** "Archiving published it as 2.0, and the restore opened 2.1.", with words for a version not read. */
export function archiveAndRestoreVersions(archived: string, opened: string): string {
  const published = archived ? `Archiving published it as ${archived}` : 'Archiving published it as a new major version';
  const restore = opened ? `the restore opened ${opened}` : 'the restore opened an in-progress revision on top';
  return `${published}, and ${restore}.`;
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
export async function moveProcessToGroup(
  gateway: DeleteGateway,
  processUniqueId: string,
  targetGroupId: number | null,
  options: MoveOptions,
): Promise<MoveOutcome> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const notMoved: MoveOutcome = { moved: false, actualGroupId: null, verified: false };
  // A group that is gone is not somewhere to move to, and the fallback would archive the
  // process on the way to finding that out.
  if (targetGroupId === null || options.targetGroupExists === false) return notMoved;

  // Asked once per run and with no retries: on the measured tenant RestoreProcess answers
  // 500 for an active process every time, and the retry ladder spent 14 seconds per
  // process learning it.
  if (options.probe.state !== 'No') {
    await restoreProcess(gateway, processUniqueId, targetGroupId, { retry: false, isFatal });
    const actual = await currentGroupOf(gateway, processUniqueId, isFatal);
    if (actual === targetGroupId) {
      if (options.probe.state === 'Unknown') options.onEvent?.({ kind: 'relocationProbe', relocatesActive: true });
      options.probe.state = 'Yes';
      return { moved: true, actualGroupId: actual, verified: true };
    }
    if (options.probe.state === 'Unknown') {
      options.probe.state = 'No';
      options.onEvent?.({ kind: 'relocationProbe', relocatesActive: false });
    }
  }

  // Documented behaviour only: archive, then restore into the group wanted.
  const archive = await archiveOne(gateway, processUniqueId, RELOCATION_ARCHIVE_COMMENT, {
    approvalOverride: options.approvalsEnabled ?? true,
    isFatal,
  });
  // The restore is still attempted: ArchiveProcess can report failure and take effect,
  // and the placement is read back either way.
  if (!archive.success) options.onEvent?.({ kind: 'log', line: `Archive step of relocating ${processUniqueId} failed: ${archive.message}` });
  await restoreProcess(gateway, processUniqueId, targetGroupId, { isFatal });

  const actual = await currentGroupOf(gateway, processUniqueId, isFatal);
  if (actual === null) return notMoved;
  return { moved: actual === targetGroupId, actualGroupId: actual, verified: true };
}

const RELOCATION_ARCHIVE_COMMENT = 'Relocating to original group';
export const RE_ARCHIVE_COMMENT = 'Re-archiving after dependency cleanup';

/**
 * The group a process is in now, from the active read or the archived batch read, or
 * null when neither says. Port of `Get-NpmProcessGroupId`.
 */
export async function currentGroupOf(
  gateway: Pick<DeleteGateway, 'readModel' | 'readArchivedModels'>,
  processUniqueId: string,
  isFatal: (error: unknown) => string | null = defaultIsFatal,
): Promise<number | null> {
  try {
    const read = await gateway.readModel(processUniqueId);
    if (read.kind === 'model') return nodeInt(read.model, 'GroupId');
    const archived = await gateway.readArchivedModels([processUniqueId]);
    const model = archived.find((m) => nodeString(m, 'UniqueId').toLowerCase() === processUniqueId.toLowerCase());
    return model ? nodeInt(model, 'GroupId') : null;
  } catch (error) {
    if (isFatal(error)) throw error;
    return null;
  }
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
export async function restorePlanState(
  gateway: DeleteGateway,
  plan: Pick<DependencyPlan, 'ledger'>,
  options: RestorePlanStateOptions,
): Promise<ResultRow[]> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const results = reportingRows(options.onRow);
  // The ledger, not the target list: holders as well as targets (old T1).
  const toRestore = plan.ledger.filter((e) => e.wasArchived && e.restoredByThisRun && !e.denormalized && !e.deleted);
  if (toRestore.length === 0) return results;
  options.onEvent?.({ kind: 'stage', stage: 'returning-processes' });

  for (const [i, entry] of toRestore.entries()) {
    options.onEvent?.({ kind: 'progress', label: 'Returning processes', done: i + 1, total: toRestore.length });
    const homeGroupId = entry.originalGroupId;
    let placement: string;
    let movedOk = true;
    // Where it is when the row is written; null only where no read could say.
    let landed: number | null = null;

    if (homeGroupId === null) {
      landed = await currentGroupOf(gateway, entry.uniqueId, isFatal);
      placement = 'no original group was recorded, so it was archived where it sat';
      movedOk = false;
    } else if (!readGroupExists(entry.originalGroupExists).exists) {
      // Home is gone, so it is archived where it sits: archiving takes no group. This is
      // also where a parked holder lands, which is why parking one is safe.
      landed = await currentGroupOf(gateway, entry.uniqueId, isFatal);
      const where = landed !== null ? `group ${landed}` : 'the group it currently sits in';
      placement = `${where}; its original group ${homeGroupId} no longer exists`;
      movedOk = false;
    } else {
      const current = await currentGroupOf(gateway, entry.uniqueId, isFatal);
      if (current === homeGroupId) {
        placement = `group ${homeGroupId}`;
        landed = homeGroupId;
      } else {
        // ArchiveProcess archives where the process sits, which is the holding group.
        const move = await moveProcessToGroup(gateway, entry.uniqueId, homeGroupId, {
          probe: options.probe,
          approvalsEnabled: options.approvalsEnabled,
          isFatal,
          onEvent: options.onEvent,
        });
        movedOk = move.moved;
        if (move.moved) {
          placement = `group ${homeGroupId}`;
          landed = homeGroupId;
        } else if (move.verified) {
          placement = `group ${move.actualGroupId}, NOT the original group ${homeGroupId}`;
          landed = move.actualGroupId;
        } else {
          placement = `an UNVERIFIED group; the move to ${homeGroupId} could not be confirmed`;
        }
      }
    }

    const outcome = await archiveOne(gateway, entry.uniqueId, RE_ARCHIVE_COMMENT, {
      approvalOverride: options.approvalsEnabled ?? true,
      isFatal,
    });
    entry.denormalized = outcome.success;

    // A parked holder had no group of its own before the run either: archived where it
    // sits is the state it was found in, so that is a success, not a compromise.
    let status = outcome.success ? (movedOk ? 'Success' : 'Skipped') : 'Failed';
    if (outcome.success && entry.parkedInHoldingGroup) status = 'Success';
    let message = outcome.success
      ? `Re-archived in ${placement}`
      : `Re-archive failed; this process is still ACTIVE in ${placement}. ${outcome.message}`.trimEnd();
    if (entry.parkedInHoldingGroup) {
      // Old T2: it stays archived without a group, the state it was found in.
      message = `${message}. This run held it here only so its references could be read; it was already orphaned before the run started, and stays archived without a group`;
    }
    results.push(
      resultRow({
        objectId: entry.uniqueId,
        name: entry.name,
        operation: reArchiveOperation(entry.role, entry.parkedInHoldingGroup),
        status,
        message,
        groupId: landed,
        statusCode: outcome.statusCode,
      }),
    );
    // Saved after each, so an interrupted unwind can be finished from the plan.
    await options.persist?.();
  }
  return results;
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
