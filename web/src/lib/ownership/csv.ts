/**
 * Reading an ownership CSV, with the same columns and cell rules as
 * `Update-ProcessOwnership.ps1`, so a file written for the script works here unchanged.
 *
 * Columns, each matched case-insensitively by any of its names, the first non-blank
 * match winning, as the script's `Get-RowValue` does:
 *
 *  - process id: ProcessID, ProcessId, Process ID, ProcessUniqueId, Id, ID;
 *  - new owner: NewOwner, Owner, OwnerUsername, ProcessOwner;
 *  - new expert: NewExpert, Expert, ExpertUsername, ProcessExpert.
 *
 * A blank cell leaves the role unchanged. An unassign keyword (unassigned, unassign,
 * none, n/a, na) sets it to the built-in placeholder. Anything else is a username,
 * resolved through SCIM (plan.ts, `resolveCell`).
 */

import { isBlankRow, parseCsv } from '../csv/parse.ts';

const ID_COLUMNS = ['ProcessID', 'ProcessId', 'Process ID', 'ProcessUniqueId', 'Id', 'ID'];
const OWNER_COLUMNS = ['NewOwner', 'Owner', 'OwnerUsername', 'ProcessOwner'];
const EXPERT_COLUMNS = ['NewExpert', 'Expert', 'ExpertUsername', 'ProcessExpert'];

export interface OwnershipCsvRow {
  /** The file's own line number, header included, for the operator to find it. */
  line: number;
  processId: string | null;
  owner: string | null;
  expert: string | null;
}

export type OwnershipCsv =
  | { ok: true; rows: OwnershipCsvRow[]; nonGuidIds: string[] }
  | { ok: false; problem: string };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string): boolean {
  return GUID.test(value);
}

/** Column positions for one role, in the order the script tries them. */
function positions(header: readonly string[], names: readonly string[]): number[] {
  const cleaned = header.map((h) => h.trim().toLowerCase());
  const out: number[] = [];
  for (const name of names) {
    const at = cleaned.indexOf(name.toLowerCase());
    if (at >= 0 && !out.includes(at)) out.push(at);
  }
  return out;
}

function firstValue(row: readonly string[], columns: readonly number[]): string | null {
  for (const at of columns) {
    const value = (row[at] ?? '').trim();
    if (value !== '') return value;
  }
  return null;
}

export function parseOwnershipCsv(text: string): OwnershipCsv {
  const table = parseCsv(text);
  const header = table[0];
  if (!header || table.length < 2) return { ok: false, problem: 'The file is empty, or has a header and no rows.' };

  const idAt = positions(header, ID_COLUMNS);
  if (idAt.length === 0) {
    return {
      ok: false,
      problem: `No process id column was found. The file's columns are: ${header.map((h) => h.trim()).join(', ')}. Expected one of: ${ID_COLUMNS.join(', ')}.`,
    };
  }
  const ownerAt = positions(header, OWNER_COLUMNS);
  const expertAt = positions(header, EXPERT_COLUMNS);

  const rows: OwnershipCsvRow[] = [];
  for (const [i, cells] of table.entries()) {
    if (i === 0 || isBlankRow(cells)) continue;
    rows.push({ line: i + 1, processId: firstValue(cells, idAt), owner: firstValue(cells, ownerAt), expert: firstValue(cells, expertAt) });
  }
  if (rows.length === 0) return { ok: false, problem: 'The file has a header and no rows.' };
  if (rows.every((row) => row.processId === null)) {
    return { ok: false, problem: `The process id column (${header[idAt[0] ?? 0]?.trim()}) is empty on every row.` };
  }

  // The endpoint takes the process UniqueId, as in a process URL, not the short number.
  const nonGuidIds = rows.map((r) => r.processId).filter((id): id is string => id !== null && !isGuid(id));
  return { ok: true, rows, nonGuidIds };
}
