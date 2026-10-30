/**
 * The document lists (W8), read whole and kept as plain entries.
 *
 * Fields are read case-insensitively and every one is optional, because the list was
 * measured from a browser session and the shape the bearer token gets is R16's to
 * confirm. The fields used are the script-era notes' (`documentId`, `documentUniqueId`,
 * `documentName`, `primaryGroupUniqueId`, `primaryGroupName`, `isArchived`,
 * `isLinkedFile`) and the spike's (`documentLocationType`, `isPending`).
 */

import { nodeString, nodeValue } from '../delete/model.ts';
import type { DocumentListPage, DocumentListType } from '../pm/documents.ts';
import { DOCUMENT_PAGE_SIZE } from '../pm/documents.ts';

export interface DocumentEntry {
  /** The numeric id the writes take. */
  documentId: number;
  /** What a results file names it by. */
  uniqueId: string;
  name: string;
  primaryGroupUniqueId: string | null;
  primaryGroupName: string;
  isArchived: boolean;
  isPending: boolean;
  /** "Cloud" (uploaded), "External link" or "Network", as the operator would say it. */
  location: string;
  /** The file's type, or '' when neither the list nor the name says. */
  type: string;
}

/** Both lists, keyed by lowercased `documentUniqueId`. */
export type DocumentIndex = ReadonlyMap<string, DocumentEntry>;

function flag(item: unknown, name: string): boolean {
  const value = nodeValue(item, name);
  return value === true || value === 'true' || value === 1;
}

export function locationOf(item: unknown): string {
  const raw = nodeString(item, 'documentLocationType');
  if (/cloud|upload/i.test(raw)) return 'Cloud';
  if (/external|url|web/i.test(raw)) return 'External link';
  if (/network|unc|file/i.test(raw)) return 'Network';
  if (raw !== '') return raw;
  return flag(item, 'isLinkedFile') ? 'External link' : '';
}

function typeOf(item: unknown, name: string): string {
  for (const field of ['documentType', 'fileType', 'fileExtension', 'extension']) {
    const value = nodeString(item, field).trim();
    if (value !== '' && !/^all$/i.test(value)) return value.replace(/^\./, '').toUpperCase();
  }
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name);
  return ext ? ext[1]!.toUpperCase() : '';
}

/** One list row as an entry, or null when it has no usable id. */
export function toDocumentEntry(item: unknown, listType: DocumentListType): DocumentEntry | null {
  const documentId = Number(nodeValue(item, 'documentId'));
  const uniqueId = nodeString(item, 'documentUniqueId').trim();
  if (!Number.isInteger(documentId) || documentId <= 0 || uniqueId === '') return null;
  const name = nodeString(item, 'documentName').trim();
  const archivedField = nodeValue(item, 'isArchived');
  return {
    documentId,
    uniqueId,
    name,
    primaryGroupUniqueId: nodeString(item, 'primaryGroupUniqueId').trim() || null,
    primaryGroupName: nodeString(item, 'primaryGroupName').trim(),
    // The list it came from decides, unless the row says otherwise.
    isArchived: archivedField === null ? listType === 'Archived' : flag(item, 'isArchived'),
    isPending: flag(item, 'isPending'),
    location: locationOf(item),
    type: typeOf(item, name),
  };
}

export type ListReader = (listType: DocumentListType, page: number, groupUniqueId: string | null) => Promise<DocumentListPage>;

/** Pages past this are refused by the proxy too. */
const MAX_PAGES = 100;

/** Every document in one list, each once, in the tenant's order. */
export async function loadDocumentList(
  read: ListReader,
  listType: DocumentListType,
  groupUniqueId: string | null = null,
  onProgress?: (read: number) => void,
): Promise<DocumentEntry[]> {
  const out = new Map<string, DocumentEntry>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const answer = await read(listType, page, groupUniqueId);
    for (const item of answer.items) {
      const entry = toDocumentEntry(item, listType);
      if (entry && !out.has(entry.uniqueId.toLowerCase())) out.set(entry.uniqueId.toLowerCase(), entry);
    }
    onProgress?.(out.size);
    const total = answer.totalItemCount;
    if (answer.items.length < DOCUMENT_PAGE_SIZE || (total !== null && out.size >= total)) break;
  }
  return [...out.values()];
}

/** Both lists as one index. An entry in both (a race between the reads) counts as archived. */
export async function loadDocumentIndex(read: ListReader, onProgress?: (read: number) => void): Promise<Map<string, DocumentEntry>> {
  const active = await loadDocumentList(read, 'All', null, onProgress);
  const archived = await loadDocumentList(read, 'Archived', null, (n) => onProgress?.(active.length + n));
  const index = new Map<string, DocumentEntry>();
  for (const entry of [...active, ...archived]) index.set(entry.uniqueId.toLowerCase(), entry);
  return index;
}

/** The label a document is shown under: its primary group's path, or the list's group name. */
export function documentPath(entry: DocumentEntry, paths: ReadonlyMap<string, string[]>): string[] {
  const path = entry.primaryGroupUniqueId ? paths.get(entry.primaryGroupUniqueId) : undefined;
  if (path && path.length > 0) return path;
  return entry.primaryGroupName ? [entry.primaryGroupName] : [];
}
