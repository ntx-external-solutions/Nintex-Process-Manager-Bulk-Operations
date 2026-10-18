/**
 * The run's record of every participant's state before it touched anything, and the
 * plan file that carries it.
 *
 * The ledger has to exist before the first mutation. Without it, a run that dies between
 * restoring processes and re-archiving them leaves them active, in the wrong group, with
 * no record of where they belong. The Hold phase moves archived targets, so any index
 * read after it reports the moved state; the pre-Hold snapshot is the authority for
 * `wasArchived` and the original group from then on.
 *
 * The script writes the plan to `Delete_Plan_*.json` and reads it back to resume. Here
 * the working ledger lives in IndexedDB and the plan is a file the operator downloads and
 * can upload again, so `Export-`/`Import-DependencyPlan` become serialize and parse.
 */

import type { DependencyClaim, HolderWorkItem, Reconciliation } from './claims.ts';
import type { CollateralChange } from './collateral.ts';
import type { DeleteIndex, ProcessModel } from './model.ts';
import { notPorted } from './phases.ts';
import type { ReferenceSite } from './references.ts';
import type { IndexEntry } from '../tenant/state.ts';

/** One process's state as the plan found it. Port of `New-ProcessLedgerEntry`'s object. */
export interface LedgerEntry {
  uniqueId: string;
  name: string;
  wasArchived: boolean;
  /** Empty when unknown: the listing gives a numeric group id only. */
  originalGroupUniqueId: string;
  originalGroupId: number | null;
  /** False when the home group was deleted, so the process cannot be restored to it. */
  originalGroupExists: boolean;
  restoredByThisRun: boolean;
  restoredToGroupId: number | null;
  denormalized: boolean;
  deleted: boolean;
}

export interface LedgerEntryInput {
  uniqueId: string;
  name: string;
  wasArchived: boolean;
  originalGroupUniqueId: string;
  originalGroupId: number | null;
  originalGroupExists?: boolean;
}

/** Port of `New-ProcessLedgerEntry`. Progress flags start false; the group is assumed to exist unless told. */
export function newLedgerEntry(input: LedgerEntryInput): LedgerEntry {
  return notPorted('hold');
}

/**
 * From a fetched model. `StateId` 1 is active and anything else archived; the `State`
 * label is the fallback when there is no id. Port of `New-ProcessLedgerEntryFromModel`.
 */
export function ledgerEntryFromModel(model: ProcessModel): LedgerEntry {
  return notPorted('hold');
}

/** A target's state before the Hold phase. Port of `New-ProcessStateSnapshot`'s rows. */
export interface ProcessSnapshot {
  uniqueId: string;
  name: string;
  numericId: number | null;
  wasArchived: boolean;
  isArchivedNow: boolean;
  originalGroupId: number | null;
  originalGroupUniqueId: string;
  originalGroupExists: boolean;
  restoredByThisRun: boolean;
}

/** Keyed by lowercased process id. Mutable: the Hold phase marks what it restored. */
export type ProcessStateSnapshot = Map<string, ProcessSnapshot>;

/**
 * Archive state and home group for the given processes, before anything is mutated.
 * Ids missing from the index are left out. `groupUniqueIds` maps a numeric group id (as
 * a string) to its UniqueId, which the listing does not give. Port of
 * `New-ProcessStateSnapshot`.
 */
export function processStateSnapshot(
  index: DeleteIndex,
  uniqueIds: readonly string[],
  groupUniqueIds?: ReadonlyMap<string, string>,
): ProcessStateSnapshot {
  return notPorted('hold');
}

/**
 * Archive state and group for every process in the tenant, the baseline the collateral
 * checks diff against. Port of `New-TenantStateSnapshot`.
 *
 * The app's archive run uses the fresh `ProcessIndex` as its baseline directly
 * (archive/run.ts), which is what this amounts to: a copy keyed the same way, so a later
 * refresh of the index cannot change the baseline under it. A null index is an empty
 * baseline.
 */
export function tenantStateSnapshot<E extends IndexEntry>(index: ReadonlyMap<string, E> | null): Map<string, E> {
  return notPorted('checkpoints');
}

/** Records that the Hold phase restored this process, which the unwind keys off. Port of `Set-ProcessSnapshotRestored`. */
export function markSnapshotRestored(
  snapshot: ProcessStateSnapshot | null,
  uniqueId: string,
  holdingGroupId?: number | null,
): void {
  return notPorted('hold');
}

export type LedgerRole = 'Target' | 'Holder';

/** A ledger row as the plan persists it and the unwind reads it. The model is never persisted. */
export interface PlanLedgerRow {
  uniqueId: string;
  name: string;
  numericId: number | null;
  wasArchived: boolean;
  originalGroupUniqueId: string;
  originalGroupId: number | null;
  originalGroupExists: boolean;
  restoredByThisRun: boolean;
  role: LedgerRole;
  /** Restored into the holding group, because its own group is gone. */
  parkedInHoldingGroup: boolean;
  denormalized: boolean;
  deleted: boolean;
}

/** A participant in the working ledger, with the model it was read with. */
export interface ParticipantRecord extends PlanLedgerRow {
  model: ProcessModel | null;
}

/** Snapshot rows as plan ledger rows, all `Target`, so the plan can be saved before the first mutation. Port of `ConvertTo-PlanLedgerEntry`. */
export function snapshotToPlanLedger(snapshot: ProcessStateSnapshot | null): PlanLedgerRow[] {
  return notPorted('hold');
}

/** The working ledger as plan rows, models dropped. Port of `ConvertTo-PlanLedgerRow`. */
export function ledgerToPlanRows(ledger: ReadonlyMap<string, ParticipantRecord>): PlanLedgerRow[] {
  return notPorted('hold');
}

/**
 * The plan ledger with the pre-Hold snapshot folded in: the snapshot wins for the
 * targets it covers, a `deleted` or `denormalized` already recorded is kept, and every
 * holder the snapshot does not cover is kept. Replacing the ledger with the snapshot is
 * what once lost eleven restored holders. Port of `Merge-PlanLedgerEntry`.
 */
export function mergePlanLedger(
  ledger: readonly PlanLedgerRow[],
  snapshot: ProcessStateSnapshot | null,
): PlanLedgerRow[] {
  return notPorted('hold');
}

export type PlanStatus = 'Draft' | 'Planned' | 'PlannedIncomplete' | 'Blocked';

/** A participant the plan could not read at all, so any reference it holds stays. */
export interface UnresolvedParticipant {
  uniqueId: string;
  name: string;
  reason: string;
}

/** An archived holder that could not be restored anywhere, which blocks the plan. */
export interface OrphanedHolder {
  uniqueId: string;
  name: string;
  originalGroupId: number | null;
  reason: string;
}

/** The plan file. Port of `New-DependencyPlan`'s object. */
export interface DependencyPlan {
  schemaVersion: 1;
  /** ISO 8601, UTC. */
  createdUtc: string;
  siteUrl: string;
  status: PlanStatus;
  targetUniqueIds: string[];
  ledger: PlanLedgerRow[];
  claims: DependencyClaim[];
  sites: ReferenceSite[];
  workItems: HolderWorkItem[];
  reconciliation: Reconciliation[];
  /** Targets whose dependency check failed after a retry. */
  failedTargets: string[];
  unresolved: UnresolvedParticipant[];
  orphanedHolders: OrphanedHolder[];
  collateral: CollateralChange[];
  log: string[];
}

/** An empty `Draft` plan. Port of `New-DependencyPlan`. */
export function newDependencyPlan(
  siteUrl: string,
  targetUniqueIds: readonly string[],
  now?: Date,
): DependencyPlan {
  return notPorted('hold');
}

/** The plan file's text. Port of `Export-DependencyPlan`, minus the disk. */
export function serializePlan(plan: DependencyPlan): string {
  return notPorted('hold');
}

/**
 * A plan read back from an uploaded file, or null when the text is not one, as the
 * script returns null for a plan that is not there. Port of `Import-DependencyPlan`.
 */
export function parsePlan(text: string): DependencyPlan | null {
  return notPorted('hold');
}
