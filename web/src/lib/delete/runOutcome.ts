/**
 * The end-of-run re-check: what the results say needs a human, corrected against a fresh
 * read of the tenant.
 *
 * Both manual-attention lists were built from what API calls said, and the calls do not
 * always say what happened. One run told an operator to move five processes that were
 * already home (returning a target appears to bring its sibling variations back with
 * it); another reported two targets "still active" that a read afterwards found archived
 * (an archive call can report failure and take effect). So every row that is not
 * already a success is re-derived from one sweep taken when the run ends. A row is only
 * ever corrected to match the tenant, and a process missing from the sweep proves
 * nothing, because the sweeps are known to be incomplete.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import { readGroupExists } from '../select/archived.ts';
import { loadProcessIndex, type ProcessIndex } from '../tenant/state.ts';
import type { CollateralChange } from './collateral.ts';
import type { DeleteEventSink } from './events.ts';
import type { DeleteGateway } from './gateway.ts';
import type { LedgerRole, PlanLedgerRow } from './ledger.ts';

/**
 * The unwind's operations. A `ReArchive` row is one of the run's targets going home; a
 * `ReArchiveHolder` row is a process that was never a target, un-archived only so its
 * references could be read, then put back. One name for both left no way to see that a
 * holder had been moved at all (R11). Port of `$script:NpmReArchiveOperations`.
 *
 * `ReArchiveOrphanedHolder` is new (old T2, named in Cowork's review of phase 1): a holder
 * parked in the holding group because its own group is gone. It is archived where it sits
 * and stays archived without a group, which is the state it was found in, and its row
 * should not read like a holder that went home.
 */
export const RE_ARCHIVE_OPERATIONS = ['ReArchive', 'ReArchiveHolder', 'ReArchiveOrphanedHolder'] as const;

export type ReArchiveOperation = (typeof RE_ARCHIVE_OPERATIONS)[number];

/** Port of `Get-NpmReArchiveOperation`, plus the parked holder. */
export function reArchiveOperation(role: LedgerRole, parkedInHoldingGroup = false): ReArchiveOperation {
  if (role !== 'Holder') return 'ReArchive';
  return parkedInHoldingGroup ? 'ReArchiveOrphanedHolder' : 'ReArchiveHolder';
}

/** What the target re-check needs from a ledger row. */
export type OutcomeLedgerEntry = Pick<PlanLedgerRow, 'uniqueId' | 'name' | 'originalGroupId' | 'originalGroupExists'>;

type IndexReader = Pick<DeleteGateway, 'listProcesses'>;

const freshIndexOf = (gateway: IndexReader): Promise<ProcessIndex> =>
  loadProcessIndex((page, listType) => gateway.listProcesses(page, listType));

const isReArchive = (operation: string): boolean => (RE_ARCHIVE_OPERATIONS as readonly string[]).includes(operation);

/**
 * `ReverseCollateral` rows not yet a success, cleared when the process is back in its
 * group and state by the end of the run. A NotInBaseline process has nothing to be
 * compared to and is never cleared. Port of `Resolve-CollateralOutcome`.
 */
export async function resolveCollateralOutcome(
  gateway: IndexReader,
  collateral: readonly CollateralChange[],
  results: readonly ResultRow[],
  freshIndex?: ProcessIndex | null,
): Promise<ResultRow[]> {
  const rows = [...results];
  if (collateral.length === 0) return rows;
  if (!rows.some((r) => r.operation === 'ReverseCollateral' && r.status !== 'Success')) return rows;
  const fresh = freshIndex ?? (await freshIndexOf(gateway));
  const expected = new Map(collateral.filter((c) => c.uniqueId).map((c) => [c.uniqueId.toLowerCase(), c]));

  return rows.map((row) => {
    if (row.operation !== 'ReverseCollateral' || row.status === 'Success') return row;
    const key = row.objectId.toLowerCase();
    const want = expected.get(key);
    const now = fresh.get(key);
    // Missing from the sweep proves nothing: the sweeps are known to be incomplete.
    if (!want || !now || want.originalGroupId === null || want.change === 'NotInBaseline') return row;
    const backInGroup = now.groupId === want.originalGroupId;
    const backInState = now.isArchived === (want.wasArchived === true);
    if (!backInGroup || !backInState) return row;
    return resultRow({
      objectType: row.objectType,
      objectId: row.objectId,
      name: row.name,
      operation: 'ReverseCollateral',
      status: 'Success',
      message: `Back in group ${want.originalGroupId} by the end of the run; no action needed`,
      groupId: now.groupId,
    });
  });
}

/**
 * Re-archive rows not yet a success, re-derived from whether the process is archived now
 * and which group it is in. Rows for other operations, and rows with no ledger entry,
 * are left alone. Port of `Resolve-TargetOutcome`.
 */
export async function resolveTargetOutcome(
  gateway: IndexReader,
  ledger: readonly OutcomeLedgerEntry[],
  results: readonly ResultRow[],
  freshIndex?: ProcessIndex | null,
): Promise<ResultRow[]> {
  const rows = [...results];
  if (ledger.length === 0) return rows;
  if (!rows.some((r) => isReArchive(r.operation) && r.status !== 'Success')) return rows;
  const fresh = freshIndex ?? (await freshIndexOf(gateway));
  const byId = new Map(ledger.filter((e) => e.uniqueId).map((e) => [e.uniqueId.toLowerCase(), e]));

  return rows.map((row) => {
    if (!isReArchive(row.operation) || row.status === 'Success') return row;
    const key = row.objectId.toLowerCase();
    const entry = byId.get(key);
    const now = fresh.get(key);
    if (!entry || !now) return row;

    const homeGroupId = entry.originalGroupId;
    const homeExists = readGroupExists(entry.originalGroupExists).exists;
    let status = 'Failed';
    let message = `Still ACTIVE in group ${now.groupId}; archive it manually`;
    if (now.isArchived) {
      status = 'Skipped';
      if (homeGroupId !== null && now.groupId === homeGroupId) {
        status = 'Success';
        message = `Re-archived in group ${homeGroupId}; confirmed by a read after the run`;
      } else if (homeGroupId === null) {
        message = `Archived in group ${now.groupId}; no original group was recorded`;
      } else if (!homeExists) {
        message = `Archived in group ${now.groupId}; its original group ${homeGroupId} no longer exists`;
      } else {
        message = `Archived in group ${now.groupId}, NOT the original group ${homeGroupId}; move it manually`;
      }
    }
    if (status === row.status && message === row.message) return row;
    return { ...row, status, message, groupId: now.groupId === null ? '' : String(now.groupId) };
  });
}

/**
 * Both lists against one sweep, and no sweep at all when nothing is outstanding. Port of
 * `Resolve-RunOutcome`.
 */
export async function resolveRunOutcome(
  gateway: IndexReader,
  collateral: readonly CollateralChange[],
  ledger: readonly OutcomeLedgerEntry[],
  results: readonly ResultRow[],
  options: { onEvent?: DeleteEventSink | undefined } = {},
): Promise<ResultRow[]> {
  const outstanding = results.some((r) => (r.operation === 'ReverseCollateral' || isReArchive(r.operation)) && r.status !== 'Success');
  if (!outstanding) return [...results];
  options.onEvent?.({ kind: 'stage', stage: 'rechecking' });
  const fresh = await freshIndexOf(gateway);
  const rows = await resolveCollateralOutcome(gateway, collateral, results, fresh);
  return resolveTargetOutcome(gateway, ledger, rows, fresh);
}
