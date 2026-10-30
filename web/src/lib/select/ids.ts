/**
 * Processes picked by id: typed or pasted, or read from a CSV (W7).
 *
 * Shared by Bulk Delete and Bulk Archive. Moved here from delete/targets.ts, which
 * re-exports it. The script also takes a CSV, which includes its own results file: take
 * the failures out of `Delete_Results_*.csv` and run them again. That file names its id
 * column ObjectID, which the CSV reader did not accept, so the obvious re-run read zero
 * ids and said "No processes to delete", the same line an empty file gets.
 *
 * Ids only, never names. Names are not unique (R15 saw three archived processes with the
 * same name in one group), and both operations that take this input are destructive.
 */

import { isBlankRow, parseCsvLines } from '../csv/parse.ts';

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

/** Headers that name a process without identifying it, so a file with only these is explained. */
const NAME_COLUMNS = ['Name', 'ProcessName', 'Process Name', 'Process', 'Title'];

/** The template the page offers: one column, headed as the first accepted header. */
export const ID_TEMPLATE_CSV = 'ProcessID\r\n';

/** The document pages' template (W8). `DocumentID` is already an accepted column. */
export const DOCUMENT_ID_TEMPLATE_CSV = 'DocumentID\r\n';

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
  /** Each id once, in file order, spelled as the file first spells it. */
  ids: string[];
  /** Data rows read, blank rows not counted. */
  rowCount: number;
  headers: string[];
  /** Rows were read but none had an id column: the file's headers, not its contents, are why it is empty. */
  idColumnMissing: boolean;
  /** Rows whose id was already read from an earlier row. */
  duplicates: number;
  /** The file line of each row that has an id column but no id in it. */
  noIdLines: number[];
  /** A name column, when the file has one and no id column, so the note can say why it is not used. */
  nameColumn: string | null;
}

/** A target file read the way the script reads one. Port of the CSV branch of `Invoke-BulkDeleteProcesses`. */
export function targetsFromCsv(text: string): CsvTargets {
  const [header, ...body] = parseCsvLines(text);
  const headers = (header?.cells ?? []).map((h) => h.trim());
  const rows = body.filter((r) => !isBlankRow(r.cells));
  const ids: string[] = [];
  const seen = new Set<string>();
  const noIdLines: number[] = [];
  let duplicates = 0;
  for (const { cells, line } of rows) {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (!(h in row)) row[h] = cells[i] ?? '';
    });
    const id = idFromCsvRow(row);
    if (id === null) {
      noIdLines.push(line);
      continue;
    }
    if (seen.has(id.toLowerCase())) {
      duplicates += 1;
      continue;
    }
    seen.add(id.toLowerCase());
    ids.push(id);
  }
  const idColumnMissing = rows.length > 0 && ids.length === 0 && !headers.some(isIdHeader);
  return {
    ids,
    rowCount: rows.length,
    headers,
    idColumnMissing,
    duplicates,
    noIdLines: idColumnMissing ? [] : noIdLines,
    nameColumn: idColumnMissing ? (headers.find((h) => NAME_COLUMNS.some((n) => n.toLowerCase() === h.toLowerCase())) ?? null) : null,
  };
}

function isIdHeader(header: string): boolean {
  return CSV_ID_COLUMNS.some((c) => c.toLowerCase() === header.toLowerCase());
}

/** What the page says after reading a file. Uploading replaces the box, and the note says so. */
export function csvReadNote(fileName: string, read: CsvTargets, kind: 'process' | 'document' = 'process'): string {
  if (read.rowCount === 0) return `${fileName}: no rows to read. Nothing was put in the box.`;
  if (read.ids.length === 0 && !read.idColumnMissing) {
    return `${fileName}: read ${read.rowCount} row(s), and none had an id (${linesText(read.noIdLines)}). Nothing was put in the box.`;
  }
  if (read.idColumnMissing) {
    const why = read.nameColumn
      ? `It has a name column (${read.nameColumn}), but ${kind === 'document' ? 'documents' : 'processes'} are picked by id only: names are not unique.`
      : `Columns in the file: ${read.headers.join(', ')}.`;
    return (
      `${fileName}: read ${read.rowCount} row(s) but found no id column. ${why} ` +
      `A results file from this app has the ids in ObjectID, or download the template and fill in ${kind === 'document' ? 'DocumentID' : 'ProcessID'}. ` +
      `Nothing was put in the box.`
    );
  }
  const parts = [`${read.rowCount} row(s) read`, `${read.ids.length} id(s) found`];
  if (read.duplicates > 0) parts.push(`${read.duplicates} duplicate(s) dropped`);
  if (read.noIdLines.length > 0) parts.push(`${read.noIdLines.length} row(s) with no id (${linesText(read.noIdLines)})`);
  return `${fileName}: ${parts.join(', ')}. This replaced what was in the box.`;
}

/** "line 4", "lines 4, 9 and 12", or the first 20 and a count of the rest. */
export function linesText(lines: readonly number[], shown = 20): string {
  if (lines.length === 1) return `line ${lines[0]}`;
  const head = lines.slice(0, shown);
  const rest = lines.length - head.length;
  if (rest > 0) return `lines ${head.join(', ')} and ${rest} more`;
  return `lines ${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`;
}

/** Ids typed or pasted into the box: one per line, or separated by commas, semicolons or spaces. */
export function typedIds(text: string): string[] {
  return text.split(/[\s,;]+/).filter((v) => v !== '');
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Process ids are GUIDs; the listing's own number is accepted too. */
export function looksLikeId(value: string): boolean {
  return GUID.test(value) || /^\d+$/.test(value);
}

/**
 * Raw ids as process UniqueIds. A GUID is taken as given (spelled as the index spells it
 * when it is there; the planner recovers one neither listing returns). A number is the
 * listing's numeric id, as the script's `Get-ProcessUniqueIdMap` reads it. Anything else,
 * or a number no listing has, is reported rather than dropped. Each process once.
 */
export function resolveTargetIds(
  raw: readonly string[],
  index: ReadonlyMap<string, { uniqueId: string; numericId?: number | null | undefined }>,
): { uniqueIds: string[]; unknown: string[] } {
  const byNumber = new Map<number, string>();
  for (const entry of index.values()) if (entry.numericId != null) byNumber.set(entry.numericId, entry.uniqueId);

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

/** What the id box holds: the text, and the file the text last came from. */
export interface IdInput {
  text: string;
  /** The last file read into the box, and its ids (lowercased), so each id can say where it came from. */
  file: { name: string; ids: ReadonlySet<string> } | null;
  /** What reading the last file found, shown under the box. */
  note: string | null;
}

export const EMPTY_ID_INPUT: IdInput = { text: '', file: null, note: null };

/** The box after reading a file. A file with no usable ids leaves the box as it was and says why. */
export function afterFileRead(current: IdInput, fileName: string, text: string, kind: 'process' | 'document' = 'process'): IdInput {
  const read = targetsFromCsv(text);
  const note = csvReadNote(fileName, read, kind);
  if (read.ids.length === 0) return { ...current, note };
  return { text: read.ids.join('\n'), file: { name: fileName, ids: new Set(read.ids.map((id) => id.toLowerCase())) }, note };
}

/** "From <file name>" for an id the file supplied, otherwise "By id". */
export function chosenLabel(input: IdInput, value: string): string {
  return input.file?.ids.has(value.trim().toLowerCase()) ? `From ${input.file.name}` : 'By id';
}
