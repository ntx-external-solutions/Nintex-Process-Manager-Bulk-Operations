/**
 * How an edit to a process is written: saved only, saved and published, or saved for
 * approval and then published. Decided from what the process itself says, never from an
 * operator flag.
 *
 * PGM's rules, first used by Bulk Update Ownership (W4). W5 phase 4's reference removal
 * chose its route from `approvalsEnabled`, whose default disagreed between the save and
 * its caller: the "declared, not read" pattern R10/R11 removed from archive. Cowork's
 * phase 4 review moved the decision here so both writers read it from the process.
 *
 * Both publishing paths end in `POST /Api/v1/Processes/{id}/Publish` with `IsPublishNow`
 * and a `PublishMessage` (measured on the demo tenant in S2 and W4). The only difference
 * is `DoSubmitForApproval` on the save.
 */

import type { ProcessActions } from './types.ts';

export type WritePath = 'save-only' | 'publish-direct' | 'submit-then-publish';

/** Why a process cannot be written the way the caller asked. Each caller words its own row. */
export type WriteRefusal = 'cannot-save' | 'awaiting-approval' | 'open-draft' | 'cannot-publish';

export interface WriteState {
  /** 1 in progress, 2 awaiting approval, 3 published. */
  revisionStateId: number | null;
  canSave: boolean;
  canPublishAfterEdit: boolean;
  canSubmitForApprovalAfterEdit: boolean;
  /**
   * A major version of 1 or more: something is live beneath an open draft. Unknown
   * (absent) is treated as true, since a draft over a published version is the case that
   * costs something.
   */
  publishedVersionExists?: boolean | undefined;
}

export interface WritePathOptions {
  /** `save-only` never publishes; `match-state` republishes what was published. */
  publish: 'match-state' | 'save-only';
  /**
   * Edit a revision someone has submitted for approval, and publish over it. Off for
   * ownership (W4: someone else is mid-review). Reference removal passes the run's
   * `approvalsEnabled`, the permission the script's `-ApprovalsEnabled` gave.
   */
  overridePendingApproval?: boolean | undefined;
  /**
   * An open draft over a published version. `save-only` (the default, ownership's rule)
   * saves into the draft. `refuse` writes nothing: reference removal, where saving into
   * the draft leaves the reference in the live version and publishing puts someone else's
   * draft live (Cowork's review of W5 phase 5). `publish` publishes the draft with the
   * edit, for a holder the operator ticked.
   */
  openDraft?: 'save-only' | 'refuse' | 'publish' | undefined;
}

export function chooseWritePath(state: WriteState, options: WritePathOptions): WritePath | { refused: WriteRefusal } {
  if (!state.canSave) return { refused: 'cannot-save' };
  if (state.revisionStateId === 2 && options.overridePendingApproval !== true) return { refused: 'awaiting-approval' };
  // A draft may hold someone's unpublished edits, which are not ours to publish unless
  // the operator says so. A never-published process has nothing live to leave stale.
  if (state.revisionStateId === 1) {
    if (state.publishedVersionExists === false) return 'save-only';
    if (options.openDraft === 'refuse') return { refused: 'open-draft' };
    if (options.openDraft !== 'publish') return 'save-only';
  }
  if (options.publish === 'save-only') return 'save-only';
  if (state.canPublishAfterEdit) return 'publish-direct';
  if (state.canSubmitForApprovalAfterEdit) return 'submit-then-publish';
  return { refused: 'cannot-publish' };
}

/** An open draft over a published version: the draft a write would publish. */
export function isOpenDraft(state: Pick<WriteState, 'revisionStateId' | 'publishedVersionExists'>): boolean {
  return state.revisionStateId === 1 && state.publishedVersionExists !== false;
}

export function isWritePath(value: WritePath | { refused: WriteRefusal }): value is WritePath {
  return typeof value === 'string';
}

/**
 * The write state from a process read. A missing `processActions` grants nothing. A
 * missing revision state falls back to the script's rule, a major version above 0 is
 * published, so a model from somewhere other than the active read still gets a path.
 */
export function writeStateOf(
  processJson: Record<string, unknown> | null | undefined,
  processActions: Partial<ProcessActions> | null | undefined,
): WriteState {
  const stateId = Number(processJson?.['ProcessRevisionStateId']);
  let revisionStateId: number | null = Number.isInteger(stateId) && stateId > 0 ? stateId : null;
  const version = typeof processJson?.['Version'] === 'string' ? processJson['Version'] : null;
  const major = version !== null && version.includes('.') ? Number(version.split('.')[0]) : Number.NaN;
  if (revisionStateId === null && version !== null) {
    revisionStateId = Number.isInteger(major) && major > 0 ? 3 : 1;
  }
  return {
    revisionStateId,
    // move/plan.ts's `isDraftOverPublished` rule, measured for F1: 0.x is never published.
    publishedVersionExists: Number.isInteger(major) ? major >= 1 : undefined,
    canSave: processActions?.CanSave === true,
    canPublishAfterEdit: processActions?.CanPublishAfterEdit === true,
    canSubmitForApprovalAfterEdit: processActions?.CanSubmitForApprovalAfterEdit === true,
  };
}
