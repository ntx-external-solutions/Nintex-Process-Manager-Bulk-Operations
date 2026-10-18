// W5 phase 4 (reference removal): what the ported suites do not reach on their own. The
// save's stages and failures, the removal's per-holder rows and its verification, and the
// two things Cowork's live check after phase 3 found: the archived batch read takes at
// most 20 ids, and a batch that fails must not be skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failureOf } from '../archive/outcome.ts';
import { REFERENCE_REMOVAL_DESCRIPTION, removePlanReferences, saveProcessModel } from './executor.ts';
import { ARCHIVED_BATCH_SIZE } from './gateway.ts';
import { newDependencyPlan, type DependencyPlan } from './ledger.ts';
import type { ProcessModel } from './model.ts';
import { buildDeletePlan, findHiddenInputOutputReferences, loadDeleteIndex, planSummaryLines } from './planner.ts';
import { findProcessReferenceSites } from './references.ts';
import { FakeTenant, type FakeProcessSeed } from './testing/fakeTenant.ts';

const SITE = 'https://example.invalid/tenant';
const H = 'cdcd0000-0000-0000-0000-00000000000a';
const T = 'cdcd0000-0000-0000-0000-00000000000b';
const id = (n: number) => `cdcd0000-0000-0000-0001-${String(n).padStart(12, '0')}`;
const fatalOn401 = (error: unknown) => (failureOf(error).status === 401 ? 'Signed out.' : null);

/** A holder that links to the target once and takes one Input from it. */
function holderModel(version: string): ProcessModel {
  return {
    UniqueId: H,
    Name: 'Holder',
    Version: version,
    ProcessProcedures: { ProcessLink: [{ Id: 1, LinkedProcessUniqueId: T }, { Id: 2, LinkedProcessUniqueId: 'something-else' }] },
    Inputs: { Input: [{ Id: 3, FromProcessUniqueId: T }] },
    Outputs: null,
    LinkedStakeholders: { LinkedStakeholder: [{ Id: 9 }] },
  };
}

function tenantWith(version: string, extra: FakeProcessSeed[] = []) {
  return new FakeTenant({
    processes: [
      { uniqueId: H, name: 'Holder', model: holderModel(version) },
      { uniqueId: T, name: 'Target' },
      ...extra,
    ],
  });
}

/** A plan with one work item: the holder, both sites, the target. */
function planFor(tenant: FakeTenant): DependencyPlan {
  const plan = newDependencyPlan(SITE, [T]);
  const sites = findProcessReferenceSites(tenant.modelOf(H), [T]);
  plan.sites = sites;
  plan.workItems = [{ holderUniqueId: H, sites, targetsAffected: [T] }];
  plan.ledger = [
    {
      uniqueId: H,
      name: 'Holder',
      numericId: null,
      wasArchived: false,
      originalGroupUniqueId: '',
      originalGroupId: null,
      originalGroupExists: true,
      restoredByThisRun: false,
      role: 'Holder',
      parkedInHoldingGroup: false,
      denormalized: false,
      deleted: false,
    },
  ];
  return plan;
}

// ---------------------------------------------------------------- the save

test('a never-published process is saved and not published', async () => {
  const tenant = tenantWith('0.2');
  const outcome = await saveProcessModel(tenant, H, holderModel('0.2'));
  assert.deepEqual(outcome, { success: true, stage: 'SavedUnpublished', error: null, statusCode: 200 });
  assert.equal(tenant.callsTo('publishNow').length + tenant.callsTo('publishRevisionEdit').length, 0, 'nothing is published');
  assert.equal(tenant.callsTo('saveModel')[0]?.envelope?.ChangeDescription, REFERENCE_REMOVAL_DESCRIPTION, "the script's description by default");
});

test('a published process is published again, by the route approvals call for, with the description as its message', async () => {
  const off = tenantWith('2.0');
  assert.equal((await saveProcessModel(off, H, holderModel('2.0'), { changeDescription: 'Run note' })).stage, 'Published');
  const edit = off.callsTo('publishRevisionEdit')[0];
  assert.equal(edit?.comment, 'Run note', 'approvals off: PublishProcessRevisionEdit, with the message');
  assert.equal(edit?.revisionEditId, off.process(H)?.revisionEditId, 'the revision the save produced, read back');
  assert.equal(off.callsTo('saveModel')[0]?.envelope?.DoSubmitForApproval, false);

  const on = tenantWith('2.0');
  await saveProcessModel(on, H, holderModel('2.0'), { changeDescription: 'Run note', approvalsEnabled: true });
  assert.equal(on.callsTo('publishNow')[0]?.comment, 'Run note', 'approvals on: Publish now, with the message (S2)');
  assert.equal(on.callsTo('saveModel')[0]?.envelope?.DoSubmitForApproval, true);
});

test('a refused save and a refused publish say which stage failed, with the status', async () => {
  const tenant = tenantWith('2.0');
  tenant.fail = (call) => (call.op === 'saveModel' ? { status: 400, message: 'Bad model' } : null);
  const save = await saveProcessModel(tenant, H, holderModel('2.0'));
  assert.equal(save.success, false);
  assert.equal(save.stage, 'Save');
  assert.equal(save.statusCode, 400);
  assert.match(save.error ?? '', /Bad model/);
  assert.equal(tenant.callsTo('publishRevisionEdit').length, 0, 'nothing is published after a refused save');

  tenant.fail = (call) => (call.op === 'publishRevisionEdit' ? { status: 409, message: 'Locked' } : null);
  const publish = await saveProcessModel(tenant, H, holderModel('2.0'));
  assert.equal(publish.stage, 'Publish');
  assert.equal(publish.statusCode, 409);
});

test('a re-read that fails does not pass a published process off as never published', async () => {
  // The script read the version off the re-read alone and reported SavedUnpublished.
  const tenant = tenantWith('2.0');
  tenant.fail = (call) => (call.op === 'readModel' ? { status: 503, message: 'Unavailable' } : null);
  const outcome = await saveProcessModel(tenant, H, holderModel('2.0'));
  assert.equal(outcome.success, false, 'the draft was left unpublished, so it failed');
  assert.equal(outcome.stage, 'Publish');
  assert.match(outcome.error ?? '', /could not be read back/);
});

test('a dead session during the save ends the run', async () => {
  const tenant = tenantWith('2.0');
  tenant.fail = (call) => (call.op === 'saveModel' ? { status: 401 } : null);
  await assert.rejects(saveProcessModel(tenant, H, holderModel('2.0'), { isFatal: fatalOn401 }));
});

// ---------------------------------------------------------------- the removal

test('the removal reads fresh, saves once, carries the run description, and verifies', async () => {
  const tenant = tenantWith('2.0');
  const run = await removePlanReferences(tenant, planFor(tenant), { changeDescription: 'Retiring old processes' });

  assert.equal(run.results.length, 1, 'one row per holder');
  assert.equal(run.results[0]?.operation, 'RemoveReferences');
  assert.equal(run.results[0]?.status, 'Success');
  assert.equal(run.results[0]?.name, 'Holder');
  assert.match(run.results[0]?.message ?? '', /Removed 2 reference\(s\), Published/);
  assert.equal(tenant.callsTo('saveModel')[0]?.envelope?.ChangeDescription, 'Retiring old processes');
  assert.equal(tenant.callsTo('publishNow')[0]?.comment, 'Retiring old processes', 'approvals default on for the engine, as in the script');
  assert.equal(run.verificationFailed.length, 0);

  const after = tenant.modelOf(H);
  assert.equal(findProcessReferenceSites(after, [T]).length, 0, 'nothing to the target survives');
  assert.deepEqual(after?.['LinkedStakeholders'], { LinkedStakeholder: [{ Id: 9 }] }, 'LinkedStakeholders is sent back untouched');
});

test('a holder with nothing left to remove is skipped, and saved never', async () => {
  const tenant = tenantWith('2.0');
  const plan = planFor(tenant);
  tenant.process(H)!.model = { UniqueId: H, Name: 'Holder', Version: '2.0' };
  const run = await removePlanReferences(tenant, plan);
  assert.equal(run.results[0]?.status, 'Skipped');
  assert.equal(tenant.callsTo('saveModel').length, 0);
});

test('a holder that cannot be read fails its row and fails verification', async () => {
  // The script skipped an unreadable holder at verification, so a holder unreadable at
  // both reads reached the delete with its references unchecked.
  const tenant = tenantWith('2.0');
  const plan = planFor(tenant);
  tenant.setArchived(H, true);
  const run = await removePlanReferences(tenant, plan);
  assert.equal(run.results[0]?.status, 'Failed');
  assert.match(run.results[0]?.message ?? '', /Could not fetch process for editing \(it is archived\)/);
  assert.equal(run.verificationFailed.length, 1, 'unread is unverified');
  assert.equal(run.verificationFailed[0]?.unreadReason, 'it is archived');
});

test('a save the tenant answers but drops is caught by verification', async () => {
  const tenant = tenantWith('0.1');
  tenant.noEffect = (call) => call.op === 'saveModel';
  const run = await removePlanReferences(tenant, planFor(tenant));
  assert.equal(run.results[0]?.status, 'Success', 'the save itself was answered 200');
  assert.equal(run.verificationFailed[0]?.remaining.length, 2, 'both references are still there, and verification says so');
});

test('skipping verification reads each holder once', async () => {
  const tenant = tenantWith('0.1');
  await removePlanReferences(tenant, planFor(tenant), { skipVerification: true });
  assert.equal(tenant.callsTo('readModel', H).length, 2, 'the read for the edit and the save\'s re-read, nothing more');
});

test('a dead session during the removal ends the run', async () => {
  const tenant = tenantWith('2.0');
  tenant.fail = (call) => (call.op === 'readModel' ? { status: 401 } : null);
  await assert.rejects(removePlanReferences(tenant, planFor(tenant), { isFatal: fatalOn401 }));
});

// ---------------------------------------------------------------- the archived batch read

/** `n` archived processes, the last of which takes an Input from the target. */
function archiveOf(n: number): FakeProcessSeed[] {
  return Array.from({ length: n }, (_, i) => ({
    uniqueId: id(i + 1),
    name: `Archived ${i + 1}`,
    archived: true,
    model: i === n - 1 ? { UniqueId: id(i + 1), Inputs: { Input: [{ Id: 1, FromProcessUniqueId: T }] } } : { UniqueId: id(i + 1) },
  }));
}

test('the archive scan reads all 45 archived processes, in batches the tenant accepts', async () => {
  const tenant = new FakeTenant({ processes: [{ uniqueId: T, name: 'Target' }, ...archiveOf(45)] });
  const index = await loadDeleteIndex(tenant);
  const scan = await findHiddenInputOutputReferences(tenant, [T], index);

  const batches = tenant.callsTo('readArchivedModels');
  assert.equal(ARCHIVED_BATCH_SIZE, 20, 'the measured limit');
  assert.deepEqual(batches.map((b) => b.uniqueIds?.length), [20, 20, 5]);
  assert.equal(batches.every((b) => b.failedWith === undefined), true, 'none refused');
  assert.equal(new Set(batches.flatMap((b) => b.uniqueIds ?? [])).size, 45, 'every one read');
  assert.equal(scan.unread.length, 0);
  assert.equal(scan.sites.length, 1, 'the reference in the last process is found');
});

test('a larger batch is refused by the fake as the tenant refuses it', async () => {
  const tenant = new FakeTenant({ processes: archiveOf(21) });
  await assert.rejects(tenant.readArchivedModels(archiveOf(21).map((p) => p.uniqueId)), /maximum size is 20/);
});

test('a batch that fails is named, id by id, and the plan comes back incomplete', async () => {
  const tenant = new FakeTenant({ processes: [{ uniqueId: T, name: 'Target' }, ...archiveOf(45)] });
  // The second batch is refused.
  tenant.fail = (call) =>
    call.op === 'readArchivedModels' && call.uniqueIds?.includes(id(21)) ? { status: 400, message: 'Refused for the test' } : null;
  const index = await loadDeleteIndex(tenant);

  const scan = await findHiddenInputOutputReferences(tenant, [T], index);
  assert.equal(scan.unread.length, 20, 'the whole batch is reported unread');
  assert.equal(scan.unread[0]?.name, 'Archived 21', 'named from the index');
  assert.equal(scan.unread[0]?.status, 400);
  assert.equal(scan.sites.length, 1, 'the batches that were read still count');

  const plan = await buildDeletePlan(tenant, { siteUrl: SITE, targetUniqueIds: [T], index, holdingGroupId: 999, allowRestore: true });
  assert.equal(plan.status, 'PlannedIncomplete', 'a real run, and still incomplete');
  assert.equal(plan.unreadByScan?.length, 20);
  const shown = planSummaryLines(plan, index).join('\n');
  assert.match(shown, /NOT READ BY THE INPUT\/OUTPUT SCAN \(20\):/);
  assert.match(shown, /Archived 21 {2}\(cdcd0000-0000-0000-0001-000000000021\)\n\s+HTTP 400: Refused for the test/);
  assert.match(shown, /THIS PLAN IS INCOMPLETE\nThe Input\/Output scan could not read 20 process\(es\)/);
  assert.doesNotMatch(shown, /Preview mode/, 'a real run is not called a preview');
});

test('a dead session during the batch read still ends the run', async () => {
  const tenant = new FakeTenant({ processes: [{ uniqueId: T, name: 'Target' }, ...archiveOf(3)] });
  tenant.fail = (call) => (call.op === 'readArchivedModels' ? { status: 401 } : null);
  const index = await loadDeleteIndex(tenant);
  await assert.rejects(findHiddenInputOutputReferences(tenant, [T], index, { isFatal: fatalOn401 }));
});

test('a plan file from before the reasons were recorded still reads as a preview', () => {
  const plan = newDependencyPlan(SITE, [T]);
  plan.status = 'PlannedIncomplete';
  assert.match(planSummaryLines(plan, null).join('\n'), /Preview mode does not restore archived processes/);
});
