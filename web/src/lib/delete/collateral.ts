/**
 * What the run changed without being asked to, and what can be put back.
 *
 * A variation is its own record in its own group, and acting on one can act on its
 * master. Nothing in a model or a list entry says so, so the run has two handles: the
 * name heuristic and `variationSetData` before the first write (archive/plan.ts), and a
 * before/after diff of the whole tenant after each mutating phase (tenant/state.ts).
 * This module adds the delete engine's parts: the warning, the gate's acceptance rows,
 * the on-screen list and the reversal.
 */

import type { ResultRow } from '../exec/report.ts';
import type { VariationMatch } from '../archive/plan.ts';
import type { Collateral } from '../tenant/state.ts';
import { notPorted } from './phases.ts';

/**
 * DIFFERS: `Compare-TenantState` also records `OriginalGroupExists` on every row, so a
 * reversal knows the group it would restore into is gone. `tenant/state.ts`'s
 * `Collateral` has no such field. The checkpoints phase has to carry it through.
 */
export interface CollateralChange extends Collateral {
  originalGroupExists: boolean;
}

/**
 * DIFFERS: `Find-VariationMaster` also returns `BaseName` and `TargetGroupId`.
 * `findVariationMasters` (archive/plan.ts) returns neither, and the warning's ordering
 * needs the target's group to put a master in the same group first.
 */
export interface VariationMasterHit extends VariationMatch {
  baseName: string;
  targetGroupId: number | null;
}

export interface VariationWarningMaster extends VariationMasterHit {
  /** Active, so this run can archive it. Only these carry the risk. */
  atRisk: boolean;
}

export interface VariationWarningTarget {
  targetUniqueId: string;
  targetName: string;
  /** At-risk (active) first, then same group as the target, then by name. */
  masters: VariationWarningMaster[];
}

/** One row per target/master pair counts pairs; the warning counts targets and masters separately. */
export interface VariationWarning {
  targetCount: number;
  masterCount: number;
  targets: VariationWarningTarget[];
}

/**
 * The counting and ordering of `Show-VariationWarning`, without the printing. Null when
 * there is nothing to warn about.
 */
export function variationWarning(matches: readonly VariationMasterHit[]): VariationWarning | null {
  return notPorted('checkpoints');
}

/**
 * The collateral list as the operator reads it: one entry per process, its name or
 * `UNKNOWN_NAME` (never the id twice), its id, and what happened to it. Port of
 * `Show-CollateralDamage`'s text.
 */
export function collateralLines(collateral: readonly CollateralChange[], phase?: string): string[] {
  return notPorted('checkpoints');
}

/**
 * One `Collateral`/`Accepted` results row per change an operator authorised at the gate,
 * so the file records a decision rather than a fault. Port of `New-CollateralAcceptanceRow`.
 */
export function collateralAcceptanceRows(
  collateral: readonly CollateralChange[],
  phase?: string,
  authority?: string,
): ResultRow[] {
  return notPorted('checkpoints');
}

/** The two calls a reversal can make. Each reports rather than throws. */
export interface CollateralGateway {
  restore(
    uniqueId: string,
    groupId: number | null,
    destinationGroupExists: boolean,
  ): Promise<{ ok: boolean; statusCode: number | null }>;
  archive(uniqueId: string, comment: string): Promise<{ ok: boolean; message: string; statusCode: number | null }>;
}

/**
 * Puts back what it can prove: an archived master is restored into its own group (if it
 * still exists), an un-archived one is re-archived. A move, a disappearance and a
 * process with no before-state are reported, never guessed at. One `ReverseCollateral`
 * row per change. Port of `Restore-CollateralState`.
 */
export function restoreCollateral(
  gateway: CollateralGateway,
  collateral: readonly CollateralChange[],
  options?: { approvalsEnabled?: boolean },
): Promise<ResultRow[]> {
  return notPorted('checkpoints');
}
