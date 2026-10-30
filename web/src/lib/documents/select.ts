/**
 * Choosing documents (W8): from the tree's groups, from the document list, and by id or
 * CSV. The three add up, each document once, as on the process pages.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import { looksLikeId } from '../select/ids.ts';
import type { DocumentEntry, DocumentIndex } from './list.ts';

export const CHOSEN_FROM_TREE = 'From the tree';
export const CHOSEN_FROM_LIST = 'From the document list';
export const CHOSEN_BY_ID = 'By id';

/** A results row's Name for a document nothing could name. The process pages' wording names the process lists. */
export const DOCUMENT_UNKNOWN_NAME = '(name unavailable; not in either document list)';

export const NOT_A_DOCUMENT_ID = 'Not a document id. Ids are GUIDs, or the number Process Manager gives a document';
export const DOCUMENT_NOT_FOUND = 'Document not found in the active or archived document lists';

export interface ChosenDocument {
  entry: DocumentEntry;
  /** How the operator chose it, for the plan's "Chosen" column. */
  chosen: string;
}

/**
 * A checked group's listing, split. The tenant's group filter returns the subgroups'
 * documents and documents only associated with the group (spike), so the primary group
 * decides: in the checked subtree, the document is chosen; anywhere else, it is listed
 * apart for the operator to tick or not, because archiving it acts on it everywhere.
 */
export function splitByPrimaryGroup(
  listed: readonly DocumentEntry[],
  coveredGroups: ReadonlySet<string>,
): { inSubtree: DocumentEntry[]; associatedOnly: DocumentEntry[] } {
  const covered = new Set([...coveredGroups].map((g) => g.toLowerCase()));
  const inSubtree: DocumentEntry[] = [];
  const associatedOnly: DocumentEntry[] = [];
  for (const entry of listed) {
    const primary = entry.primaryGroupUniqueId?.toLowerCase();
    (primary !== undefined && covered.has(primary) ? inSubtree : associatedOnly).push(entry);
  }
  return { inSubtree, associatedOnly };
}

export interface DocumentIdResolution {
  chosen: ChosenDocument[];
  /** `Resolve` rows for values that matched no document. */
  skipped: ResultRow[];
  unknown: string[];
}

/**
 * Ids as documents. A GUID is a `documentUniqueId` and a number a `documentId`: on the
 * document pages a number is never a process id. Archived documents are returned too;
 * the plan says what each operation does with them.
 */
export function resolveDocumentIds(
  raw: readonly string[],
  index: DocumentIndex,
  chosenOf: (value: string) => string = () => CHOSEN_BY_ID,
): DocumentIdResolution {
  const byNumber = new Map<number, DocumentEntry>();
  for (const entry of index.values()) byNumber.set(entry.documentId, entry);

  const chosen: ChosenDocument[] = [];
  const skipped: ResultRow[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const value of raw.map((v) => v.trim()).filter((v) => v !== '')) {
    const entry = !looksLikeId(value) ? undefined : /^\d+$/.test(value) ? byNumber.get(Number(value)) : index.get(value.toLowerCase());
    const key = entry ? entry.uniqueId.toLowerCase() : value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!entry) {
      unknown.push(value);
      skipped.push(
        resultRow({
          objectType: 'Document',
          objectId: value,
          name: DOCUMENT_UNKNOWN_NAME,
          operation: 'Resolve',
          status: 'Skipped',
          message: looksLikeId(value) ? DOCUMENT_NOT_FOUND : NOT_A_DOCUMENT_ID,
        }),
      );
      continue;
    }
    chosen.push({ entry, chosen: chosenOf(value) });
  }
  return { chosen, skipped, unknown };
}

/** Each document once, the first way it was chosen kept. */
export function combineChosen(...lists: ReadonlyArray<readonly ChosenDocument[]>): ChosenDocument[] {
  const out: ChosenDocument[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const c of list) {
      const key = c.entry.uniqueId.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/** Case-insensitive name search over the list tab. Every word must appear. */
export function searchDocuments(entries: readonly DocumentEntry[], query: string): DocumentEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [...entries];
  return entries.filter((e) => words.every((w) => e.name.toLowerCase().includes(w)));
}
