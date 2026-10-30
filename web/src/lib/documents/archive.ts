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

function skippedRow(c: ChosenDocument, message: string, groupId: number | null = null): ResultRow {
  return resultRow({
    objectType: 'Document',
    objectId: c.entry.uniqueId,
    name: c.entry.name,
    operation: 'Archive',
    status: 'Skipped',
    message,
    groupId,
  });
}

/**
 * The plan. `properties` holds a read for every chosen document. An archived or pending
 * one is left out whether or not its read succeeded.
 */
export function buildDocumentArchivePlan(input: {
  chosen: readonly ChosenDocument[];
  resolveSkipped?: readonly ResultRow[];
  paths: ReadonlyMap<string, string[]>;
  properties: ReadonlyMap<string, PropertiesRead>;
  scan: ReferenceScan;
  index: ProcessIndex;
}): DocumentArchivePlan {
  const targets: DocumentTarget[] = [];
  const skipped: ResultRow[] = [...(input.resolveSkipped ?? [])];

  for (const c of input.chosen) {
    const read = input.properties.get(c.entry.uniqueId.toLowerCase());
    const props = read && !isError(read) ? read : null;
    const groupId = props?.primaryGroupId ?? null;
    if (props?.isArchived ?? c.entry.isArchived) {
      skipped.push(skippedRow(c, ALREADY_ARCHIVED, groupId));
      continue;
    }
    if (props?.isPending ?? c.entry.isPending) {
      skipped.push(skippedRow(c, PENDING, groupId));
      continue;
    }
    if (!props) {
      const why = isError(read) ? read.error : 'it was not read';
      skipped.push(skippedRow(c, `Could not read what holds it (${why}), so it is not archived. Build the plan again to retry.`));
      continue;
    }
    const held = holdersMessage(props, processesReferencing(input.scan, c.entry), input.index);
    if (held !== null) {
      skipped.push(skippedRow(c, held, groupId));
      continue;
    }
    targets.push({
      documentId: c.entry.documentId,
      uniqueId: c.entry.uniqueId,
      name: c.entry.name,
      path: documentPath(c.entry, input.paths),
      groupId,
      chosen: c.chosen,
      location: c.entry.location,
      type: c.entry.type,
    });
  }

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

/**
 * Archive the plan's targets in batches of up to 50. Returns a row per target, to be
 * settled by `settleDocumentArchive` against a fresh read: a Success here is what the
 * call said, not yet what the tenant did.
 */
export async function runDocumentArchive(
  gateway: DocumentArchiveGateway,
  targets: readonly DocumentTarget[],
  controls: Controls,
  options: DocumentRunOptions,
): Promise<ResultRow[]> {
  const size = Math.max(1, Math.min(options.batchSize ?? DOCUMENT_BATCH_SIZE, DOCUMENT_BATCH_SIZE));
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const errorText = options.errorText ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const rows: ResultRow[] = [];
  const row = (t: DocumentTarget, status: string, message: string, statusCode: number | null = null) =>
    resultRow({ objectType: 'Document', objectId: t.uniqueId, name: t.name, operation: 'Archive', status, message, groupId: t.groupId, statusCode });
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
    for (let i = 0; i < batch.length && stop.reason === null; i += concurrency) {
      await Promise.all(
        batch.slice(i, i + concurrency).map(async (t) => {
          try {
            const props = toDocumentProperties(await gateway.properties(t.documentId));
            const held = attachedNow(props) ? holdersMessage(props, [], options.index) : null;
            if (props.isArchived === true) recheck.push(row(t, 'Skipped', `${ALREADY_ARCHIVED} by the time its batch ran`));
            else if (props.isPending === true) recheck.push(row(t, 'Skipped', PENDING));
            else if (held !== null) recheck.push(row(t, 'Skipped', `Attached since the plan was built. ${held}`));
            else clear.push(t);
          } catch (error) {
            const reason = controls.isFatal(error);
            if (reason) {
              stop.reason = reason;
              return;
            }
            recheck.push(row(t, 'Skipped', `Could not re-check what holds it straight before archiving (${errorText(error)}), so it was not archived`, options.statusOf?.(error) ?? null));
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
        const answer = await gateway.archive(sent.map((t) => t.documentId));
        rows.push(...rowsFromAnswer(sent, answer, row));
      } catch (error) {
        const reason = controls.isFatal(error);
        const why = reason ?? errorText(error);
        for (const t of sent) {
          rows.push(row(t, 'Failed', `The archive call failed (${why}). The final read says whether it took effect.`, options.statusOf?.(error) ?? null));
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
    return mine ? row(t, 'Failed', `Process Manager refused: ${mine.join(', ')}`) : row(t, 'Success', `Archived.${note}`);
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
