/**
 * What a delete run is asked to delete, before anything resolves it.
 *
 * The screen hands the run ids from the tree or the archived view. The script also takes
 * every archived process, and a CSV, which includes its own results file: take the
 * failures out of `Delete_Results_*.csv` and run them again. That file names its id
 * column ObjectID, which the CSV reader did not accept, so the obvious re-run read zero
 * ids and said "No processes to delete", the same line an empty file gets.
 */

import { notPorted } from './phases.ts';

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
  return notPorted('discovery');
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
  return notPorted('discovery');
}
