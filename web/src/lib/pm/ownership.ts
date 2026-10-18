/**
 * Reading and setting a process's owner and expert.
 *
 * Ported from `Update-ProcessOwnership.ps1`. The process model stores each role as a
 * numeric user id plus a display name (`OwnerId`/`Owner`, `ExpertId`/`Expert`), and the
 * script sets both from SCIM. The write is a read-modify-write of the whole model, done
 * here on the server so process bodies never cross into the browser, which only ever
 * sees the compact `OwnershipState`.
 */

import type { PmContext } from './client.ts';
import { buildUpdateEnvelope, getLatestRevision, readProcess, updateProcess } from './processes.ts';
import type { ProcessJson, ProcessResponse, ProcessRevisionStateId } from './types.ts';

/** The built-in "Needs to be reassigned N/A" placeholder. Always id 2. */
export const UNASSIGNED_USER = { id: 2, name: 'Needs to be reassigned N/A' } as const;

export interface UserRef {
  id: number;
  name: string;
}

export interface OwnershipState {
  uniqueId: string;
  name: string;
  version: string;
  revisionEditId: number;
  revisionStateId: ProcessRevisionStateId;
  /** null when the model does not say. Absent is not false. */
  isArchived: boolean | null;
  owner: UserRef | null;
  expert: UserRef | null;
  canSave: boolean;
  canPublishAfterEdit: boolean;
  canSubmitForApprovalAfterEdit: boolean;
}

function role(model: ProcessJson, idField: string, nameField: string): UserRef | null {
  const id = Number(model[idField]);
  if (!Number.isInteger(id) || id <= 0) return null;
  const name = model[nameField];
  return { id, name: typeof name === 'string' ? name : '' };
}

/**
 * The ownership read: the process, or that it is archived. An archived process answers
 * 200 with only `{success, isArchived}` and no model, which read as a model crashed into
 * "Unexpected error" in the W4 live test (F4). `readProcessEnvelope` tells them apart.
 */
export type OwnershipRead = { kind: 'process'; state: OwnershipState } | { kind: 'archived' };

export async function getOwnership(ctx: PmContext, processUniqueId: string): Promise<OwnershipRead> {
  const read = await readProcess(ctx, processUniqueId);
  if (read.kind === 'archived') return { kind: 'archived' };
  return { kind: 'process', state: ownershipState(read.response) };
}

function ownershipState({ processJson, processActions }: ProcessResponse): OwnershipState {
  const archived = processJson['isArchived'] ?? processJson['IsArchived'];
  return {
    uniqueId: processJson.UniqueId,
    name: processJson.Name,
    version: processJson.Version,
    revisionEditId: processJson.ProcessRevisionEditId,
    revisionStateId: processJson.ProcessRevisionStateId,
    isArchived: typeof archived === 'boolean' ? archived : null,
    owner: role(processJson, 'OwnerId', 'Owner'),
    expert: role(processJson, 'ExpertId', 'Expert'),
    canSave: processActions?.CanSave === true,
    canPublishAfterEdit: processActions?.CanPublishAfterEdit === true,
    canSubmitForApprovalAfterEdit: processActions?.CanSubmitForApprovalAfterEdit === true,
  };
}

/** A copy of the model with the given roles set, id and display name together. */
export function withOwnership(model: ProcessJson, change: { owner: UserRef | null; expert: UserRef | null }): ProcessJson {
  const next: ProcessJson = { ...model };
  if (change.owner) {
    next['OwnerId'] = change.owner.id;
    next['Owner'] = change.owner.name;
  }
  if (change.expert) {
    next['ExpertId'] = change.expert.id;
    next['Expert'] = change.expert.name;
  }
  return next;
}

export interface SetOwnershipRequest {
  processUniqueId: string;
  /** The revision the preview was built from. Anything else means someone edited it since. */
  expectedRevisionEditId: number;
  owner: UserRef | null;
  expert: UserRef | null;
  changeDescription: string;
  submitForApproval: boolean;
}

export type SetOwnershipResult =
  | { ok: true; revisionEditId: number | null }
  | { ok: false; conflict: { expected: number; actual: number } }
  | { ok: false; archived: true };

/**
 * Save the new owner and expert.
 *
 * Refuses to write over an edit made since the preview: the script read and saved in one
 * pass, but here the preview and the write can be minutes apart, and saving a stale
 * model would silently discard someone's change. Returns the new revision id, which a
 * publish needs. A null id means the save landed but the follow-up read did not.
 */
export async function setOwnership(ctx: PmContext, request: SetOwnershipRequest): Promise<SetOwnershipResult> {
  const read = await readProcess(ctx, request.processUniqueId);
  // Archived since the preview: there is no model to save over.
  if (read.kind === 'archived') return { ok: false, archived: true };
  const { processJson } = read.response;
  if (processJson.ProcessRevisionEditId !== request.expectedRevisionEditId) {
    return { ok: false, conflict: { expected: request.expectedRevisionEditId, actual: processJson.ProcessRevisionEditId } };
  }

  await updateProcess(
    ctx,
    request.processUniqueId,
    buildUpdateEnvelope(withOwnership(processJson, request), {
      changeDescription: request.changeDescription,
      submitForApproval: request.submitForApproval,
      // Never negotiable for a bulk run (SPEC-WEB.md). The script sent false.
      suppressChangeNotification: true,
    }),
  );

  try {
    const latest = await getLatestRevision(ctx, request.processUniqueId);
    return { ok: true, revisionEditId: latest.latestProcessRevisionEditId };
  } catch {
    return { ok: true, revisionEditId: null };
  }
}
