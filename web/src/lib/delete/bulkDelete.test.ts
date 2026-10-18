// Ported from Tests/Test-BulkDelete.ps1: Mode 5 orchestration, the Hold phase, the plan
// ledger, the holding group, the collateral gate and the results rows, against a fake
// tenant.
//
// These cover defects no engine test can reach, because they live in the order
// `Invoke-BulkDeleteProcesses` does things. The script's version runs Mode 5 with
// `-Force` and reads three things back: its console, `Delete_Plan_*.json`, and the rows
// `Save-DeleteResults` was handed. Here those are the run's events, the plan store, and
// `runBulkDelete`'s rows. `-Force` (unattended) is a run with no decision callbacks;
// `-AcceptCollateral` is `acceptCollateral`. Each scenario's mock becomes a seeded
// `FakeTenant` and, where the tenant does something on its own, an `after` hook.
//
// `runBulkDelete` calls the end-of-run re-check on every exit, so every scenario that
// runs it is tagged unwind, the phase that lands it; a function the scenario also calls
// on its own carries its own phase.
//
// Replaced as possible tenant data: the listing's group name, the unnameable process's
// id, three id prefixes, and seven process names (a held target, two holders, the
// stranded process and its group-listing name, a stuck target, the R11 target). The
// synthetic names the script made up ('Alpha', 'Order Handling (AU)') are kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultRow, resultsToCsv, UNKNOWN_NAME, type ResultRow } from '../exec/report.ts';
import { LIST_PAGE_SIZE } from '../pm/processes.ts';
import { ACCEPTANCE_AUTHORITY, deleteResultsSummary, resumeUnwind, runBulkDelete, type BulkDeleteOptions } from './bulkDelete.ts';
import { collateralLines } from './collateral.ts';
import type { DeleteEvent } from './events.ts';
import { HOLDING_GROUP_NAME, type GroupRef } from './gateway.ts';
import { removeHoldingGroup, orphanedTargetWarningLines } from './holdingGroup.ts';
import { mergePlanLedger, type PlanLedgerRow, type ProcessStateSnapshot } from './ledger.ts';
import { resolveCollateralName } from './names.ts';
import { PHASE } from './phases.ts';
import { idFromCsvRow } from './targets.ts';
import { FakeTenant, PROCESS_MUTATIONS, type FakeProcessSeed, type FakeTenantOptions } from './testing/fakeTenant.ts';
import { FakePlanStore } from './testing/planStore.ts';

const SITE = 'https://example.invalid/tenant';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const T3 = '33333333-3333-3333-3333-333333333333';

const HOME: GroupRef = { id: 100, uniqueId: 'group-100-home', name: 'Home' };
const TEMP: GroupRef = { id: 830, uniqueId: 'group-830-temp', name: HOLDING_GROUP_NAME };

function scenario(processes: FakeProcessSeed[], options: FakeTenantOptions = {}): FakeTenant {
  return new FakeTenant({ groups: [HOME], holdingGroup: TEMP, processes, ...options });
}

/** Mode 5, unattended unless the options say otherwise, with its events and plan saves kept. */
async function run(tenant: FakeTenant, options: Partial<BulkDeleteOptions> = {}) {
  const store = new FakePlanStore().watch(tenant);
  const events: DeleteEvent[] = [];
  const result = await runBulkDelete(tenant, {
    siteUrl: SITE,
    source: { kind: 'archived' },
    planStore: store,
    holdingGroupName: HOLDING_GROUP_NAME,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { rows: result.results, store, events, plan: store.latest() };
}

/** Restores the tenant accepted, which is what the script's mocks counted. */
const restored = (tenant: FakeTenant, uniqueId?: string) =>
  tenant.callsTo('restore', uniqueId).filter((call) => call.failedWith === undefined);
const holdingGroupDeleted = (tenant: FakeTenant) => tenant.deletedGroups.includes(TEMP.uniqueId);
const rowsOf = (rows: readonly ResultRow[], operation: string) => rows.filter((r) => r.operation === operation);
const distinctIds = (rows: readonly ResultRow[]) => new Set(rows.map((r) => r.objectId.toLowerCase())).size;
const stageAt = (events: readonly DeleteEvent[], stage: string) =>
  events.findIndex((e) => e.kind === 'stage' && e.stage === stage);

// ---------------------------------------------------------------- three archived processes in group 100, nothing depends on them

function threeArchived(overrides: Readonly<Record<string, Partial<FakeProcessSeed>>> = {}): FakeTenant {
  const seed = (uniqueId: string, numericId: number, name: string): FakeProcessSeed => ({
    uniqueId,
    numericId,
    name,
    archived: true,
    groupId: 100,
    groupExists: true,
    ...overrides[uniqueId],
  });
  return scenario([seed(T1, 1001, 'Alpha'), seed(T2, 1002, 'Bravo'), seed(T3, 1003, 'Charlie')]);
}

test('archived targets are held, deleted, and the ledger tells the truth', { skip: PHASE.unwind }, async () => {
  const tenant = threeArchived();
  const { rows, store, plan } = await run(tenant);

  assert.equal(restored(tenant).length, 3, 'all three archived targets are held');
  assert.equal(tenant.deleted.length, 3, 'all three targets are deleted');

  // B4: the plan must exist before the first thing the run changes.
  const atFirst = store.atFirstMutation;
  assert.ok(atFirst, 'a plan is saved BEFORE the first restore');
  assert.equal(atFirst?.ledger.length, 3, 'the pre-mutation plan already carries every target');
  assert.equal(atFirst?.ledger[0]?.wasArchived, true, 'the pre-mutation ledger records the targets as archived');

  for (const entry of plan?.ledger ?? []) {
    assert.equal(entry.wasArchived, true, `${entry.name}: the ledger says it WAS archived`);
    assert.equal(entry.originalGroupId, HOME.id, `${entry.name}: OriginalGroupId is the home group, not the temp group`);
    assert.equal(entry.originalGroupUniqueId, HOME.uniqueId, `${entry.name}: OriginalGroupUniqueId is the home group, not the temp group`);
    assert.equal(entry.restoredByThisRun, true, `${entry.name}: RestoredByThisRun is set so the unwind path can put it back`);
  }
  assert.equal(plan?.ledger.filter((e) => e.originalGroupId === TEMP.id).length, 0, 'no ledger entry names the temporary group as its origin');
  assert.equal(holdingGroupDeleted(tenant), true, 'the empty holding group is cleaned up');

  // A target is, by the time it is deleted, an archived process this run restored, so it
  // matches the re-archive filter on every count except that it no longer exists. One
  // archive each (the pre-delete archive), not two.
  assert.equal(tenant.callsTo('archive').length, 3, 'deleted targets are archived once, not re-archived afterwards');
  for (const entry of plan?.ledger ?? []) {
    assert.equal(entry.deleted, true, `${entry.name}: the ledger records that it was deleted`);
  }
  assert.equal(rowsOf(rows, 'ReArchive').length, 0, 'no re-archive is attempted against a deleted process');
});

// ---------------------------------------------------------------- a target whose group is gone is named before the run starts
// A warning, not a gate. These targets can be held and deleted normally; what they cannot
// do is go home if the run stops short, and the operator wants that before the first
// mutation rather than out of the results file afterwards.

test('a target whose group is gone is named before the first mutation, and still deleted', { skip: PHASE.unwind }, async () => {
  const tenant = threeArchived({ [T3]: { groupId: 1, groupExists: false } });
  const { events } = await run(tenant);

  const warnAt = events.findIndex((e) => e.kind === 'orphanedTargets');
  const warning = events[warnAt];
  assert.ok(warning?.kind === 'orphanedTargets', 'the run says so up front');
  const shown = orphanedTargetWarningLines(warning.orphans, warning.totalTargets, warning.holdingGroupName).join('\n');
  assert.match(shown, /TARGETS WHOSE GROUP NO LONGER EXISTS/, 'under its own heading');
  assert.match(shown, /1 of 3 target\(s\) belong to a group that no longer exists/, 'and counts targets, not rows');
  assert.match(shown, /Charlie/, 'and names the one it means');

  const holdAt = stageAt(events, 'holding-group');
  assert.ok(warnAt >= 0 && holdAt > warnAt, 'before the first mutation, not after it');
  assert.equal(tenant.deleted.length, 3, 'it is a warning: all three targets are still deleted');
  assert.equal(holdingGroupDeleted(tenant), true, 'and the holding group is still cleaned up');
});

test('a run with no orphaned target says nothing about orphans', { skip: PHASE.unwind }, async () => {
  const tenant = threeArchived();
  const { events } = await run(tenant);
  assert.equal(events.filter((e) => e.kind === 'orphanedTargets').length, 0, 'a tenant with no orphaned targets gets no orphan warning');
  assert.equal(tenant.deleted.length, 3, 'and the ordinary run is untouched');
});

// ---------------------------------------------------------------- a collateral process no source can name

test('a collateral name comes from the index, then the listing, then says it is unavailable', { skip: PHASE.checkpoints }, () => {
  const ghost = 'ffff1111-0000-0000-0000-000000000001';
  const fromIndex = new Map([[ghost.toLowerCase(), { name: 'From the index' }]]);
  assert.equal(resolveCollateralName(fromIndex, ghost, 'From the group listing'), 'From the index', 'the index name still wins over the group listing');
  assert.equal(
    resolveCollateralName(new Map(), ghost, 'From the group listing'),
    'From the group listing',
    'and the listing is still used when the index has nothing',
  );
  assert.equal(resolveCollateralName(new Map(), ghost, ''), UNKNOWN_NAME, 'but with every source empty the row says the name is unavailable, not the id');
  assert.equal(resolveCollateralName(new Map(), ghost, ghost), UNKNOWN_NAME, 'and a fallback that is only the id counts as empty');
});

// ---------------------------------------------------------------- a holding group that still holds processes is NOT deleted

test('a holding group that still holds processes is not deleted, and the leftover is named', { skip: PHASE.unwind }, async () => {
  const tenant = scenario([{ uniqueId: T2, name: 'Bravo', groupId: TEMP.id }], { groups: [HOME, TEMP] });

  const cleanup = await removeHoldingGroup(tenant, TEMP, { groupName: HOLDING_GROUP_NAME });
  assert.equal(holdingGroupDeleted(tenant), false, 'a non-empty holding group is left in place');
  assert.equal(cleanup[0]?.status, 'Skipped', 'the skip is reported rather than passing silently');
  assert.ok(cleanup[0]?.message.includes(T2), 'the leftover process is named so it can be found');

  tenant.setArchived(T2, true);
  const cleanup2 = await removeHoldingGroup(tenant, TEMP, { groupName: HOLDING_GROUP_NAME });
  assert.equal(holdingGroupDeleted(tenant), true, 'an empty holding group is deleted');
  assert.equal(cleanup2[0]?.status, 'Success', 'the successful cleanup is reported');
});

// ---------------------------------------------------------------- a variation drags its master, and the run stops
// T1 is a variation. Restoring it out of the archive also archives its master, which is
// not a target and not in the ledger. Nothing in the model says the two are linked, so
// the only way to see it is the before/after diff. The run must stop and put it back.

const M1 = '99999999-9999-9999-9999-999999999999';

test('a variation that drags its master out at the Hold stops the run, and both are put back', { skip: PHASE.unwind }, async () => {
  const tenant = scenario(
    [
      { uniqueId: T1, numericId: 1, name: 'Order Handling (AU)', archived: true, groupId: 100 },
      { uniqueId: M1, numericId: 1, name: 'Order Handling', groupId: 100 },
    ],
    // The coupling under test: acting on the variation acts on the master.
    { after: (call, t) => call.op === 'restore' && call.uniqueId === T1 && t.setArchived(M1, true) },
  );
  const { rows, plan } = await run(tenant);

  assert.equal(tenant.deleted.length, 0, 'NOTHING is deleted once collateral is detected');
  assert.equal(tenant.isArchived(M1), false, 'the master is put back to active');
  assert.equal(tenant.groupOf(M1), 100, 'the master is returned to its own group');
  assert.equal(tenant.isArchived(T1), true, 'the target is re-archived on the way out');

  assert.equal(plan?.status, 'AbortedCollateral', 'the plan records why the run stopped');
  assert.equal(plan?.collateral.length, 1, 'the collateral is recorded in the plan for audit');
  assert.equal(plan?.collateral[0]?.uniqueId, M1, 'the master is named in the plan');
  assert.equal(plan?.collateral[0]?.change, 'Archived', 'the plan says what happened to it');

  assert.ok(rows.length > 0, 'results are still reported when the run stops');
  assert.ok(rowsOf(rows, 'Collateral').length > 0, 'the results name the collateral');
  assert.ok(rowsOf(rows, 'ReverseCollateral').some((r) => r.status === 'Success'), 'the reversal is recorded as done');
});

// ---------------------------------------------------------------- collateral during the ARCHIVE phase stops before deletion
// The targets are active, so there is no Hold phase and no first checkpoint. The
// pre-delete archive is itself a mutation, and the last point at which stopping still
// costs nothing: an unwanted archive can be undone, a delete cannot.

test('a variation that drags its master in at the archive pass stops before any delete', { skip: PHASE.unwind }, async () => {
  const tenant = scenario(
    [
      { uniqueId: T1, numericId: 1, name: 'Order Handling (AU)', groupId: 100, batchReadable: false },
      { uniqueId: M1, numericId: 1, name: 'Order Handling', groupId: 100, batchReadable: false },
    ],
    { after: (call, t) => call.op === 'archive' && call.uniqueId === T1 && t.setArchived(M1, true) },
  );
  await run(tenant, { source: { kind: 'csv', text: `ProcessID\n${T1}\n` } });

  assert.equal(tenant.deleted.length, 0, 'the run stops between archiving and deleting');
  assert.ok(tenant.callsTo('archive', T1).length > 0, 'the target was archived, which is what exposed the coupling');
  assert.equal(tenant.isArchived(M1), false, 'the master is un-archived again');
});

// ---------------------------------------------------------------- the coupling fires on DELETE, and the run says so
// Measurement settled where the damage lands: restoring and archiving leave the tenant as
// found, and the index shows each change on the first read afterwards. The master moves
// when the variation is DELETED. The post-delete checkpoint cannot prevent that. It must
// report it, reverse what is reversible, and above all not finish claiming 0 failed.

const M2 = '88888888-8888-8888-8888-888888888888';

const deleteTimeTenant = (masterName: string) =>
  scenario(
    [
      { uniqueId: T1, numericId: 1, name: 'Order Handling::AU', archived: true, groupId: 333 },
      { uniqueId: M2, numericId: 1, name: masterName, groupId: 100 },
    ],
    // The delete is where the coupling actually fires.
    { after: (call, t) => call.op === 'deleteProcess' && call.uniqueId === T1 && t.setArchived(M2, true) },
  );

test('the coupling fires on delete: reported as a failure, and the master put back', { skip: PHASE.unwind }, async () => {
  // The master has an unrelated name, so the pre-flight heuristic stays quiet and the
  // post-delete checkpoint is what has to catch it.
  const tenant = deleteTimeTenant('Something Unrelated');
  const { rows, plan } = await run(tenant);

  assert.equal(tenant.deleted.length, 1, 'the target is deleted, as asked');
  assert.ok(tenant.deleted.includes(T1), 'and it is the right one');

  const collateralRows = rowsOf(rows, 'Collateral');
  assert.equal(collateralRows.length, 1, 'the post-delete checkpoint reports the master');
  assert.equal(collateralRows[0]?.objectId, M2, 'by id');
  assert.equal(collateralRows[0]?.status, 'Failed', 'as a failure, so the run cannot report 0 failed');
  assert.ok(rows.some((r) => r.status === 'Failed'), 'the run does NOT finish with zero failures');

  assert.equal(tenant.isArchived(M2), false, 'the reversible damage is reversed: the master is active again');
  assert.equal(tenant.groupOf(M2), 100, 'and back in its own group');

  assert.equal(plan?.collateral.length, 1, 'the plan records the collateral for audit');
  assert.match(plan?.log.join(' ') ?? '', /after delete phase/, 'the log says which phase found it');
});

test('the variation pre-flight stops an unattended run before it changes anything', { skip: PHASE.unwind }, async () => {
  const tenant = deleteTimeTenant('Order Handling'); // now the heuristic matches
  const { rows } = await run(tenant);

  assert.equal(tenant.deleted.length, 0, 'nothing is deleted');
  assert.equal(restored(tenant).length, 0, 'nothing is even restored; the run stops before the Hold phase');
  assert.equal(tenant.callsTo('archive').length, 0, 'and before anything is archived');
  assert.equal(tenant.isArchived(M2), false, 'the master is untouched');

  const warnRows = rowsOf(rows, 'VariationWarning');
  assert.equal(warnRows.length, 1, 'the master is named in the results');
  assert.equal(warnRows[0]?.objectId, M2, 'by id');
  assert.equal(warnRows[0]?.status, 'Failed', 'and counted as a failure, not a clean finish');
});

// ---------------------------------------------------------------- a process stranded BY the delete is seen and named once
// W3: the observed-id list was gathered before the deletes, when the holding group held
// only the targets, so NotInBaseline could never fire. The process worth catching is
// stranded there BY the delete. W2: two producers raise collateral rows, the checkpoints
// and the holding-group sweep, and neither merged with the other; the group listing also
// names a variation by its master, so one id printed under two names.

const STRANDED = 'eeee1111-0000-0000-0000-0000000000aa';

test('a process stranded by the delete is caught by the checkpoint and reported once', { skip: PHASE.unwind }, async () => {
  const tenant = scenario(
    [{ uniqueId: T1, numericId: 1, name: 'Raise invoice', archived: true, groupId: 333, batchReadable: false }],
    {
      // The delete strands a process that no listing ever returns, and the group listing
      // shows it under its master's name, suffix dropped.
      after: (call, t) => {
        if (call.op !== 'deleteProcess' || call.uniqueId !== T1) return;
        t.add({ uniqueId: STRANDED, name: 'Grant permit', groupId: TEMP.id, listed: false, batchReadable: false });
      },
    },
  );
  const { rows, plan } = await run(tenant);

  const strandedRows = rows.filter((r) => r.operation === 'Collateral' && r.objectId === STRANDED);
  assert.ok(strandedRows.length > 0, 'a process stranded by the DELETE is caught, which the pre-delete list never could');
  assert.equal(strandedRows.length, 1, 'and it is reported once, not once per producer');
  assert.equal(distinctIds(rowsOf(rows, 'Collateral')), 1, 'one collateral row per affected process');
  assert.equal(rowsOf(rows, 'Collateral').length, 1, 'no duplicate rows across the two producers');
  assert.ok(rows.some((r) => r.status === 'Failed'), 'and the run does not report it as clean');

  // The plan's collateral is written ONLY by the checkpoints, so this isolates W3 from the
  // holding-group sweep, which would otherwise cover for it.
  const planStranded = plan?.collateral.filter((c) => c.uniqueId === STRANDED) ?? [];
  assert.equal(planStranded.length, 1, 'the CHECKPOINT itself sees the stranded process, not just the cleanup sweep');
  assert.equal(planStranded[0]?.change, 'NotInBaseline', 'and classifies it as a process the baseline never covered');
  assert.match(plan?.log.join(' ') ?? '', /NotInBaseline/, 'the plan log records it');
});

// ---------------------------------------------------------------- a target whose Hold fails is NOT deleted
// The Hold phase exists because archiving hides Input and Output rows. A target that never
// came out of the archive was never checked. Deleting it anyway can leave a dangling
// reference on a process that survives, the one failure the engine exists to stop.

const GOOD1 = 'aa000000-0000-0000-0000-00000000aa01';
const GOOD2 = 'aa000000-0000-0000-0000-00000000aa02';
const STUCK = 'dddd2222-0000-0000-0000-00000000aa03';

const holdFailTenant = () =>
  scenario(
    [
      { uniqueId: GOOD1, numericId: 1, name: 'Alpha', archived: true, groupId: 100 },
      { uniqueId: GOOD2, numericId: 1, name: 'Beta', archived: true, groupId: 100 },
      { uniqueId: STUCK, numericId: 1, name: 'Stuck target', archived: true, groupId: 100 },
    ],
    // This one target refuses to come out of the archive, as the tenant did.
    { fail: (call) => (call.op === 'restore' && call.uniqueId === STUCK ? { status: 500, message: 'server error' } : null) },
  );

test('a target whose Hold fails is not deleted, and says why', { skip: PHASE.unwind }, async () => {
  const tenant = holdFailTenant();
  const { rows } = await run(tenant);

  assert.equal(tenant.deleted.includes(STUCK), false, 'the target that never came out of the archive is NOT deleted');
  assert.ok(tenant.deleted.includes(GOOD1), 'the rest of the batch is still deleted');
  assert.ok(tenant.deleted.includes(GOOD2), 'both of them');
  assert.equal(tenant.deleted.length, 2, 'exactly the two that were held');

  const stuckDelete = rows.filter((r) => r.objectId === STUCK && r.operation === 'Delete');
  assert.equal(stuckDelete.length, 1, 'the excluded target still appears in the results');
  assert.equal(stuckDelete[0]?.status, 'Skipped', 'as skipped, not deleted');
  assert.match(stuckDelete[0]?.message ?? '', /never checked/, 'and the reason says its references were never checked');
  assert.equal(
    rows.filter((r) => r.objectId === STUCK && r.operation === 'Delete' && r.status === 'Success').length,
    0,
    'there is no Delete/Success row for it anywhere',
  );
});

test('allowUnheldTargets is the only way to delete it unchecked, and the plan says so', { skip: PHASE.unwind }, async () => {
  const tenant = holdFailTenant();
  const { plan } = await run(tenant, { allowUnheldTargets: true });

  assert.ok(tenant.deleted.includes(STUCK), 'with the explicit option the unchecked target IS deleted');
  assert.equal(tenant.deleted.length, 3, 'all three go');
  assert.match(plan?.log.join(' ') ?? '', /UNCHECKED DELETE allowed/, 'and the plan records that it was an unchecked delete');
});

// ---------------------------------------------------------------- every results row carries a name, never its own id
// Naming used to be applied where rows were printed, so the console said "(name
// unavailable)" while the CSV, written from the same rows, carried a bare GUID.

test('no process row has its id, or nothing, in the Name column', { skip: PHASE.unwind }, async () => {
  const { rows } = await run(threeArchived());
  assert.ok(rows.length > 0, 'the run produced results rows');
  assert.equal(rows.filter((r) => r.objectType === 'Process' && r.name === r.objectId).length, 0, 'no process row has its id in the Name column');
  assert.equal(rows.filter((r) => r.objectType === 'Process' && !r.name).length, 0, 'and none has an empty one');
});

test('a row built for an unnameable process carries the marker, not the id', () => {
  const ghostRow = resultRow({ objectId: 'ffff1111-0000-0000-0000-000000000001', operation: 'Collateral', status: 'Failed', message: 'x' });
  assert.equal(ghostRow.name, UNKNOWN_NAME, 'a row built for an unnameable process carries the marker, not the id');
});

// ---------------------------------------------------------------- acceptCollateral is the third answer to the collateral gate
// Unattended means "answer the prompts", and it deliberately cannot answer this one: a run
// that has just proved it affects processes nobody listed has no business continuing to
// an irreversible delete on an assumption. Approving in advance says something
// unattended does not: the operator reviewed this list and accepts it. It approves this
// gate and the variation pre-flight, and nothing else.

const MA = '99999999-9999-9999-9999-99999999aa01';

const acceptTenant = (variationName = 'Order Handling (AU)') =>
  scenario(
    [
      { uniqueId: T1, numericId: 1, name: variationName, archived: true, groupId: 100, batchReadable: false },
      { uniqueId: MA, numericId: 1, name: 'Order Handling', groupId: 100, batchReadable: false },
    ],
    // The coupling: pulling the variation out of the archive drags the master in.
    { after: (call, t) => call.op === 'restore' && call.uniqueId === T1 && t.setArchived(MA, true) },
  );

test('unattended alone still stops at the collateral gate and approves nothing', { skip: PHASE.unwind }, async () => {
  const tenant = acceptTenant();
  const { rows } = await run(tenant);
  assert.equal(tenant.deleted.length, 0, 'an unattended run alone still stops at the collateral gate');
  assert.equal(rows.filter((r) => r.status === 'Accepted').length, 0, 'and approves nothing');
});

test('approved in advance, the run deletes, records the approval once, and still puts the collateral back', { skip: PHASE.unwind }, async () => {
  const tenant = acceptTenant();
  const { rows, events } = await run(tenant, { acceptCollateral: true });

  assert.equal(tenant.deleted.length, 1, 'with acceptCollateral the run reaches the delete phase');
  assert.ok(tenant.deleted.includes(T1), 'and deletes the target it was given');

  // The list has to be in front of the operator before the run acts on the approval.
  const listedAt = events.findIndex((e) => e.kind === 'collateral');
  const acceptAt = events.findIndex((e) => e.kind === 'collateralDecision' && e.accepted && e.authority === ACCEPTANCE_AUTHORITY.inAdvance);
  const deleteAt = stageAt(events, 'deleting-targets');
  assert.ok(listedAt >= 0, 'the full collateral list is raised');
  assert.ok(acceptAt > listedAt, 'the approval is announced after the list, not instead of it');
  assert.ok(deleteAt > acceptAt, 'and both come before anything is deleted');
  const listed = events[listedAt];
  assert.match(
    listed?.kind === 'collateral' ? collateralLines(listed.collateral, listed.phase).join('\n') : '',
    /Order Handling/,
    'the affected process is named',
  );

  const acceptedRows = rows.filter((r) => r.operation === 'Collateral' && r.status === 'Accepted');
  assert.equal(acceptedRows.length, 1, 'the approved process gets one Accepted row');
  assert.equal(acceptedRows[0]?.objectId, MA, 'naming the process that was approved');
  assert.ok(acceptedRows[0]?.message.includes(ACCEPTANCE_AUTHORITY.inAdvance), 'and saying it was approved in advance rather than at the gate');

  assert.equal(rows.filter((r) => r.operation === 'Collateral' && r.status === 'Failed').length, 0, 'an approved change is not also filed as a failure');
  assert.equal(distinctIds(rowsOf(rows, 'Collateral')), 1, 'and it is raised once, not again at every checkpoint after the one that asked');
  assert.equal(rowsOf(rows, 'Collateral').length, 1, 'one row per approved process');

  // Approval is permission to carry on, not a request to leave the tenant changed.
  assert.equal(tenant.isArchived(MA), false, 'the approved collateral is still put back');
  assert.equal(tenant.groupOf(MA), 100, 'into its own group');
  assert.equal(
    rows.filter((r) => r.operation === 'ReverseCollateral' && r.objectId === MA && r.status === 'Success').length,
    1,
    'and the reversal is recorded exactly once, not once per list that carries it',
  );
  assert.equal(holdingGroupDeleted(tenant), true, 'the holding group is still cleaned up');
});

test('acceptCollateral also answers the variation pre-flight, as an authorisation', { skip: PHASE.unwind }, async () => {
  const tenant = acceptTenant('Order Handling :: AU'); // now the heuristic matches
  const { rows } = await run(tenant, { acceptCollateral: true });

  assert.equal(tenant.deleted.length, 1, 'the pre-flight no longer stops the run');
  const warnRows = rowsOf(rows, 'VariationWarning');
  assert.equal(warnRows.length, 1, 'the master is still named in the results');
  assert.equal(warnRows[0]?.status, 'Accepted', 'as an authorisation rather than a failure');
  assert.equal(warnRows[0]?.objectId, MA, 'and it is the right master');
  assert.equal(warnRows[0]?.groupId, '100', 'the row says which group that master is in');
});

// ---------------------------------------------------------------- a ReArchive row says which group the process landed in
// GroupId and StatusCode exist so the manual-review companion can be built from the rows
// rather than by parsing Message back apart. ReArchive is the row that carries it.

test('the unwind rows carry the group each process landed in', { skip: PHASE.unwind }, async () => {
  // Not approved, so the gate stops the run and the target goes home and is re-archived.
  const { rows } = await run(acceptTenant());

  const reArchive = rowsOf(rows, 'ReArchive');
  assert.ok(reArchive.length > 0, 'the unwind produced ReArchive rows');
  assert.equal(reArchive.filter((r) => !r.groupId).length, 0, 'and not one of them has an empty GroupId');
  assert.equal(reArchive[0]?.groupId, '100', 'it is the home group, not the holding group the process was parked in');
  assert.match(reArchive[0]?.message ?? '', /100/, 'and the Message still tells the story');

  const reverse = rowsOf(rows, 'ReverseCollateral');
  assert.ok(reverse.length > 0, 'the collateral reversal produced rows too');
  assert.equal(reverse.filter((r) => !r.groupId).length, 0, 'and those carry a group as well');
});

test('a row carries its status code and group in their own columns, and every row has every column', () => {
  assert.equal(
    resultRow({ objectId: T1, name: 'Alpha', operation: 'Hold', status: 'Failed', statusCode: 404, message: 'x' }).statusCode,
    '404',
    'a row carries a status code through to the row',
  );
  assert.equal(
    resultRow({ objectId: T1, name: 'Alpha', operation: 'Hold', status: 'Failed', groupId: 830, message: 'x' }).groupId,
    '830',
    'and a group id',
  );

  // The script's CSV took its header from whichever row came first. A ResultRow always has
  // every column, so the file's shape cannot depend on the order.
  const mixed = [
    resultRow({ objectType: 'ProcessGroup', objectId: 'g830', name: 'Temp', operation: 'Cleanup', status: 'Success', message: 'x' }),
    resultRow({ objectId: T1, name: 'Alpha', operation: 'ReArchive', status: 'Success', groupId: 100, message: 'y' }),
  ];
  assert.ok(
    'groupId' in mixed[0]! && resultsToCsv(mixed).split(/\r?\n/)[0]?.includes('GroupId'),
    'a row that carries no group still gets the column, so a header cannot lose it',
  );
  assert.equal(mixed[1]?.groupId, '100', 'and a row that does keeps its value');
});

// ---------------------------------------------------------------- the results file can be fed back in
// Every results file uses ObjectID, which the CSV reader did not accept, so re-running the
// failures out of a results file silently produced "No processes to delete".

test('ObjectID and its spellings are read as an id', () => {
  assert.equal(idFromCsvRow({ ObjectType: 'Process', ObjectID: T1, Name: 'Alpha' }), T1, 'ObjectID is read as an id');
  assert.equal(idFromCsvRow({ ObjectId: T1 }), T1, 'and so is ObjectId');
  assert.equal(idFromCsvRow({ ProcessID: '', ObjectID: T1 }), T1, 'a header that exists but is blank on this row does not swallow the lookup');
  assert.equal(idFromCsvRow({ Name: 'Alpha', Status: 'Failed' }), null, 'a row with no id column at all still yields nothing');
});

test('the failures out of a results file are run again, and nothing else', { skip: PHASE.unwind }, async () => {
  const tenant = threeArchived();
  // Shaped exactly like a file this tool writes.
  const results = [
    'ObjectType,ObjectID,Name,Operation,Status,Message,GroupId,StatusCode',
    `Process,${T1},Alpha,Delete,Failed,Delete failed,100,500`,
    `Process,${T2},Bravo,Delete,Failed,Delete failed,100,500`,
  ].join('\n');
  await run(tenant, { source: { kind: 'csv', text: results, fileName: 'Delete_Results_20260919_040932.csv' } });

  assert.equal(tenant.deleted.length, 2, 'the two failures out of a results file are re-run');
  assert.ok(tenant.deleted.includes(T1), 'the first of them');
  assert.ok(tenant.deleted.includes(T2), 'and the second');
  assert.equal(tenant.deleted.includes(T3), false, 'and nothing that was not in the file');
});

test('an unreadable header does not look like an empty file', { skip: PHASE.unwind }, async () => {
  const tenant = threeArchived();
  const csv = ['Process Name,Owner', 'Alpha,someone', 'Bravo,someone else'].join('\n');
  const { events } = await run(tenant, { source: { kind: 'csv', text: csv } });

  const miss = events.find((e) => e.kind === 'csvNoIdColumn');
  assert.equal(miss?.kind === 'csvNoIdColumn' ? miss.rowCount : null, 2, 'the run says how many rows it read');
  assert.ok(miss, 'and that the headers are why it got nothing');
  assert.deepEqual(miss?.kind === 'csvNoIdColumn' ? miss.headers : null, ['Process Name', 'Owner'], 'naming the columns the file actually has');
  assert.ok(miss?.kind === 'csvNoIdColumn' && miss.accepted.includes('ObjectID'), 'and the ones it would have accepted');
  assert.equal(tenant.deleted.length, 0, 'nothing is deleted');
});

// ---------------------------------------------------------------- a blocked plan still puts back the holders it restored
// The measured failure (R11): the Hold phase restored eleven archived dependency holders
// so their Input/Output edges could be read, planning was then blocked, and the unwind
// re-archived the twenty targets but not the eleven holders. The tenant went 181 active /
// 464 archived to 192 / 454, and not one of the 45 results rows mentioned any of them.
// The blocked path assigned a target-only snapshot over the ledger, erasing the holders
// from the run's own memory.

const R11_TARGET = 'aa110000-0000-0000-0000-0000000000a1';
const R11_HOLDER = 'bb110000-0000-0000-0000-00000000b0b0';
const R11_DEAD_HOLDER = 'cc110000-0000-0000-0000-00000000dead';

/**
 * The target, held against by two archived processes: one with a live group, restored in
 * place for discovery, and one whose group is gone, which has to be parked in the holding
 * group. With `refuseHold` the tenant refuses that, which blocks planning AFTER the first
 * holder has already been restored. That ordering is what the blocked-unwind test turns on.
 */
function holderTenant(refuseHold: boolean): FakeTenant {
  return scenario(
    [
      {
        uniqueId: R11_TARGET,
        numericId: 1,
        name: 'Raise invoice',
        archived: true,
        groupId: 100,
        groupExists: true,
        groupUniqueId: '',
        dependencies: [
          {
            Type: 'Linked Process',
            Dependencies: [
              { Name: 'Review requests', UniqueId: R11_HOLDER },
              { Name: 'Approve hiring', UniqueId: R11_DEAD_HOLDER },
            ],
          },
        ],
      },
      { uniqueId: R11_HOLDER, numericId: 1, name: 'Review requests', archived: true, groupId: 500, groupExists: true, groupUniqueId: '' },
      { uniqueId: R11_DEAD_HOLDER, numericId: 1, name: 'Approve hiring', archived: true, groupId: 1, groupExists: false, groupUniqueId: '' },
    ],
    {
      missingGroupIds: [1],
      fail: (call) =>
        refuseHold && call.op === 'restore' && call.uniqueId === R11_DEAD_HOLDER ? { status: 500, message: 'Internal Server Error' } : null,
    },
  );
}

// Only the target is offered as a delete candidate; the holders are reached through the
// dependency API, the way they are on the tenant. (The script's mock listed only the
// target as archived; here the selection names it.)
const r11Source = { kind: 'ids', ids: [R11_TARGET] } as const;

test('a blocked plan still puts back the holders it restored, each with its own row', { skip: PHASE.unwind }, async () => {
  const tenant = holderTenant(true);
  const { rows, plan } = await run(tenant, { source: r11Source, acceptCollateral: true });

  assert.ok(restored(tenant, R11_HOLDER).length > 0, 'the holder was un-archived for discovery');
  assert.equal(tenant.deleted.length, 0, 'planning was blocked, so nothing is deleted');

  // The finding, as an invariant: a process this run un-archived is a process it puts back.
  assert.equal(tenant.isArchived(R11_HOLDER), true, 'the holder the run un-archived is archived again on the way out');
  assert.equal(tenant.groupOf(R11_HOLDER), 500, 'and is still in its own group');
  assert.equal(tenant.isArchived(R11_TARGET), true, 'the target is re-archived too, as it always was');

  const holderRows = rows.filter((r) => r.objectId === R11_HOLDER);
  assert.ok(holderRows.length > 0, 'and the results say so, rather than changing a process and reporting nothing');
  assert.equal(holderRows[0]?.operation, 'ReArchiveHolder', 'under its own operation, so a holder the run moved does not read as a target or as collateral');
  assert.equal(holderRows[0]?.status, 'Success', 'and it is recorded as done');
  assert.equal(holderRows[0]?.groupId, '500', 'with the group it landed in');

  // The target keeps the operation it always had; the two are distinguishable.
  assert.equal(rows.filter((r) => r.objectId === R11_TARGET && r.operation === 'ReArchive').length, 1, 'the target is still reported under ReArchive');
  assert.equal(rows.filter((r) => r.operation === 'ReArchiveHolder' && !r.groupId).length, 0, 'no holder row is missing its group');

  // The saved plan is the audit record and has to carry the holders too.
  assert.equal(plan?.status, 'Blocked', 'the plan records that it was blocked');
  const holderEntry = plan?.ledger.filter((e) => e.uniqueId === R11_HOLDER) ?? [];
  assert.ok(holderEntry.length > 0, 'and its ledger still carries the holder after the snapshot is folded in');
  assert.equal(holderEntry[0]?.role, 'Holder', 'labelled as a holder');
  assert.ok((plan?.ledger.filter((e) => e.uniqueId === R11_TARGET).length ?? 0) > 0, 'and the target, which is what the snapshot was assigned for');
});

// ---------------------------------------------------------------- a holder whose group is gone is held, read, and put back
// Eleven archived holders on the demo tenant sat behind eleven of twenty targets, each in
// a group that had been deleted. The run named them and told the operator to move them by
// hand, so no delete could complete. A holder is the same problem as an orphaned target.

test('a holder whose group is gone is held, read, archived again, and its row says so', { skip: PHASE.unwind }, async () => {
  const tenant = holderTenant(false); // the holding group will take the orphan
  const { rows, events, plan } = await run(tenant, { source: r11Source, acceptCollateral: true });

  assert.doesNotMatch(plan?.log.join(' ') ?? '', /Move these holders into a group that exists/, 'the run no longer tells the operator to go and move processes by hand');
  assert.ok(restored(tenant, R11_DEAD_HOLDER).length > 0, 'the orphaned holder is restored rather than refused');
  assert.ok(
    events.some((e) => e.kind === 'holderHeld' && e.uniqueId === R11_DEAD_HOLDER && e.originalGroupId === 1),
    'and the run says it went to the holding group and why',
  );

  // It has to leave the holding group before cleanup, or the group cannot go.
  assert.equal(tenant.isArchived(R11_DEAD_HOLDER), true, 'the parked holder is archived again on the way out');
  assert.equal(holdingGroupDeleted(tenant), true, 'so the holding group is empty by cleanup time and is deleted');

  const parkedRow = rows.find((r) => r.objectId === R11_DEAD_HOLDER);
  assert.ok(parkedRow, 'the parked holder has a results row');
  // Cowork's review of phase 1: its own operation, saying it stays archived without a group.
  assert.equal(parkedRow?.operation, 'ReArchiveOrphanedHolder', 'under the orphaned-holder operation');
  assert.match(parkedRow?.message ?? '', /stays archived without a group/, 'which says it stays archived without a group');
  assert.equal(parkedRow?.status, 'Success', 'and counts as done: archived where it sits is the state it was found in');
  assert.match(parkedRow?.message ?? '', /group 1\b/, 'the row names the dead group it came from, so the trail survives the run');
  assert.match(parkedRow?.message ?? '', /already orphaned before the run started/, 'and is explicit that the run did not cause the orphaning');

  // The holder with a real group still goes home, unchanged by any of this.
  const homeRow = rows.find((r) => r.objectId === R11_HOLDER);
  assert.equal(homeRow?.operation, 'ReArchiveHolder', 'the ordinary holder is a holder too');
  assert.equal(homeRow?.groupId, '500', 'and goes back to its own group');
  assert.equal(tenant.isArchived(R11_HOLDER), true, 'and is archived again');

  assert.equal(
    rows.filter((r) => r.operation === 'Collateral' && r.status === 'Failed').length,
    0,
    'a holder the run moved on purpose is not reported as collateral damage',
  );
});

// A process the run could not put back is NAMED, not just counted. It used to be listed
// only inside the collateral block, so a run that left a holder active with no collateral
// to report said nothing beyond a number on the Failed line.
test('the summary names every process the run left needing attention, and only then', { skip: PHASE.unwind }, () => {
  const stranded = deleteResultsSummary([
    resultRow({
      objectId: R11_HOLDER,
      name: 'Review requests',
      operation: 'ReArchiveHolder',
      status: 'Failed',
      message: 'Re-archive failed; this process is still ACTIVE in group 500',
    }),
    resultRow({ objectId: R11_TARGET, name: 'Raise invoice', operation: 'Delete', status: 'Success', message: 'Deleted' }),
  ]).lines.join('\n');
  assert.match(stranded, /STILL NEEDS MANUAL ATTENTION/, 'a process the run left active is called out, with no collateral needed to trigger it');
  assert.match(stranded, /Review requests/, 'and named');
  assert.match(stranded, /still ACTIVE in group 500/, 'with what has to be done about it');

  const clean = deleteResultsSummary([
    resultRow({ objectId: R11_TARGET, name: 'Raise invoice', operation: 'Delete', status: 'Success', message: 'Deleted' }),
  ]).lines.join('\n');
  assert.doesNotMatch(clean, /STILL NEEDS MANUAL ATTENTION/, 'and a clean run says nothing of the kind');
});

test('folding the snapshot into the plan ledger keeps every holder', { skip: PHASE.hold }, () => {
  const snapshot: ProcessStateSnapshot = new Map([
    [
      'aaa',
      {
        uniqueId: 'aaa',
        name: 'Target',
        numericId: 1,
        wasArchived: true,
        isArchivedNow: false,
        originalGroupUniqueId: 'g',
        originalGroupId: 100,
        originalGroupExists: true,
        restoredByThisRun: true,
      },
    ],
  ]);
  const row = (r: Partial<PlanLedgerRow> & Pick<PlanLedgerRow, 'uniqueId' | 'name'>): PlanLedgerRow => ({
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
    ...r,
  });
  const ledger = [
    row({ uniqueId: 'aaa', name: 'Target', originalGroupId: 999, deleted: true }),
    row({ uniqueId: 'bbb', name: 'Holder', originalGroupId: 500, role: 'Holder' }),
  ];
  const merged = mergePlanLedger(ledger, snapshot);
  assert.equal(merged.length, 2, 'the merge keeps both entries where the old assignment kept one');
  assert.equal(merged.find((e) => e.uniqueId === 'aaa')?.originalGroupId, 100, 'the snapshot wins for a process it covers, which is what the assignment was for');
  assert.equal(merged.find((e) => e.uniqueId === 'aaa')?.deleted, true, 'but progress the plan recorded against it is carried across, not reset');
  assert.equal(merged.find((e) => e.uniqueId === 'bbb')?.role, 'Holder', 'and an entry the snapshot never knew about survives intact');
});

// ---------------------------------------------------------------- both archived-list readers page identically
// The script had two archived readers, one at PageSize 20. The gateway has one listing
// call at one page size, so they cannot disagree; what is left to check is the size, and
// that the archived source reads past a full page.

test('the listing reads at a page size of 200', () => {
  assert.equal(LIST_PAGE_SIZE, 200, 'that page size is 200, not 20');
});

test('the archived source reads every page, as the index does', { skip: PHASE.unwind }, async () => {
  const many = Array.from({ length: LIST_PAGE_SIZE + 50 }, (_, i): FakeProcessSeed => ({
    uniqueId: `abcd0000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    name: `Archived ${i}`,
    archived: true,
    groupId: 100,
  }));
  const { plan } = await run(scenario(many), { dryRun: true });
  assert.equal(plan?.targetUniqueIds.length, LIST_PAGE_SIZE + 50, 'the archived source and the index both read past the first page');
});

// ---------------------------------------------------------------- NEW (T1): every exit path, and the resumed run

// The holders' synthetic models hold none of the references the target's dependency check
// claims, so reconciliation reports a mismatch, and an unattended run stops there, as the
// script's does. The tests below that need to get further answer that gate yes.
const pastMismatches = { mismatches: () => true } as const;

// NEW (T1): the operator declines the delete at the last confirmation, after the run has
// un-archived two holders for discovery, one of them parked. That exit, too, puts back
// holders and target with a row each.
test('NEW (T1): declining the delete puts back every process the run un-archived', { skip: PHASE.unwind }, async () => {
  const tenant = holderTenant(false);
  const { rows } = await run(tenant, {
    source: r11Source,
    acceptCollateral: true,
    decisions: { ...pastMismatches, confirmDelete: () => false },
  });

  assert.equal(tenant.deleted.length, 0, 'nothing is deleted');
  for (const id of [R11_TARGET, R11_HOLDER, R11_DEAD_HOLDER]) {
    assert.equal(tenant.isArchived(id), true, `${id}: archived again`);
    assert.equal(rows.filter((r) => r.objectId === id && /^ReArchive/.test(r.operation)).length, 1, `${id}: one unwind row`);
  }
  assert.equal(holdingGroupDeleted(tenant), true, 'and the holding group, empty again, is removed');
});

// NEW (T1): "a results file never omits a process the run changed". Every process that
// received a call changing it has at least one row, on a run that restores holders.
test('NEW (T1): every process the run changed has a results row', { skip: PHASE.unwind }, async () => {
  const tenant = holderTenant(false);
  const { rows } = await run(tenant, { source: r11Source, acceptCollateral: true, decisions: pastMismatches });
  assert.ok(tenant.deleted.includes(R11_TARGET), 'the run went all the way to the delete');

  const changed = new Set(
    tenant.calls
      .filter((c) => PROCESS_MUTATIONS.has(c.op) && c.failedWith === undefined && c.uniqueId !== undefined)
      .map((c) => c.uniqueId!.toLowerCase()),
  );
  assert.ok(changed.size >= 3, 'the run changed the target and both holders');
  for (const id of changed) {
    assert.ok(rows.some((r) => r.objectId.toLowerCase() === id), `${id}: changed on the tenant, and named in the results`);
  }
});

// NEW (T1): a run that dies mid-way (here the session ends at its first archive call, after
// the Hold phase and planning have un-archived three processes) can do nothing more
// against the tenant. What it must leave is a saved plan naming every process
// it un-archived, holders included, and that plan, uploaded again, must finish the job.
test('NEW (T1): a run that dies leaves a plan that a resumed unwind finishes', { skip: PHASE.unwind }, async () => {
  const tenant = holderTenant(false);
  tenant.fail = (call) => (call.op === 'archive' ? { status: 401, message: 'session ended' } : null);
  const store = new FakePlanStore().watch(tenant);
  await assert.rejects(
    runBulkDelete(tenant, {
      siteUrl: SITE,
      source: r11Source,
      planStore: store,
      acceptCollateral: true,
      decisions: pastMismatches,
      isFatal: (e) => ((e as { status?: number }).status === 401 ? 'Your session ended.' : null),
    }),
    'a fatal error ends the run',
  );

  const saved = store.latest();
  assert.ok(saved, 'a plan was saved');
  for (const id of [R11_TARGET, R11_HOLDER, R11_DEAD_HOLDER]) {
    const entry: PlanLedgerRow | undefined = saved?.ledger.find((e) => e.uniqueId === id);
    assert.equal(entry?.restoredByThisRun, true, `${id}: the saved plan records that this run un-archived it`);
  }
  assert.equal(saved?.ledger.find((e) => e.uniqueId === R11_DEAD_HOLDER)?.parkedInHoldingGroup, true, 'and which one was parked');
  assert.equal(saved?.holdingGroup?.uniqueId, TEMP.uniqueId, 'and the holding group it was parked in');

  // Signed in again.
  tenant.fail = undefined;
  const resumed = await resumeUnwind(tenant, saved!, { planStore: store });
  for (const id of [R11_TARGET, R11_HOLDER, R11_DEAD_HOLDER]) {
    assert.equal(tenant.isArchived(id), true, `${id}: archived again by the resumed unwind`);
    assert.equal(resumed.results.filter((r) => r.objectId === id && /^ReArchive/.test(r.operation)).length, 1, `${id}: one row`);
  }
  assert.equal(holdingGroupDeleted(tenant), true, 'and the holding group is removed once it lists nothing');
});

// ---------------------------------------------------------------- NEW (T2): the parked holder's order of events

// NEW (T2): an orphaned holder is restored into the holding group, read there, and
// re-archived before the holding group is removed. The PowerShell checks the end state;
// this checks the order, from the call log.
test('NEW (T2): a parked holder is read while held and archived before the holding group goes', { skip: PHASE.unwind }, async () => {
  const tenant = holderTenant(false);
  const { rows } = await run(tenant, { source: r11Source, acceptCollateral: true });

  const at = (predicate: (c: (typeof tenant.calls)[number]) => boolean) => tenant.calls.findIndex(predicate);
  const parkedAt = at((c) => c.op === 'restore' && c.uniqueId === R11_DEAD_HOLDER && c.groupId === TEMP.id && c.failedWith === undefined);
  const checkedAfter = at((c) => c.op === 'checkDependencies' && c.uniqueId === R11_TARGET && tenant.calls.indexOf(c) > parkedAt);
  const archives = tenant.calls.map((c, i) => (c.op === 'archive' && c.uniqueId === R11_DEAD_HOLDER ? i : -1));
  const archivedAt = Math.max(...archives);
  const removedAt = at((c) => c.op === 'deleteGroup' && c.groupUniqueId === TEMP.uniqueId);

  assert.ok(parkedAt >= 0, 'restored into the holding group');
  assert.ok(checkedAfter > parkedAt, 'discovery runs again while it is held, so its hidden edges are read');
  assert.ok(archivedAt > parkedAt && removedAt > archivedAt, 'archived again before the holding group is removed');
  assert.equal(rows.find((r) => r.objectId === R11_DEAD_HOLDER)?.groupId, String(TEMP.id), 'and its row names the group it was archived in');
});
