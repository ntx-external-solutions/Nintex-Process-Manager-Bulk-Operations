// The fake tenant is real code the scenario suites stand on, so it is held to the
// tenant behaviour they assume, against the app's own readers where one exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archiveOne, failureOf } from '../../archive/outcome.ts';
import { buildUpdateEnvelope } from '../../pm/processes.ts';
import type { ProcessJson } from '../../pm/types.ts';
import { loadProcessIndex } from '../../tenant/state.ts';
import { readFixture } from './fixtures.ts';
import { FakeTenant } from './fakeTenant.ts';
import { FakePlanStore } from './planStore.ts';
import type { ActiveRead } from '../gateway.ts';
import type { DependencyPlan } from '../ledger.ts';

/** The model off an active read; fails the test if the read said archived. */
async function modelOf(read: Promise<ActiveRead>): Promise<Record<string, unknown>> {
  const r = await read;
  assert.equal(r.kind, 'model', 'the active read returned a model');
  return r.kind === 'model' ? r.model : {};
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const tenant = () =>
  new FakeTenant({
    groups: [{ id: 100, uniqueId: 'group-100-home', name: 'Home' }],
    processes: [
      { uniqueId: A, numericId: 1001, name: 'Alpha', archived: true, groupId: 100, groupExists: true },
      { uniqueId: B, numericId: 1002, name: 'Bravo', archived: false, groupId: 100 },
    ],
    missingGroupIds: [1],
  });

test('the listings split by archive state, page at 200, and report groupExists only where asked', async () => {
  const t = tenant();
  for (let i = 0; i < 250; i++) {
    t.add({ uniqueId: `cccccccc-0000-0000-0000-${String(i).padStart(12, '0')}`, name: `P${i}`, archived: true, groupId: 100 });
  }
  const index = await loadProcessIndex((page, listType) => t.listProcesses(page, listType));
  assert.equal(index.size, 252, 'both sweeps, every page');
  assert.equal(index.get(A.toLowerCase())?.isArchived, true);
  assert.equal(index.get(B.toLowerCase())?.isArchived, false);
  assert.equal(t.callsTo('listProcesses').filter((c) => c.listType === 7).length, 2, 'a full page of 200 is followed by another');

  const firstArchived = await t.listProcesses(1, 7);
  const row = (id: string) => firstArchived.items.find((item) => item.processUniqueId === id) as unknown as Record<string, unknown>;
  assert.equal(row(A)['groupExists'], true, 'reported when the seed says so');
  assert.equal('groupExists' in row(`cccccccc-0000-0000-0000-${'0'.repeat(12)}`), false, 'omitted otherwise');
  t.reportGroupExists = false;
  assert.equal('groupExists' in ((await t.listProcesses(1, 7)).items[0] as unknown as Record<string, unknown>), false);
});

test('restore, archive and delete change what the reads and the group listing see', async () => {
  const t = tenant();
  const group = t.group(100)!;
  assert.deepEqual((await t.groupProcesses(group)).map((p) => p.processUniqueId), [B], 'an archived process is not listed');
  // Measured: 200 with only {success, isArchived}, not a 404. 404 is for a deleted process.
  assert.deepEqual(await t.readModel(A), { kind: 'archived' }, 'the active read says archived, with no model');
  assert.deepEqual(await t.archiveState(A), { found: true, isArchived: true, revisionEditId: null }, 'as getArchiveState reads that envelope');
  assert.equal((await t.readArchivedModels([A]))[0]?.['StateId'], 2, 'the batch read serves it');

  await t.restore(A, 100);
  assert.equal(t.isArchived(A), false);
  assert.equal((await modelOf(t.readModel(A)))['GroupUniqueId'], 'group-100-home', 'the model follows the group it was put in');
  assert.equal((await t.groupProcesses(group)).length, 2);

  await t.archive(B, 'c');
  assert.deepEqual((await t.groupProcesses(group)).map((p) => p.processUniqueId), [A]);
  await t.deleteProcess(B, null);
  assert.equal(t.exists(B), false);
  assert.deepEqual(t.deleted, [B]);
  await assert.rejects(t.readModel(B), (e) => failureOf(e).status === 404, 'a deleted process is the 404');
  assert.equal((await t.archiveState(B)).found, false);
});

test('a refusal carries the status and the tenant message the app reads', async () => {
  const t = tenant();
  await assert.rejects(t.restore(A, 1), (e) => {
    const f = failureOf(e);
    return f.status === 500 && f.detail === 'Internal Server Error';
  }, 'a group that is gone is a 500');
  assert.equal(t.callsTo('restore', A)[0]?.failedWith, 500, 'and the failed call is logged');
  assert.equal(t.isArchived(A), true, 'and changes nothing');

  t.fail = (call) => (call.op === 'checkDependencies' ? { status: 500, message: 'server error' } : null);
  await assert.rejects(t.checkDependencies(B), (e) => failureOf(e).status === 500);
  t.fail = undefined;
  assert.equal(await t.checkDependencies(B), null, 'no dependencies is an empty answer, not a failure');

  t.restoreActive = 'refuse';
  await assert.rejects(t.restore(B, 100), (e) => failureOf(e).status === 500, 'the measured tenant refuses an active one');
  t.restoreActive = 'ignore';
  await t.restore(B, 7);
  assert.equal(t.groupOf(B), 100, 'or accepts it and does nothing');
});

test('a save keeps a ProcessJson string and drops anything else, as the tenant does', async () => {
  const model = readFixture('ActionCustomerRequest.json');
  const id = String(model['UniqueId']);
  const t = new FakeTenant({ processes: [{ uniqueId: id, name: String(model['Name']), model }] });

  const edited = { ...model, Name: 'Edited' } as unknown as ProcessJson;
  await t.saveModel(id, buildUpdateEnvelope(edited, { changeDescription: 'x' }));
  assert.equal((await modelOf(t.readModel(id)))['Name'], 'Edited');
  assert.equal(t.callsTo('saveModel')[0]?.envelope?.SuppressChangeNotification, true, 'the envelope sent is logged');

  const lost = { ...model, Name: 'Lost' } as unknown as ProcessJson;
  const asObject = { ...buildUpdateEnvelope(lost, { changeDescription: 'x' }), ProcessJson: {} as unknown as string };
  await t.saveModel(id, asObject);
  assert.equal((await modelOf(t.readModel(id)))['Name'], 'Edited', 'an object body is silently discarded');
});

test('the app archive reads an archive that took effect as archived', async () => {
  const t = tenant();
  const outcome = await archiveOne(t, B, 'c', { approvalOverride: true, isFatal: () => null });
  assert.equal(outcome.outcome, 'Archived');
  assert.equal(t.isArchived(B), true);
});

test('the plan store remembers what was saved when the first process changed', async () => {
  const t = tenant();
  const store = new FakePlanStore().watch(t);
  // Reads and the holding group are not process mutations.
  await t.listProcesses(1, 0);
  await t.createGroup('Holding', null);
  // Read through a function: an assertion would narrow the field for the rest of the test.
  const atFirst = () => store.atFirstMutation;
  assert.equal(atFirst(), undefined, 'nothing has changed a process yet');

  const plan: DependencyPlan = { ...newPlanShell(), status: 'Holding' };
  await store.save(plan);
  await t.restore(A, 100);
  plan.status = 'Completed';
  await store.save(plan);

  assert.equal(atFirst()?.status, 'Holding', 'the plan as it stood at the first restore');
  assert.equal(store.saves.length, 2);
  assert.equal(store.latest()?.status, 'Completed');
});

// newDependencyPlan is a stub until the hold phase lands, so the shell is spelled out.
function newPlanShell(): DependencyPlan {
  return {
    schemaVersion: 1,
    createdUtc: '2026-01-01T00:00:00.000Z',
    siteUrl: 'https://example.invalid/t',
    status: 'Draft',
    targetUniqueIds: [A],
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

test('a scenario can make a call succeed without effect, or serve archived processes on the active read', async () => {
  const t = tenant();
  t.noEffect = (call) => call.op === 'restore';
  await t.restore(A, 100);
  assert.equal(t.isArchived(A), true, 'accepted, and nothing moved');
  assert.equal(t.callsTo('restore', A).length, 1, 'but the call is still logged');
  t.noEffect = undefined;

  t.activeReadServesArchived = true;
  assert.equal((await modelOf(t.readModel(A)))['StateId'], 2, 'the active read now returns the archived model');
  assert.deepEqual(await t.archiveState(A), { found: true, isArchived: true, revisionEditId: 1 });
});

test('a restore into the group a process is already in keeps the group id the model came with', async () => {
  const model = readFixture('DependencyTest.json');
  const id = String(model['UniqueId']);
  const t = new FakeTenant({ processes: [{ uniqueId: id, name: String(model['Name']), model, archived: true }] });
  await t.restore(id, Number(model['GroupId']));
  assert.equal((await modelOf(t.readModel(id)))['GroupUniqueId'], model['GroupUniqueId']);
});
