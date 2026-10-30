/**
 * Where processes point at documents, read from their models (W8).
 *
 * The tenant's own `attachedProcesses` misses a reference that exists only in an
 * unpublished draft, and deleting a document a draft points at leaves that process unable
 * to publish or archive ("Could not find Form: <name>", documents spike). So the current
 * model of every active process is read and walked, and anything under
 * `ProcessProcedures` carrying a `DocumentId` or `DocumentUniqueId` is a reference.
 * Attachments sit in `Activity[].ChildProcessProcedures.<Type>[]` on the demo tenant, but
 * the walk does not assume it. W8d's repair finds dead references with the same walk.
 */

import { nodeInt, nodeString, nodeValue } from '../delete/model.ts';
import type { ActiveRead } from '../pm/dependencies.ts';

export interface DocumentReference {
  /** Null when the item carried no usable number. */
  documentId: number | null;
  /** Null when the item carried no GUID. */
  documentUniqueId: string | null;
  /** The array the item sits in: Form, Image, Policy and so on. */
  type: string;
  /** The item's own text, as the process shows it. */
  text: string;
  /** e.g. `ProcessProcedures.Activity[1].ChildProcessProcedures.Form[0]`. */
  path: string;
  /** Keys and indexes from the model's root to the item, for removing it (W8d). */
  segments: Array<string | number>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function referenceAt(node: Record<string, unknown>, type: string, path: string, segments: Array<string | number>): DocumentReference | null {
  const id = nodeInt(node, 'DocumentId');
  const guid = nodeString(node, 'DocumentUniqueId').trim();
  const documentId = id !== null && id > 0 ? id : null;
  const documentUniqueId = guid !== '' && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(guid) ? guid : null;
  if (documentId === null && documentUniqueId === null) return null;
  const text = ['Text', 'Name', 'DocumentName', 'Title'].map((f) => nodeString(node, f).trim()).find((t) => t !== '') ?? '';
  return { documentId, documentUniqueId, type, text, path, segments };
}

/** Every document reference in one model, in the order the walk meets them. */
export function findDocumentReferences(model: unknown): DocumentReference[] {
  const out: DocumentReference[] = [];
  const root = isObject(model) ? Object.keys(model).find((k) => k.toLowerCase() === 'processprocedures') : undefined;
  if (root === undefined) return out;

  const walk = (value: unknown, type: string, path: string, segments: Array<string | number>, depth: number): void => {
    // Models nest a few levels; the limit only guards against a payload that loops.
    if (depth > 64) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, type, `${path}[${i}]`, [...segments, i], depth + 1));
      return;
    }
    if (!isObject(value)) return;
    const found = referenceAt(value, type, path, segments);
    if (found) out.push(found);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'object' && child !== null) walk(child, key, `${path}.${key}`, [...segments, key], depth + 1);
    }
  };

  walk((model as Record<string, unknown>)[root], root, root, [root], 0);
  return out;
}

/** True when the reference names this document, by GUID or by number. */
export function refersTo(ref: DocumentReference, doc: { documentId: number; uniqueId: string }): boolean {
  if (ref.documentUniqueId !== null && ref.documentUniqueId.toLowerCase() === doc.uniqueId.toLowerCase()) return true;
  return ref.documentId !== null && ref.documentId === doc.documentId;
}

/** A process the scan found holding a reference. */
export interface ReferencingProcess {
  uniqueId: string;
  name: string;
  /** False when the model read is an open draft, or its state is not known. */
  published: boolean;
  references: DocumentReference[];
}

export interface ReferenceScan {
  /** Only processes with at least one reference. */
  holders: ReferencingProcess[];
  /** Processes whose model could not be read, so a reference they hold is unknown. */
  unread: Array<{ uniqueId: string; name: string; error: string }>;
  /** How many models were read. */
  read: number;
}

/** `ProcessRevisionStateId` 3 is published; anything else on the current model is a draft. */
const PUBLISHED_STATE = 3;

/**
 * Read the current model of each process, a few at a time, and keep the ones that point
 * at any document. One read per process: about 186 on the demo tenant, accepted as the
 * cost of finding draft references (W8 decision 1). A process that has been archived
 * since the list was read answers without a model and is not counted.
 */
export async function scanProcessesForDocuments(
  processes: ReadonlyArray<{ uniqueId: string; name: string }>,
  readModel: (processUniqueId: string) => Promise<ActiveRead>,
  options: {
    concurrency?: number;
    isFatal?: (error: unknown) => boolean;
    errorText?: (error: unknown) => string;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ReferenceScan> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const holders: ReferencingProcess[] = [];
  const unread: ReferenceScan['unread'] = [];
  let read = 0;
  let done = 0;

  for (let i = 0; i < processes.length; i += concurrency) {
    await Promise.all(
      processes.slice(i, i + concurrency).map(async (p) => {
        try {
          const answer = await readModel(p.uniqueId);
          if (answer.kind !== 'model') return;
          read++;
          const references = findDocumentReferences(answer.model);
          if (references.length === 0) return;
          const state = nodeValue(answer.model, 'ProcessRevisionStateId');
          holders.push({ uniqueId: p.uniqueId, name: p.name, published: Number(state) === PUBLISHED_STATE, references });
        } catch (error) {
          if (options.isFatal?.(error)) throw error;
          unread.push({ uniqueId: p.uniqueId, name: p.name, error: options.errorText?.(error) ?? String(error) });
        } finally {
          options.onProgress?.(++done, processes.length);
        }
      }),
    );
  }

  return { holders, unread, read };
}

/** The processes whose current model points at this document. */
export function processesReferencing(scan: ReferenceScan, doc: { documentId: number; uniqueId: string }): ReferencingProcess[] {
  return scan.holders.filter((h) => h.references.some((r) => refersTo(r, doc)));
}
