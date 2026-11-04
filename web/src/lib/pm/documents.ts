/**
 * The document endpoints (W8), as the documents spike measured them (API_ARCHITECTURE.md,
 * "Documents spike, 30 Oct 2026"). Measured with a browser session, not yet with the
 * bearer token this client sends; R16 checks each one.
 *
 * The bulk writes answer 200 when items fail. Each failure is an entry in `errors`, so a
 * caller that only looks at the status reports success for a document that was never
 * touched. They are returned as given, and the caller reads every entry.
 */

import { nodeHas, nodeString, nodeValue } from '../delete/model.ts';
import { toDocumentProperties } from '../documents/holders.ts';
import { pmRequest, type PmContext } from './client.ts';

const DOCUMENTS = '/bff/document/api/v1/documents';

/** The spike read all 207 active documents on the demo tenant in one page of 500. */
export const DOCUMENT_PAGE_SIZE = 500;

/** The script-era note's advice for the bulk calls, and the most one proxied write may name. */
export const DOCUMENT_BATCH_SIZE = 50;

export type DocumentListType = 'All' | 'Archived';

export interface DocumentListPage {
  items: Record<string, unknown>[];
  totalItemCount: number | null;
}

/**
 * One page of a document list. `All` leaves archived documents out (spike S1).
 *
 * With a group, the tenant returns that group's subgroups' documents too, and documents
 * only associated with it, not just those whose primary group it is (spike).
 */
export async function listDocuments(
  ctx: PmContext,
  listType: DocumentListType,
  page: number,
  groupUniqueId: string | null,
): Promise<DocumentListPage> {
  const response = await pmRequest<{ items?: unknown; totalItemCount?: unknown } | null>(ctx, {
    path: DOCUMENTS,
    query: {
      Page: page,
      PageSize: DOCUMENT_PAGE_SIZE,
      ListType: listType,
      DocumentType: 'All',
      ProcessGroupId: groupUniqueId ?? undefined,
    },
  });
  const items = Array.isArray(response?.items) ? response.items : [];
  return {
    items: items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null),
    totalItemCount: typeof response?.totalItemCount === 'number' ? response.totalItemCount : null,
  };
}

/** What holds one document, and where it lives. Returned as the tenant gives it. */
export async function getDocumentProperties(ctx: PmContext, documentId: number): Promise<Record<string, unknown>> {
  const response = await pmRequest<Record<string, unknown> | null>(ctx, { path: `${DOCUMENTS}/${documentId}/properties` });
  return response ?? {};
}

/** A bulk write's answer: 200 with one entry per document that failed. */
export interface DocumentBulkAnswer {
  errors: Array<{ documentId: number | null; errorCode: string }>;
}

function bulkAnswer(response: unknown): DocumentBulkAnswer {
  const raw = typeof response === 'object' && response !== null ? (response as Record<string, unknown>)['errors'] : null;
  const list = Array.isArray(raw) ? raw : [];
  return {
    errors: list.map((entry) => {
      const e = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
      const id = Number(e['documentId'] ?? e['DocumentId']);
      const code = e['errorCode'] ?? e['ErrorCode'] ?? e['code'];
      return {
        documentId: Number.isInteger(id) && id > 0 ? id : null,
        // An entry with no code is still a failure; it says so rather than vanishing.
        errorCode: typeof code === 'string' && code !== '' ? code : 'Unknown',
      };
    }),
  };
}

/**
 * Archive up to 50 documents. Retried only when the tenant says it did nothing (429, 408):
 * a repeat of a batch that landed would answer `NotFound` or similar for every document
 * and turn successes into failures.
 */
export async function bulkArchiveDocuments(ctx: PmContext, documentIds: readonly number[]): Promise<DocumentBulkAnswer> {
  return bulkAnswer(
    await pmRequest<unknown>(ctx, {
      path: `${DOCUMENTS}/bulk/archive`,
      method: 'POST',
      body: { documentIds: [...documentIds] },
      retry: 'write',
    }),
  );
}

/**
 * Restore up to 50 archived documents (W8b's put-back, W8c). The spike measured it: each
 * returns to its primary group with its associations. Retried as the archive is.
 */
export async function bulkRestoreDocuments(ctx: PmContext, documentIds: readonly number[]): Promise<DocumentBulkAnswer> {
  return bulkAnswer(
    await pmRequest<unknown>(ctx, {
      path: `${DOCUMENTS}/bulk/restore`,
      method: 'POST',
      body: { documentIds: [...documentIds] },
      retry: 'write',
    }),
  );
}

/**
 * Permanently delete up to 50 archived documents. The tenant refuses an active one
 * (`NotArchived`) and one a process still holds (`ProcessAttachment`), each as an entry
 * in a 200, but not one only an unpublished draft points at (spike): the caller's scan
 * is what keeps those.
 */
export async function bulkDeleteDocuments(ctx: PmContext, documentIds: readonly number[]): Promise<DocumentBulkAnswer> {
  return bulkAnswer(
    await pmRequest<unknown>(ctx, {
      path: `${DOCUMENTS}/bulk`,
      method: 'DELETE',
      body: { documentIds: [...documentIds] },
      retry: 'write',
    }),
  );
}

export const MOVE_ARCHIVED = 'Archived. Restore it first to move it';
export const MOVE_PENDING = 'Pending in Process Manager';
export const MOVE_ALREADY_THERE = 'Already in that group';
export const MOVE_LINK = 'A linked document. Its save form has not been measured, and a save without its address could lose it, so it was left alone';

const moveMissing = (field: string) =>
  `Its properties did not give ${field}, which a save has to send back unchanged, so it was left alone`;

/** The first of these fields the answer carries, or null. */
function firstField(raw: unknown, names: readonly string[]): string | null {
  return names.find((name) => nodeHas(raw, name)) ?? null;
}

/**
 * The form that moves one document, or why it can't be built.
 *
 * `POST .../{id}/properties` replaces the whole record, so everything but the primary
 * group has to go back as it came. A field left blank would be wiped on the tenant with a
 * success answer, and the final read can't see that: it only checks the group. So a field
 * the read didn't carry refuses the move, rather than being sent empty. The form's names
 * are from a browser capture (W9). The read's names for the reference and the review
 * frequency are that form's, camel-cased, and unmeasured until R16; if they're wrong every
 * document is skipped with this message and nothing is touched.
 *
 * The old primary group isn't kept as an association, and the new one is taken out of the
 * associations, since a group can't be both. Link documents are refused until their form
 * is captured: the spike's create call has `Url` and `NetworkPath`, which this form hasn't.
 */
export function documentMoveForm(raw: unknown, targetGroupId: number): { form: Record<string, string> } | { refused: string } {
  const props = toDocumentProperties(raw);
  if (props.isArchived === true) return { refused: MOVE_ARCHIVED };
  if (props.isPending === true) return { refused: MOVE_PENDING };
  if (props.primaryGroupId === null) return { refused: moveMissing('its primary group') };
  if (props.primaryGroupId === targetGroupId) return { refused: MOVE_ALREADY_THERE };

  const location = nodeString(raw, 'documentLocationType');
  if (location === '') return { refused: moveMissing('its location type') };
  if (!/cloud|upload/i.test(location)) return { refused: MOVE_LINK };

  const name = nodeString(raw, 'documentName');
  if (name.trim() === '') return { refused: moveMissing('its name') };

  // A word, as captured ("Image"). A number here would be an enum the form doesn't take.
  const type = nodeString(raw, 'documentType');
  if (!/^[a-z]+$/i.test(type.trim())) return { refused: moveMissing('its document type') };

  const referenceField = firstField(raw, ['referenceNo', 'referenceNumber']);
  if (referenceField === null) return { refused: moveMissing('its reference number') };

  const override = nodeValue(raw, 'doOverrideDocumentReviewFreq');
  if (typeof override !== 'boolean') return { refused: moveMissing('its review frequency setting') };
  if (!nodeHas(raw, 'documentReviewFreqMonths')) return { refused: moveMissing('its review frequency') };
  const months = nodeValue(raw, 'documentReviewFreqMonths');
  if (override && !/^\d+$/.test(String(months ?? ''))) return { refused: moveMissing('its review frequency') };

  // Absent would read as "no associations", and the save would remove them all.
  if (nodeValue(raw, 'associatedGroups') === null) return { refused: moveMissing('its associated groups') };
  if (props.associatedGroups.some((g) => g.id === null)) return { refused: moveMissing('the id of an associated group') };
  const selected = [...new Set(props.associatedGroups.map((g) => g.id as number))].filter(
    (id) => id !== props.primaryGroupId && id !== targetGroupId,
  );

  return {
    form: {
      DoOverrideDocumentReviewFreq: String(override),
      DocumentReviewFreqMonths: months === null ? '' : String(months),
      ReferenceNo: nodeString(raw, referenceField),
      DocumentName: name,
      DocumentType: type,
      PrimaryProcessGroupId: String(targetGroupId),
      GroupList: JSON.stringify({ selected }),
    },
  };
}

export type DocumentMoveAnswer = { moved: true } | { moved: false; refused: string };

/**
 * Move one document to another primary group. Reads the record and saves it in one
 * operation, so the browser never supplies a name or a list of groups, and the save sends
 * back what the tenant holds now rather than what the plan saw. 204 when it lands (spike).
 */
export async function moveDocument(ctx: PmContext, documentId: number, targetGroupId: number): Promise<DocumentMoveAnswer> {
  const built = documentMoveForm(await getDocumentProperties(ctx, documentId), targetGroupId);
  if ('refused' in built) return { moved: false, refused: built.refused };
  await pmRequest<unknown>(ctx, { path: `${DOCUMENTS}/${documentId}/properties`, method: 'POST', multipart: built.form, retry: 'write' });
  return { moved: true };
}
