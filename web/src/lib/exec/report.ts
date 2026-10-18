/**
 * The results file: the record of what a run did, for whoever has to answer for it.
 *
 * Built in the browser and downloaded directly. It never transits our server, which is
 * the same reason plans are built client-side.
 *
 * The columns are the PowerShell script's, in its order (`$script:ProcessResultColumns`
 * in Nintex-BulkOperations.ps1), so a results file from either tool reads the same and
 * one can be fed back to the other as a target file through its ObjectID column.
 *
 * Two rules carried over from the script:
 *
 *  - every process a run changes on the tenant gets a row. A change with no row is a
 *    defect, not a cosmetic gap;
 *  - a row's Name is never its ObjectID. Where nothing can name a process, the row says
 *    so in words, rather than printing the id twice.
 */

import { toCsv } from '../csv/parse.ts';

export type ObjectType = 'Process' | 'ProcessGroup' | 'Document';

export interface ResultRow {
  objectType: ObjectType;
  objectId: string;
  name: string;
  operation: string;
  status: string;
  message: string;
  /** Blank where it does not apply, which is most rows. */
  groupId: string;
  /** The failing call's HTTP status, blank when no call failed. */
  statusCode: string;
}

export const RESULT_COLUMNS = [
  'ObjectType',
  'ObjectID',
  'Name',
  'Operation',
  'Status',
  'Message',
  'GroupId',
  'StatusCode',
] as const;

/** The script's wording, so the two tools' files agree. */
export const UNKNOWN_NAME = '(name unavailable; not in any process list)';

export interface ResultRowInput {
  objectType?: ObjectType | undefined;
  objectId: string;
  name?: string | null | undefined;
  operation: string;
  status: string;
  message?: string | undefined;
  groupId?: string | number | null | undefined;
  statusCode?: number | null | undefined;
}

/** One row, named at construction so the screen and the file cannot disagree. */
export function resultRow(input: ResultRowInput): ResultRow {
  const name = (input.name ?? '').trim();
  const real = name !== '' && name.toLowerCase() !== input.objectId.toLowerCase();
  return {
    objectType: input.objectType ?? 'Process',
    objectId: input.objectId,
    name: real ? name : UNKNOWN_NAME,
    operation: input.operation,
    status: input.status,
    message: input.message ?? '',
    groupId: input.groupId === null || input.groupId === undefined ? '' : String(input.groupId),
    statusCode:
      typeof input.statusCode === 'number' && input.statusCode > 0 ? String(input.statusCode) : '',
  };
}

export function resultsToCsv(rows: readonly ResultRow[]): string {
  const out: string[][] = [[...RESULT_COLUMNS]];
  for (const row of rows) {
    out.push([
      row.objectType,
      row.objectId,
      row.name,
      row.operation,
      row.status,
      row.message,
      row.groupId,
      row.statusCode,
    ]);
  }
  return toCsv(out);
}

export interface StatusCount {
  status: string;
  count: number;
  /** Not in the operation's vocabulary. Shown, and flagged, rather than left uncounted. */
  unexpected: boolean;
}

/**
 * Rows per status, in the vocabulary's order, then anything the vocabulary does not name.
 *
 * The script added that last part after Pending and Blocked rows were written to the CSV
 * and counted nowhere. A status nobody listed is exactly the one someone needs to see.
 */
export function countByStatus(
  rows: readonly ResultRow[],
  vocabulary: readonly string[],
): StatusCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);

  const out: StatusCount[] = [];
  for (const status of vocabulary) {
    const count = counts.get(status) ?? 0;
    if (count > 0) out.push({ status, count, unexpected: false });
  }
  for (const [status, count] of counts) {
    if (!vocabulary.includes(status)) out.push({ status, count, unexpected: true });
  }
  return out;
}
