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

import { failureOf } from '../archive/outcome.ts';
import { defaultIsFatal } from '../exec/runner.ts';
import { readGroupExists } from '../select/archived.ts';
import { ACTIVE_LIST_TYPE, ARCHIVED_LIST_TYPE, INDEX_PAGE_SIZE } from '../tenant/state.ts';
import {
  dependencyCandidates,
  groupSitesByHolder,
  parseDependencyResponse,
  reconcileDependencies,
  reconciliationGate,
  type DependencyClaim,
  type Reconciliation,
} from './claims.ts';
import type { DeleteEventSink } from './events.ts';
import { restoreProcess } from './executor.ts';
import { ARCHIVED_BATCH_SIZE, type DeleteGateway } from './gateway.ts';
import {
  ledgerToPlanRows,
  newDependencyPlan,
  type DependencyPlan,
  type FailedTarget,
  type OrphanedHolder,
  type ParticipantRecord,
  type ProcessStateSnapshot,
  type UnreadProcess,
} from './ledger.ts';
import { nodeArray, nodeInt, nodeString, nodeValue, type DeleteIndex, type DeleteIndexEntry, type ProcessModel } from './model.ts';
import { resolveClaimName } from './names.ts';
import { findInputOutputReferenceSites, findProcessReferenceSites, type ReferenceSite } from './references.ts';

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

/** A dead session ends planning; anything else is that one read failing. */
type FatalCheck = (error: unknown) => string | null;

/** `CheckProcessDependencies` for one process. Port of `Get-ProcessDependencyClaim`. */
export async function checkProcessDependencies(
  gateway: Pick<DeleteGateway, 'checkDependencies'>,
  processUniqueId: string,
  isFatal: FatalCheck = defaultIsFatal,
): Promise<DependencyCheck> {
  try {
    const response = await gateway.checkDependencies(processUniqueId);
    return { success: true, claims: parseDependencyResponse(response, processUniqueId), status: 200, error: null };
  } catch (error) {
    if (isFatal(error)) throw error;
    const failure = failureOf(error);
    return { success: false, claims: [], status: failure.status, error: failure.detail ?? failure.error };
  }
}

/**
 * Both listings into the engine's wider index entry: the listing's numeric `id`, and
 * whether the row reported `groupExists` at all. Active first, then archived. Port of
 * `Get-NpmProcessIndex`.
 */
export async function loadDeleteIndex(
  gateway: Pick<DeleteGateway, 'listProcesses'>,
  options: { maxPages?: number; onProgress?: (loaded: number) => void } = {},
): Promise<Map<string, DeleteIndexEntry>> {
  const index = new Map<string, DeleteIndexEntry>();
  const maxPages = options.maxPages ?? 500;

  for (const listType of [ACTIVE_LIST_TYPE, ARCHIVED_LIST_TYPE]) {
    for (let page = 1; page <= maxPages; page++) {
      const items = nodeArray(await gateway.listProcesses(page, listType), 'items');
      for (const item of items) {
        const uniqueId = nodeString(item, 'processUniqueId');
        if (!uniqueId) continue;
        const flag = readGroupExists(nodeValue(item, 'groupExists'));
        index.set(uniqueId.toLowerCase(), {
          uniqueId,
          // The script reads `id`; the typed listing calls it `processId`.
          numericId: nodeInt(item, 'id') ?? nodeInt(item, 'processId'),
          name: nodeString(item, 'processName'),
          isArchived: listType === ARCHIVED_LIST_TYPE,
          groupId: nodeInt(item, 'groupId'),
          groupUniqueId: nodeString(item, 'groupUniqueId') || null,
          groupName: nodeString(item, 'groupName'),
          groupExists: flag.exists,
          // Absent and false are not the same claim: control flow treats absence as "the
          // group is there", but reporting has to be able to say the listing never answered.
          groupExistsReported: flag.reported,
        });
      }
      options.onProgress?.(index.size);
      if (items.length < INDEX_PAGE_SIZE) break;
    }
  }
  return index;
}

/**
 * Models read during planning, keyed by lowercased id. Planning reads the same process
 * several times (each pass, the blind-spot sweep, the ledger), which on a 497-target run
 * was most of eleven minutes. Passed explicitly rather than held in a module global, and
 * never across a write: a cached model that outlives a save is a corrupted save waiting
 * to happen. Port of `Enable-NpmModelCache` and friends.
 */
export type ModelCache = Map<string, ProcessModel>;

async function readActive(
  gateway: Pick<DeleteGateway, 'readModel' | 'readArchivedModels'>,
  processUniqueId: string,
  isFatal: FatalCheck,
): Promise<ProcessModel | null> {
  try {
    const read = await gateway.readModel(processUniqueId);
    if (read.kind === 'model') return read.model;
  } catch (error) {
    if (isFatal(error)) throw error;
    return null;
  }
  // The active read says it is archived (200, no model). The script took that envelope
  // for the model and walked an empty process; the batch read is where an archived one is.
  return readArchived(gateway, processUniqueId, isFatal);
}

async function readArchived(
  gateway: Pick<DeleteGateway, 'readArchivedModels'>,
  processUniqueId: string,
  isFatal: FatalCheck,
): Promise<ProcessModel | null> {
  try {
    return (await gateway.readArchivedModels([processUniqueId]))[0] ?? null;
  } catch (error) {
    if (isFatal(error)) throw error;
    return null;
  }
}

/**
 * A model from the endpoint matching the process's state, the batch read for archived and
 * the active read otherwise; null when it cannot be read. The wrong endpoint returns
 * nothing, which a caller would read as "no references". Port of
 * `Get-NpmProcessModelAnyState`.
 */
export async function readModelAnyState(
  gateway: Pick<DeleteGateway, 'readModel' | 'readArchivedModels'>,
  processUniqueId: string,
  isArchived: boolean,
  cache?: ModelCache | null,
  isFatal: FatalCheck = defaultIsFatal,
): Promise<ProcessModel | null> {
  const key = processUniqueId.toLowerCase();
  const cached = cache?.get(key);
  if (cached) return cached;
  const model = isArchived ? await readArchived(gateway, processUniqueId, isFatal) : await readActive(gateway, processUniqueId, isFatal);
  if (model && cache) cache.set(key, model);
  return model;
}

export interface HiddenReferenceScanOptions {
  /** Also read every active process, one call each. Off by default: 700+ calls on a typical tenant. */
  includeActive?: boolean | undefined;
  batchSize?: number | undefined;
  cache?: ModelCache | null | undefined;
  isFatal?: FatalCheck | undefined;
  onEvent?: DeleteEventSink | undefined;
}

/** What the Input/Output scan found, and what it could not read. */
export interface HiddenReferenceScan {
  sites: ReferenceSite[];
  /** Processes the scan never read, so any reference they hold is unknown. */
  unread: UnreadProcess[];
}

/**
 * Input and Output references to the targets held by archived processes (and active ones
 * when asked), which no dependency response ever names: finding them would need a
 * restore, and knowing to restore would need finding them. Targets are never read. Port
 * of `Find-HiddenInputOutputReference`.
 *
 * DIFFERS: the script skipped a batch that failed and carried on. With its batch size
 * over the tenant's limit, that was every full batch, and the scan read only the last
 * partial one: 18 of 19 batches lost on the demo tenant (Cowork's live check after W5
 * phase 3). A failed read is now reported, id by id, and the plan is incomplete.
 */
export async function findHiddenInputOutputReferences(
  gateway: Pick<DeleteGateway, 'readModel' | 'readArchivedModels'>,
  targetUniqueIds: readonly string[],
  index: DeleteIndex,
  options: HiddenReferenceScanOptions = {},
): Promise<HiddenReferenceScan> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? ARCHIVED_BATCH_SIZE, ARCHIVED_BATCH_SIZE));
  const cache = options.cache ?? null;
  const sites: ReferenceSite[] = [];
  const unread: UnreadProcess[] = [];
  const unreadEntry = (id: string, status: number, error: string): UnreadProcess => ({
    uniqueId: id,
    name: index.get(id.toLowerCase())?.name ?? '',
    status,
    error,
  });

  // A reference a target holds to another target dies with both, and a target is never
  // edited, so reading one here buys nothing.
  const targets = new Set(targetUniqueIds.map((t) => t.toLowerCase()));
  const archivedIds: string[] = [];
  const activeIds: string[] = [];
  for (const entry of index.values()) {
    if (targets.has(entry.uniqueId.toLowerCase())) continue;
    if (entry.isArchived) archivedIds.push(entry.uniqueId);
    else if (options.includeActive) activeIds.push(entry.uniqueId);
  }
  if (archivedIds.length + activeIds.length === 0) return { sites, unread };

  // Cached only on a hit: a holder found here is read again for the ledger, and keeping
  // the rest would hold hundreds of models to serve no reads at all.
  const scan = (model: ProcessModel, id: string) => {
    const found = findInputOutputReferenceSites(model, targetUniqueIds);
    sites.push(...found);
    if (found.length > 0) cache?.set(id.toLowerCase(), model);
  };

  for (const [i, id] of activeIds.entries()) {
    options.onEvent?.({ kind: 'progress', label: 'Input/Output scan: active processes', done: i + 1, total: activeIds.length });
    // The batch endpoint is for archived processes; active ones are read one by one.
    const model = cache?.get(id.toLowerCase()) ?? (await readActive(gateway, id, isFatal));
    if (model) scan(model, id);
    else unread.push(unreadEntry(id, 0, 'could not be read'));
  }

  const toFetch: string[] = [];
  for (const id of archivedIds) {
    const cached = cache?.get(id.toLowerCase());
    if (cached) sites.push(...findInputOutputReferenceSites(cached, targetUniqueIds));
    else toFetch.push(id);
  }
  for (let i = 0; i < toFetch.length; i += batchSize) {
    const chunk = toFetch.slice(i, i + batchSize);
    let models: ProcessModel[] = [];
    try {
      models = await gateway.readArchivedModels(chunk);
    } catch (error) {
      // A dead session still ends the run. Anything else is a batch never read: named, and
      // never passed off as a batch with nothing in it.
      if (isFatal(error)) throw error;
      const failure = failureOf(error);
      for (const id of chunk) unread.push(unreadEntry(id, failure.status, failure.detail ?? failure.error));
    }
    for (const model of models) scan(model, nodeString(model, 'UniqueId'));
    options.onEvent?.({
      kind: 'progress',
      label: 'Input/Output scan: archived processes',
      done: Math.min(i + batchSize, toFetch.length),
      total: toFetch.length,
    });
  }
  return { sites, unread };
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
  isFatal?: FatalCheck | undefined;
  now?: Date | undefined;
}

/**
 * Discovers, locates and reconciles everything that references the targets, restoring
 * archived participants so their hidden edges show: in place when their group exists,
 * into the holding group when it does not. A holder that cannot be read anywhere blocks
 * the plan, and the blocked plan still carries the ledger, because it is the only record
 * of what was restored. Port of `New-ProcessDeletePlan`.
 */
/** What planning calls. Only a real run restores; a dry run's gateway can refuse to. */
export type PlanningGateway = Pick<DeleteGateway, 'listProcesses' | 'checkDependencies' | 'readModel' | 'readArchivedModels' | 'restore'>;

export async function buildDeletePlan(gateway: PlanningGateway, options: DeletePlanOptions): Promise<DependencyPlan> {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const allowRestore = options.allowRestore ?? true;
  const holdingGroupId = options.holdingGroupId ?? null;
  const maxPasses = options.maxPasses ?? 3;
  const cache: ModelCache = options.cache ?? new Map();
  const index = options.index;
  let targetIds = [...options.targetUniqueIds];

  const plan = newDependencyPlan(options.siteUrl, targetIds, options.now);
  const ledger = new Map<string, ParticipantRecord>();
  let allClaims: DependencyClaim[] = [];
  let restoredTotal = 0;
  const log = (line: string) => {
    plan.log.push(line);
    options.onEvent?.({ kind: 'log', line });
  };
  const progress = (label: string, done: number, total: number) => options.onEvent?.({ kind: 'progress', label, done, total });
  const finish = (): DependencyPlan => {
    // Every exit carries the ledger: a blocked plan is exactly when the caller needs to
    // know what the run un-archived.
    plan.ledger = ledgerToPlanRows(ledger);
    return plan;
  };

  // Which entries are the run's own targets. Everything else is a dependency holder, which
  // survives the run and needs a different results row.
  const targetLookupForRole = new Set(targetIds.map((t) => t.toLowerCase()));

  const addLedgerEntry = async (uniqueId: string): Promise<ParticipantRecord | null> => {
    const key = uniqueId.toLowerCase();
    const existing = ledger.get(key);
    if (existing) return existing;

    let entry: Pick<DeleteIndexEntry, 'uniqueId' | 'numericId' | 'name' | 'isArchived' | 'groupId' | 'groupExists'> | null =
      index.get(key) ?? null;

    if (!entry) {
      // Neither listing returned it, yet the dependency API named it. Processes have been
      // seen that both sweeps miss and the batch endpoint still serves, so both reads are
      // tried before giving up, and an unreachable one is said out loud.
      let recovered = await readModelAnyState(gateway, uniqueId, true, cache, isFatal);
      let recoveredArchived = true;
      if (!recovered) {
        recovered = await readModelAnyState(gateway, uniqueId, false, cache, isFatal);
        recoveredArchived = false;
      }
      if (!recovered) {
        const label = resolveClaimName(allClaims, uniqueId);
        plan.unresolved.push({ uniqueId, name: label, reason: 'Absent from both process lists and not fetchable by either endpoint' });
        log(`UNRESOLVED participant ${uniqueId} (${label}): not in the index and not fetchable; any reference it holds will NOT be removed`);
        return null;
      }
      const stateId = nodeInt(recovered, 'StateId');
      if (stateId !== null) recoveredArchived = stateId !== 1;
      entry = {
        uniqueId,
        numericId: nodeInt(recovered, 'Id'),
        name: nodeString(recovered, 'Name'),
        isArchived: recoveredArchived,
        groupId: nodeInt(recovered, 'GroupId'),
        groupExists: true,
      };
      log(`Recovered participant ${uniqueId} (${entry.name}) by direct fetch; it is missing from both process list sweeps`);
    }

    // The pre-Hold snapshot wins wherever it has an entry: the index was refreshed after
    // the Hold phase moved archived targets, and reports their moved state.
    const snap = options.preHoldSnapshot?.get(key) ?? null;
    const isArchivedNow = snap ? snap.isArchivedNow : entry.isArchived;
    const model = await readModelAnyState(gateway, uniqueId, isArchivedNow, cache, isFatal);

    let groupUniqueId = nodeString(model, 'GroupUniqueId');
    let groupId = nodeInt(model, 'GroupId') ?? entry.groupId;
    let wasArchived = entry.isArchived;
    let restoredByThisRun = false;
    let groupExists = entry.groupExists;
    if (snap) {
      wasArchived = snap.wasArchived;
      restoredByThisRun = snap.restoredByThisRun;
      if (snap.originalGroupId !== null) groupId = snap.originalGroupId;
      if (snap.originalGroupUniqueId) groupUniqueId = snap.originalGroupUniqueId;
      // The snapshot names the home group, so it also says whether that group is there.
      groupExists = snap.originalGroupExists;
    }

    const record: ParticipantRecord = {
      uniqueId: entry.uniqueId,
      name: entry.name,
      numericId: entry.numericId,
      wasArchived,
      originalGroupUniqueId: groupUniqueId,
      originalGroupId: groupId,
      originalGroupExists: groupExists,
      restoredByThisRun,
      role: targetLookupForRole.has(key) ? 'Target' : 'Holder',
      parkedInHoldingGroup: false,
      denormalized: false,
      deleted: false,
      model,
    };
    ledger.set(key, record);
    return record;
  };

  // ---- Pass loop: discover, restore, re-discover until the set is stable ----
  for (let pass = 1; pass <= maxPasses; pass++) {
    allClaims = [];
    let failed: string[] = [];

    for (const [i, target] of targetIds.entries()) {
      progress(`Discovery pass ${pass}: checking dependencies`, i + 1, targetIds.length);
      const check = await checkProcessDependencies(gateway, target, isFatal);
      // An empty claims list is a process with no dependencies, which is not a failure.
      if (!check.success) failed.push(target);
      else allClaims.push(...check.claims);
    }

    // One retry before giving up: a transient 5xx should not throw away twenty minutes
    // of discovery a large run has already paid for.
    let stillFailed: FailedTarget[] = [];
    for (const [i, target] of failed.entries()) {
      progress(`Discovery pass ${pass}: retrying failed checks`, i + 1, failed.length);
      const check = await checkProcessDependencies(gateway, target, isFatal);
      if (!check.success) stillFailed.push({ uniqueId: target, status: check.status, error: check.error });
      else allClaims.push(...check.claims);
    }
    failed = [];

    if (stillFailed.length > 0) {
      const names = stillFailed.map((f) => {
        const label = index.get(f.uniqueId.toLowerCase())?.name || f.uniqueId;
        return `${label} (${f.uniqueId}): HTTP ${f.status} ${f.error ?? ''}`.trimEnd();
      });
      const proceed = options.onFailedTargets ? await options.onFailedTargets(stillFailed) : false;
      if (!proceed) {
        // A failed check is NOT an empty dependency list. Proceeding would delete a
        // process whose references were never examined.
        plan.status = 'Blocked';
        plan.failedTargets = stillFailed;
        log(`Dependency check failed for ${stillFailed.length} target(s) after retry: ${names.join('; ')}`);
        return finish();
      }
      // Dropped from the target set outright, so nothing downstream can delete one.
      const excluded = new Set(stillFailed.map((f) => f.uniqueId.toLowerCase()));
      targetIds = targetIds.filter((t) => !excluded.has(t.toLowerCase()));
      plan.targetUniqueIds = [...targetIds];
      plan.failedTargets = stillFailed;
      log(`Excluded ${stillFailed.length} target(s) whose dependency check failed: ${names.join('; ')}`);
      if (targetIds.length === 0) {
        plan.status = 'Blocked';
        log('Every target failed its dependency check; nothing is left to plan');
        return finish();
      }
    }
    stillFailed = [];

    const candidates = dependencyCandidates(allClaims, targetIds);
    for (const [i, candidate] of candidates.entries()) {
      progress(`Discovery pass ${pass}: reading process models`, i + 1, candidates.length);
      await addLedgerEntry(candidate);
    }

    // Restore archived participants so their suppressed Input/Output edges show next pass.
    let restoredThisPass = 0;
    const orphanedHolders: OrphanedHolder[] = [];
    if (allowRestore && holdingGroupId !== null) {
      for (const candidate of candidates) {
        const record = ledger.get(candidate.toLowerCase());
        if (!record || !record.wasArchived || record.restoredByThisRun) continue;

        // In place: holders survive the run, so parking them would strand them.
        let groupId = record.originalGroupId ?? holdingGroupId;
        // A holder whose own group was deleted has nowhere to go back to. It takes the
        // answer orphaned targets already get: held in the holding group, read there, and
        // archived where it sits on the way out (old T2).
        const parked = record.originalGroupId !== null && !record.originalGroupExists;
        if (parked) {
          groupId = holdingGroupId;
          options.onEvent?.({ kind: 'holderHeld', uniqueId: record.uniqueId, name: record.name, originalGroupId: record.originalGroupId });
        }

        const restored = await restoreProcess(gateway, record.uniqueId, groupId, { isFatal });
        if (restored.ok) {
          record.restoredByThisRun = true;
          record.parkedInHoldingGroup = parked;
          // Read again on the next pass: the cached copy is the archived one.
          cache.delete(record.uniqueId.toLowerCase());
          restoredThisPass++;
          restoredTotal++;
          log(
            parked
              ? `Held ${record.uniqueId} (${record.name}) in the holding group for discovery; its own group ${record.originalGroupId} no longer exists`
              : `Restored ${record.uniqueId} (${record.name}) to group ${groupId} for discovery`,
          );
        } else if (parked) {
          // The holding group was the fallback. Refused there too, it cannot be read
          // anywhere, and a target it points at cannot be deleted safely.
          orphanedHolders.push({
            uniqueId: record.uniqueId,
            name: record.name,
            originalGroupId: record.originalGroupId,
            reason: `its group no longer exists and it could not be held in the holding group either (HTTP ${restored.statusCode})`,
          });
        } else {
          log(`FAILED to restore ${record.uniqueId} (${record.name}); its Input/Output edges stay hidden`);
        }
      }
    }

    if (orphanedHolders.length > 0) {
      plan.orphanedHolders = orphanedHolders;
      plan.status = 'Blocked';
      for (const holder of orphanedHolders) {
        log(
          `BLOCKED: dependency holder ${holder.uniqueId} (${holder.name}) is archived and cannot be restored because ${holder.reason} (group ${holder.originalGroupId}). Its Input/Output references cannot be read, so a target it points at cannot be deleted safely.`,
        );
      }
      log('Move these holders into a group that exists, then re-run.');
      return finish();
    }

    if (restoredThisPass === 0) break;
  }

  // ---- The API blind spot: archived Input/Output holders ----
  const freshIndex = restoredTotal > 0 ? await loadDeleteIndex(gateway) : index;
  const scan = await findHiddenInputOutputReferences(gateway, targetIds, freshIndex, {
    includeActive: options.scanActiveForInputOutput,
    cache,
    isFatal,
    onEvent: options.onEvent,
  });
  const blindSites = scan.sites;
  plan.unreadByScan = scan.unread;
  if (scan.unread.length > 0) {
    log(
      `Input/Output scan could not read ${scan.unread.length} process(es); any Input or Output reference they hold to a target is unknown`,
    );
  }
  for (const site of blindSites) {
    if (!ledger.has(site.holderUniqueId.toLowerCase())) {
      await addLedgerEntry(site.holderUniqueId);
      log(`Archive scan found holder ${site.holderUniqueId} that the dependency API never reported`);
    }
  }

  // ---- Locate: walk every participant, both directions ----
  for (const target of targetIds) await addLedgerEntry(target);
  const participants = [...ledger.values()];
  const targetLookup = new Set(targetIds.map((t) => t.toLowerCase()));

  const allSites: ReferenceSite[] = [];
  for (const record of participants) {
    if (!record.model) {
      log(`Could not fetch model for ${record.uniqueId} (${record.name}); its references were not examined`);
      continue;
    }
    if (targetLookup.has(record.uniqueId.toLowerCase())) {
      // Located for reconciliation only: a target is about to be deleted, not edited.
      const others = participants.filter((p) => p.uniqueId !== record.uniqueId).map((p) => p.uniqueId);
      allSites.push(...findProcessReferenceSites(record.model, others));
    } else {
      allSites.push(...findProcessReferenceSites(record.model, targetIds));
    }
  }

  // ---- Filter: self-references and target-held sites are not work ----
  const workSites = allSites.filter(
    (s) =>
      s.holderUniqueId.toLowerCase() !== s.targetUniqueId.toLowerCase() &&
      !targetLookup.has(s.holderUniqueId.toLowerCase()) &&
      targetLookup.has(s.targetUniqueId.toLowerCase()),
  );

  // ---- Reconcile per pair ----
  const reconciliation: Reconciliation[] = [];
  for (const target of targetIds) {
    const related = [
      ...new Map(
        allClaims
          .filter((c) => c.queriedUniqueId.toLowerCase() === target.toLowerCase())
          .map((c) => [c.relatedUniqueId.toLowerCase(), c.relatedUniqueId] as const),
      ).values(),
    ];
    for (const relatedId of related) {
      const record = ledger.get(relatedId.toLowerCase());
      const relatedIsArchived = record ? record.wasArchived && !record.restoredByThisRun : false;
      reconciliation.push(
        ...reconcileDependencies({
          queriedUniqueId: target,
          relatedUniqueId: relatedId,
          claims: allClaims,
          sites: allSites,
          relatedIsArchived,
          // Both ends in the delete set: not work, and not a decision.
          bothSidesDeleted: targetLookup.has(relatedId.toLowerCase()),
        }),
      );
    }
  }

  plan.claims = allClaims;
  plan.sites = workSites;
  plan.workItems = groupSitesByHolder(workSites);
  plan.reconciliation = reconciliation;
  plan.status = 'Planned';

  const reasons: string[] = [];
  if (!allowRestore) {
    const archivedCount = [...ledger.values()].filter((r) => r.wasArchived).length;
    if (archivedCount > 0) {
      reasons.push(PREVIEW_INCOMPLETE);
      log(
        `Preview did not restore ${archivedCount} archived participant(s); their Input/Output references are hidden and this plan understates the work`,
      );
    }
  }
  if (scan.unread.length > 0) {
    reasons.push(
      `The Input/Output scan could not read ${scan.unread.length} process(es), listed above. An Input or Output reference any of them holds to a target is unknown, so the targets cannot be deleted safely until they are read.`,
    );
  }
  if (reasons.length > 0) {
    plan.status = 'PlannedIncomplete';
    plan.incompleteReasons = reasons;
  }
  return finish();
}

const PREVIEW_INCOMPLETE =
  'Preview mode does not restore archived processes, so their Input and Output references are hidden. A real run will find more than this preview shows.';

/**
 * The best name for an id: the plan ledger, then the index, then the name the dependency
 * payload carried, which is the only one a process no listing returns ever gets. Port of
 * `Resolve-PlanProcessName`.
 */
export function planProcessName(plan: DependencyPlan, index: DeleteIndex | null, uniqueId: string): string {
  if (!uniqueId) return '(unknown)';
  const lower = uniqueId.toLowerCase();
  const record = plan.ledger.find((r) => r.uniqueId.toLowerCase() === lower);
  if (record?.name) return record.name;
  const entry = index?.get(lower);
  if (entry?.name) return entry.name;
  return resolveClaimName(plan.claims, uniqueId);
}

/**
 * The plan preview as the operator reads it. A preview restores nothing, so it says so
 * rather than claiming restores it never made. Port of `Show-ProcessDeletePlan`'s text.
 */
export function planSummaryLines(plan: DependencyPlan, index: DeleteIndex | null): string[] {
  const lines: string[] = [];
  lines.push(`Targets to delete: ${plan.targetUniqueIds.length}`);
  lines.push(`Processes to edit: ${plan.workItems.length}`);
  lines.push(`Reference sites: ${plan.sites.length}`);

  const archived = plan.ledger.filter((r) => r.wasArchived);
  if (archived.length > 0) {
    const restored = plan.ledger.filter((r) => r.restoredByThisRun);
    lines.push(
      restored.length > 0
        ? `Archived involved: ${archived.length} (${restored.length} restored for the run, re-archived afterwards)`
        : `Archived involved: ${archived.length} (none restored; a real run would restore them)`,
    );
  }

  // Named before anyone runs a delete, preview included: these are what blocked R11, and
  // the ledger already knows them (Cowork's review of W5 phase 2).
  const homeless = plan.ledger.filter((r) => r.role === 'Holder' && r.wasArchived && !readGroupExists(r.originalGroupExists).exists);
  if (homeless.length > 0) {
    const blocked = new Set(plan.orphanedHolders.map((o) => o.uniqueId.toLowerCase()));
    lines.push(
      `Archived holders with no group: ${homeless.length}. Their groups were deleted, so they cannot go home. A run parks them in the holding group, reads them there, and archives them again before the holding group is removed.`,
    );
    for (const r of homeless) {
      const state = r.parkedInHoldingGroup
        ? 'parked in the holding group for this run'
        : blocked.has(r.uniqueId.toLowerCase())
          ? 'could not be held, which blocks the run'
          : 'not restored by this preview';
      lines.push(`  ${planProcessName(plan, index, r.uniqueId)}  (${r.uniqueId})`);
      lines.push(`      group ${r.originalGroupId ?? 'unknown'} is gone; ${state}`);
    }
  }

  const ledgerRow = (id: string) => plan.ledger.find((r) => r.uniqueId.toLowerCase() === id.toLowerCase());
  if (plan.workItems.length > 0) {
    lines.push('References to remove, by holding process:');
    for (const item of plan.workItems) {
      const record = ledgerRow(item.holderUniqueId);
      lines.push(`  ${record?.name || item.holderUniqueId}${record?.wasArchived ? ' [archived]' : ''}`);
      for (const site of item.sites) lines.push(`      ${site.action.padEnd(7)} ${site.path}`);
    }
  }

  const groupSites = plan.sites.filter((s) => s.action === 'Report');
  if (groupSites.length > 0) {
    lines.push('Group links (reported, never removed automatically):');
    for (const site of groupSites) lines.push(`  ${site.holderUniqueId} -> ${site.targetUniqueId}`);
  }

  if (plan.unresolved.length > 0) {
    lines.push(`UNRESOLVED PARTICIPANTS (${plan.unresolved.length}):`);
    lines.push('The dependency API named these processes but neither process list nor either fetch endpoint returned them. Any reference they hold will NOT be removed.');
    for (const u of plan.unresolved) {
      lines.push(`  ${u.name}  (${u.uniqueId})`);
      lines.push(`      ${u.reason}`);
    }
  }

  const notApplicable = plan.reconciliation.filter((r) => r.status === 'NotApplicable');
  if (notApplicable.length > 0) {
    lines.push(`${notApplicable.length} reconciliation entr(ies) skipped: both sides of the pair are being deleted. They are recorded in the plan file for audit but need no decision.`);
  }
  const known = plan.reconciliation.filter((r) => r.status === 'MatchWithKnownAsymmetry');
  if (known.length > 0) {
    lines.push(`${known.length} entr(ies) differ by the known child-reference asymmetry (warning, not a gate). See the open question in API_ARCHITECTURE.md.`);
  }

  const across = plan.reconciliation.filter((r) => r.status === 'MatchAcrossCategories');
  if (across.length > 0) {
    lines.push(
      `${across.length} entr(ies) disagree on the category but not on the total for their pair (the API labels some Input references as links). Not a gate; the per-category numbers are in the plan file.`,
    );
  }

  const gate = reconciliationGate(plan.reconciliation);
  const doubled = gate.doubleCounted;
  const different = gate.blocking;
  const targets = new Set(plan.targetUniqueIds.map((t) => t.toLowerCase()));
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // Grouped by the queried process, so an operator scans by process rather than down 120
  // undifferentiated rows.
  const listMismatches = (rows: readonly Reconciliation[], withSites: boolean) => {
    const byQueried = new Map<string, Reconciliation[]>();
    for (const p of rows) byQueried.set(p.queriedUniqueId, [...(byQueried.get(p.queriedUniqueId) ?? []), p]);
    for (const [queried, group] of byQueried) {
      lines.push(`  ${planProcessName(plan, index, queried)}`);
      for (const p of group) {
        const survives = targets.has(p.relatedUniqueId.toLowerCase()) ? 'also a target' : 'survives';
        lines.push(
          `    ${p.category.padEnd(6)} -> ${planProcessName(plan, index, p.relatedUniqueId)}   claimed ${p.claimed}, located ${p.located}   [${survives}]`,
        );
        if (!withSites) continue;
        for (const site of plan.sites) {
          if (
            site.category === p.category &&
            ((same(site.holderUniqueId, p.queriedUniqueId) && same(site.targetUniqueId, p.relatedUniqueId)) ||
              (same(site.holderUniqueId, p.relatedUniqueId) && same(site.targetUniqueId, p.queriedUniqueId)))
          ) {
            lines.push(`           ${site.path}`);
          }
        }
      }
    }
  };

  if (different.length > 0) {
    lines.push(`RECONCILIATION MISMATCHES (${different.length}):`);
    lines.push('The dependency API claims references that neither process holds. Investigate before deleting.');
    listMismatches(different, true);
  }
  if (gate.overClaims.length > 0) {
    lines.push(`CLAIMED MORE THAN FOUND (${gate.overClaims.length}):`);
    lines.push(
      'The models hold fewer references than the dependency API claims, and every one found will be removed. Every such pair checked so far was the API over-claiming. A run asks you to acknowledge these before it changes anything.',
    );
    listMismatches(gate.overClaims, true);
  }
  // Apart from the rest, so the ones that are different stand out (Cowork's review of W5
  // phase 2). Cowork then checked all 21 on R11's set, so they no longer gate.
  if (doubled.length > 0) {
    lines.push(`LINKS THE DEPENDENCY API COUNTS TWICE (${doubled.length}):`);
    lines.push(
      'Each is claimed exactly twice per reference found. The dependency check lists every linked process twice, while the holder holds one reference (API_ARCHITECTURE.md). Reported only; they do not stop a run.',
    );
    listMismatches(doubled, false);
  }

  const suppressed = plan.reconciliation.filter((r) => r.suppressed && r.located > 0);
  if (suppressed.length > 0) {
    lines.push('Suppressed by archiving (found in JSON, hidden from the API):');
    for (const s of suppressed) lines.push(`  ${s.category}: ${s.located} reference(s) on ${s.relatedUniqueId}`);
  }

  if (plan.log.length > 0) {
    lines.push('Plan log:');
    for (const line of plan.log) lines.push(`  ${line}`);
  }

  const unread = plan.unreadByScan ?? [];
  if (unread.length > 0) {
    lines.push(`NOT READ BY THE INPUT/OUTPUT SCAN (${unread.length}):`);
    for (const u of unread) {
      lines.push(`  ${u.name || planProcessName(plan, index, u.uniqueId)}  (${u.uniqueId})`);
      lines.push(`      ${u.status > 0 ? `HTTP ${u.status}: ` : ''}${u.error}`);
    }
  }

  if (plan.status === 'PlannedIncomplete') {
    lines.push('THIS PLAN IS INCOMPLETE');
    // A plan file from before the reasons were recorded was always a preview.
    for (const reason of plan.incompleteReasons ?? [PREVIEW_INCOMPLETE]) lines.push(reason);
  }
  return lines;
}
