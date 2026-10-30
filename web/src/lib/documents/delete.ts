/**
 * Bulk Delete for documents (W8b): the plan, the two phases, the put-back, and settling
 * against a fresh read.
 *
 * The tenant refuses to delete an active document (`NotArchived`), so an active target is
 * archived first, exactly as Archive documents does it. The delete phase waits for the
 * operator's typed confirmation on screen. A document this run archived and then did not
 * delete, for whatever reason, is restored, so the run leaves nothing archived that it
 * found active, as the process engine does.
 *
 * The tenant guards a delete against processes that list the document, active or
 * archived, but not against a reference only a draft holds (spike), so the plan scans
 * every active process's model, as the archive plan does, and each batch re-reads its
 * documents' properties straight before the delete.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { Controls } from '../exec/runner.ts';
import type { DocumentBulkAnswer } from '../pm/documents.ts';
import type { ProcessIndex } from '../tenant/state.ts';
import {
  checkChosenDocuments,
  PENDING,
  runDocumentArchive,
  runDocumentBatches,
  settleDocumentArchive,
  type BatchWrite,
  type DocumentArchiveGateway,
  type DocumentRunOptions,
  type DocumentTarget,
  type PlanInput,
} from './archive.ts';
import { attachedNow, holdersMessage } from './holders.ts';
import type { DocumentIndex } from './list.ts';
import type { ReferenceScan } from './references.ts';

export const STILL_ATTACHED = 'Process Manager refused: still attached';
export const NOT_ARCHIVED_ANY_MORE = 'No longer archived by the time its batch ran, so it was not deleted';
export const NOT_CONFIRMED = 'the delete was not confirmed';

export const DELETE_MID_RUN_NOTE =
  'Each batch re-reads its documents’ attachments straight before archiving them and again straight before deleting them. The scan of process drafts runs once, when this plan is built, so a draft reference added while the run is going is not caught.';

export interface DocumentDeletePlan {
  /** Active: archived in phase 1, then deleted in phase 2. */
  toArchive: DocumentTarget[];
  /** Archived already: deleted in phase 2 only. */
  alreadyArchived: DocumentTarget[];
  skipped: ResultRow[];
  unreadProcesses: ReferenceScan['unread'];
  processesRead: number;
}

export function buildDocumentDeletePlan(input: PlanInput): DocumentDeletePlan {
  const { targets, skipped } = checkChosenDocuments(input, 'Delete');
  return {
    toArchive: targets.filter((t) => !t.isArchived),
    alreadyArchived: targets.filter((t) => t.isArchived),
    skipped,
    unreadProcesses: [...input.scan.unread],
    processesRead: input.scan.read,
  };
}

export function deletePreviewRows(plan: DocumentDeletePlan): ResultRow[] {
  const preview = (t: DocumentTarget, message: string) =>
    resultRow({ objectType: 'Document', objectId: t.uniqueId, name: t.name, operation: 'Delete', status: 'Preview', message, groupId: t.groupId });
  return [
    ...plan.skipped,
    ...plan.toArchive.map((t) => preview(t, 'Would be archived, then permanently deleted')),
    ...plan.alreadyArchived.map((t) => preview(t, 'Archived already; would be permanently deleted')),
  ];
}

// ------------------------------------------------------------------ running

export interface DocumentDeleteGateway extends DocumentArchiveGateway {
  delete(documentIds: number[]): Promise<DocumentBulkAnswer>;
  restore(documentIds: number[]): Promise<DocumentBulkAnswer>;
}

/** Phase 1: the active targets, archived as Archive documents does it. */
export function runArchivePhase(
  gateway: DocumentDeleteGateway,
  plan: DocumentDeletePlan,
  controls: Controls,
  options: DocumentRunOptions,
): Promise<ResultRow[]> {
  return runDocumentArchive(gateway, plan.toArchive, controls, options);
}

/** What phase 1 left for the confirmation. */
export interface AfterArchive {
  /** Phase 1's rows, settled against the read between the phases when there was one. */
  archiveRows: ResultRow[];
  /** Every document the delete phase would take: archived before the run, then archived by it. */
  toDelete: DocumentTarget[];
  /** Archived by this run: put back unless deleted. */
  archivedByRun: DocumentTarget[];
}

/**
 * Settle phase 1 and work out the delete phase. A target that failed to archive is not
 * deleted (the tenant would refuse it anyway). With no read between the phases
 * (`after` null), a Success is taken at its word; the delete's own re-check reads each
 * document again before anything is deleted.
 */
export function afterArchivePhase(plan: DocumentDeletePlan, archiveRows: readonly ResultRow[], after: DocumentIndex | null): AfterArchive {
  const settled = after === null ? [...archiveRows] : settleDocumentArchive(archiveRows, after);
  const archived = new Set(settled.filter((r) => r.operation === 'Archive' && r.status === 'Success').map((r) => r.objectId.toLowerCase()));
  const archivedByRun = plan.toArchive.filter((t) => archived.has(t.uniqueId.toLowerCase()));
  return { archiveRows: settled, toDelete: [...plan.alreadyArchived, ...archivedByRun], archivedByRun };
}

/** The delete's re-check: anything restored, pending or held since the plan is dropped. */
function deleteRecheck(index: ProcessIndex) {
  return (props: Parameters<NonNullable<BatchWrite['recheck']>>[0]): string | null => {
    if (props.isArchived === false) return NOT_ARCHIVED_ANY_MORE;
    if (props.isPending === true) return PENDING;
    const held = attachedNow(props) ? holdersMessage(props, [], index) : null;
    return held === null ? null : `Attached since the plan was built. ${held}`;
  };
}

/**
 * Phase 2: delete in batches of up to 50, each re-checked first. `ProcessAttachment` in
 * the answer means the tenant left it alone because something holds it, which is a skip,
 * not a failure; it should only happen when something changed mid-run.
 */
export function runDeletePhase(
  gateway: DocumentDeleteGateway,
  toDelete: readonly DocumentTarget[],
  controls: Controls,
  options: DocumentRunOptions,
): Promise<ResultRow[]> {
  const write: BatchWrite = {
    operation: 'Delete',
    verb: 'delete',
    past: 'deleted',
    verbing: 'deleting',
    done: 'Deleted.',
    call: (ids) => gateway.delete(ids),
    recheck: deleteRecheck(options.index),
    skipCodes: { ProcessAttachment: STILL_ATTACHED },
  };
  return runDocumentBatches(gateway, toDelete, controls, write, options);
}

/** Restore rows' wording, shared with W8c's page. */
export function restoreWrite(gateway: Pick<DocumentDeleteGateway, 'restore'>, done = 'Restored.'): BatchWrite {
  return { operation: 'Restore', verb: 'restore', past: 'restored', verbing: 'restoring', done, call: (ids) => gateway.restore(ids) };
}

/**
 * Phase 3: put back every document this run archived and did not delete: skipped by the
 * re-check, refused, failed, not attempted, or the operator declined the delete. Runs
 * with its own controls, so an operator's stop still puts things back; a dead session
 * cannot, and the caller says what is left archived.
 */
export async function putBack(
  gateway: DocumentDeleteGateway,
  archivedByRun: readonly DocumentTarget[],
  deleteRows: readonly ResultRow[],
  controls: Controls,
  options: Omit<DocumentRunOptions, 'index'> & { why?: string },
): Promise<ResultRow[]> {
  const deleted = new Set(deleteRows.filter((r) => r.operation === 'Delete' && r.status === 'Success').map((r) => r.objectId.toLowerCase()));
  const back = archivedByRun.filter((t) => !deleted.has(t.uniqueId.toLowerCase()));
  if (back.length === 0) return [];
  const why = options.why ?? 'it was not deleted';
  return runDocumentBatches(gateway, back, controls, restoreWrite(gateway, `Put back: this run archived it, and ${why}.`), options);
}

/** The documents a stopped run archived and could not put back, for the warning. */
export function leftArchived(archivedByRun: readonly DocumentTarget[], rows: readonly ResultRow[]): DocumentTarget[] {
  const gone = new Set(
    rows.filter((r) => (r.operation === 'Delete' || r.operation === 'Restore') && r.status === 'Success').map((r) => r.objectId.toLowerCase()),
  );
  return archivedByRun.filter((t) => !gone.has(t.uniqueId.toLowerCase()));
}

/**
 * Delete and Restore rows' final status from the lists read after the run. A deleted
 * document is in neither list; a restored one is in the active list. Archive rows were
 * settled between the phases and are left alone here: a document this run archived and
 * then deleted is in neither list, which is the delete's success, not the archive's doubt.
 */
export function settleDocumentDelete(rows: readonly ResultRow[], after: DocumentIndex): ResultRow[] {
  const deletedNow = new Set<string>();
  const settled = rows.map((r) => {
    if (r.objectType !== 'Document' || r.operation !== 'Delete' || (r.status !== 'Success' && r.status !== 'Failed')) return r;
    const now = after.get(r.objectId.toLowerCase());
    if (!now) {
      deletedNow.add(r.objectId.toLowerCase());
      return r.status === 'Success' ? r : { ...r, status: 'Success', message: `Deleted, confirmed by the final read, although the run reported: ${r.message}` };
    }
    if (r.status === 'Failed') return r;
    return { ...r, status: 'Failed', message: `Delete reported success, but the document is still in the ${now.isArchived ? 'archived' : 'active'} list` };
  });
  return settled.map((r) => {
    if (r.objectType !== 'Document' || r.operation !== 'Restore' || (r.status !== 'Success' && r.status !== 'Failed')) return r;
    const now = after.get(r.objectId.toLowerCase());
    if (now && !now.isArchived) {
      return r.status === 'Success' ? r : { ...r, status: 'Success', message: `Restored, confirmed by the final read, although the run reported: ${r.message}` };
    }
    if (!now && deletedNow.has(r.objectId.toLowerCase())) {
      return { ...r, status: 'Skipped', message: 'Not put back: the final read shows the delete took effect after all' };
    }
    if (r.status === 'Failed') return r;
    if (!now) return { ...r, status: 'Unverified', message: 'Restore was accepted, but neither document list returns it now, so its state could not be confirmed' };
    return { ...r, status: 'Failed', message: 'Restore reported success, but the document is still archived' };
  });
}

export const DOCUMENT_DELETE_STATUSES = ['Success', 'Preview', 'Skipped', 'Unverified', 'Failed'] as const;
