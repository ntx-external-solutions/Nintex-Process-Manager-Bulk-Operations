/**
 * The document endpoints (W8), as the documents spike measured them (API_ARCHITECTURE.md,
 * "Documents spike, 30 Oct 2026"). Measured with a browser session, not yet with the
 * bearer token this client sends; R16 checks each one.
 *
 * The bulk writes answer 200 when items fail. Each failure is an entry in `errors`, so a
 * caller that only looks at the status reports success for a document that was never
 * touched. They are returned as given, and the caller reads every entry.
 */

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
