/**
 * Bulk Archive for documents (W8a): the plan, the run, and settling the run against a
 * fresh read.
 *
 * A document attached to anything is never archived (W8 decision 1), although the API
 * would archive one attached to a published process. The plan reads every chosen
 * document's properties and scans every active process's current model; each batch
 * re-reads its documents' properties straight before the write. The full scan is not
 * repeated per batch, so a draft reference added mid-run is not caught, and the plan
 * page says so.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { Controls } from '../exec/runner.ts';
import { DOCUMENT_BATCH_SIZE, type DocumentBulkAnswer } from '../pm/documents.ts';
import type { ProcessIndex } from '../tenant/state.ts';
import { attachedNow, holdersMessage, toDocumentProperties, type DocumentProperties } from './holders.ts';
import { documentPath, type DocumentIndex } from './list.ts';
import { processesReferencing, type ReferenceScan } from './references.ts';
import type { ChosenDocument } from './select.ts';

export const ALREADY_ARCHIVED = 'Already archived';
export const PENDING = 'Pending in Process Manager';

export const MID_RUN_NOTE =
  'Each batch re-reads its documents’ attachments straight before archiving them. The scan of process drafts runs once, when this plan is built, so a draft reference added while the run is going is not caught.';

export interface DocumentTarget {
  documentId: number;
  uniqueId: string;
  name: string;
  path: string[];
  /** The primary group's numeric id, blank in the results when unknown. */
  groupId: number | null;
  /** The primary group's GUID, for the delete page's cleanup offer. */
  groupUniqueId: string | null;
  /** Archived when the plan was built: Delete documents takes these straight to its delete phase. */
  isArchived: boolean;
  chosen: string;
  location: string;
  type: string;
}

export interface DocumentArchivePlan {
  targets: DocumentTarget[];
  /** Ids that matched nothing first, then the documents left out, each with its reason. */
  skipped: ResultRow[];
  /** Processes whose model could not be read. While there are any, the plan cannot run. */
  unreadProcesses: ReferenceScan['unread'];
  processesRead: number;
}

export type PropertiesRead = DocumentProperties | { error: string };

const isError = (read: PropertiesRead | undefined): read is { error: string } =>
  read !== undefined && 'error' in read;

export type DocumentOperation = 'Archive' | 'Delete' | 'Restore';

export interface PlanInput {
  chosen: readonly ChosenDocument[];
  resolveSkipped?: readonly ResultRow[];
  paths: ReadonlyMap<string, string[]>;
  properties: ReadonlyMap<string, PropertiesRead>;
  scan: ReferenceScan;
  index: ProcessIndex;
}

/**
 * The checks every archive and delete plan makes, in order: archived (left out by an
 * archive, kept by a delete), pending, unreadable, then anything holding it. An archived
 * document is checked for holders too: deleting one a process or a draft points at breaks
 * that process (spike).
 */
export function checkChosenDocuments(
  input: PlanInput,
  operation: 'Archive' | 'Delete',
): { targets: DocumentTarget[]; skipped: ResultRow[] } {
  const targets: DocumentTarget[] = [];
  const skipped: ResultRow[] = [...(input.resolveSkipped ?? [])];
  const verb = operation === 'Archive' ? 'archived' : 'deleted';
  const skip = (c: ChosenDocument, message: string, groupId: number | null = null) =>
    skipped.push(
      resultRow({ objectType: 'Document', objectId: c.entry.uniqueId, name: c.entry.name, operation, status: 'Skipped', message, groupId }),
    );

  for (const c of input.chosen) {
    const read = input.properties.get(c.entry.uniqueId.toLowerCase());
    const props = read && !isError(read) ? read : null;
    const groupId = props?.primaryGroupId ?? null;
    const isArchived = props?.isArchived ?? c.entry.isArchived;
    if (isArchived && operation === 'Archive') {
      skip(c, ALREADY_ARCHIVED, groupId);
      continue;
    }
    if (props?.isPending ?? c.entry.isPending) {
      skip(c, PENDING, groupId);
      continue;
    }
    if (!props) {
      const why = isError(read) ? read.error : 'it was not read';
      skip(c, `Could not read what holds it (${why}), so it is not ${verb}. Build the plan again to retry.`);
      continue;
    }
    const held = holdersMessage(props, processesReferencing(input.scan, c.entry), input.index);
    if (held !== null) {
      skip(c, held, groupId);
      continue;
    }
    targets.push({
      documentId: c.entry.documentId,
      uniqueId: c.entry.uniqueId,
      name: c.entry.name,
      path: documentPath(c.entry, input.paths),
      groupId,
      groupUniqueId: c.entry.primaryGroupUniqueId,
      isArchived,
      chosen: c.chosen,
      location: c.entry.location,
      type: c.entry.type,
    });
  }
  return { targets, skipped };
}

/**
 * The plan. `properties` holds a read for every chosen document. An archived or pending
 * one is left out whether or not its read succeeded.
 */
export function buildDocumentArchivePlan(input: PlanInput): DocumentArchivePlan {
  const { targets, skipped } = checkChosenDocuments(input, 'Archive');
  return { targets, skipped, unreadProcesses: [...input.scan.unread], processesRead: input.scan.read };
}

/** The preview file: what would be archived, then what is left out. */
export function documentPreviewRows(plan: DocumentArchivePlan): ResultRow[] {
  return [
    ...plan.skipped,
    ...plan.targets.map((t) =>
      resultRow({ objectType: 'Document', objectId: t.uniqueId, name: t.name, operation: 'Archive', status: 'Preview', message: 'Would be archived', groupId: t.groupId }),
    ),
  ];
}

// ------------------------------------------------------------------ running

export interface DocumentArchiveGateway {
  properties(documentId: number): Promise<unknown>;
  archive(documentIds: number[]): Promise<DocumentBulkAnswer>;
}

export interface DocumentRunOptions {
  index: ProcessIndex;
  batchSize?: number;
  /** How many property re-reads go at once inside a batch. */
  concurrency?: number;
  errorText?: (error: unknown) => string;
  statusOf?: (error: unknown) => number | null;
  onProgress?: (done: number, total: number, label: string) => void;
}

/** One bulk write, as the batch runner needs it. */
export interface BatchWrite {
  operation: DocumentOperation;
  /** "archive", "delete", "restore". */
  verb: string;
  /** "archived", "deleted", "restored". */
  past: string;
  /** "archiving", "deleting", "restoring". */
  verbing: string;
  /** A Success row's message, before any note about the batch. */
  done: string;
  call(documentIds: number[]): Promise<DocumentBulkAnswer>;
  /**
   * The re-check straight before the write: a reason to leave the document out, or null.
   * Without one, the batch is sent as planned (the restore: attachments don't matter).
   */
  recheck?: (properties: DocumentProperties) => string | null;
  /** Error codes that mean "left alone", Skipped with this message rather than Failed. */
  skipCodes?: Readonly<Record<string, string>>;
}

/** The archive's re-check: anything archived, pending or held since the plan is dropped. */
function archiveRecheck(index: ProcessIndex) {
  return (props: DocumentProperties): string | null => {
    if (props.isArchived === true) return `${ALREADY_ARCHIVED} by the time its batch ran`;
    if (props.isPending === true) return PENDING;
    const held = attachedNow(props) ? holdersMessage(props, [], index) : null;
    return held === null ? null : `Attached since the plan was built. ${held}`;
  };
}

export function archiveWrite(gateway: DocumentArchiveGateway, index: ProcessIndex): BatchWrite {
  return { operation: 'Archive', verb: 'archive', past: 'archived', verbing: 'archiving', done: 'Archived.', call: (ids) => gateway.archive(ids), recheck: archiveRecheck(index) };
}

/**
 * Archive the plan's targets in batches of up to 50. Returns a row per target, to be
 * settled by `settleDocumentArchive` against a fresh read: a Success here is what the
 * call said, not yet what the tenant did.
 */
export function runDocumentArchive(
  gateway: DocumentArchiveGateway,
  targets: readonly DocumentTarget[],
  controls: Controls,
  options: DocumentRunOptions,
): Promise<ResultRow[]> {
  return runDocumentBatches(gateway, targets, controls, archiveWrite(gateway, options.index), options);
}

/**
 * Any bulk write in batches of up to 50, each batch re-checked first when the write has
 * a re-check. A row per target; the caller settles them against a fresh read.
 */
export async function runDocumentBatches(
  gateway: { properties(documentId: number): Promise<unknown> },
  targets: readonly DocumentTarget[],
  controls: Controls,
  write: BatchWrite,
  options: Omit<DocumentRunOptions, 'index'>,
): Promise<ResultRow[]> {
  const size = Math.max(1, Math.min(options.batchSize ?? DOCUMENT_BATCH_SIZE, DOCUMENT_BATCH_SIZE));
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const errorText = options.errorText ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const rows: ResultRow[] = [];
  const row = (t: DocumentTarget, status: string, message: string, statusCode: number | null = null) =>
    resultRow({ objectType: 'Document', objectId: t.uniqueId, name: t.name, operation: write.operation, status, message, groupId: t.groupId, statusCode });
  let done = 0;

  for (let start = 0; start < targets.length; start += size) {
    const batch = targets.slice(start, start + size);
    if (controls.cancelled()) {
      for (const t of targets.slice(start)) rows.push(row(t, 'Skipped', `Not attempted: ${controls.stoppedReason() ?? 'the run stopped'}`));
      break;
    }

    // The re-check: anything that has picked up an attachment since the plan is dropped.
    const clear: DocumentTarget[] = [];
    const recheck: ResultRow[] = [];
    // Set from inside the re-reads, so held in an object the loop can see change.
    const stop = { reason: null as string | null };
    const check = write.recheck;
    if (check === undefined) clear.push(...batch);
    for (let i = 0; check !== undefined && i < batch.length && stop.reason === null; i += concurrency) {
      await Promise.all(
        batch.slice(i, i + concurrency).map(async (t) => {
          try {
            const why = check(toDocumentProperties(await gateway.properties(t.documentId)));
            if (why === null) clear.push(t);
            else recheck.push(row(t, 'Skipped', why));
          } catch (error) {
            const reason = controls.isFatal(error);
            if (reason) {
              stop.reason = reason;
              return;
            }
            recheck.push(
              row(t, 'Skipped', `Could not re-check what holds it straight before ${write.verbing} (${errorText(error)}), so it was not ${write.past}`, options.statusOf?.(error) ?? null),
            );
          }
        }),
      );
    }
    if (stop.reason !== null) {
      controls.stop(stop.reason);
      for (const t of targets.slice(start)) rows.push(row(t, 'Skipped', `Not attempted: ${stop.reason}`));
      break;
    }
    rows.push(...recheck);

    if (clear.length > 0) {
      // Keep the plan's order in the batch, whatever order the re-reads finished in.
      const sent = batch.filter((t) => clear.includes(t));
      try {
        const answer = await write.call(sent.map((t) => t.documentId));
        rows.push(...rowsFromAnswer(sent, answer, row, write));
      } catch (error) {
        const reason = controls.isFatal(error);
        const why = reason ?? errorText(error);
        for (const t of sent) {
          rows.push(row(t, 'Failed', `The ${write.verb} call failed (${why}). The final read says whether it took effect.`, options.statusOf?.(error) ?? null));
        }
        if (reason) {
          controls.stop(reason);
          for (const t of targets.slice(start + batch.length)) rows.push(row(t, 'Skipped', `Not attempted: ${reason}`));
          break;
        }
      }
    }

    done += batch.length;
    options.onProgress?.(done, targets.length, batch[batch.length - 1]!.name);
  }

  return rows;
}

/**
 * Rows from a bulk answer. A 200 is not success: every `errors` entry is a document that
 * failed (spike). An entry naming no document in the batch cannot be put on a row, so
 * every row of the batch carries it and the final read decides.
 */
export function rowsFromAnswer(
  sent: readonly DocumentTarget[],
  answer: DocumentBulkAnswer,
  row: (t: DocumentTarget, status: string, message: string) => ResultRow,
  write: Pick<BatchWrite, 'done' | 'skipCodes'> = { done: 'Archived.' },
): ResultRow[] {
  const ids = new Set(sent.map((t) => t.documentId));
  const codes = new Map<number, string[]>();
  const loose: string[] = [];
  for (const e of answer.errors) {
    if (e.documentId !== null && ids.has(e.documentId)) codes.set(e.documentId, [...(codes.get(e.documentId) ?? []), e.errorCode]);
    else loose.push(e.documentId === null ? e.errorCode : `${e.errorCode} for document ${e.documentId}`);
  }
  const note = loose.length > 0 ? ` Process Manager also reported an error it did not tie to a document in this batch (${loose.join(', ')}).` : '';
  return sent.map((t) => {
    const mine = codes.get(t.documentId);
    if (!mine) return row(t, 'Success', `${write.done}${note}`);
    const skip = mine.length === 1 ? write.skipCodes?.[mine[0]!] : undefined;
    return skip !== undefined ? row(t, 'Skipped', skip) : row(t, 'Failed', `Process Manager refused: ${mine.join(', ')}`);
  });
}

/**
 * Each Archive row's final status from the lists read after the run. Statuses other than
 * Success and Failed (skips, not attempted) are left as they are.
 */
export function settleDocumentArchive(rows: readonly ResultRow[], after: DocumentIndex): ResultRow[] {
  return rows.map((r) => {
    if (r.objectType !== 'Document' || r.operation !== 'Archive' || (r.status !== 'Success' && r.status !== 'Failed')) return r;
    const now = after.get(r.objectId.toLowerCase());
    if (now?.isArchived) {
      return r.status === 'Success' ? r : { ...r, status: 'Success', message: `Archived, confirmed by the final read, although the run reported: ${r.message}` };
    }
    if (r.status === 'Failed') return r;
    if (!now) return { ...r, status: 'Unverified', message: 'Archive was accepted, but neither document list returns it now, so its state could not be confirmed' };
    return { ...r, status: 'Failed', message: 'Archive reported success, but the document is still active' };
  });
}

export const DOCUMENT_ARCHIVE_STATUSES = ['Success', 'Preview', 'Skipped', 'Unverified', 'Failed'] as const;
