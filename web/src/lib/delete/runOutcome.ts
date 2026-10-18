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

import type { ResultRow } from '../exec/report.ts';
import type { ProcessIndex } from '../tenant/state.ts';
import type { CollateralChange } from './collateral.ts';
import type { DeleteEventSink } from './events.ts';
import type { DeleteGateway } from './gateway.ts';
import type { LedgerRole, PlanLedgerRow } from './ledger.ts';
import { notPorted } from './phases.ts';

/**
 * The unwind's two operations. A `ReArchive` row is one of the run's targets going home;
 * a `ReArchiveHolder` row is a process that was never a target, un-archived only so its
 * references could be read, then put back. One name for both left no way to see that a
 * holder had been moved at all (R11). Port of `$script:NpmReArchiveOperations`.
 */
export const RE_ARCHIVE_OPERATIONS = ['ReArchive', 'ReArchiveHolder'] as const;

export type ReArchiveOperation = (typeof RE_ARCHIVE_OPERATIONS)[number];

/** Port of `Get-NpmReArchiveOperation`. */
export function reArchiveOperation(role: LedgerRole): ReArchiveOperation {
  return role === 'Holder' ? 'ReArchiveHolder' : 'ReArchive';
}

/** What the target re-check needs from a ledger row. */
export type OutcomeLedgerEntry = Pick<PlanLedgerRow, 'uniqueId' | 'name' | 'originalGroupId' | 'originalGroupExists'>;

type IndexReader = Pick<DeleteGateway, 'listProcesses'>;

/**
 * `ReverseCollateral` rows not yet a success, cleared when the process is back in its
 * group and state by the end of the run. A NotInBaseline process has nothing to be
 * compared to and is never cleared. Port of `Resolve-CollateralOutcome`.
 */
export function resolveCollateralOutcome(
  gateway: IndexReader,
  collateral: readonly CollateralChange[],
  results: readonly ResultRow[],
  freshIndex?: ProcessIndex | null,
): Promise<ResultRow[]> {
  return notPorted('unwind');
}

/**
 * `ReArchive` and `ReArchiveHolder` rows not yet a success, re-derived from whether the
 * process is archived now and which group it is in. Rows for other operations, and rows
 * with no ledger entry, are left alone. Port of `Resolve-TargetOutcome`.
 */
export function resolveTargetOutcome(
  gateway: IndexReader,
  ledger: readonly OutcomeLedgerEntry[],
  results: readonly ResultRow[],
  freshIndex?: ProcessIndex | null,
): Promise<ResultRow[]> {
  return notPorted('unwind');
}

/**
 * Both lists against one sweep, and no sweep at all when nothing is outstanding. Port of
 * `Resolve-RunOutcome`.
 */
export function resolveRunOutcome(
  gateway: IndexReader,
  collateral: readonly CollateralChange[],
  ledger: readonly OutcomeLedgerEntry[],
  results: readonly ResultRow[],
  options?: { onEvent?: DeleteEventSink | undefined },
): Promise<ResultRow[]> {
  return notPorted('unwind');
}
