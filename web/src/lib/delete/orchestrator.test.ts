// W5 phase 7 (unwind and orchestrator): what the ported Test-BulkDelete scenarios do not
// reach. The holding group on a run with no archived target, the stop reason, the
// draft-holder ticks reaching the run, the hard stop on an incomplete plan, and a resumed
// unwind that leaves alone collateral the interrupted run already put back.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultRow, type ResultRow } from '../exec/report.ts';
import { deleteResultsSummary, resumeUnwind, runBulkDelete, type BulkDeleteOptions } from './bulkDelete.ts';
import type { DeleteEvent } from './events.ts';
import { HOLDING_GROUP_NAME, type GroupRef } from './gateway.ts';
import { newDependencyPlan } from './ledger.ts';
import type { ProcessModel } from './model.ts';
import { FakeTenant, type FakeProcessSeed, type FakeTenantOptions } from './testing/fakeTenant.ts';
import { readFixture } from './testing/fixtures.ts';
import { FakePlanStore } from './testing/planStore.ts';

const SITE = 'https://example.invalid/tenant';
const HOME: GroupRef = { id: 100, uniqueId: 'group-100-home', name: 'Home' };
const TEMP: GroupRef = { id: 830, uniqueId: 'group-830-temp', name: HOLDING_GROUP_NAME };
const T1 = 'efef0000-0000-0000-0000-000000000001';
const X1 = 'efef0000-0000-0000-0000-0000000000a1';
const M1 = 'efef0000-0000-0000-0000-0000000000b1';

const rowsOf = (rows: readonly ResultRow[], operation: string) => rows.filter((r) => r.operation === operation);

function scenario(processes: FakeProcessSeed[], options: FakeTenantOptions = {}): FakeTenant {
  return new FakeTenant({ groups: [HOME], holdingGroup: TEMP, processes, ...options });
}

async function run(tenant: FakeTenant, options: Partial<BulkDeleteOptions> = {}) {
  const store = new FakePlanStore();
  const events: DeleteEvent[] = [];
  const result = await runBulkDelete(tenant, {
    siteUrl: SITE,
    source: { kind: 'ids', ids: [T1] },
    planStore: store,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { rows: result.results, events, plan: store.latest() };
}

const stopped = (events: readonly DeleteEvent[]) => events.filter((e) => e.kind === 'stopped').map((e) => (e.kind === 'stopped' ? e.reason : ''));

test('a run with only active targets still has a holding group, and removes it when empty', async () => {
  // A holder whose group is gone can only be read from the holding group; the script
  // blocked on one whenever every target was active.
  const tenant = scenario([{ uniqueId: T1, name: 'Raise invoice', groupId: HOME.id }]);
  const { rows, plan } = await run(tenant);

  assert.equal(tenant.callsTo('createGroup').length, 1);
  assert.ok(tenant.deletedGroups.includes(TEMP.uniqueId), 'removed once it lists nothing');
  assert.equal(rowsOf(rows, 'Cleanup')[0]?.status, 'Success');
  assert.deepEqual(tenant.deleted, [T1]);
  assert.equal(plan?.status, 'Completed');
  assert.equal(plan?.holdingGroup?.uniqueId, TEMP.uniqueId, 'the plan names it, so a resumed unwind can remove it');
});

test('an unattended stop says why, and the unwind still runs', async () => {
  const tenant = scenario(
    [
      { uniqueId: T1, name: 'Order Handling (AU)', archived: true, groupId: HOME.id, batchReadable: false },
      { uniqueId: M1, name: 'Order Handling', groupId: HOME.id, batchReadable: false },
    ],
    { after: (call, t) => call.op === 'restore' && call.uniqueId === T1 && t.setArchived(M1, true) },
  );
  const { events, rows } = await run(tenant);
  assert.equal(stopped(events).length, 1);
  assert.match(stopped(events)[0] ?? '', /restored\. Nothing has been deleted/);
  assert.equal(rowsOf(rows, 'ReArchive')[0]?.status, 'Success', 'the target went home');
});

// ---------------------------------------------------------------- draft holders: the tick reaches the run

type Fixture = ProcessModel & { UniqueId: string; Name: string };
const occurrences = (type: string, model: Fixture, n: number) => ({
  Type: type,
  Dependencies: Array.from({ length: n }, () => ({ Name: model.Name, UniqueId: model.UniqueId })),
});

function draftTenant() {
  const holder = readFixture<Fixture>('ActionCustomerRequest.json');
  const target = readFixture<Fixture>('DependencyTest.json');
  const tenant = new FakeTenant({
    holdingGroup: TEMP,
    processes: [
      {
        uniqueId: holder.UniqueId,
        name: holder.Name,
        model: { ...holder, ProcessRevisionStateId: 1, Version: '3.1' },
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

test('unticked, a draft holder keeps its target, and the run finishes without deleting it', async () => {
  const { tenant, holder, target } = draftTenant();
  const asked: string[][] = [];
  const { rows } = await run(tenant, {
    source: { kind: 'ids', ids: [target.UniqueId] },
    decisions: { publishDrafts: (drafts) => (asked.push(drafts.map((d) => d.holderUniqueId)), []) },
  });

  assert.deepEqual(asked, [[holder.UniqueId]], 'the operator is asked about the draft holder, by id');
  assert.equal(tenant.exists(target.UniqueId), true);
  assert.equal(rowsOf(rows, 'RemoveReferences')[0]?.status, 'Failed');
  assert.equal(rowsOf(rows, 'Delete')[0]?.status, 'Skipped');
  assert.equal(tenant.callsTo('saveModel').length, 0);
});

test('ticked, the draft is published with the removal and the target is deleted', async () => {
  const { tenant, holder, target } = draftTenant();
  const { rows } = await run(tenant, {
    source: { kind: 'ids', ids: [target.UniqueId] },
    decisions: { publishDrafts: () => [holder.UniqueId] },
  });
  assert.match(rowsOf(rows, 'RemoveReferences')[0]?.message ?? '', /open draft went live/);
  assert.equal(tenant.exists(target.UniqueId), false);
});

// ---------------------------------------------------------------- an incomplete plan stops a real run

test('a plan the scan could not finish stops the run before any reference is removed, naming what went unread', async () => {
  const tenant = scenario(
    [
      { uniqueId: T1, name: 'Raise invoice', groupId: HOME.id },
      { uniqueId: X1, name: 'Old intake', archived: true, groupId: HOME.id },
    ],
    { fail: (call) => (call.op === 'readArchivedModels' ? { status: 400, message: 'Bad request' } : null) },
  );
  const { events, plan } = await run(tenant);

  assert.equal(plan?.status, 'PlannedIncomplete');
  assert.match(stopped(events)[0] ?? '', /This plan is incomplete/);
  assert.match(stopped(events)[0] ?? '', new RegExp(X1));
  assert.equal(tenant.deleted.length, 0);
  assert.equal(tenant.callsTo('saveModel').length + tenant.callsTo('archive').length, 0, 'nothing written past the holding group');
  assert.ok(tenant.deletedGroups.includes(TEMP.uniqueId), 'and the holding group is removed');
});

// ---------------------------------------------------------------- a resumed unwind and collateral already put back

test('a resumed unwind reverses only the collateral that is still changed', async () => {
  const tenant = scenario(
    [
      { uniqueId: M1, name: 'Order Handling', groupId: HOME.id },
      { uniqueId: X1, name: 'Old intake', archived: true, groupId: HOME.id },
    ],
    { groups: [HOME, TEMP] },
  );
  const plan = newDependencyPlan(SITE, [T1]);
  plan.holdingGroup = TEMP;
  const change = (uniqueId: string, name: string) => ({
    uniqueId,
    name,
    change: 'Archived' as const,
    wasArchived: false,
    isArchivedNow: true,
    originalGroupId: HOME.id,
    currentGroupId: HOME.id,
    originalGroupExists: true,
  });
  // M1 was put back before the run died; X1 is still archived.
  plan.collateral = [change(M1, 'Order Handling'), change(X1, 'Old intake')];

  const resumed = await resumeUnwind(tenant, plan, { planStore: new FakePlanStore() });
  const reverse = rowsOf(resumed.results, 'ReverseCollateral');
  assert.deepEqual(reverse.map((r) => r.objectId), [X1], 'the one still changed');
  assert.equal(tenant.callsTo('restore', M1).length, 0, 'an active process is not sent RestoreProcess');
  assert.equal(tenant.isArchived(X1), false);
  assert.ok(tenant.deletedGroups.includes(TEMP.uniqueId));
});

// ---------------------------------------------------------------- the summary

test('the summary counts a process raised by two producers once, and leaves accepted ones out', () => {
  const row = (status: string, message: string, name = 'Order Handling') =>
    resultRow({ objectId: M1, name, operation: 'Collateral', status, message });
  const summary = deleteResultsSummary([
    row('Failed', 'Changed without being a target (Archived); detected after deletion'),
    row('Failed', "Left stranded in the holding group 'x'", 'Order'),
    resultRow({ objectId: X1, name: 'Old intake', operation: 'Collateral', status: 'Accepted', message: 'accepted' }),
  ]);
  assert.equal(summary.collateral.length, 1);
  assert.equal(summary.collateral[0]?.label, 'Order Handling', 'the fullest name wins');
  assert.equal(summary.collateral[0]?.messages.length, 2);
  assert.equal(summary.accepted, 1);
  assert.match(summary.lines.join('\n'), /THIS RUN CHANGED PROCESSES IT WAS NOT ASKED TO/);
});

// ---------------------------------------------------------------- the holder only the archive scan finds

test('an archived holder only the archive scan finds is restored, edited, and archived again', async () => {
  // Found by the offline run: the script recorded such a holder and never restored it, so
  // its hidden Input could not be removed and verification stopped every run that had one.
  const holderModel: ProcessModel = {
    UniqueId: X1,
    Name: 'Old intake',
    Version: '1.0',
    ProcessRevisionStateId: 3,
    Inputs: { Input: [{ Id: 1, FromProcessUniqueId: T1 }] },
  };
  const tenant = scenario([
    { uniqueId: T1, name: 'Raise invoice', groupId: HOME.id },
    { uniqueId: X1, name: 'Old intake', archived: true, groupId: HOME.id, model: holderModel },
  ]);
  const { rows, plan } = await run(tenant);

  assert.equal(tenant.callsTo('restore', X1)[0]?.groupId, HOME.id, 'restored in place, into its own group');
  assert.equal(rowsOf(rows, 'RemoveReferences')[0]?.status, 'Success', 'its hidden reference is removed');
  assert.deepEqual(tenant.deleted, [T1], 'so the target can be deleted');
  assert.equal(tenant.isArchived(X1), true, 'and the holder is archived again');
  assert.equal(rows.find((r) => r.objectId === X1 && r.operation === 'ReArchiveHolder')?.status, 'Success');
  assert.equal(plan?.ledger.find((e) => e.uniqueId === X1)?.restoredByThisRun, true);
});

test('a run that dies keeps its rows in the plan, and the resumed unwind reports them with its own', async () => {
  const holderModel: ProcessModel = {
    UniqueId: X1,
    Name: 'Old intake',
    Version: '1.0',
    ProcessRevisionStateId: 3,
    Inputs: { Input: [{ Id: 1, FromProcessUniqueId: T1 }] },
  };
  const tenant = scenario([
    { uniqueId: T1, name: 'Raise invoice', groupId: HOME.id },
    { uniqueId: X1, name: 'Old intake', archived: true, groupId: HOME.id, model: holderModel },
  ]);
  // The session ends at the pre-delete archive, after the holder was edited and published.
  tenant.fail = (call) => (call.op === 'archive' ? { status: 401, message: 'session ended' } : null);
  const store = new FakePlanStore();
  const isFatal = (e: unknown) => ((e as { status?: number }).status === 401 ? 'Your session ended.' : null);
  await assert.rejects(runBulkDelete(tenant, { siteUrl: SITE, source: { kind: 'ids', ids: [T1] }, planStore: store, isFatal }));

  const saved = store.latest();
  assert.equal(saved?.interruptedResults?.find((r) => r.objectId === X1)?.operation, 'RemoveReferences', 'the edit is on record');

  tenant.fail = undefined;
  const resumed = await resumeUnwind(tenant, saved!, { planStore: store });
  const ops = resumed.results.filter((r) => r.objectId === X1).map((r) => r.operation);
  assert.deepEqual(ops, ['RemoveReferences', 'ReArchiveHolder'], 'the results file names the edit and the re-archive');
  assert.equal(tenant.isArchived(X1), true);
});
