/**
 * What a delete run is asked to delete, before anything resolves it.
 *
 * The id input is shared with Bulk Archive since W7 and lives in select/ids.ts; it is
 * re-exported here so the engine's imports did not move.
 */

export { CSV_ID_COLUMNS, idFromCsvRow, resolveTargetIds, targetsFromCsv, type CsvTargets } from '../select/ids.ts';

/** Raw ids, GUID or numeric, resolved against the index once the run has read it. */
export type TargetSource =
  | { kind: 'ids'; ids: readonly string[] }
  /** Every archived process on the tenant (the script's `-SourceType Archived`). */
  | { kind: 'archived' }
  | { kind: 'csv'; text: string; fileName?: string | undefined };
