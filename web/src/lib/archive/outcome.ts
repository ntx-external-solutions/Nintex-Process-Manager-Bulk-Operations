/**
 * Archive one process and report what the tenant actually did.
 *
 * Ported from the script's `Set-NpmProcessArchived` (NintexProcessDependencies.ps1), with
 * the same outcome names and the same messages, because each branch encodes something
 * measured on a live tenant (API_ARCHITECTURE.md, "ArchiveProcess archives in place"):
 *
 *  - on an approvals-enabled tenant a 200 means *pending*, not archived. Whether it is
 *    archived is read back from `isArchived`, never decided from a setting, because R11
 *    measured both outcomes on one tenant;
 *  - if pending, the revision id is re-read after the archive (archiving creates a new
 *    revision) and published with IsPublishNow, the id sent as a string, and the change
 *    description as PublishMessage, which a tenant in "Publish Only mode" requires;
 *  - a 4xx is the tenant refusing on the process's own data. It is reported with the
 *    tenant's message and never retried;
 *  - absent is not false. A payload that does not report `isArchived` is not read as
 *    pending.
 *
 * Each call here is one proxy operation naming one process.
 */

export type ArchiveOutcomeName = 'Archived' | 'PendingApproval' | 'Overridden' | 'Refused' | 'Failed';

export interface ArchiveOutcome {
  /** The process is archived, confirmed or believed. */
  success: boolean;
  outcome: ArchiveOutcomeName;
  /** From the failing call; 0 when no HTTP call failed. */
  statusCode: number;
  /** The tenant's own words, null when there are none. */
  detail: string | null;
  /** The approval override ran. */
  overridden: boolean;
  /** One line fit for a results row. */
  message: string;
}

export interface ArchiveState {
  found: boolean;
  isArchived: boolean | null;
  revisionEditId: number | null;
}

/** The three proxy operations an archive needs. */
export interface ArchiveGateway {
  archive(processUniqueId: string, comment: string): Promise<unknown>;
  archiveState(processUniqueId: string): Promise<ArchiveState>;
  publishNow(processUniqueId: string, processRevisionEditId: number, publishMessage: string): Promise<unknown>;
}

export interface ArchiveOptions {
  /**
   * Permission to override a pending archive, not a prediction that one is needed.
   * Whether the override runs is decided from `isArchived`.
   */
  approvalOverride: boolean;
  /** An error that should stop the run is rethrown rather than turned into an outcome. */
  isFatal: (error: unknown) => string | null;
}

interface Failure {
  status: number;
  detail: string | null;
  error: string;
}

/** Status and reason from whatever the gateway threw. */
export function failureOf(error: unknown): Failure {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const status = typeof record['status'] === 'number' ? record['status'] : 0;
  const detail =
    typeof record['tenantMessage'] === 'string' && record['tenantMessage'].trim() !== ''
      ? record['tenantMessage']
      : null;
  return { status, detail, error: error instanceof Error ? error.message : String(error) };
}

function http(status: number): string {
  return status > 0 ? `HTTP ${status}` : 'no response';
}

function outcome(
  success: boolean,
  name: ArchiveOutcomeName,
  message: string,
  extra: { statusCode?: number; detail?: string | null; overridden?: boolean } = {},
): ArchiveOutcome {
  return {
    success,
    outcome: name,
    statusCode: extra.statusCode ?? 0,
    detail: extra.detail ?? null,
    overridden: extra.overridden ?? false,
    message,
  };
}

export async function archiveOne(
  gateway: ArchiveGateway,
  processUniqueId: string,
  comment: string,
  options: ArchiveOptions,
): Promise<ArchiveOutcome> {
  try {
    await gateway.archive(processUniqueId, comment);
  } catch (error) {
    if (options.isFatal(error)) throw error;
    const failure = failureOf(error);
    const reason = failure.detail ?? failure.error;
    // Refused is data, not a malfunction: the same process fails the same way in the UI,
    // and an administrator has to fix it. Not retried, and the batch carries on.
    const refused = failure.status >= 400 && failure.status <= 499;
    return refused
      ? outcome(false, 'Refused', `HTTP ${failure.status} refused by the tenant: ${reason}`, {
          statusCode: failure.status,
          detail: failure.detail,
        })
      : outcome(false, 'Failed', `Archive call failed (${http(failure.status)}): ${reason}`, {
          statusCode: failure.status,
          detail: failure.detail,
        });
  }

  // One fresh read after the version bump. It carries both the revision id the override
  // needs and the answer to whether an override is needed at all.
  let state: ArchiveState | null;
  try {
    state = await gateway.archiveState(processUniqueId);
  } catch (error) {
    if (options.isFatal(error)) throw error;
    state = null;
  }

  if (state !== null && !state.found) {
    return outcome(true, 'Archived', 'Archived; the active-process read no longer returns it');
  }

  if (state === null) {
    // Guessing either fires a needless publish or leaves a process pending in silence.
    return outcome(
      false,
      'PendingApproval',
      'Archive accepted but the process could not be re-read, so its state is unknown',
    );
  }

  // Pending detected is evidence; pending assumed is not. Only the first turns a missing
  // revision id or a failed publish into a reported PendingApproval.
  let pendingDetected = false;

  if (state.isArchived !== null) {
    if (state.isArchived) return outcome(true, 'Archived', 'Archived');
    pendingDetected = true;
    if (!options.approvalOverride) {
      return outcome(
        false,
        'PendingApproval',
        'Archive is pending approval; the override was not permitted on this run',
      );
    }
  } else if (!options.approvalOverride) {
    return outcome(
      true,
      'Archived',
      'Archive accepted; the tenant did not report isArchived, so no override was sent',
    );
  }
  // Field absent and the override permitted: send it speculatively, which is what the
  // script did before the state could be read at all.

  if (state.revisionEditId === null) {
    return pendingDetected
      ? outcome(
          false,
          'PendingApproval',
          'Archive is pending approval and no revision id came back, so the override could not be sent',
        )
      : outcome(true, 'Archived', 'Archive accepted; no revision id came back, so no override was sent');
  }

  try {
    await gateway.publishNow(processUniqueId, state.revisionEditId, comment);
  } catch (error) {
    if (options.isFatal(error)) throw error;
    const failure = failureOf(error);
    const reason = failure.detail ?? failure.error;
    if (pendingDetected) {
      return outcome(
        false,
        'PendingApproval',
        `Archive is pending approval and the override failed (${http(failure.status)}): ${reason}`,
        { statusCode: failure.status, detail: failure.detail },
      );
    }
    // A speculative override on a tenant that never said anything was pending. Its
    // failure is not evidence the archive did not take.
    return outcome(
      true,
      'Archived',
      `Archive accepted; a speculative approval override failed (${http(failure.status)}): ${reason}`,
      { statusCode: failure.status, detail: failure.detail },
    );
  }

  return outcome(true, 'Overridden', 'Archived after the pending-approval override', { overridden: true });
}

/** The script's mapping from outcome to results Status (Invoke-BulkArchiveProcesses). */
export function statusFor(name: ArchiveOutcomeName): ArchiveStatus {
  switch (name) {
    case 'Archived':
      return 'Success';
    case 'Overridden':
      return 'Overridden';
    case 'PendingApproval':
      return 'Pending';
    case 'Refused':
      return 'Blocked';
    case 'Failed':
      return 'Failed';
  }
}

/**
 * The results vocabulary for an archive run, in the script's order
 * (`$script:ArchiveResultStatuses`), plus the two this app adds:
 *
 *   Success     archived, confirmed by the final read
 *   Overridden  archived after the pending-approval override ran
 *   Preview     dry run only; nothing was changed
 *   Skipped     already archived, left out of the plan, or not attempted
 *   Pending     accepted and awaiting approval; the override did not run or failed
 *   Unverified  accepted, and neither listing returns the process, so the final read
 *               could not confirm it
 *   Blocked     the tenant refused with a 4xx. A human has to fix the process
 *   Failed      anything else, including a final read that says it is still active
 *   Accepted    a variation warning the operator reviewed before the run (script: same)
 *   Unreversed  something changed that nobody asked to change, and this app does not
 *               put it back yet (see the W2 report)
 */
export type ArchiveStatus =
  | 'Success'
  | 'Overridden'
  | 'Preview'
  | 'Skipped'
  | 'Pending'
  | 'Unverified'
  | 'Blocked'
  | 'Failed'
  | 'Accepted'
  | 'Unreversed';

export const ARCHIVE_STATUSES: readonly ArchiveStatus[] = [
  'Success',
  'Overridden',
  'Preview',
  'Skipped',
  'Pending',
  'Unverified',
  'Blocked',
  'Failed',
  'Accepted',
  'Unreversed',
];
