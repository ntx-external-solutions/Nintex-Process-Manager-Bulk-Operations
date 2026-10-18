// Ported from Tests/Test-Executor.ps1: planning and execution end to end, against a
// tenant that answers the way the measured one did.
//
// The script's suite mocks `Invoke-NpmApi` per scenario; here each scenario seeds a
// `FakeTenant` and changes its hooks. Its dependency answers were the verbatim payloads
// captured from the demo tenant for the two fixture processes. They are rebuilt below
// from the fixtures themselves, occurrence for occurrence, so no tenant id or name is
// spelled out here. "The holder" is ActionCustomerRequest.json, "the target"
// DependencyTest.json.
//
// Each PowerShell scenario runs its stages in sequence; here a stage that needs a later
// phase is its own test, rebuilding the state it starts from, so it can be skipped on the
// phase that will make it pass. `buildDeletePlan` returns its plan through the ledger
// functions (newDependencyPlan, ledgerToPlanRows), which ledger.ts schedules for the hold
// phase, so every planner test is tagged hold even where no restore happens.
//
// Replaced as possible tenant data: the orphan scenario's id prefix and its listing's
// group name, and the collateral scenario's two process names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultRow, type ResultRow } from '../exec/report.ts';
import { reconcileDependencies, type DependencyClaim } from './claims.ts';
import { restoreCollateral, type CollateralChange } from './collateral.ts';
import {
  collateralGateway,
  deletePlanTargets,
  moveProcessToGroup,
  newRelocationProbe,
  removePlanReferences,
  restorePlanState,
  restoreProcess,
} from './executor.ts';
import { findOrphanedGroupProcesses, groupExistsCoverage } from './groups.ts';
import { parsePlan, serializePlan, type DependencyPlan, type PlanLedgerRow } from './ledger.ts';
import type { DeleteIndex, DeleteIndexEntry, ProcessModel } from './model.ts';
import { PHASE } from './phases.ts';
import {
  buildDeletePlan,
  checkProcessDependencies,
  loadDeleteIndex,
  planProcessName,
  planSummaryLines,
  type DeletePlanOptions,
} from './planner.ts';
import { findProcessReferenceSites } from './references.ts';
import { resolveCollateralOutcome, resolveRunOutcome, resolveTargetOutcome, type OutcomeLedgerEntry } from './runOutcome.ts';
import { FakeTenant, type FakeTenantOptions } from './testing/fakeTenant.ts';
import { readFixture } from './testing/fixtures.ts';
import { count, dig } from './testing/json.ts';

type Fixture = ProcessModel & { UniqueId: string; Name: string; GroupId: number; GroupUniqueId: string };

const SITE = 'https://example.invalid/tenant';

const entry = (index: DeleteIndex, uniqueId: string): DeleteIndexEntry | undefined => index.get(uniqueId.toLowerCase());
const joined = (lines: readonly string[]) => lines.join(' ');

/** A full ledger row, defaulted to a target this run un-archived, as the unwind reads it. */
function ledgerRow(row: Partial<PlanLedgerRow> & Pick<PlanLedgerRow, 'uniqueId' | 'name'>): PlanLedgerRow {
  return {
    numericId: null,
    wasArchived: true,
    originalGroupUniqueId: '',
    originalGroupId: null,
    originalGroupExists: true,
    restoredByThisRun: true,
    role: 'Target',
    parkedInHoldingGroup: false,
    denormalized: false,
    deleted: false,
    ...row,
  };
}

function plan(tenant: FakeTenant, options: Omit<DeletePlanOptions, 'siteUrl'>): Promise<DependencyPlan> {
  return buildDeletePlan(tenant, { siteUrl: SITE, ...options });
}

// ---------------------------------------------------------------- the captured pair

/** One response entry: `n` occurrences of `type`, each naming `model`, as the tenant sends them. */
const occurrences = (type: string, model: Fixture, n: number) => ({
  Type: type,
  Dependencies: Array.from({ length: n }, () => ({ Name: model.Name, UniqueId: model.UniqueId })),
});

/**
 * The two fixture processes. Querying the target with both active answered three Linked
 * Process rows and one Process Input row naming the holder; querying the holder, two and
 * one naming the target.
 */
function capturedTenant(options: { holderArchived?: boolean } = {}) {
  const holder = readFixture<Fixture>('ActionCustomerRequest.json');
  const target = readFixture<Fixture>('DependencyTest.json');
  const tenant = new FakeTenant({
    processes: [
      {
        uniqueId: holder.UniqueId,
        name: holder.Name,
        model: holder,
        archived: options.holderArchived ?? false,
        dependencies: [occurrences('Linked Process', target, 2), occurrences('Process Input', target, 1)],
      },
      {
        uniqueId: target.UniqueId,
        name: target.Name,
        model: target,
        dependencies: [occurrences('Linked Process', holder, 3), occurrences('Process Input', holder, 1)],
      },
    ],
  });
  return { tenant, holder, target };
}

// ---------------------------------------------------------------- delete the target, both processes active

test('both active: the index sweep classifies both processes', { skip: PHASE.discovery }, async () => {
  const { tenant, target } = capturedTenant();
  const index = await loadDeleteIndex(tenant);
  assert.equal(index.size, 2, 'the index sweep classifies both processes');
  assert.equal(entry(index, target.UniqueId)?.isArchived, false, 'the target reads as active');
});

test('both active: the holder is the work, not the target', { skip: PHASE.hold }, async () => {
  const { tenant, holder, target } = capturedTenant();
  const index = await loadDeleteIndex(tenant);
  const p = await plan(tenant, { targetUniqueIds: [target.UniqueId], index, holdingGroupId: 999, allowRestore: true });

  assert.equal(p.status, 'Planned', 'the plan completes');
  assert.equal(p.claims.length, 4, 'all 4 occurrences from the target query become claims');
  assert.equal(p.workItems.length, 1, 'exactly one holder needs editing');
  assert.equal(p.workItems[0]?.holderUniqueId, holder.UniqueId, 'the holder is the holder, not the target');
  assert.equal(p.workItems[0]?.sites.length, 3, 'all 3 holder sites are queued');

  // The target holds 2 references to the holder, but it is about to be deleted, so
  // editing it would be wasted work.
  assert.equal(
    p.sites.filter((s) => s.holderUniqueId === target.UniqueId).length,
    0,
    'sites held by the target itself are excluded from the work set',
  );
  assert.equal(p.ledger.length, 2, 'both participants are recorded in the ledger');

  const linkRec = p.reconciliation.find((r) => r.category === 'Link');
  assert.equal(linkRec?.claimed, 3, 'link claims reconcile against the union');
  assert.equal(linkRec?.status, 'Match', 'link reconciliation matches');
});

test('both active: one save per holder, and nothing else in it is lost', { skip: PHASE.references }, async () => {
  const { tenant, holder, target } = capturedTenant();
  const index = await loadDeleteIndex(tenant);
  const p = await plan(tenant, { targetUniqueIds: [target.UniqueId], index, holdingGroupId: 999, allowRestore: true });

  const run = await removePlanReferences(tenant, p);
  const saves = tenant.callsTo('saveModel');
  assert.equal(saves.length, 1, 'the holder is saved exactly once, not once per site');
  assert.equal(typeof saves[0]?.envelope?.ProcessJson, 'string', 'ProcessJson is sent as a STRING, not an object');
  assert.equal(saves[0]?.envelope?.SuppressChangeNotification, true, 'change notification is suppressed');
  assert.equal(run.verificationFailed.length, 0, 'verification passes');
  assert.equal(run.results[0]?.status, 'Success', 'the removal is reported successful');

  const after = tenant.modelOf(holder.UniqueId);
  assert.equal(findProcessReferenceSites(after, [target.UniqueId]).length, 0, 'no references to the target survive in the saved process');
  assert.equal(count(dig(after, 'LinkedStakeholders', 'LinkedStakeholder')), 2, 'LinkedStakeholders survives the save');
  assert.equal(count(dig(after, 'ProcessProcedures', 'Activity')), 2, 'activities survive the save');
  const notePath = ['ProcessProcedures', 'Activity', 1, 'ChildProcessProcedures', 'Note', 0, 'Text'] as const;
  assert.equal(dig(after, ...notePath), dig(holder, ...notePath), 'the orphaned note keeps its text');
});

test('both active: the target is deleted', { skip: PHASE.delete }, async () => {
  const { tenant, target } = capturedTenant();
  const index = await loadDeleteIndex(tenant);
  const p = await plan(tenant, { targetUniqueIds: [target.UniqueId], index, holdingGroupId: 999, allowRestore: true });
  await removePlanReferences(tenant, p);

  const deleteResults = await deletePlanTargets(tenant, p);
  assert.equal(deleteResults[0]?.status, 'Success', 'the target is deleted');
  assert.equal(tenant.exists(target.UniqueId), false, 'the target is gone from the tenant');
});

// ---------------------------------------------------------------- the holder is archived

test('an archived holder reads as archived', { skip: PHASE.discovery }, async () => {
  const { tenant, holder } = capturedTenant({ holderArchived: true });
  const index = await loadDeleteIndex(tenant);
  assert.equal(entry(index, holder.UniqueId)?.isArchived, true, 'the holder reads as archived');
});

test('an archived holder is restored so its hidden edges show, and its home is recorded first', { skip: PHASE.hold }, async () => {
  const { tenant, holder, target } = capturedTenant({ holderArchived: true });
  const index = await loadDeleteIndex(tenant);
  const p = await plan(tenant, { targetUniqueIds: [target.UniqueId], index, holdingGroupId: 999, allowRestore: true });

  const holderRow = p.ledger.find((r) => r.uniqueId === holder.UniqueId);
  assert.equal(holderRow?.wasArchived, true, 'the ledger records that the holder was archived');
  assert.equal(holderRow?.restoredByThisRun, true, 'the holder was restored so its hidden edges become visible');
  assert.equal(holderRow?.originalGroupUniqueId, holder.GroupUniqueId, 'the original group is captured before anything moves');
  assert.equal(p.workItems.length, 1, 'the archived holder still becomes a work item');
  assert.equal(p.workItems[0]?.sites.length, 3, 'all 3 sites are found once restored');
});

test('a restored holder is verified, then re-archived once, and only once', { skip: PHASE.unwind }, async () => {
  const { tenant, holder, target } = capturedTenant({ holderArchived: true });
  const index = await loadDeleteIndex(tenant);
  const p = await plan(tenant, { targetUniqueIds: [target.UniqueId], index, holdingGroupId: 999, allowRestore: true });

  const run = await removePlanReferences(tenant, p);
  assert.equal(run.verificationFailed.length, 0, 'verification passes for the restored holder');

  // The script passed a plan path, rewritten after each entry; here the plan is saved.
  const persist = async () => {};
  const probe = newRelocationProbe();
  const restoreResults = await restorePlanState(tenant, p, { probe, persist });
  assert.equal(restoreResults.length, 1, 'one process is re-archived');
  assert.equal(restoreResults[0]?.status, 'Success', 're-archiving succeeds');
  assert.equal(tenant.isArchived(holder.UniqueId), true, 'the holder is archived again afterwards');
  assert.equal(p.ledger.find((r) => r.uniqueId === holder.UniqueId)?.denormalized, true, 'the ledger marks the entry denormalised');

  // Re-running must be a no-op, so an interrupted run can be resumed safely.
  const again = await restorePlanState(tenant, p, { probe, persist });
  assert.equal(again.length, 0, 're-running denormalisation is idempotent');
});

// ---------------------------------------------------------------- a failed dependency check blocks the run

test('a failed dependency check blocks planning', { skip: PHASE.hold }, async () => {
  const target = readFixture<Fixture>('DependencyTest.json');
  const tenant = new FakeTenant({
    processes: [{ uniqueId: target.UniqueId, name: target.Name, model: target }],
    fail: (call) => (call.op === 'checkDependencies' ? { status: 500, message: 'server error' } : null),
  });
  const index = await loadDeleteIndex(tenant);
  const p = await plan(tenant, { targetUniqueIds: [target.UniqueId], index, holdingGroupId: 999, allowRestore: true });

  assert.equal(p.status, 'Blocked', 'a failed dependency check blocks planning');
  assert.equal(p.workItems.length, 0, 'a blocked plan queues no work');
  assert.match(joined(p.log), /failed/, 'the block reason is logged');
});

// ---------------------------------------------------------------- a CLEAN dependency check is not a failed one
// The inverse of the scenario above. The tenant answers HTTP 200 with an empty body for a
// process that has no dependencies. PowerShell unrolled the empty array on return, so the
// old code read a clean check as a failed one: on the measured tenant that blocked 392 of
// 497 targets, which is to say every dependency-free process.

const CLEAN_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const CLEAN_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const cleanTenant = () =>
  new FakeTenant({
    processes: [
      { uniqueId: CLEAN_A, numericId: 11, name: 'Clean A', groupId: 5, groupUniqueId: 'g-5' },
      { uniqueId: CLEAN_B, numericId: 12, name: 'Clean B', groupId: 5, groupUniqueId: 'g-5' },
    ],
  });

test('an empty dependency payload is a successful check with no claims', { skip: PHASE.discovery }, async () => {
  const clean = await checkProcessDependencies(cleanTenant(), CLEAN_A);
  assert.equal(clean.success, true, 'an empty dependency payload is a SUCCESSFUL check');
  assert.equal(clean.claims.length, 0, 'an empty payload yields zero claims');
  assert.notEqual(clean.claims, null, 'claims is an empty collection, never null');
  assert.ok(Array.isArray(clean.claims), 'claims is an array');
});

test('a tenant-wide clean dependency result does not block the plan', { skip: PHASE.hold }, async () => {
  const tenant = cleanTenant();
  const index = await loadDeleteIndex(tenant);
  const p = await plan(tenant, { targetUniqueIds: [CLEAN_A, CLEAN_B], index, holdingGroupId: 999, allowRestore: true });

  assert.notEqual(p.status, 'Blocked', 'a tenant-wide clean dependency result does NOT block the plan');
  assert.equal(p.status, 'Planned', 'the plan reaches Planned');
  assert.equal(p.claims.length, 0, 'no claims were discovered, correctly');
  assert.equal(p.workItems.length, 0, 'dependency-free targets queue no reference removal');
  assert.equal(p.failedTargets.length, 0, 'no target is recorded as failed');
  assert.equal(p.targetUniqueIds.length, 2, 'both targets stay in the delete set');
});

// ---------------------------------------------------------------- reconciliation skips pairs where both sides are deleted
// 114 of the 120 mismatches on the measured tenant were pairs like this. The references
// between them cease to exist when both are deleted, so gating on them asked the
// operator to adjudicate 120 lines to protect 6.

test('a pair whose both sides are deleted is not a mismatch', { skip: PHASE.discovery }, () => {
  const holder = readFixture<Fixture>('ActionCustomerRequest.json');
  const target = readFixture<Fixture>('DependencyTest.json');
  const claim: DependencyClaim = {
    queriedUniqueId: holder.UniqueId,
    relatedUniqueId: target.UniqueId,
    relatedName: '',
    type: 'Linked Process',
    category: 'Link',
  };
  const claimsPair = [claim, { ...claim }];
  const pair = { queriedUniqueId: holder.UniqueId, relatedUniqueId: target.UniqueId, claims: claimsPair, sites: [] };

  const bothGone = reconcileDependencies({ ...pair, bothSidesDeleted: true });
  const bothLink = bothGone.find((r) => r.category === 'Link');
  assert.equal(bothLink?.status, 'NotApplicable', 'a pair with both sides deleted is NotApplicable, not a mismatch');
  assert.equal(bothGone.filter((r) => r.status === 'Mismatch').length, 0, 'no category of that pair gates the run');
  assert.equal(bothLink?.claimed, 2, 'the claim count is still recorded for the audit trail');

  // One side surviving is exactly the case the gate exists for, so it still fires.
  const oneSide = reconcileDependencies({ ...pair, bothSidesDeleted: false });
  assert.equal(oneSide.find((r) => r.category === 'Link')?.status, 'Mismatch', 'a surviving holder still raises a mismatch');
});

// ---------------------------------------------------------------- a participant missing from both list sweeps
// Processes exist that the dependency API reports but that neither listing returns, while
// the batch endpoint still serves them. Dropping one silently leaves a holder whose
// reference to a deleted target is never removed.

const GHOST = 'eeee0000-0000-0000-0000-00000000000e';
const TARGET = 'ffff0000-0000-0000-0000-00000000000f';

const ghostTenant = () =>
  new FakeTenant({
    processes: [
      {
        uniqueId: TARGET,
        numericId: 7,
        name: 'Target',
        groupId: 12,
        groupUniqueId: 'g-12',
        dependencies: [{ Type: 'Linked Process', Dependencies: [{ Name: 'Ghost Holder', UniqueId: GHOST }] }],
      },
      // In neither listing, archived, and served by the batch endpoint despite that.
      { uniqueId: GHOST, numericId: 4242, name: 'Ghost Holder', archived: true, groupId: 77, groupUniqueId: 'g-77', listed: false },
    ],
  });

test('the unlisted participant really is absent from the index', { skip: PHASE.discovery }, async () => {
  const index = await loadDeleteIndex(ghostTenant());
  assert.equal(index.size, 1, 'the ghost really is absent from the index');
});

test('an unlisted participant is recovered by direct fetch, or named when it cannot be', { skip: PHASE.hold }, async () => {
  const tenant = ghostTenant();
  const index = await loadDeleteIndex(tenant);

  const found = await plan(tenant, { targetUniqueIds: [TARGET], index, allowRestore: false });
  const ghostLedger = found.ledger.filter((r) => r.uniqueId === GHOST);
  assert.equal(ghostLedger.length, 1, 'the unlisted participant is recovered into the ledger, not dropped');
  assert.equal(ghostLedger[0]?.name, 'Ghost Holder', 'its name comes back with it');
  assert.equal(ghostLedger[0]?.originalGroupId, 77, 'its group comes back with it');
  assert.equal(found.unresolved.length, 0, 'a recoverable participant is not reported unresolved');
  assert.match(joined(found.log), /Recovered participant/, 'the recovery is logged');

  // Now the same participant, unreachable by any endpoint.
  tenant.process(GHOST)!.batchReadable = false;
  const lost = await plan(tenant, { targetUniqueIds: [TARGET], index, allowRestore: false });
  assert.equal(lost.unresolved.length, 1, 'a genuinely unreachable participant is recorded, not ignored');
  assert.equal(lost.unresolved[0]?.uniqueId, GHOST, 'it is named by id');
  assert.equal(lost.unresolved[0]?.name, 'Ghost Holder', 'and by the name the dependency payload carried');
  assert.match(joined(lost.log), /UNRESOLVED/, 'the run says its references will not be removed');

  // W3: a name is available for a process no sweep returned.
  assert.equal(planProcessName(lost, index, GHOST), 'Ghost Holder', 'the claim name is used rather than printing a bare GUID');
  assert.equal(planProcessName(lost, index, TARGET), 'Target', 'the ledger still wins where it has an entry');
});

// ---------------------------------------------------------------- a preview does not claim restores it did not make

test('a preview restores nothing and says so; a real run says what it restored', { skip: PHASE.hold }, async () => {
  const { tenant, target } = capturedTenant({ holderArchived: true });
  const previewIndex = await loadDeleteIndex(tenant);
  const preview = await plan(tenant, { targetUniqueIds: [target.UniqueId], index: previewIndex, allowRestore: false });

  assert.equal(
    preview.ledger.filter((r) => r.restoredByThisRun).length,
    0,
    'a preview restores nothing, so nothing is flagged as restored',
  );
  assert.ok(preview.ledger.filter((r) => r.wasArchived).length > 0, 'the preview still knows an archived participant is involved');

  const shown = joined(planSummaryLines(preview, previewIndex));
  assert.match(shown, /none restored/, 'the preview says plainly that it restored nothing');
  assert.doesNotMatch(shown, /restored for the run/, 'the preview does not claim restores it never made');

  // A real run does restore, and says so.
  const realIndex = await loadDeleteIndex(tenant);
  const real = await plan(tenant, { targetUniqueIds: [target.UniqueId], index: realIndex, holdingGroupId: 999, allowRestore: true });
  assert.match(joined(planSummaryLines(real, realIndex)), /restored for the run/, 'a real run does report the restores it made');
});

// ---------------------------------------------------------------- a cancelled run puts targets back in their OWN group
// ArchiveProcess archives a process where it currently sits, and at unwind time the
// targets sit in the temporary holding group. Archiving without moving them first left
// three targets archived under the temp group instead of their homes, while the results
// CSV asserted the home group anyway.

const R1 = 'a1a1a1a1-0000-0000-0000-00000000000a';
const R2 = 'b2b2b2b2-0000-0000-0000-00000000000b';
const TEMP_GROUP = 834;

const heldTenant = (options: FakeTenantOptions = {}) =>
  new FakeTenant({
    processes: [
      { uniqueId: R1, numericId: 1, name: 'Alpha', groupId: TEMP_GROUP },
      { uniqueId: R2, numericId: 2, name: 'Beta', groupId: TEMP_GROUP },
    ],
    // The mock answered the active read for an archived process too.
    activeReadServesArchived: true,
    ...options,
  });

test('a cancelled run puts each target back in its own group, archived, and says where', { skip: PHASE.unwind }, async () => {
  const tenant = heldTenant();
  const ledger = [
    ledgerRow({ uniqueId: R1, name: 'Alpha', numericId: 1, originalGroupUniqueId: 'g-134', originalGroupId: 134 }),
    ledgerRow({ uniqueId: R2, name: 'Beta', numericId: 2, originalGroupUniqueId: 'g-649', originalGroupId: 649 }),
  ];
  const unwound = await restorePlanState(tenant, { ledger }, { probe: newRelocationProbe() });

  assert.equal(unwound.length, 2, 'both restored targets are unwound');
  assert.equal(tenant.groupOf(R1), 134, 'Alpha ends in its own group, not the holding group');
  assert.equal(tenant.groupOf(R2), 649, 'Beta ends in its own group, not the holding group');
  assert.equal(tenant.isArchived(R1), true, 'Alpha ends archived');
  assert.equal(tenant.isArchived(R2), true, 'Beta ends archived');
  assert.equal([R1, R2].filter((id) => tenant.groupOf(id) === TEMP_GROUP).length, 0, 'nothing is left archived under the temporary group');

  assert.equal(unwound[0]?.status, 'Success', 'the unwind reports success');
  assert.match(unwound[0]?.message ?? '', /group 134/, 'the results row names the group it actually reached');
  assert.doesNotMatch(unwound[0]?.message ?? '', new RegExp(String(TEMP_GROUP)), 'and does not name the holding group');
});

test('a relocation that did not happen is reported as where the process really is', { skip: PHASE.unwind }, async () => {
  // A tenant that accepts every relocation and moves nothing.
  const tenant = heldTenant({ noEffect: (call) => call.op === 'restore' });
  tenant.remove(R2);
  const ledger = [ledgerRow({ uniqueId: R1, name: 'Alpha', numericId: 1, originalGroupUniqueId: 'g-134', originalGroupId: 134 })];
  const stuck = await restorePlanState(tenant, { ledger }, { probe: newRelocationProbe() });

  assert.equal(stuck.length, 1, 'the stuck process still produces a row');
  assert.match(stuck[0]?.message ?? '', new RegExp(`group ${TEMP_GROUP}`), 'the row names where it REALLY is');
  assert.match(stuck[0]?.message ?? '', /NOT the original group 134/, 'and says plainly that it is not home');
  assert.equal(stuck[0]?.status, 'Skipped', 'a failed relocation is not reported as a clean success');
});

test('with no recorded home group the row says so rather than inventing one', { skip: PHASE.unwind }, async () => {
  const tenant = heldTenant();
  tenant.remove(R2);
  const ledger = [ledgerRow({ uniqueId: R1, name: 'Alpha', numericId: 1 })];
  const rows = await restorePlanState(tenant, { ledger }, { probe: newRelocationProbe() });
  assert.match(rows[0]?.message ?? '', /no original group was recorded/, 'with no recorded home group the row says so rather than inventing one');
});

// ---------------------------------------------------------------- the relocation probe is asked once, not once per process
// RestoreProcess answers HTTP 500 for an already-active process on this tenant, every
// time. Through the normal retry ladder that is 2 + 4 + 8 seconds per process before the
// fallback: close to two hours of pure backoff on a 479-target run. The answer is the
// same for every process, so it is asked once and remembered.

const P1 = 'aa11bb22-0000-0000-0000-0000000000f1';
const P2 = 'aa11bb22-0000-0000-0000-0000000000f2';

test('the relocation probe is asked once, with no retries, and its answer kept', { skip: PHASE.unwind }, async () => {
  // Only relocates a process that is currently archived.
  const tenant = new FakeTenant({
    processes: [
      { uniqueId: P1, name: 'P', groupId: 834 },
      { uniqueId: P2, name: 'P', groupId: 834 },
    ],
    restoreActive: 'refuse',
  });
  const probe = newRelocationProbe();

  const m1 = await moveProcessToGroup(tenant, P1, 493, { probe });
  assert.equal(m1.moved, true, 'the fallback lands the first process in its group');
  assert.equal(m1.actualGroupId, 493, 'and says where it actually is');
  assert.equal(probe.state, 'No', 'the run has learned that RestoreProcess does not relocate an active process');

  const probe1 = tenant.callsTo('restore', P1)[0];
  assert.equal(probe1?.retry, false, 'the probe runs with NO retry ladder, so a 500 costs nothing');

  const attemptsAfterFirst = tenant.callsTo('restore').length;
  const m2 = await moveProcessToGroup(tenant, P2, 493, { probe });
  assert.equal(m2.moved, true, 'the second process still lands correctly');
  assert.equal(tenant.callsTo('restore', P2).length, 1, 'the second process skips the probe entirely and restores once');
  assert.equal(tenant.callsTo('restore').length, attemptsAfterFirst + 1, 'no wasted call is made for it');
});

test('a tenant whose probe succeeds is not pushed down the fallback', { skip: PHASE.unwind }, async () => {
  const tenant = new FakeTenant({ processes: [{ uniqueId: P1, name: 'P', archived: true, groupId: 834 }], restoreActive: 'refuse' });
  const probe = newRelocationProbe();

  const m3 = await moveProcessToGroup(tenant, P1, 493, { probe });
  assert.equal(m3.moved, true, 'a tenant whose probe succeeds relocates on the first call');
  assert.equal(probe.state, 'Yes', 'and that is remembered too');
  assert.equal(tenant.callsTo('archive').length, 0, 'with no archive/restore round trip forced on it');
});

// ---------------------------------------------------------------- the manual list reflects the tenant when the run ENDS
// The list is built from the checkpoint diff, taken before the targets are returned to
// their groups. Returning a target appears to bring its sibling variations back with it,
// so by the end some entries have undone themselves. One run told an operator to go and
// move five processes that were already home.

const SIB1 = 'cc00dd00-0000-0000-0000-0000000000c1';
const SIB2 = 'cc00dd00-0000-0000-0000-0000000000c2';

const moved = (uniqueId: string, name: string, from: number): CollateralChange => ({
  uniqueId,
  name,
  change: 'Moved',
  wasArchived: false,
  isArchivedNow: false,
  originalGroupId: from,
  originalGroupExists: true,
  currentGroupId: 836,
});

const manual = (objectId: string, name: string, operation: string, status: string, message: string): ResultRow =>
  resultRow({ objectId, name, operation, status, message });

test('a collateral row already put right by the end of the run is cleared', { skip: PHASE.unwind }, async () => {
  // By the end of the run the first sibling is home again; the second genuinely is not.
  const tenant = new FakeTenant({
    processes: [
      { uniqueId: SIB1, numericId: 1, name: 'Purchase :: Tier 2', groupId: 8 },
      { uniqueId: SIB2, numericId: 2, name: 'Raise invoice :: Region B', groupId: 836 },
    ],
  });
  const collateral = [moved(SIB1, 'Purchase :: Tier 2', 8), moved(SIB2, 'Raise invoice :: Region B', 20)];
  const rows = [
    manual(SIB1, 'Purchase :: Tier 2', 'ReverseCollateral', 'Skipped', 'Moved from group 8 to 836. Move it back manually'),
    manual(SIB2, 'Raise invoice :: Region B', 'ReverseCollateral', 'Skipped', 'Moved from group 20 to 836. Move it back manually'),
    manual('zz', 'Unrelated', 'Delete', 'Success', 'Deleted'),
  ];

  const resolved = await resolveCollateralOutcome(tenant, collateral, rows);
  assert.equal(resolved.length, 3, 'every row survives; none is silently dropped');

  const row1 = resolved.find((r) => r.objectId === SIB1);
  assert.equal(row1?.status, 'Success', 'a process already back in its group is cleared from the manual list');
  assert.match(row1?.message ?? '', /no action needed/, 'and says plainly that nothing needs doing');
  assert.equal(resolved.find((r) => r.objectId === SIB2)?.status, 'Skipped', 'a process that is genuinely still misplaced stays on the list');
  assert.equal(
    resolved.filter((r) => r.operation === 'ReverseCollateral' && r.status !== 'Success').length,
    1,
    'the outstanding count is what is really outstanding, not what was outstanding mid-run',
  );

  // A process the baseline never covered has no home group to compare against.
  const ghost: CollateralChange = {
    uniqueId: SIB2,
    name: 'Ghost',
    change: 'NotInBaseline',
    wasArchived: null,
    isArchivedNow: false,
    originalGroupId: null,
    originalGroupExists: true,
    currentGroupId: 836,
  };
  const ghostResolved = await resolveCollateralOutcome(tenant, [ghost], [manual(SIB2, 'Ghost', 'ReverseCollateral', 'Skipped', 'No before-state')]);
  assert.equal(ghostResolved[0]?.status, 'Skipped', 'an unbaselined process is never cleared, having nothing to be compared to');
});

// ---------------------------------------------------------------- a process whose group was deleted while it was archived
// RestoreProcess answers HTTP 500 for a destination group that does not exist, and the
// listing has been saying which groups those are all along. Nothing here should ever ask.

const ORPHAN = 'dddd0000-0000-0000-0000-0000000000f1'; // archived, its group is gone
const HOLDER = 'dddd0000-0000-0000-0000-0000000000f2'; // archived, its group is fine
const LIVE = 'dddd0000-0000-0000-0000-0000000000f3'; // active target
const HOLDING_GROUP = 900;

interface OrphanState {
  archived: readonly string[];
  groups: Readonly<Record<string, number>>;
  dependencies?: Readonly<Record<string, unknown>>;
  refuseHold?: boolean;
}

/** The three processes, in whatever state a stage starts from. Group 1 is the deleted one. */
function orphanTenant(state: OrphanState): FakeTenant {
  const seed = (uniqueId: string, name: string) => ({
    uniqueId,
    numericId: 700,
    name,
    archived: state.archived.includes(uniqueId),
    groupId: state.groups[uniqueId] ?? null,
    groupUniqueId: '',
    // The one field this whole scenario turns on.
    groupExists: uniqueId !== ORPHAN,
    dependencies: state.dependencies?.[uniqueId] ?? null,
  });
  return new FakeTenant({
    processes: [seed(ORPHAN, 'Orphan'), seed(HOLDER, 'Has a home'), seed(LIVE, 'Live')],
    missingGroupIds: [1],
    // Lets a test refuse the holding group too, which is the one case where an orphaned
    // holder has nowhere left to be read and blocking is right.
    fail: (call) =>
      state.refuseHold && call.op === 'restore' && call.groupId === HOLDING_GROUP
        ? { status: 500, message: 'Internal Server Error' }
        : null,
  });
}

const atRest = (): OrphanState => ({ archived: [ORPHAN, HOLDER], groups: { [ORPHAN]: 1, [HOLDER]: 500, [LIVE]: 500 } });

test('the index carries groupExists, and says when the listing never answered', { skip: PHASE.hold }, async () => {
  const tenant = orphanTenant(atRest());
  const oIndex = await loadDeleteIndex(tenant);
  assert.equal(entry(oIndex, ORPHAN)?.groupExists, false, 'the index carries groupExists through from the listing payload');
  assert.equal(entry(oIndex, HOLDER)?.groupExists, true, 'and does not mark a process whose group is fine');
  assert.equal(entry(oIndex, ORPHAN)?.groupExistsReported, true, 'and records that this listing answered the question at all');
  assert.equal(groupExistsCoverage(oIndex).state, 'Full', 'so orphan detection is genuinely available on this tenant');

  // A listing that omits the field is a tenant that was never measured, not a clean one.
  tenant.reportGroupExists = false;
  const quietIndex = await loadDeleteIndex(tenant);
  assert.equal(entry(quietIndex, ORPHAN)?.groupExistsReported, false, 'a listing that omits groupExists is recorded as not having answered');
  assert.equal(entry(quietIndex, ORPHAN)?.groupExists, true, 'while control flow still degrades to "the group is there"');
  assert.equal(
    groupExistsCoverage(quietIndex).state,
    'None',
    'so the run can say orphan detection is unavailable rather than reporting a clean zero',
  );
  assert.equal(
    findOrphanedGroupProcesses(quietIndex, [ORPHAN]).length,
    0,
    'and finds no orphans, which is why the unavailability has to be said out loud',
  );
});

test('a restore into a group that is gone is never sent', { skip: PHASE.hold }, async () => {
  const tenant = orphanTenant(atRest());
  const refused = await restoreProcess(tenant, ORPHAN, 1, { destinationGroupExists: false });
  assert.equal(refused.ok, false, 'a restore into a group that is gone fails');
  assert.equal(tenant.callsTo('restore').length, 0, 'and fails WITHOUT calling the endpoint, so there is no retry ladder to climb');
  assert.equal(refused.failure, 'MissingGroup', 'the failure is distinct from an endpoint failure, so a caller can pick somewhere real');

  await restoreProcess(tenant, HOLDER, 500);
  assert.equal(tenant.callsTo('restore').length, 1, 'a restore into a group that exists still goes through');
});

test('the unwind archives an orphan where it sits and says where, and sends the rest home', { skip: PHASE.unwind }, async () => {
  // Both were pulled into the holding group by the Hold phase. One can go home.
  const tenant = orphanTenant({ archived: [], groups: { [ORPHAN]: HOLDING_GROUP, [HOLDER]: HOLDING_GROUP, [LIVE]: 500 } });
  const ledger = [
    ledgerRow({ uniqueId: ORPHAN, name: 'Orphan', originalGroupId: 1, originalGroupExists: false }),
    ledgerRow({ uniqueId: HOLDER, name: 'Has a home', originalGroupId: 500, originalGroupExists: true }),
  ];
  const unwound = await restorePlanState(tenant, { ledger }, { probe: newRelocationProbe() });

  const orphanRow = unwound.find((r) => r.objectId === ORPHAN);
  assert.equal(orphanRow?.status, 'Skipped', 'the orphan is archived but not returned home, and the row says so');
  assert.match(orphanRow?.message ?? '', new RegExp(`group ${HOLDING_GROUP}`), 'the results row names the group the process is ACTUALLY in');
  assert.match(orphanRow?.message ?? '', /no longer exists/, 'and gives the reason it is not in its original group');
  assert.equal(
    tenant.callsTo('restore', ORPHAN).length,
    0,
    'no restore is attempted for the orphan, so no 500s and no archive-then-restore fallback',
  );
  assert.equal(tenant.isArchived(ORPHAN), true, 'it does end up archived, which always works');

  // The narrow test: everything else behaves exactly as before.
  const homeRow = unwound.find((r) => r.objectId === HOLDER);
  assert.equal(homeRow?.status, 'Success', 'a process whose group still exists is unaffected');
  assert.match(homeRow?.message ?? '', /group 500/, 'and is reported back in its own group');
  assert.equal(tenant.isArchived(HOLDER), true, 'and re-archived');
});

// A holder whose group is gone is HELD, not made into a blocker. This used to stop the run
// dead: the holders were named and the operator was told to move them by hand, so no
// delete could complete on a tenant that has any. Eleven of them sat behind eleven of
// twenty targets on the demo tenant. The run already parks an orphaned target in the
// holding group, reads it there and archives it in place on the way out; a holder is the
// same problem, and parking costs it nothing it had not already lost.

const linkTo = (uniqueId: string, name: string) => [{ Type: 'Linked Process', Dependencies: [{ Name: name, UniqueId: uniqueId }] }];

test('a holder whose group is gone is held in the holding group, not made a blocker', { skip: PHASE.hold }, async () => {
  const tenant = orphanTenant({
    archived: [ORPHAN],
    groups: { [ORPHAN]: 1, [HOLDER]: 500, [LIVE]: 500 },
    dependencies: { [LIVE]: linkTo(ORPHAN, 'Orphan') },
  });
  const heldIndex = await loadDeleteIndex(tenant);
  const heldPlan = await plan(tenant, { targetUniqueIds: [LIVE], index: heldIndex, holdingGroupId: HOLDING_GROUP, allowRestore: true });

  assert.notEqual(heldPlan.status, 'Blocked', 'a holder whose group is gone no longer blocks the run');
  assert.equal(heldPlan.orphanedHolders.length, 0, 'and is not reported as an orphan the operator must go and move');

  const heldRestores = tenant.callsTo('restore', ORPHAN);
  assert.equal(heldRestores.length, 1, 'it is restored once');
  assert.equal(heldRestores[0]?.groupId, HOLDING_GROUP, 'into the holding group, which is the only group it can be read in');

  const heldEntry = heldPlan.ledger.find((r) => r.uniqueId === ORPHAN);
  assert.ok(heldEntry, 'the ledger carries the holder');
  assert.equal(heldEntry?.restoredByThisRun, true, 'and records that this run un-archived it');
  assert.equal(heldEntry?.parkedInHoldingGroup, true, 'and that it was parked rather than sent home');
  assert.equal(heldEntry?.role, 'Holder', 'and that it is a holder, not one of the run targets');
  assert.equal(heldEntry?.originalGroupId, 1, 'the dead group it came from is still on the record');
  assert.equal(
    heldPlan.log.filter((line) => /Held .* in the holding group/.test(line)).length,
    1,
    'and the plan log says so, naming the group that is gone',
  );

  // A target in the same plan is still marked as a target.
  assert.equal(heldPlan.ledger.find((r) => r.uniqueId === LIVE)?.role, 'Target', 'the run target is labelled as one');
});

test('a holder that cannot be held anywhere still blocks the run', { skip: PHASE.hold }, async () => {
  // The holding group was the fallback. With that refused there is nowhere left to read
  // the holder, so its Input/Output edges stay hidden.
  const tenant = orphanTenant({
    archived: [ORPHAN],
    groups: { [ORPHAN]: 1, [HOLDER]: 500, [LIVE]: 500 },
    dependencies: { [LIVE]: linkTo(ORPHAN, 'Orphan') },
    refuseHold: true,
  });
  const blockIndex = await loadDeleteIndex(tenant);
  const blockPlan = await plan(tenant, { targetUniqueIds: [LIVE], index: blockIndex, holdingGroupId: HOLDING_GROUP, allowRestore: true });

  assert.equal(blockPlan.status, 'Blocked', 'a holder that cannot be held anywhere still blocks the run');
  assert.equal(blockPlan.orphanedHolders.length, 1, 'and is named');
  assert.equal(blockPlan.orphanedHolders[0]?.uniqueId, ORPHAN, 'by id');
  assert.equal(
    blockPlan.log.filter((line) => /could not be held in the holding group/.test(line)).length,
    1,
    'with the cause given: the fallback was tried and refused',
  );
  assert.equal(blockPlan.reconciliation.length, 0, 'the run stops before reconciliation, so there is no mismatch to misread');
});

test('an archived holder whose group still exists plans as it always did', { skip: PHASE.hold }, async () => {
  const tenant = orphanTenant({
    archived: [HOLDER],
    groups: { [ORPHAN]: 1, [HOLDER]: 500, [LIVE]: 500 },
    dependencies: { [LIVE]: linkTo(HOLDER, 'Has a home') },
  });
  const okIndex = await loadDeleteIndex(tenant);
  const okPlan = await plan(tenant, { targetUniqueIds: [LIVE], index: okIndex, holdingGroupId: HOLDING_GROUP, allowRestore: true });
  assert.equal(okPlan.status, 'Planned', 'an archived holder whose group still exists plans as it always did');
  assert.equal(okPlan.orphanedHolders.length, 0, 'and is not named as orphaned');
});

test('a collateral archive with nowhere to go is reported, not retried', { skip: PHASE.checkpoints }, async () => {
  const tenant = orphanTenant(atRest());
  const change: CollateralChange = {
    uniqueId: ORPHAN,
    name: 'Orphan',
    change: 'Archived',
    wasArchived: false,
    isArchivedNow: true,
    originalGroupId: 1,
    originalGroupExists: false,
    currentGroupId: 1,
  };
  const rows = await restoreCollateral(collateralGateway(tenant), [change]);
  assert.equal(rows[0]?.status, 'Failed', 'a collateral archive whose group is gone cannot be reversed');
  assert.match(rows[0]?.message ?? '', /no longer exists/, 'and the row says why');
  assert.equal(tenant.callsTo('restore').length, 0, 'without calling an endpoint that can only answer 500');
});

// ---------------------------------------------------------------- the unwind reported what the API said, not what happened
// A measured run told the operator that two targets were "still active and must be
// archived manually". A read afterwards found all three archived: the archive call
// reported failure and took effect anyway.

const outcomeLedger: OutcomeLedgerEntry[] = [
  { uniqueId: HOLDER, name: 'Reported failed, actually archived', originalGroupId: 500, originalGroupExists: true },
  { uniqueId: LIVE, name: 'Reported failed, actually in the wrong group', originalGroupId: 500, originalGroupExists: true },
  { uniqueId: ORPHAN, name: 'Orphan', originalGroupId: 1, originalGroupExists: false },
];

const reported = (): ResultRow[] => [
  manual(HOLDER, 'Reported failed, actually archived', 'ReArchive', 'Failed', 'Re-archive failed; this process is still ACTIVE in group 500'),
  manual(LIVE, 'Reported failed, actually in the wrong group', 'ReArchive', 'Failed', 'Re-archive failed; this process is still ACTIVE in group 500'),
  manual(ORPHAN, 'Orphan', 'ReArchive', 'Failed', 'Re-archive failed; this process is still ACTIVE in group 1'),
];

test('a re-archive that reported failure is re-derived from the tenant', { skip: PHASE.unwind }, async () => {
  const tenant = orphanTenant({ archived: [ORPHAN, HOLDER, LIVE], groups: { [ORPHAN]: 900, [HOLDER]: 500, [LIVE]: 777 } });
  const checked = await resolveTargetOutcome(tenant, outcomeLedger, reported());

  const fixed = checked.find((r) => r.objectId === HOLDER);
  assert.equal(fixed?.status, 'Success', 'an archive that reported failure but took effect is no longer on the manual list');
  assert.match(fixed?.message ?? '', /group 500/, 'and the row names where it actually is');

  const wrongGroup = checked.find((r) => r.objectId === LIVE);
  assert.equal(wrongGroup?.status, 'Skipped', 'archived but in the wrong group is not a failure and not a success');
  assert.match(wrongGroup?.message ?? '', /group 777/, 'and the row names the group it is really in');
  assert.doesNotMatch(wrongGroup?.message ?? '', /still ACTIVE/, 'and stops claiming it is still active');

  const orphanRow = checked.find((r) => r.objectId === ORPHAN);
  assert.equal(orphanRow?.status, 'Skipped', 'an orphan archived where it sits is reported as such');
  assert.match(orphanRow?.message ?? '', /no longer exists/, 'with the reason it is not in its original group');
});

test('a target that really is still active stays on the list', { skip: PHASE.unwind }, async () => {
  const tenant = orphanTenant({ archived: [], groups: { [ORPHAN]: 900, [HOLDER]: 500, [LIVE]: 777 } });
  const stillActive = await resolveTargetOutcome(tenant, outcomeLedger, reported());
  assert.equal(
    stillActive.filter((r) => r.status === 'Failed').length,
    3,
    'a process that really is still active is still reported as still active',
  );
  assert.match(stillActive.find((r) => r.objectId === HOLDER)?.message ?? '', /archive it manually/, 'and is still told to be archived manually');
});

test('rows already right, rows with no ledger entry, and other operations are left alone', { skip: PHASE.unwind }, async () => {
  const tenant = orphanTenant({ archived: [HOLDER], groups: { [ORPHAN]: 900, [HOLDER]: 500, [LIVE]: 777 } });
  const untouched = [
    manual(HOLDER, 'Fine', 'ReArchive', 'Success', 'Re-archived in group 500'),
    manual('99999999-0000-0000-0000-000000000000', 'Not in the ledger', 'ReArchive', 'Failed', 'Re-archive failed'),
    manual(HOLDER, 'Different operation', 'Delete', 'Failed', 'Delete failed'),
  ];
  const kept = await resolveTargetOutcome(tenant, outcomeLedger, untouched);
  assert.equal(kept[0]?.status, 'Success', 'a row that was already a success is untouched');
  assert.equal(kept[1]?.status, 'Failed', 'a row with no ledger entry is left alone');
  assert.equal(kept[2]?.status, 'Failed', 'and so is a row for a different operation');
});

test('a process absent from both sweeps does not get cleared', { skip: PHASE.unwind }, async () => {
  // The sweeps are known to be incomplete, so a missing row cannot clear a warning.
  const absent = '88888888-0000-0000-0000-000000000000';
  const tenant = new FakeTenant();
  const gone = [manual(absent, 'Absent', 'ReArchive', 'Failed', 'Re-archive failed')];
  const rows = await resolveTargetOutcome(tenant, [{ uniqueId: absent, name: 'Absent', originalGroupId: 500, originalGroupExists: true }], gone);
  assert.equal(rows[0]?.status, 'Failed', 'a process absent from both sweeps does not get cleared');
});

test('both lists are re-checked against one fresh read, and a clean run pays for none', { skip: PHASE.unwind }, async () => {
  const tenant = orphanTenant({ archived: [HOLDER], groups: { [HOLDER]: 500, [LIVE]: 500 } });
  const bothLists = [
    manual(HOLDER, 'Target', 'ReArchive', 'Failed', 'Re-archive failed; this process is still ACTIVE in group 500'),
    manual(LIVE, 'Collateral', 'ReverseCollateral', 'Skipped', 'Still misplaced'),
  ];
  const bothCollateral: CollateralChange[] = [
    {
      uniqueId: LIVE,
      name: 'Collateral',
      change: 'Archived',
      wasArchived: false,
      isArchivedNow: true,
      originalGroupId: 500,
      originalGroupExists: true,
      currentGroupId: 500,
    },
  ];
  const bothLedger: OutcomeLedgerEntry[] = [{ uniqueId: HOLDER, name: 'Target', originalGroupId: 500, originalGroupExists: true }];

  const both = await resolveRunOutcome(tenant, bothCollateral, bothLedger, bothLists);
  assert.equal(both.find((r) => r.operation === 'ReArchive')?.status, 'Success', 'the target list is corrected');
  assert.equal(both.find((r) => r.operation === 'ReverseCollateral')?.status, 'Success', 'and the collateral list is corrected in the same pass');
  assert.equal(
    tenant.callsTo('listProcesses').filter((c) => c.listType === 0).length,
    1,
    'against a single index sweep, not one per list',
  );

  // Nothing outstanding means no sweep at all.
  const quiet = orphanTenant({ archived: [HOLDER], groups: { [HOLDER]: 500, [LIVE]: 500 } });
  await resolveRunOutcome(quiet, bothCollateral, bothLedger, [manual(HOLDER, 'Target', 'ReArchive', 'Success', 'Re-archived in group 500')]);
  assert.equal(
    quiet.callsTo('listProcesses').filter((c) => c.listType === 0).length,
    0,
    'a clean run does not pay for a re-check it does not need',
  );
});

// ---------------------------------------------------------------- NEW (T1): a resumed unwind

// NEW (T1): the unwind must put back every process the run un-archived on every exit
// path, including a resumed run. A run that dies leaves only its plan file; uploaded
// again, that plan alone must be enough to put back the holders as well as the targets,
// one row each, under the operation that says which they were.
test('NEW (T1): an uploaded plan alone puts back every process the run un-archived, one row each', { skip: PHASE.unwind }, async () => {
  const tenant = orphanTenant({ archived: [], groups: { [ORPHAN]: HOLDING_GROUP, [HOLDER]: 500, [LIVE]: HOLDING_GROUP } });
  const before: DependencyPlan = {
    schemaVersion: 1,
    createdUtc: '2026-01-01T00:00:00.000Z',
    siteUrl: SITE,
    status: 'Holding',
    targetUniqueIds: [LIVE],
    ledger: [
      ledgerRow({ uniqueId: LIVE, name: 'Live', originalGroupId: 500 }),
      ledgerRow({ uniqueId: HOLDER, name: 'Has a home', originalGroupId: 500, role: 'Holder' }),
      ledgerRow({ uniqueId: ORPHAN, name: 'Orphan', originalGroupId: 1, originalGroupExists: false, role: 'Holder', parkedInHoldingGroup: true }),
    ],
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
  const resumed = parsePlan(serializePlan(before));
  assert.ok(resumed, 'the downloaded plan reads back');

  const rows = await restorePlanState(tenant, resumed, { probe: newRelocationProbe() });
  for (const id of [LIVE, HOLDER, ORPHAN]) {
    assert.equal(tenant.isArchived(id), true, `${id}: archived again from the uploaded plan alone`);
    assert.equal(rows.filter((r) => r.objectId === id).length, 1, `${id}: exactly one results row`);
  }
  assert.equal(rows.find((r) => r.objectId === LIVE)?.operation, 'ReArchive', 'the target under the target operation');
  assert.equal(rows.find((r) => r.objectId === HOLDER)?.operation, 'ReArchiveHolder', 'a holder under the holder operation');
  assert.equal(tenant.groupOf(LIVE), 500, 'the target went home before it was archived');
  assert.equal(resumed.ledger.every((r) => r.denormalized), true, 'and the plan records every one as done, so a second resume does nothing');
});
