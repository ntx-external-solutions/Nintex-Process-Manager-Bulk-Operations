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
import type { GroupRef } from './gateway.ts';
import { nodeInt, nodeString, type DeleteIndex, type ProcessModel } from './model.ts';
import type { ReferenceSite } from './references.ts';
import { readGroupExists } from '../select/archived.ts';
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
  return {
    uniqueId: input.uniqueId,
    name: input.name,
    wasArchived: input.wasArchived,
    originalGroupUniqueId: input.originalGroupUniqueId,
    originalGroupId: input.originalGroupId,
    originalGroupExists: input.originalGroupExists ?? true,
    restoredByThisRun: false,
    restoredToGroupId: null,
    denormalized: false,
    deleted: false,
  };
}

/**
 * From a fetched model. `StateId` 1 is active and anything else archived; the `State`
 * label is the fallback when there is no id. Port of `New-ProcessLedgerEntryFromModel`.
 */
export function ledgerEntryFromModel(model: ProcessModel): LedgerEntry {
  const stateId = nodeInt(model, 'StateId');
  const state = nodeString(model, 'State');
  // Trust the numeric id and fall back to the label.
  const wasArchived = stateId !== null ? stateId !== 1 : state === 'Archived';
  return newLedgerEntry({
    uniqueId: nodeString(model, 'UniqueId'),
    name: nodeString(model, 'Name'),
    wasArchived,
    originalGroupUniqueId: nodeString(model, 'GroupUniqueId'),
    originalGroupId: nodeInt(model, 'GroupId'),
  });
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
  const snapshot: ProcessStateSnapshot = new Map();
  for (const id of uniqueIds) {
    if (!id) continue;
    const entry = index.get(id.toLowerCase());
    if (!entry) continue;
    // The map first, as the script resolves it; then the listing's own group UniqueId,
    // which the app's index carries and the script's did not.
    const mapped = entry.groupId !== null ? groupUniqueIds?.get(String(entry.groupId)) : undefined;
    snapshot.set(entry.uniqueId.toLowerCase(), {
      uniqueId: entry.uniqueId,
      name: entry.name,
      numericId: entry.numericId,
      wasArchived: entry.isArchived,
      isArchivedNow: entry.isArchived,
      originalGroupId: entry.groupId,
      originalGroupUniqueId: mapped ?? entry.groupUniqueId ?? '',
      originalGroupExists: readGroupExists(entry.groupExists).exists,
      restoredByThisRun: false,
    });
  }
  return snapshot;
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
  const baseline = new Map<string, E>();
  if (!index) return baseline;
  for (const entry of index.values()) {
    if (!entry.uniqueId) continue;
    // A copy of each entry too: a later read that patched an entry in place would
    // otherwise change the before-state it is compared against.
    baseline.set(entry.uniqueId.toLowerCase(), { ...entry, groupExists: readGroupExists(entry.groupExists).exists });
  }
  return baseline;
}

/** Records that the Hold phase restored this process, which the unwind keys off. Port of `Set-ProcessSnapshotRestored`. */
export function markSnapshotRestored(
  snapshot: ProcessStateSnapshot | null,
  uniqueId: string,
  // The script takes the holding group id and never uses it; kept for the same signature.
  _holdingGroupId?: number | null,
): void {
  const row = snapshot?.get(uniqueId.toLowerCase());
  if (!row) return;
  row.restoredByThisRun = true;
  row.isArchivedNow = false;
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
  return [...(snapshot?.values() ?? [])].map((row) => ({
    uniqueId: row.uniqueId,
    name: row.name,
    numericId: row.numericId,
    wasArchived: row.wasArchived,
    originalGroupUniqueId: row.originalGroupUniqueId,
    originalGroupId: row.originalGroupId,
    originalGroupExists: readGroupExists(row.originalGroupExists).exists,
    restoredByThisRun: row.restoredByThisRun,
    // A snapshot only covers the run's own targets: holders are not known until the plan is built.
    role: 'Target',
    parkedInHoldingGroup: false,
    denormalized: false,
    deleted: false,
  }));
}

/** The working ledger as plan rows, models dropped. Port of `ConvertTo-PlanLedgerRow`. */
export function ledgerToPlanRows(ledger: ReadonlyMap<string, ParticipantRecord>): PlanLedgerRow[] {
  // Every early return of the planner is a blocked plan, and a blocked plan is when the
  // caller most needs to know what the run un-archived, so this is used on every exit.
  return [...ledger.values()].map((record) => ({
    uniqueId: record.uniqueId,
    name: record.name,
    numericId: record.numericId,
    wasArchived: record.wasArchived,
    originalGroupUniqueId: record.originalGroupUniqueId,
    originalGroupId: record.originalGroupId,
    originalGroupExists: readGroupExists(record.originalGroupExists).exists,
    restoredByThisRun: record.restoredByThisRun,
    role: record.role || 'Target',
    parkedInHoldingGroup: record.parkedInHoldingGroup === true,
    denormalized: record.denormalized,
    deleted: record.deleted,
  }));
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
  const existing = new Map(ledger.filter((r) => r.uniqueId).map((r) => [r.uniqueId.toLowerCase(), r]));
  const covered = new Set<string>();
  const merged: PlanLedgerRow[] = [];
  for (const row of snapshotToPlanLedger(snapshot)) {
    if (!row.uniqueId) continue;
    const key = row.uniqueId.toLowerCase();
    covered.add(key);
    // A fresh snapshot row reports both as false; the plan may already know better.
    const prior = existing.get(key);
    merged.push(prior ? { ...row, deleted: row.deleted || prior.deleted, denormalized: row.denormalized || prior.denormalized } : row);
  }
  for (const row of ledger) {
    if (row.uniqueId && !covered.has(row.uniqueId.toLowerCase())) merged.push(row);
  }
  return merged;
}

/**
 * The planner writes the first four. The orchestrator writes the rest over the same
 * plan: `Holding` on the pre-mutation plan, an `Aborted*` when it stops before deleting,
 * `Completed` at the end (`Invoke-BulkDeleteProcesses`).
 */
export type PlanStatus =
  | 'Draft'
  | 'Planned'
  | 'PlannedIncomplete'
  | 'Blocked'
  | 'Holding'
  | 'AbortedCollateral'
  | 'AbortedNoHeldTargets'
  | 'Completed';

/** A target whose dependency check still failed after one retry. */
export interface FailedTarget {
  uniqueId: string;
  /** The failing call's HTTP status, 0 when there was no response. */
  status: number;
  error: string | null;
}

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

/** A process a read was meant to cover and did not, with the failing call's answer. */
export interface UnreadProcess {
  uniqueId: string;
  /** From the index; empty when it has none. */
  name: string;
  /** 0 when there was no response. */
  status: number;
  error: string;
}

/**
 * A holder with an open draft over a published version, as planning read it. Removing its
 * references would publish the draft, so the run refuses it unless the operator ticks it,
 * and the targets it holds are left out of the delete (Cowork's review of W5 phase 5).
 */
export interface DraftHolder {
  holderUniqueId: string;
  name: string;
  /** The draft's version, for example 2.1. */
  version: string;
  /** The targets it holds a reference to, which an unticked holder keeps from deletion. */
  targetsBlocked: string[];
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
  /** Targets whose dependency check failed after a retry, with why, for the results rows. */
  failedTargets: FailedTarget[];
  unresolved: UnresolvedParticipant[];
  orphanedHolders: OrphanedHolder[];
  collateral: CollateralChange[];
  log: string[];
  /**
   * The holding group, once the run has made one. The script only wrote it into the log;
   * a plan uploaded to finish an interrupted run needs it to remove the group.
   */
  holdingGroup?: GroupRef | null;
  /**
   * Processes the archive-wide Input/Output scan could not read. Absent in a plan file
   * from before it was recorded.
   */
  unreadByScan?: UnreadProcess[];
  /** Why a `PlannedIncomplete` plan is incomplete, one sentence each. Absent: a preview. */
  incompleteReasons?: string[];
  /**
   * Holders with an open draft when the plan was read. The run decides again from its own
   * read; this is what the preview asks the operator about. Absent in older plan files.
   */
  draftHolders?: DraftHolder[];
}

/** An empty `Draft` plan. Port of `New-DependencyPlan`. */
export function newDependencyPlan(
  siteUrl: string,
  targetUniqueIds: readonly string[],
  now: Date = new Date(),
): DependencyPlan {
  return {
    schemaVersion: 1,
    createdUtc: now.toISOString(),
    siteUrl,
    status: 'Draft',
    targetUniqueIds: [...targetUniqueIds],
    ledger: [],
    claims: [],
    sites: [],
    workItems: [],
    reconciliation: [],
    failedTargets: [],
    unresolved: [],
    orphanedHolders: [],
    collateral: [],
    log: [],
  };
}

/** The plan file's text. Port of `Export-DependencyPlan`, minus the disk. */
export function serializePlan(plan: DependencyPlan): string {
  return JSON.stringify(plan, null, 2);
}

/**
 * A plan read back from an uploaded file, or null when the text is not one, as the
 * script returns null for a plan that is not there. Port of `Import-DependencyPlan`.
 */
export function parsePlan(text: string): DependencyPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const plan = parsed as Partial<DependencyPlan>;
  // Enough to know it is one of ours: a later phase resumes from it, and resuming from
  // something else would act on whatever ids it happened to hold.
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.targetUniqueIds) || !Array.isArray(plan.ledger)) return null;
  return parsed as DependencyPlan;
}
