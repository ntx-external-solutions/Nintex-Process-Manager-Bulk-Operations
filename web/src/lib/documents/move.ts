/**
 * Move documents (W9): active documents to another primary group, one destination a run.
 *
 * The tenant has no bulk call: each move saves the document's whole properties record
 * (`documentMoveForm`), so a document that can't be saved safely is left out at the plan
 * and refused again by the save, which reads the record fresh.
 *
 * What holds a document doesn't matter. Processes and training units point at the document
 * itself, not at its group, so an attached document is moved, unlike on the archive and
 * delete pages. R16 confirms that on a real attachment.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { Controls } from '../exec/runner.ts';
import { documentMoveForm, MOVE_ALREADY_THERE, MOVE_ARCHIVED, MOVE_PENDING, type DocumentMoveAnswer } from '../pm/documents.ts';
import type { DocumentTarget } from './archive.ts';
import { toDocumentProperties } from './holders.ts';
import { documentPath, type DocumentIndex } from './list.ts';
import type { DocumentRunRecord } from './runRecord.ts';
import type { ChosenDocument } from './select.ts';

/** The script's name for a change of group, which the process Move results also use. */
export const MOVE_OPERATION = 'UpdateLocation';

export interface MoveDestination {
  /** The numeric id the save takes. */
  id: number;
  /** What the final read compares against. */
  uniqueId: string;
  /** Top first, itself last. */
  path: string[];
}

/** One document's read for the plan: whether a save could be built, or why the read failed. */
export type MoveRead = { primaryGroupId: number | null; refused: string | null } | { error: string };

export interface DocumentMovePlan {
  destination: MoveDestination;
  targets: DocumentTarget[];
  skipped: ResultRow[];
}

export const destinationLabel = (d: MoveDestination) => d.path.join(' / ');

/** Each chosen document's record, four at a time. A failed read is kept; a dead session ends the plan. */
export async function readForMove(
  chosen: readonly ChosenDocument[],
  read: (documentId: number) => Promise<unknown>,
  destination: MoveDestination,
  options: { isFatal?: (error: unknown) => boolean; errorText?: (error: unknown) => string; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, MoveRead>> {
  const out = new Map<string, MoveRead>();
  for (let i = 0; i < chosen.length; i += 4) {
    options.onProgress?.(i, chosen.length);
    await Promise.all(
      chosen.slice(i, i + 4).map(async (c) => {
        const key = c.entry.uniqueId.toLowerCase();
        try {
          const raw = await read(c.entry.documentId);
          const built = documentMoveForm(raw, destination.id);
          out.set(key, { primaryGroupId: toDocumentProperties(raw, c.entry.primaryGroupName).primaryGroupId, refused: 'refused' in built ? built.refused : null });
        } catch (error) {
          if (options.isFatal?.(error)) throw error;
          out.set(key, { error: options.errorText?.(error) ?? String(error) });
        }
      }),
    );
  }
  return out;
}

export function buildDocumentMovePlan(input: {
  chosen: readonly ChosenDocument[];
  resolveSkipped?: readonly ResultRow[];
  paths: ReadonlyMap<string, string[]>;
  reads: ReadonlyMap<string, MoveRead>;
  destination: MoveDestination;
}): DocumentMovePlan {
  const targets: DocumentTarget[] = [];
  const skipped: ResultRow[] = [...(input.resolveSkipped ?? [])];
  const destination = input.destination.uniqueId.toLowerCase();

  for (const c of input.chosen) {
    const read = input.reads.get(c.entry.uniqueId.toLowerCase());
    const failed = read !== undefined && 'error' in read;
    const groupId = read && !failed ? read.primaryGroupId : null;
    const skip = (message: string) =>
      skipped.push(resultRow({ objectType: 'Document', objectId: c.entry.uniqueId, name: c.entry.name, operation: MOVE_OPERATION, status: 'Skipped', message, groupId }));

    // What the list already says needs no read, so these hold even when the read failed.
    if (c.entry.isArchived) skip(MOVE_ARCHIVED);
    else if (c.entry.isPending) skip(MOVE_PENDING);
    else if (c.entry.primaryGroupUniqueId?.toLowerCase() === destination) skip(MOVE_ALREADY_THERE);
    else if (read === undefined || failed) skip(`Could not read it (${failed ? read.error : 'it was not read'}), so it is not moved. Build the plan again to retry.`);
    else if (read.refused !== null) skip(read.refused);
    else {
      targets.push({
        documentId: c.entry.documentId,
        uniqueId: c.entry.uniqueId,
        name: c.entry.name,
        path: documentPath(c.entry, input.paths),
        groupId,
        groupUniqueId: c.entry.primaryGroupUniqueId,
        isArchived: false,
        chosen: c.chosen,
        location: c.entry.location,
        type: c.entry.type,
      });
    }
  }
  return { destination: input.destination, targets, skipped };
}

export function movePreviewRows(plan: DocumentMovePlan): ResultRow[] {
  return [
    ...plan.skipped,
    ...plan.targets.map((t) =>
      resultRow({ objectType: 'Document', objectId: t.uniqueId, name: t.name, operation: MOVE_OPERATION, status: 'Preview', message: `Would move from ${t.path.join(' / ') || 'its group'} to ${destinationLabel(plan.destination)}`, groupId: t.groupId }),
    ),
  ];
}

export interface DocumentMoveGateway {
  move(documentId: number, targetGroupId: number): Promise<DocumentMoveAnswer>;
}

export interface DocumentMoveOptions {
  concurrency?: number;
  errorText?: (error: unknown) => string;
  statusOf?: (error: unknown) => number | null;
  onProgress?: (done: number, total: number, label: string) => void;
  /** As for the bulk writes: called before each set of calls, and after it with every row so far. */
  onBatch?: (event: { sending: readonly DocumentTarget[] | null; rows: readonly ResultRow[] }) => void;
}

/**
 * One call per document, a few at a time. A row per target, GroupId the group it left, to
 * be settled against a fresh read. A dead session stops the run; a call that failed on its
 * own stays a Failed row and the rest carry on.
 */
export async function runDocumentMove(
  gateway: DocumentMoveGateway,
  targets: readonly DocumentTarget[],
  destination: MoveDestination,
  controls: Controls,
  options: DocumentMoveOptions = {},
): Promise<ResultRow[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const errorText = options.errorText ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const rows: ResultRow[] = [];
  const row = (t: DocumentTarget, status: string, message: string, statusCode: number | null = null) =>
    resultRow({ objectType: 'Document', objectId: t.uniqueId, name: t.name, operation: MOVE_OPERATION, status, message, groupId: t.groupId, statusCode });

  for (let start = 0; start < targets.length; start += concurrency) {
    if (controls.cancelled()) {
      for (const t of targets.slice(start)) rows.push(row(t, 'Skipped', `Not attempted: ${controls.stoppedReason() ?? 'the run stopped'}`));
      break;
    }
    const batch = targets.slice(start, start + concurrency);
    options.onBatch?.({ sending: batch, rows });
    rows.push(
      ...(await Promise.all(
        batch.map(async (t) => {
          try {
            const answer = await gateway.move(t.documentId, destination.id);
            if (!answer.moved) return row(t, 'Skipped', answer.refused);
            return row(t, 'Success', `Moved from ${t.path.join(' / ') || 'its group'} to ${destinationLabel(destination)}.`);
          } catch (error) {
            const reason = controls.isFatal(error);
            if (reason) controls.stop(reason);
            return row(t, 'Failed', `The move failed (${reason ?? errorText(error)}). The final read says whether it took effect.`, options.statusOf?.(error) ?? null);
          }
        }),
      )),
    );
    options.onBatch?.({ sending: null, rows });
    options.onProgress?.(rows.length, targets.length, batch[batch.length - 1]!.name);
  }
  options.onBatch?.({ sending: null, rows });
  return rows;
}

const isAt = (uniqueId: string | null | undefined, destination: MoveDestination) =>
  uniqueId?.toLowerCase() === destination.uniqueId.toLowerCase();

/** Each move row's final status: in the destination is moved, anywhere else is not, in neither list is unconfirmed. */
export function settleDocumentMove(rows: readonly ResultRow[], after: DocumentIndex, destination: MoveDestination): ResultRow[] {
  return rows.map((r) => {
    if (r.objectType !== 'Document' || r.operation !== MOVE_OPERATION || (r.status !== 'Success' && r.status !== 'Failed')) return r;
    const now = after.get(r.objectId.toLowerCase());
    if (now && isAt(now.primaryGroupUniqueId, destination)) {
      return r.status === 'Success' ? r : { ...r, status: 'Success', message: `Moved to ${destinationLabel(destination)}, confirmed by the final read, although the run reported: ${r.message}` };
    }
    if (r.status === 'Failed') return r;
    if (!now) return { ...r, status: 'Unverified', message: 'The move was accepted, but neither document list returns it now, so where it is could not be confirmed' };
    return { ...r, status: 'Failed', message: `The move was accepted, but the document is still in ${now.primaryGroupName || 'its old group'}` };
  });
}

const INTERRUPTED = 'The run was interrupted while this call was out';

/**
 * Rows for the documents of a call that was out when a run died. `inFlightRows` judges by
 * active, archived or gone, and a move changes none of those; the group decides here.
 */
export function moveInFlightRows(record: DocumentRunRecord, after: DocumentIndex, destination: MoveDestination): ResultRow[] {
  const flight = record.inFlight;
  if (flight === null) return [];
  const has = new Set(record.rows.filter((r) => r.operation === flight.operation).map((r) => r.objectId.toLowerCase()));
  return flight.items
    .filter((item) => !has.has(item.uniqueId.toLowerCase()))
    .map((item) => {
      const now = after.get(item.uniqueId.toLowerCase());
      const row = (status: string, message: string) =>
        resultRow({ objectType: 'Document', objectId: item.uniqueId, name: item.name, operation: flight.operation, status, message, groupId: item.groupId });
      if (now === undefined) return row('Unverified', `${INTERRUPTED}, and neither document list returns it now, so where it is could not be confirmed.`);
      if (isAt(now.primaryGroupUniqueId, destination)) return row('Success', `Moved to ${destinationLabel(destination)}. ${INTERRUPTED}; the read afterwards confirms it.`);
      return row('Skipped', `Not attempted, or not taken: ${INTERRUPTED.toLowerCase()}, and the read afterwards shows it still in ${now.primaryGroupName || 'its old group'}.`);
    });
}

export const DOCUMENT_MOVE_STATUSES = ['Success', 'Preview', 'Skipped', 'Unverified', 'Failed'] as const;
