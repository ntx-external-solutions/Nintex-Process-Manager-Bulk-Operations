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
export type WriteRefusal = 'cannot-save' | 'awaiting-approval' | 'cannot-publish';

export interface WriteState {
  /** 1 in progress, 2 awaiting approval, 3 published. */
  revisionStateId: number | null;
  canSave: boolean;
  canPublishAfterEdit: boolean;
  canSubmitForApprovalAfterEdit: boolean;
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
}

export function chooseWritePath(state: WriteState, options: WritePathOptions): WritePath | { refused: WriteRefusal } {
  if (!state.canSave) return { refused: 'cannot-save' };
  if (state.revisionStateId === 2 && options.overridePendingApproval !== true) return { refused: 'awaiting-approval' };
  // A draft may hold someone's unpublished edits, which are not ours to publish.
  if (state.revisionStateId === 1) return 'save-only';
  if (options.publish === 'save-only') return 'save-only';
  if (state.canPublishAfterEdit) return 'publish-direct';
  if (state.canSubmitForApprovalAfterEdit) return 'submit-then-publish';
  return { refused: 'cannot-publish' };
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
  if (revisionStateId === null && typeof processJson?.['Version'] === 'string') {
    const major = Number(processJson['Version'].split('.')[0]);
    revisionStateId = processJson['Version'].includes('.') && Number.isInteger(major) && major > 0 ? 3 : 1;
  }
  return {
    revisionStateId,
    canSave: processActions?.CanSave === true,
    canPublishAfterEdit: processActions?.CanPublishAfterEdit === true,
    canSubmitForApprovalAfterEdit: processActions?.CanSubmitForApprovalAfterEdit === true,
  };
}
