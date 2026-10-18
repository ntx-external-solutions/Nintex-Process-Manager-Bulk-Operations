/**
 * What a delete run is asked to delete, before anything resolves it.
 *
 * The screen hands the run ids from the tree or the archived view. The script also takes
 * every archived process, and a CSV, which includes its own results file: take the
 * failures out of `Delete_Results_*.csv` and run them again. That file names its id
 * column ObjectID, which the CSV reader did not accept, so the obvious re-run read zero
 * ids and said "No processes to delete", the same line an empty file gets.
 */

import { isBlankRow, parseCsv } from '../csv/parse.ts';

/**
 * Every header an id is read from, in order. ObjectID is here because it is the column
 * every results file uses. Port of `$script:CsvIdColumns`.
 */
export const CSV_ID_COLUMNS = [
  'ProcessID',
  'ProcessId',
  'Process ID',
  'ProcessUniqueId',
  'ObjectID',
  'ObjectId',
  'Object ID',
  'Id',
  'ID',
  'DocumentID',
  'DocumentId',
] as const;

/** Raw ids, GUID or numeric, resolved against the index once the run has read it. */
export type TargetSource =
  | { kind: 'ids'; ids: readonly string[] }
  /** Every archived process on the tenant (the script's `-SourceType Archived`). */
  | { kind: 'archived' }
  | { kind: 'csv'; text: string; fileName?: string | undefined };

/**
 * The id in one row: the first id column with a value. A header that exists but is blank
 * on this row does not end the search. Port of `Get-IdFromCsvRow`.
 */
export function idFromCsvRow(row: Readonly<Record<string, string>>): string | null {
  const headers = Object.keys(row);
  for (const column of CSV_ID_COLUMNS) {
    // PowerShell's `-contains` on property names, which ignores case.
    const header = headers.find((h) => h.toLowerCase() === column.toLowerCase());
    if (header === undefined) continue;
    const value = (row[header] ?? '').trim();
    if (value !== '') return value;
  }
  return null;
}

export interface CsvTargets {
  ids: string[];
  rowCount: number;
  headers: string[];
  /** Rows were read but none had an id column: the file's headers, not its contents, are why it is empty. */
  idColumnMissing: boolean;
}

/** A target file read the way the script reads one. Port of the CSV branch of `Invoke-BulkDeleteProcesses`. */
export function targetsFromCsv(text: string): CsvTargets {
  const [header = [], ...body] = parseCsv(text);
  const headers = header.map((h) => h.trim());
  const rows = body.filter((cells) => !isBlankRow(cells));
  const ids: string[] = [];
  for (const cells of rows) {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (!(h in row)) row[h] = cells[i] ?? '';
    });
    const id = idFromCsvRow(row);
    if (id !== null) ids.push(id);
  }
  return { ids, rowCount: rows.length, headers, idColumnMissing: rows.length > 0 && ids.length === 0 };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Raw ids as process UniqueIds. A GUID is taken as given (spelled as the index spells it
 * when it is there; the planner recovers one neither listing returns). A number is the
 * listing's numeric id, as the script's `Get-ProcessUniqueIdMap` reads it. Anything else,
 * or a number no listing has, is reported rather than dropped. Each process once.
 */
export function resolveTargetIds(
  raw: readonly string[],
  index: ReadonlyMap<string, { uniqueId: string; numericId: number | null }>,
): { uniqueIds: string[]; unknown: string[] } {
  const byNumber = new Map<number, string>();
  for (const entry of index.values()) if (entry.numericId !== null) byNumber.set(entry.numericId, entry.uniqueId);

  const seen = new Map<string, string>();
  const unknown: string[] = [];
  for (const value of raw.map((v) => v.trim()).filter((v) => v !== '')) {
    let uniqueId: string | undefined;
    if (GUID.test(value)) uniqueId = index.get(value.toLowerCase())?.uniqueId ?? value;
    else if (/^\d+$/.test(value)) uniqueId = byNumber.get(Number(value));
    if (uniqueId === undefined) unknown.push(value);
    else if (!seen.has(uniqueId.toLowerCase())) seen.set(uniqueId.toLowerCase(), uniqueId);
  }
  return { uniqueIds: [...seen.values()], unknown };
}
