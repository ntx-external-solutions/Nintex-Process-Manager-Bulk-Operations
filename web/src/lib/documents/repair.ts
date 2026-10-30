/**
 * Repair document references (W8d): find processes pointing at a document that no longer
 * exists, and remove those dead references so the process can be published and archived
 * again.
 *
 * A deleted document that a process still points at breaks it: publishing answers 500
 * and archiving 400, "Could not find Form: <name>" (documents spike). Removing the item,
 * saving and publishing repaired it. A reference to an archived document is not dead: a
 * process pointing at one saves and publishes normally (spike).
 *
 * The scan reads every active process with the same walk as the archive and delete
 * plans, and archived processes through the mobile batch read, reported only: repairing
 * one means restore, edit, publish and re-archive, which is out of scope here.
 */

import { saveProcessModel, type SaveOutcome } from '../delete/executor.ts';
import type { DeleteGateway } from '../delete/gateway.ts';
import { nodeString, type ProcessModel } from '../delete/model.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import type { ActiveRead } from '../pm/dependencies.ts';
import { isOpenDraft, writeStateOf } from '../pm/writePath.ts';
import { loadDocumentIndex, type DocumentIndex, type ListReader } from './list.ts';
import { findDocumentReferences, scanProcessesForDocuments, type DocumentReference, type ReferenceScan } from './references.ts';

export const REPAIR_OPERATION = 'RepairDocumentReference';
export const REPAIR_DESCRIPTION = 'Removed references to deleted documents';
export const DRAFT_SAVED_NOTE = 'Saved into the open draft; publish it in Process Manager when the draft’s owner is ready';
/** The mobile batch read's limit, measured after W5 phase 3. */
export const ARCHIVED_BATCH = 20;

/** Every document id that exists, active or archived. */
export interface ExistingDocuments {
  ids: ReadonlySet<number>;
  guids: ReadonlySet<string>;
}

export function existingDocuments(index: DocumentIndex): ExistingDocuments {
  const entries = [...index.values()];
  return { ids: new Set(entries.map((e) => e.documentId)), guids: new Set(entries.map((e) => e.uniqueId.toLowerCase())) };
}

/** Dead: neither its `DocumentId` nor its `DocumentUniqueId` names a document in either list. */
export function isDead(ref: DocumentReference, existing: ExistingDocuments): boolean {
  if (ref.documentUniqueId !== null && existing.guids.has(ref.documentUniqueId.toLowerCase())) return false;
  return ref.documentId === null || !existing.ids.has(ref.documentId);
}

export function deadReferencesIn(model: unknown, existing: ExistingDocuments): DocumentReference[] {
  return findDocumentReferences(model).filter((r) => isDead(r, existing));
}

/** "Form 'Expense form' in activity 2 (document 431)". */
export function describeReference(ref: DocumentReference): string {
  const where = ref.activity !== undefined ? ` in activity ${ref.activity}` : '';
  const what = ref.documentId !== null ? `document ${ref.documentId}` : `document ${ref.documentUniqueId}`;
  return `${ref.type} '${ref.text || '(no text)'}'${where} (${what})`;
}

/** "published, version 2.0", "open draft 1.3 over version 1.0", "draft 0.2, never published". */
export function stateText(version: string, revisionStateId: number | null): string {
  const major = Number(version.split('.')[0]);
  if (revisionStateId === 3) return `published, version ${version}`;
  if (revisionStateId === 2) return `awaiting approval, version ${version}`;
  if (Number.isInteger(major) && major >= 1) return `open draft ${version} over version ${major}.0`;
  return `draft ${version}, never published`;
}

export interface BrokenProcess {
  uniqueId: string;
  name: string;
  groupUniqueId: string | null;
  groupId: number | null;
  version: string;
  revisionStateId: number | null;
  archived: boolean;
  dead: DocumentReference[];
}

export interface RepairScan {
  /** Active processes with a dead reference: offered for repair. */
  active: BrokenProcess[];
  /** Archived processes with a dead reference: reported, not offered. */
  archived: BrokenProcess[];
  /** Processes whose model could not be read, active or archived. */
  unread: Array<{ uniqueId: string; name: string; error: string; archived: boolean }>;
  read: number;
}

export interface ScanProcess {
  uniqueId: string;
  name: string;
  groupUniqueId: string | null;
  groupId: number | null;
}

/**
 * The read-only first step. Active processes one model at a time (four at once), as the
 * archive plan reads them; archived ones in batches of 20 through the mobile read.
 */
export async function scanForDeadReferences(input: {
  active: readonly ScanProcess[];
  archived: readonly ScanProcess[];
  readModel: (processUniqueId: string) => Promise<ActiveRead>;
  readArchivedModels: (processUniqueIds: string[]) => Promise<Record<string, unknown>[]>;
  existing: ExistingDocuments;
  isFatal?: (error: unknown) => boolean;
  errorText?: (error: unknown) => string;
  onProgress?: (done: number, total: number) => void;
}): Promise<RepairScan> {
  const total = input.active.length + input.archived.length;
  const errorText = input.errorText ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const byId = new Map([...input.active, ...input.archived].map((p) => [p.uniqueId.toLowerCase(), p]));
  const broken = (p: ScanProcess, model: unknown, archived: boolean, dead: DocumentReference[]): BrokenProcess => {
    const state = Number(nodeString(model, 'ProcessRevisionStateId'));
    return { ...p, version: nodeString(model, 'Version'), revisionStateId: Number.isInteger(state) && state > 0 ? state : null, archived, dead };
  };

  const scan: ReferenceScan = await scanProcessesForDocuments(input.active, input.readModel, {
    ...(input.isFatal ? { isFatal: input.isFatal } : {}),
    errorText,
    onProgress: (done) => input.onProgress?.(done, total),
  });
  const active = scan.holders
    .map((h) => {
      const dead = h.references.filter((r) => isDead(r, input.existing));
      const p = byId.get(h.uniqueId.toLowerCase())!;
      return { ...p, version: h.version, revisionStateId: h.revisionStateId, archived: false, dead };
    })
    .filter((p) => p.dead.length > 0);

  const archived: BrokenProcess[] = [];
  const unread: RepairScan['unread'] = scan.unread.map((u) => ({ ...u, archived: false }));
  let read = scan.read;
  for (let i = 0; i < input.archived.length; i += ARCHIVED_BATCH) {
    const batch = input.archived.slice(i, i + ARCHIVED_BATCH);
    try {
      const models = await input.readArchivedModels(batch.map((p) => p.uniqueId));
      const served = new Set<string>();
      for (const model of models) {
        const p = byId.get(nodeString(model, 'UniqueId').toLowerCase());
        if (!p) continue;
        served.add(p.uniqueId.toLowerCase());
        read++;
        const dead = deadReferencesIn(model, input.existing);
        if (dead.length > 0) archived.push(broken(p, model, true, dead));
      }
      for (const p of batch) if (!served.has(p.uniqueId.toLowerCase())) unread.push({ ...p, error: 'The archived read did not return it', archived: true });
    } catch (error) {
      if (input.isFatal?.(error)) throw error;
      for (const p of batch) unread.push({ ...p, error: errorText(error), archived: true });
    }
    input.onProgress?.(input.active.length + Math.min(i + ARCHIVED_BATCH, input.archived.length), total);
  }

  return { active, archived, unread, read };
}

/**
 * The model with these items taken out of their arrays, and nothing else touched. Each
 * item is found by its key path; later indexes in an array go first, so earlier ones
 * stay where the scan found them.
 */
export function removeReferences(model: ProcessModel, refs: readonly DocumentReference[]): { model: ProcessModel; removed: DocumentReference[] } {
  const copy = structuredClone(model) as ProcessModel;
  const removed: DocumentReference[] = [];
  const ordered = [...refs].sort((a, b) => Number(b.segments[b.segments.length - 1]) - Number(a.segments[a.segments.length - 1]));
  for (const ref of ordered) {
    const index = ref.segments[ref.segments.length - 1];
    let parent: unknown = copy;
    for (const key of ref.segments.slice(0, -1)) parent = parent === null || typeof parent !== 'object' ? undefined : (parent as Record<string | number, unknown>)[key];
    if (!Array.isArray(parent) || typeof index !== 'number' || index >= parent.length) continue;
    parent.splice(index, 1);
    removed.push(ref);
  }
  return { model: copy, removed };
}

export type RepairGateway = Pick<DeleteGateway, 'readModel' | 'saveModel' | 'publishNow'> & { list: ListReader };

export interface RepairTarget {
  uniqueId: string;
  name: string;
  groupId: number | null;
  /** What the scan found, so a reference whose document came back can be named. */
  dead: readonly DocumentReference[];
  /** Publish an open draft with the repair. Default: save into it and leave it unpublished. */
  publishDraft: boolean;
}

/**
 * One process: re-read it and both document lists, remove only what is still dead, save
 * (and publish when the process was published, or when the operator ticked its draft),
 * then read it back and confirm no dead reference is left.
 */
export async function repairProcess(
  gateway: RepairGateway,
  target: RepairTarget,
  options: { changeDescription?: string; isFatal?: (error: unknown) => string | null; errorText?: (error: unknown) => string } = {},
): Promise<ResultRow> {
  const errorText = options.errorText ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const row = (status: string, message: string, statusCode: number | null = null) =>
    resultRow({ objectType: 'Process', objectId: target.uniqueId, name: target.name, operation: REPAIR_OPERATION, status, message, groupId: target.groupId, statusCode });
  const fatal = (error: unknown) => {
    if (options.isFatal?.(error)) throw error;
  };

  let read: ActiveRead;
  let existing: ExistingDocuments;
  try {
    read = await gateway.readModel(target.uniqueId);
    existing = existingDocuments(await loadDocumentIndex(gateway.list));
  } catch (error) {
    fatal(error);
    return row('Failed', `Could not read it and the document lists again straight before saving (${errorText(error)}), so nothing was changed`);
  }
  if (read.kind !== 'model') return row('Skipped', 'Archived since the scan; this page does not repair archived processes');

  const dead = deadReferencesIn(read.model, existing);
  const back = target.dead.filter((r) => !isDead(r, existing));
  const backNote = back.length > 0 ? ` ${back.length} left alone, because its document exists again: ${back.map(describeReference).join('; ')}.` : '';
  if (dead.length === 0) return row('Skipped', `No dead reference is left, so nothing was changed.${backNote}`);

  const { model, removed } = removeReferences(read.model, dead);
  const wasDraft = isOpenDraft(writeStateOf(read.model, read.processActions));
  let outcome: SaveOutcome;
  try {
    outcome = await saveProcessModel(gateway, target.uniqueId, model, {
      processActions: read.processActions,
      changeDescription: options.changeDescription ?? REPAIR_DESCRIPTION,
      approvalsEnabled: false,
      publishOpenDraft: target.publishDraft,
      saveIntoOpenDraft: true,
      ...(options.isFatal ? { isFatal: options.isFatal } : {}),
    });
  } catch (error) {
    fatal(error);
    return row('Failed', `The save failed (${errorText(error)})`);
  }
  const what = `${removed.length} dead reference${removed.length === 1 ? '' : 's'} (${removed.map(describeReference).join('; ')})`;
  if (!outcome.success) {
    if (outcome.stage === 'Refused') return row('Skipped', `Not changed: ${outcome.error}.${backNote}`);
    if (outcome.stage === 'Save') return row('Failed', `Saving the removal of ${what} failed: ${outcome.error}`, outcome.statusCode);
    return row('Failed', `Removed ${what} and saved, but publishing failed: ${outcome.error}`, outcome.statusCode);
  }

  // Read back, and confirm nothing dead is left.
  let after: ActiveRead;
  try {
    after = await gateway.readModel(target.uniqueId);
  } catch (error) {
    fatal(error);
    return row('Unverified', `Removed ${what}, but it could not be read back (${errorText(error)}), so the repair is not confirmed`);
  }
  if (after.kind !== 'model') return row('Unverified', `Removed ${what}, but the read-back found it archived, so the repair is not confirmed`);
  const left = deadReferencesIn(after.model, existing);
  if (left.length > 0) return row('Failed', `Saved, but the read-back still has ${left.length} dead reference${left.length === 1 ? '' : 's'}: ${left.map(describeReference).join('; ')}`);

  const version = nodeString(after.model, 'Version');
  const how =
    outcome.stage === 'Published'
      ? wasDraft
        ? `Saved and published as version ${version}, with the open draft’s other changes.`
        : `Saved and published as version ${version}.`
      : wasDraft
        ? `${DRAFT_SAVED_NOTE}. Saved as version ${version}.`
        : `Saved as version ${version}; it has never been published, so it was not published.`;
  return row('Success', `Removed ${what}. ${how}${backNote}`);
}

export const REPAIR_STATUSES = ['Success', 'Skipped', 'Unverified', 'Failed'] as const;

/**
 * The row for a process whose repair was under way when the run died (W8 follow-up): it
 * is read back with both document lists, and what the read shows decides the row. Nothing
 * is saved: a repair half-sent is finished by scanning again, which offers whatever is
 * still dead.
 */
export async function interruptedRepairRow(
  gateway: Pick<RepairGateway, 'readModel' | 'list'>,
  item: { uniqueId: string; name: string; groupId: number | null },
  errorText: (error: unknown) => string = (e) => (e instanceof Error ? e.message : String(e)),
): Promise<ResultRow> {
  const row = (status: string, message: string) =>
    resultRow({ objectType: 'Process', objectId: item.uniqueId, name: item.name, operation: REPAIR_OPERATION, status, message, groupId: item.groupId });
  const why = 'The run was interrupted while repairing it';
  try {
    const read = await gateway.readModel(item.uniqueId);
    if (read.kind !== 'model') return row('Unverified', `${why}, and it is archived now, so the repair could not be confirmed`);
    const left = deadReferencesIn(read.model, existingDocuments(await loadDocumentIndex(gateway.list)));
    const state = stateText(nodeString(read.model, 'Version'), Number(nodeString(read.model, 'ProcessRevisionStateId')) || null);
    if (left.length === 0) return row('Success', `${why}; the read afterwards finds no dead reference left (${state}). Check in Process Manager whether it still needs publishing.`);
    return row('Skipped', `Not repaired: ${why.toLowerCase()}, and the read afterwards still finds ${left.length} dead reference${left.length === 1 ? '' : 's'} (${state}). Scan again to repair it.`);
  } catch (error) {
    return row('Unverified', `${why}, and it could not be read back (${errorText(error)}), so the repair could not be confirmed`);
  }
}
