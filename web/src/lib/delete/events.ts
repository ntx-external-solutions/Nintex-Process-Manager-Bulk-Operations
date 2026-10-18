/**
 * What a delete run tells the operator as it goes.
 *
 * The script says these things on the console, and its tests read the console to check
 * both that they are said and when: an orphan warning that arrives after the first
 * restore is a warning nobody could act on. Here they are typed events, in the order the
 * run raises them, so the screen can show them and a test can check the order.
 */

import type { CollateralChange, VariationWarning } from './collateral.ts';
import type { GroupExistsCoverage, OrphanedGroupProcess } from './groups.ts';

/** The script's `=== ... ===` banners, in run order. */
export type DeleteStage =
  | 'gathering'
  | 'snapshot'
  | 'holding-group'
  | 'checking-collateral'
  | 'building-plan'
  | 'removing-references'
  | 'verifying'
  | 'archiving-targets'
  | 'deleting-targets'
  | 'checking-collateral-after-delete'
  | 'returning-processes'
  | 'reversing-collateral'
  | 'cleanup'
  | 'rechecking';

export type DeleteEvent =
  | { kind: 'stage'; stage: DeleteStage }
  /** A CSV that parsed but had no column an id is read from (`Show-NpmCsvIdColumnMiss`). */
  | { kind: 'csvNoIdColumn'; rowCount: number; headers: string[]; accepted: readonly string[] }
  | { kind: 'noTargets'; reason: string }
  /**
   * The run stopped short of deleting, and why. What follows is the unwind. The script
   * said this in red on the console; the page shows it as the run's outcome.
   */
  | { kind: 'stopped'; reason: string }
  /** `Show-VariationWarning`, before the first mutation. */
  | { kind: 'variationWarning'; warning: VariationWarning }
  /** `Show-OrphanedGroupWarning`: targets that can be deleted but not sent home if the run stops. */
  | { kind: 'orphanedTargets'; orphans: OrphanedGroupProcess[]; totalTargets: number; holdingGroupName: string }
  /** `Show-GroupExistsCoverage`: whether zero orphans means none, or none findable. */
  | { kind: 'groupExistsCoverage'; coverage: GroupExistsCoverage }
  /** `Show-CollateralDamage`: the full list, before any decision is taken over it. */
  | { kind: 'collateral'; phase: string; collateral: CollateralChange[] }
  /** How the gate was answered, raised after the list it answers. */
  | { kind: 'collateralDecision'; phase: string; accepted: boolean; authority: string | null; count: number }
  /** A holder whose group is gone, restored into the holding group so it can be read. */
  | { kind: 'holderHeld'; uniqueId: string; name: string; originalGroupId: number | null }
  /**
   * How far a long phase has got. The script printed a counter as well as a progress bar,
   * because a phase that says nothing for eleven minutes looks like a hang.
   */
  | { kind: 'progress'; label: string; done: number; total: number }
  /** A line the plan log also records, raised as it is written so the screen can show it. */
  | { kind: 'log'; line: string }
  /** The relocation probe answered for this run (`Move-NpmProcessToGroup`). */
  | { kind: 'relocationProbe'; relocatesActive: boolean };

export type DeleteEventSink = (event: DeleteEvent) => void;
