/**
 * Planning a delete: who references the targets, where, and what the run must restore
 * to find out. Port of `New-ProcessDeletePlan` and the reads it is built on.
 *
 * The order is measured behaviour, not preference (API_ARCHITECTURE.md, "Dependency
 * Checking APIs"). Archiving hides Input and Output rows naming the archived process, so
 * discovery run against an archived participant under-reports. Participants are restored
 * before discovery is trusted, and discovery is run again afterwards. A preview may not
 * restore anything, so its plan is marked incomplete rather than passed off as whole.
 *
 * Planning reads; the only writes are those restores, through `restoreProcess`.
 */

import type { DependencyClaim } from './claims.ts';
import type { DeleteEventSink } from './events.ts';
import type { DeleteGateway } from './gateway.ts';
import type { DependencyPlan, FailedTarget, ProcessStateSnapshot } from './ledger.ts';
import type { DeleteIndex, DeleteIndexEntry, ProcessModel } from './model.ts';
import { notPorted } from './phases.ts';
import type { ReferenceSite } from './references.ts';

/**
 * One dependency check, never a bare array. The script carries success in a field because
 * an empty array unrolls to null on return in PowerShell, which read 392 dependency-free
 * targets as failed checks. The field is kept: "answered with nothing" and "did not
 * answer" are different results.
 */
export interface DependencyCheck {
  /** The endpoint answered, whatever it answered. */
  success: boolean;
  /** Empty, never null, when there are no dependencies. */
  claims: DependencyClaim[];
  status: number;
  error: string | null;
}

/** `CheckProcessDependencies` for one process. Port of `Get-ProcessDependencyClaim`. */
export function checkProcessDependencies(
  gateway: Pick<DeleteGateway, 'checkDependencies'>,
  processUniqueId: string,
): Promise<DependencyCheck> {
  return notPorted('discovery');
}

/**
 * Both listings into the engine's wider index entry: the listing's numeric `id`, and
 * whether the row reported `groupExists` at all. Active first, then archived. Port of
 * `Get-NpmProcessIndex`.
 */
export function loadDeleteIndex(
  gateway: Pick<DeleteGateway, 'listProcesses'>,
): Promise<Map<string, DeleteIndexEntry>> {
  return notPorted('discovery');
}

/**
 * Models read during planning, keyed by lowercased id. Planning reads the same process
 * several times (each pass, the blind-spot sweep, the ledger), which on a 497-target run
 * was most of eleven minutes. Passed explicitly rather than held in a module global, and
 * never across a write: a cached model that outlives a save is a corrupted save waiting
 * to happen. Port of `Enable-NpmModelCache` and friends.
 */
export type ModelCache = Map<string, ProcessModel>;

/**
 * A model from the endpoint matching the process's state, the batch read for archived and
 * the active read otherwise; null when it cannot be read. The wrong endpoint returns
 * nothing, which a caller would read as "no references". Port of
 * `Get-NpmProcessModelAnyState`.
 */
export function readModelAnyState(
  gateway: Pick<DeleteGateway, 'readModel' | 'readArchivedModels'>,
  processUniqueId: string,
  isArchived: boolean,
  cache?: ModelCache | null,
): Promise<ProcessModel | null> {
  return notPorted('discovery');
}

export interface HiddenReferenceScanOptions {
  /** Also read every active process, one call each. Off by default: 700+ calls on a typical tenant. */
  includeActive?: boolean | undefined;
  batchSize?: number | undefined;
  cache?: ModelCache | null | undefined;
}

/**
 * Input and Output references to the targets held by archived processes (and active ones
 * when asked), which no dependency response ever names: finding them would need a
 * restore, and knowing to restore would need finding them. Targets are never read. Port
 * of `Find-HiddenInputOutputReference`.
 */
export function findHiddenInputOutputReferences(
  gateway: Pick<DeleteGateway, 'readModel' | 'readArchivedModels'>,
  targetUniqueIds: readonly string[],
  index: DeleteIndex,
  options?: HiddenReferenceScanOptions,
): Promise<ReferenceSite[]> {
  return notPorted('discovery');
}

export interface DeletePlanOptions {
  siteUrl: string;
  targetUniqueIds: readonly string[];
  /** Refreshed after the Hold phase, so it reports held targets as active in the holding group. */
  index: DeleteIndex;
  /** Where a holder whose group is gone is restored to be read. Null: nowhere, so no restores. */
  holdingGroupId?: number | null | undefined;
  /** False for a preview, which must not change the tenant. Default true. */
  allowRestore?: boolean | undefined;
  scanActiveForInputOutput?: boolean | undefined;
  /** Default 3. */
  maxPasses?: number | undefined;
  /**
   * Asked when targets still fail their dependency check after one retry. True excludes
   * them and plans the rest; false, or no callback, blocks the plan. A failed check is
   * not an empty dependency list.
   */
  onFailedTargets?: ((failed: readonly FailedTarget[]) => boolean | Promise<boolean>) | undefined;
  /** The state before the Hold phase moved anything; wins over the index wherever it has an entry. */
  preHoldSnapshot?: ProcessStateSnapshot | null | undefined;
  cache?: ModelCache | null | undefined;
  onEvent?: DeleteEventSink | undefined;
  now?: Date | undefined;
}

/**
 * Discovers, locates and reconciles everything that references the targets, restoring
 * archived participants so their hidden edges show: in place when their group exists,
 * into the holding group when it does not. A holder that cannot be read anywhere blocks
 * the plan, and the blocked plan still carries the ledger, because it is the only record
 * of what was restored. Port of `New-ProcessDeletePlan`.
 */
export function buildDeletePlan(gateway: DeleteGateway, options: DeletePlanOptions): Promise<DependencyPlan> {
  return notPorted('discovery');
}

/**
 * The best name for an id: the plan ledger, then the index, then the name the dependency
 * payload carried, which is the only one a process no listing returns ever gets. Port of
 * `Resolve-PlanProcessName`.
 */
export function planProcessName(plan: DependencyPlan, index: DeleteIndex | null, uniqueId: string): string {
  return notPorted('discovery');
}

/**
 * The plan preview as the operator reads it. A preview restores nothing, so it says so
 * rather than claiming restores it never made. Port of `Show-ProcessDeletePlan`'s text.
 */
export function planSummaryLines(plan: DependencyPlan, index: DeleteIndex | null): string[] {
  return notPorted('discovery');
}
