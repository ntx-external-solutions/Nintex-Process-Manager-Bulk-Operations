// F8: delete in link order, break link cycles, retry refused deletes, keep the category in
// a refusal, and hold back what a process group ties down. The fake tenant runs with
// `linkRules`: the delete refusals and the one-sided dependency check measured on 4 Nov.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failureOf } from '../archive/outcome.ts';
import type { ResultRow } from '../exec/report.ts';
import { deleteConfirmationLines, runBulkDelete, type BulkDeleteOptions, type DeleteConfirmation } from './bulkDelete.ts';
import { deletePlanTargets, deleteRefusalText, MAX_DELETE_PASSES } from './executor.ts';
import { HOLDING_GROUP_NAME, type GroupRef } from './gateway.ts';
import { newDependencyPlan, parsePlan, serializePlan, tenantStateSnapshot } from './ledger.ts';
import type { ProcessModel } from './model.ts';
import { loadDeleteIndex, planSummaryLines } from './planner.ts';
import { FakeTenant, type FakeProcessSeed, type FakeTenantOptions } from './testing/fakeTenant.ts';
import { FakePlanStore } from './testing/planStore.ts';

const SITE = 'https://example.invalid/tenant';
const HOME: GroupRef = { id: 100, uniqueId: 'group-100-home', name: 'Home' };
const TEMP: GroupRef = { id: 830, uniqueId: 'group-830-temp', name: HOLDING_GROUP_NAME };
const id = (n: string) => `f8f80000-0000-0000-0000-0000000000${n}`;
const [A, B, C, D, E] = ['0a', '0b', '0c', '0d', '0e'].map(id) as [string, string, string, string, string];
const HOLDER = id('a1');

const rowsOf = (rows: readonly ResultRow[], operation: string) => rows.filter((r) => r.operation === operation);
const rowFor = (rows: readonly ResultRow[], operation: string, uniqueId: string) => rows.find((r) => r.operation === operation && r.objectId === uniqueId);

function linking(uniqueId: string, to: readonly string[], overrides: Partial<ProcessModel> = {}): ProcessModel {
  return {
    UniqueId: uniqueId,
    Name: `Process ${uniqueId.slice(-2)}`,
    Version: '1.0',
    ProcessRevisionStateId: 3,
    GroupId: HOME.id,
    ProcessProcedures: { ProcessLink: to.map((t, i) => ({ Id: i + 1, LinkedProcessUniqueId: t })) },
    Inputs: null,
    Outputs: null,
    ...overrides,
  };
}

const seed = (uniqueId: string, to: readonly string[] = [], extra: Partial<FakeProcessSeed> & { modelOverrides?: Partial<ProcessModel> } = {}): FakeProcessSeed => {
  const { modelOverrides, ...rest } = extra;
  return { uniqueId, name: `Process ${uniqueId.slice(-2)}`, groupId: HOME.id, model: linking(uniqueId, to, modelOverrides), ...rest };
};

function scenario(processes: FakeProcessSeed[], options: FakeTenantOptions = {}): FakeTenant {
  return new FakeTenant({ groups: [HOME], holdingGroup: TEMP, linkRules: true, restoreActive: 'refuse', processes, ...options });
}

async function run(tenant: FakeTenant, ids: readonly string[], options: Partial<BulkDeleteOptions> = {}) {
  const store = new FakePlanStore();
  const result = await runBulkDelete(tenant, { siteUrl: SITE, source: { kind: 'ids', ids: [...ids] }, planStore: store, ...options });
  return { rows: result.results, plan: store.latest() };
}

const passNumbers = (rows: readonly ResultRow[]) => rowsOf(rows, 'Delete').map((r) => r.message);

// ---------------------------------------------------------------- the measured tenant

test('the fake tenant answers as measured: linked-to side only, twice once the holder is published', async () => {
  const tenant = scenario([seed(A, [B]), seed(B), seed(C, [B], { modelOverrides: { Version: '0.1', ProcessRevisionStateId: 1 } })]);
  const named = (answer: unknown) => (answer as Array<{ Dependencies: Array<{ UniqueId: string }> }> | null)?.[0]?.Dependencies.map((d) => d.UniqueId);
  assert.deepEqual(named(await tenant.checkDependencies(B)), [A, A, C]);
  assert.equal(await tenant.checkDependencies(A), null, 'the holder sees nothing');
});

test('the fake tenant counts a link until the removal is published, and refuses with the body R14 captured', async () => {
  const tenant = scenario([seed(A, [B]), seed(B)]);
  await assert.rejects(tenant.deleteProcess(B, null), (error) => failureOf(error).status === 500);

  const saved = linking(A, [], { ProcessRevisionEditId: 2 });
  await tenant.saveModel(A, { ProcessJson: JSON.stringify(saved) } as never);
  await assert.rejects(tenant.deleteProcess(B, null), (error) => failureOf(error).status === 500);

  await tenant.publishNow(A, 2, 'published');
  await tenant.deleteProcess(B, null);
  assert.equal(tenant.exists(B), false);
});

// ---------------------------------------------------------------- 1. order

test('a chain given backwards is deleted in link order, in one pass, with nothing edited', async () => {
  const tenant = scenario([seed(A, [B]), seed(B, [C]), seed(C)]);
  const { rows, plan } = await run(tenant, [C, B, A]);

  assert.deepEqual(tenant.deleted, [A, B, C]);
  assert.deepEqual(passNumbers(rows), ['Deleted', 'Deleted', 'Deleted']);
  assert.equal(tenant.callsTo('deleteProcess').length, 3, 'one delete each');
  assert.equal(tenant.callsTo('saveModel').length, 0);
  assert.equal(rowsOf(rows, 'RemoveReferences').length, 0);
  assert.deepEqual(plan?.targetUniqueIds, [C, B, A], 'the targets as given stay as given');
  assert.deepEqual(plan?.deleteOrder, [A, B, C]);
});

test('the order is in the plan file, read back from a saved plan, and a plan from before it deletes as listed', async () => {
  const fromFile = parsePlan(serializePlan({ ...newDependencyPlan(SITE, [C, B, A]), deleteOrder: [A, B, C] }))!;
  const tenant = scenario([seed(A), seed(B), seed(C)]);
  await deletePlanTargets(tenant, fromFile);
  assert.deepEqual(tenant.deleted, [A, B, C]);

  const older = scenario([seed(A), seed(B), seed(C)]);
  await deletePlanTargets(older, newDependencyPlan(SITE, [C, B, A]));
  assert.deepEqual(older.deleted, [C, B, A]);

  // An order naming a process since dropped, and missing one, still deletes every target once.
  const stale = scenario([seed(A), seed(B)]);
  await deletePlanTargets(stale, { ...newDependencyPlan(SITE, [A, B]), deleteOrder: [B, C] });
  assert.deepEqual(stale.deleted, [B, A]);
});

test('archived targets are ordered too, and each goes back or goes on as before', async () => {
  const tenant = scenario([seed(A, [B], { archived: true }), seed(B, [], { archived: true })]);
  const { rows } = await run(tenant, [B, A]);
  assert.deepEqual(tenant.deleted, [A, B]);
  assert.equal(rowsOf(rows, 'Hold').length, 0);
  assert.ok(tenant.deletedGroups.includes(TEMP.uniqueId), 'and the holding group is emptied and removed');
});

// ---------------------------------------------------------------- 2. cycles

test('a two-process cycle: one RemoveReferences each with the cycle wording, then both deleted', async () => {
  const tenant = scenario([seed(A, [B]), seed(B, [A])]);
  const { rows, plan } = await run(tenant, [A, B]);

  assert.deepEqual(tenant.deleted, [A, B]);
  assert.deepEqual(plan?.linkCycles, [[A, B]]);
  for (const target of [A, B]) {
    assert.match(rowFor(rows, 'RemoveReferences', target)?.message ?? '', /^Edited to break a link cycle between targets: removed 1 reference\(s\) to Process 0., Published$/);
    assert.equal(rowFor(rows, 'RemoveReferences', target)?.status, 'Success');
    assert.equal(tenant.callsTo('saveModel', target).length, 1);
    assert.equal(tenant.callsTo('publishNow', target).length, 1, 'removing a link counts only once published');
  }
  assert.equal(rowsOf(rows, 'RemoveReferences').length, 2);
  assert.deepEqual(passNumbers(rows), ['Deleted', 'Deleted']);
});

test('a three-process cycle: one RemoveReferences each, then all deleted in one pass', async () => {
  const tenant = scenario([seed(A, [B]), seed(B, [C]), seed(C, [A])]);
  const { rows } = await run(tenant, [A, B, C]);
  assert.equal(tenant.deleted.length, 3);
  assert.equal(rowsOf(rows, 'RemoveReferences').length, 3);
  for (const row of rowsOf(rows, 'RemoveReferences')) assert.match(row.message, /break a link cycle between targets/);
  assert.deepEqual(passNumbers(rows), ['Deleted', 'Deleted', 'Deleted']);
});

test('only the links inside the loop go: a link out of it, and the rest of the process, are untouched', async () => {
  const tenant = scenario([seed(A, [B, D]), seed(B, [A]), seed(D, [], { name: 'Survives' })]);
  let saved: ProcessModel | null = null;
  tenant.after = (call) => {
    if (call.op === 'saveModel' && call.uniqueId === A) saved = JSON.parse(call.envelope!.ProcessJson as string) as ProcessModel;
  };
  const { rows } = await run(tenant, [A, B]);

  const links = (saved as unknown as ProcessModel | null)?.['ProcessProcedures'] as { ProcessLink: Array<{ LinkedProcessUniqueId: string }> };
  assert.deepEqual(links.ProcessLink.map((l) => l.LinkedProcessUniqueId), [D]);
  assert.equal(rowFor(rows, 'RemoveReferences', A)?.status, 'Success');
  assert.ok(tenant.exists(D));
});

test('an open draft on a cycle member goes live without being asked about, and its row says so', async () => {
  const tenant = scenario([seed(A, [B], { modelOverrides: { Version: '1.1', ProcessRevisionStateId: 1 } }), seed(B, [A])]);
  let asked = 0;
  const { rows } = await run(tenant, [A, B], {
    decisions: {
      publishDrafts: async () => {
        asked++;
        return [];
      },
    },
  });
  assert.equal(asked, 0, 'that question is about processes that survive');
  assert.deepEqual([...tenant.deleted].sort(), [A, B].sort());
  assert.match(rowFor(rows, 'RemoveReferences', A)?.message ?? '', /its open draft went live with the removal, which is fine as it is about to be deleted$/);
  assert.doesNotMatch(rowFor(rows, 'RemoveReferences', B)?.message ?? '', /draft/);
});

test('an archived cycle member is published over the restore\'s own revision, which is nobody\'s draft', async () => {
  const tenant = scenario([seed(A, [B], { archived: true }), seed(B, [A], { archived: true })]);
  const { rows } = await run(tenant, [A, B]);
  assert.equal(tenant.deleted.length, 2);
  for (const target of [A, B]) {
    assert.equal(tenant.callsTo('publishNow', target).length, 1);
    assert.doesNotMatch(rowFor(rows, 'RemoveReferences', target)?.message ?? '', /draft/);
  }
});

test('a never-published cycle member is saved only, which is all a process with nothing live needs', async () => {
  const tenant = scenario([seed(A, [B], { modelOverrides: { Version: '0.1', ProcessRevisionStateId: 1 } }), seed(B, [A])]);
  const { rows } = await run(tenant, [A, B]);
  assert.equal(tenant.deleted.length, 2);
  assert.equal(tenant.callsTo('publishNow', A).length, 0);
  assert.match(rowFor(rows, 'RemoveReferences', A)?.message ?? '', /SavedUnpublished$/);
});

test('the preview and the final confirmation count and name the targets edited first', async () => {
  const tenant = scenario([seed(A, [B]), seed(B, [A])]);
  let confirmation: DeleteConfirmation | null = null;
  const { plan } = await run(tenant, [A, B], {
    decisions: {
      confirmDelete: async (c) => {
        confirmation = c;
        return false;
      },
    },
  });

  const preview = planSummaryLines(plan!, null).join('\n');
  assert.match(preview, /Targets edited first, to break a link cycle: 2/);
  assert.match(preview, new RegExp(`TARGETS EDITED FIRST, TO BREAK A LINK CYCLE \\(2\\)[\\s\\S]*Process 0a  \\(${A}\\)\\n\\s+link to Process 0b removed`));

  const lines = deleteConfirmationLines(confirmation!).join('\n');
  assert.match(lines, /Edited first, to break a link cycle, 2 target\(s\)/);
  assert.match(lines, new RegExp(`Process 0b  \\(${B}\\)`));
  assert.equal(tenant.callsTo('saveModel').length, 0, 'cancelled at the confirmation: nothing was edited');
});

test('a run stopped at verification has edited no target', async () => {
  const holder = seed(HOLDER, [A], { name: 'Holder' });
  const tenant = scenario([holder, seed(A, [B]), seed(B, [A])], {
    noEffect: (call) => call.op === 'saveModel' && call.uniqueId === HOLDER,
  });
  const { rows } = await run(tenant, [A, B]);
  assert.equal(tenant.deleted.length, 0);
  assert.equal(tenant.callsTo('saveModel', A).length + tenant.callsTo('saveModel', B).length, 0);
  assert.equal(rowsOf(rows, 'Delete').length, 0);
});

// ---------------------------------------------------------------- cycle members that survive

test('a cycle member held back by an unticked draft holder: its row says its links were removed', async () => {
  // D's open draft keeps A, so B's delete needs A's link to B gone. A survives without it.
  const draft = seed(D, [A], { name: 'Draft holder', modelOverrides: { Version: '2.1', ProcessRevisionStateId: 1 } });
  const tenant = scenario([draft, seed(A, [B]), seed(B, [A])]);
  const { rows } = await run(tenant, [A, B]);

  assert.deepEqual(tenant.deleted, [B]);
  const kept = rowFor(rows, 'Delete', A);
  assert.equal(kept?.status, 'Skipped');
  assert.equal(
    kept?.message,
    'Not deleted: Draft holder has an unpublished draft; removing its reference would publish it. Its links to the other targets in the cycle were removed and published, and it stays without them',
  );
  assert.match(rowFor(rows, 'RemoveReferences', A)?.message ?? '', /It is being kept, so it stays without those links$/);
  assert.equal(tenant.callsTo('archive', A).length, 0, 'kept, so neither archived');
  assert.equal(rowFor(rows, 'Delete', B)?.status, 'Success');
  // B's link goes with B: nothing was saved to remove a link to a process that stays.
  assert.equal(rowFor(rows, 'RemoveReferences', B)?.status, 'Skipped');
  assert.equal(tenant.callsTo('saveModel', B).length, 0);
});

test('a cycle member the tenant then refuses: its row says its links were removed, and it is put back', async () => {
  const tenant = scenario([seed(A, [B]), seed(B, [A])], {
    fail: (call) => (call.op === 'deleteProcess' && call.uniqueId === A ? { status: 500, message: 'Locked' } : null),
  });
  const { rows } = await run(tenant, [A, B]);
  assert.deepEqual(tenant.deleted, [B]);
  const row = rowFor(rows, 'Delete', A);
  assert.equal(row?.status, 'Failed');
  assert.match(row?.message ?? '', /Its links to the other targets in the cycle were removed and published, and it stays without them\. Not deleted, so made active again/);
  assert.equal(tenant.isArchived(A), false);
});

test('one cycle member that cannot be saved: the other\'s edit is enough, and the retry finishes it', async () => {
  const tenant = scenario([seed(A, [B]), seed(B, [A])], {
    fail: (call) => (call.op === 'saveModel' && call.uniqueId === B ? { status: 500, message: 'Save failed' } : null),
  });
  const { rows } = await run(tenant, [A, B]);
  assert.equal(rowFor(rows, 'RemoveReferences', B)?.status, 'Failed');
  assert.match(rowFor(rows, 'RemoveReferences', B)?.message ?? '', /Its links remain, so the tenant may refuse the targets in this cycle$/);
  assert.deepEqual(tenant.deleted, [B, A], 'B still linked to A, so A waited for B');
  assert.equal(rowFor(rows, 'Delete', A)?.message, 'Deleted on pass 2, after the processes linking to it were deleted');
});

test('no cycle member can be saved: every delete is refused, and no row claims an edit that did not happen', async () => {
  const tenant = scenario([seed(A, [B]), seed(B, [A])], {
    fail: (call) => (call.op === 'saveModel' ? { status: 500, message: 'Save failed' } : null),
  });
  const { rows } = await run(tenant, [A, B]);
  assert.deepEqual(tenant.deleted, []);
  for (const target of [A, B]) {
    assert.equal(rowFor(rows, 'Delete', target)?.status, 'Failed');
    assert.doesNotMatch(rowFor(rows, 'Delete', target)?.message ?? '', /links to the other targets in the cycle were removed/);
    assert.equal(tenant.isArchived(target), false, 'put back');
  }
});

// ---------------------------------------------------------------- what a kept target keeps

test('what a kept target links to is kept too, before anything is archived or edited for it', async () => {
  // D's draft keeps A; A links to B; H links to B. Without this, H loses its link to B and
  // B is archived, all for a delete the tenant then refuses.
  const draft = seed(D, [A], { name: 'Draft holder', modelOverrides: { Version: '2.1', ProcessRevisionStateId: 1 } });
  const tenant = scenario([draft, seed(A, [B]), seed(B), seed(HOLDER, [B], { name: 'Holder' })]);
  let confirmation: DeleteConfirmation | null = null;
  const { rows } = await run(tenant, [A, B], {
    decisions: {
      confirmDelete: async (c) => {
        confirmation = c;
        return true;
      },
    },
  });

  assert.deepEqual(tenant.deleted, []);
  assert.equal(tenant.callsTo('saveModel').length, 0);
  assert.equal(tenant.callsTo('archive').length, 0);
  assert.equal(rowFor(rows, 'Delete', B)?.message, 'Not deleted: Process 0a links to it and is being kept');
  assert.equal(rowFor(rows, 'RemoveReferences', HOLDER)?.message, 'Not edited: every target it references is being kept');
  assert.deepEqual(confirmation!.heldBack.map((h: DeleteConfirmation['heldBack'][number]) => h.uniqueId), [A, B]);
  assert.equal(confirmation!.deleting.length, 0);
});

// ---------------------------------------------------------------- 3. retry

test('a link the plan cannot see: refused on pass 1, deleted on pass 2, one Delete row', async () => {
  const tenant = scenario([seed(A), seed(B, [], { hiddenLinksTo: [A] })]);
  const { rows, plan } = await run(tenant, [A, B]);

  assert.deepEqual(plan?.deleteOrder, [A, B], 'nothing told the plan otherwise');
  assert.deepEqual(tenant.deleted, [B, A]);
  assert.equal(tenant.callsTo('deleteProcess', A).length, 2);
  assert.equal(tenant.callsTo('deleteProcess', B).length, 1);
  assert.equal(rowFor(rows, 'Delete', A)?.status, 'Success');
  assert.equal(rowFor(rows, 'Delete', A)?.message, 'Deleted on pass 2, after the processes linking to it were deleted');
  assert.equal(rowsOf(rows, 'Delete').length, 2);
  assert.equal(tenant.callsTo('restore', A).length, 0, 'not put back between passes');
  assert.equal(rowFor(rows, 'Archive', A)?.status, 'Success');
});

test('retries repeat while a pass deletes something, in as many passes as the chain takes', async () => {
  // Every link is hidden and each pass frees the next one.
  const tenant = scenario([seed(A), seed(B, [], { hiddenLinksTo: [A] }), seed(C, [], { hiddenLinksTo: [B] }), seed(D, [], { hiddenLinksTo: [C] })]);
  const { rows } = await run(tenant, [A, B, C, D]);
  assert.deepEqual(tenant.deleted, [D, C, B, A]);
  assert.equal(rowFor(rows, 'Delete', D)?.message, 'Deleted');
  assert.equal(rowFor(rows, 'Delete', C)?.message, 'Deleted on pass 2, after the processes linking to it were deleted');
  assert.equal(rowFor(rows, 'Delete', A)?.message, 'Deleted on pass 4, after the processes linking to it were deleted');
});

test('nothing is resent when nothing was deleted after the refusal', async () => {
  const tenant = scenario([seed(A), seed(B)], { fail: (call) => (call.op === 'deleteProcess' && call.uniqueId === B ? { status: 500, message: 'No' } : null) });
  await run(tenant, [A, B]);
  assert.deepEqual(tenant.deleted, [A]);
  assert.equal(tenant.callsTo('deleteProcess', B).length, 1, 'B came after A, so the tenant it was refused by is the tenant it would meet');
});

test('a target refused on every pass has one Failed row, is put back once, and stops at the hard cap', async () => {
  // Length 7, so that each pass frees exactly one and the cap runs out before the chain.
  const ids = ['01', '02', '03', '04', '05', '06', '07'].map(id);
  const processes = ids.map((t, i) => seed(t, [], i > 0 ? { hiddenLinksTo: [ids[i - 1]!] } : {}));
  const tenant = scenario(processes);
  const { rows } = await run(tenant, ids);

  assert.equal(MAX_DELETE_PASSES, 5);
  assert.equal(tenant.deleted.length, 5);
  assert.equal(tenant.callsTo('deleteProcess', ids[0]).length, 5, 'sent on every pass, and not a sixth');
  const refused = rowFor(rows, 'Delete', ids[0]!);
  assert.equal(refused?.status, 'Failed');
  assert.match(refused?.message ?? '', /Sent 5 times, refused each time/);
  assert.equal(rowsOf(rows, 'Delete').length, ids.length, 'one row per target');
  assert.equal(tenant.callsTo('restore', ids[0]).length, 1);
});

test('a delete with no answer from the tenant is not resent: nothing says it did not land', async () => {
  const tenant = scenario([seed(A), seed(B)], { fail: (call) => (call.op === 'deleteProcess' && call.uniqueId === A ? { status: 0, message: 'offline' } : null) });
  await run(tenant, [A, B]);
  assert.equal(tenant.callsTo('deleteProcess', A).length, 1);
});

test('a session that ends between passes leaves a row for every refusal and failed archive', async () => {
  // A's archive fails and it is refused; B goes; the resend finds the session dead.
  let sends = 0;
  const tenant = scenario([seed(A), seed(B)], {
    fail: (call) => {
      if (call.op === 'archive' && call.uniqueId === A) return { status: 400, message: 'Locked' };
      if (call.op !== 'deleteProcess' || call.uniqueId !== A) return null;
      return ++sends === 1 ? { status: 500, message: 'Process Cannot Be Deleted' } : { status: 401 };
    },
  });
  const rows: ResultRow[] = [];
  const plan = newDependencyPlan(SITE, [A, B]);
  plan.ledger = [A, B].map((uniqueId) => ({
    uniqueId,
    name: uniqueId,
    numericId: null,
    wasArchived: false,
    originalGroupUniqueId: HOME.uniqueId,
    originalGroupId: HOME.id,
    originalGroupExists: true,
    restoredByThisRun: false,
    role: 'Target' as const,
    parkedInHoldingGroup: false,
    denormalized: false,
    deleted: false,
  }));
  await assert.rejects(
    deletePlanTargets(tenant, plan, {
      isFatal: (error) => (failureOf(error).status === 401 ? 'Signed out.' : null),
      onRow: (row) => rows.push(row),
    }),
  );
  assert.equal(rowFor(rows, 'Delete', A)?.status, 'Failed');
  assert.match(rowFor(rows, 'Delete', A)?.message ?? '', /The run ended before it could be sent again or put back$/);
  assert.equal(rowFor(rows, 'Archive', A)?.status, 'Failed');
  assert.match(rowFor(rows, 'Archive', A)?.message ?? '', /The delete was not sent$/);
});

// ---------------------------------------------------------------- 4. refusal text

const refusal = (additionalInfos: unknown) =>
  Object.assign(new Error('refused'), {
    status: 500,
    detail: JSON.stringify({ additionalInfos, caption: 'Process Cannot Be Deleted', errorMessage: 'Process cannot be deleted as it has links to the following items' }),
  });

test('a refusal keeps both category keys', () => {
  const text = deleteRefusalText(refusal({ 'linked Process': ['A', 'B'], 'linked Process Group': ['C'] }));
  assert.match(text, /Still referenced by: linked Process: A, B; linked Process Group: C$/);
});

test('a refusal maps a process name to its id when only one process has it, and says when more do', async () => {
  const body = JSON.stringify({
    additionalInfos: { 'linked Process': ['Only one', 'Copied'], 'linked Process Group': ['Only one'] },
    errorMessage: 'Process cannot be deleted as it has links to the following items',
  });
  const copy = (uniqueId: string) => ({ uniqueId, name: 'Copied', groupId: HOME.id });
  const tenant = scenario(
    [{ uniqueId: A, name: 'Target', groupId: HOME.id }, { uniqueId: B, name: 'Only one', groupId: HOME.id }, copy(C), copy(D)],
    { fail: (call) => (call.op === 'deleteProcess' ? { status: 500, message: 'Process cannot be deleted as it has links to the following items', body } : null) },
  );
  const baseline = tenantStateSnapshot(await loadDeleteIndex(tenant));
  const rows = await deletePlanTargets(tenant, newDependencyPlan(SITE, [A]), { tenantBaseline: baseline });
  assert.match(
    rowFor(rows, 'Delete', A)?.message ?? '',
    new RegExp(`Still referenced by: linked Process: Only one \\(${B}\\), Copied \\(name matches more than one process\\); linked Process Group: Only one`),
  );
});

test('a copy this run deleted no longer makes a name ambiguous', async () => {
  const body = JSON.stringify({ additionalInfos: { 'linked Process': ['Copied'] }, errorMessage: 'Process cannot be deleted' });
  const tenant = scenario(
    [{ uniqueId: A, name: 'Target', groupId: HOME.id }, { uniqueId: C, name: 'Copied', groupId: HOME.id }, { uniqueId: D, name: 'Copied', groupId: HOME.id }],
    { fail: (call) => (call.op === 'deleteProcess' && call.uniqueId === A ? { status: 500, message: 'Process cannot be deleted', body } : null) },
  );
  const baseline = tenantStateSnapshot(await loadDeleteIndex(tenant));
  const plan = newDependencyPlan(SITE, [A, C]);
  plan.ledger = [A, C].map((uniqueId) => ({
    uniqueId,
    name: uniqueId === A ? 'Target' : 'Copied',
    numericId: null,
    wasArchived: true,
    originalGroupUniqueId: HOME.uniqueId,
    originalGroupId: HOME.id,
    originalGroupExists: true,
    restoredByThisRun: false,
    role: 'Target' as const,
    parkedInHoldingGroup: false,
    denormalized: false,
    deleted: false,
  }));
  const rows = await deletePlanTargets(tenant, plan, { tenantBaseline: baseline });
  assert.match(rowFor(rows, 'Delete', A)?.message ?? '', new RegExp(`linked Process: Copied \\(${D}\\)`));
});

// ---------------------------------------------------------------- 5. group claims

const GROUP_CLAIM = [{ Type: 'Linked Process Group', Dependencies: [{ Name: 'Reference Library (Group)', UniqueId: 'group-ba' }] }];

test('an active target tied to a group it holds no link to is held back, never archived, and the preview names the group', async () => {
  const tenant = scenario([seed(A, [], { dependencies: GROUP_CLAIM }), seed(B)]);
  const { rows, plan } = await run(tenant, [A, B]);

  assert.deepEqual(tenant.deleted, [B]);
  assert.equal(tenant.callsTo('archive', A).length, 0);
  assert.equal(tenant.callsTo('restore', A).length, 0);
  assert.equal(tenant.callsTo('deleteProcess', A).length, 0);
  assert.equal(rowFor(rows, 'Delete', A)?.status, 'Skipped');
  assert.match(rowFor(rows, 'Delete', A)?.message ?? '', /^Not deleted: The tenant ties it to the process group Reference Library \(Group\)/);
  assert.match(planSummaryLines(plan!, null).join('\n'), new RegExp(`HELD BACK, TIED TO A PROCESS GROUP \\(1\\)[\\s\\S]*\\(${A}\\)\\n\\s+group Reference Library \\(Group\\)`));
});

test('an archived target tied to a group it holds no link to is never restored, and leaves nothing to put back', async () => {
  const tenant = scenario([seed(A, [], { archived: true, dependencies: GROUP_CLAIM }), seed(B, [], { archived: true })]);
  const { rows } = await run(tenant, [A, B]);

  assert.deepEqual(tenant.deleted, [B]);
  assert.equal(tenant.callsTo('restore', A).length, 0, 'the 13 round trips in the customer run were this restore');
  assert.equal(tenant.callsTo('archive', A).length, 0);
  assert.equal(rowsOf(rows, 'ReArchive').length, 0);
  assert.equal(rowFor(rows, 'Delete', A)?.status, 'Skipped');
  assert.equal(tenant.isArchived(A), true);
  assert.equal(tenant.groupOf(A), HOME.id);
});

test('a target with its own group link is listed as blocking the delete, not held back, and not edited', async () => {
  const model = linking(A, [], { ProcessProcedures: { ProcessLink: [], ProcessGroupLink: [{ Id: 9, LinkedProcessGroupUniqueId: 'group-ba' }] } });
  const tenant = scenario([{ uniqueId: A, name: 'Process 0a', groupId: HOME.id, model, dependencies: GROUP_CLAIM }], {
    fail: (call) => (call.op === 'deleteProcess' ? { status: 500, message: 'Process Cannot Be Deleted' } : null),
  });
  const { rows, plan } = await run(tenant, [A]);

  assert.deepEqual(plan?.groupBlocks?.map((b) => b.linkInModel), [true]);
  assert.match(planSummaryLines(plan!, null).join('\n'), /LINKS TO PROCESS GROUPS THAT WILL BLOCK THE DELETE \(1\)[\s\S]*links to group Reference Library \(Group\)/);
  assert.equal(tenant.callsTo('saveModel').length, 0);
  assert.equal(tenant.callsTo('deleteProcess', A).length, 1, 'tried: what a group link really blocks is not measured');
  assert.equal(rowFor(rows, 'Delete', A)?.status, 'Failed');
});

test('nothing is edited for a target held back for a group, and what it links to stays with it', async () => {
  const tenant = scenario([seed(A, [B], { dependencies: GROUP_CLAIM }), seed(B), seed(HOLDER, [A], { name: 'Holder' })]);
  const { rows, plan } = await run(tenant, [A, B]);
  assert.equal(plan?.workItems.length, 0, 'the holder is not listed for an edit it will not get');
  assert.equal(tenant.callsTo('saveModel').length, 0);
  assert.deepEqual(tenant.deleted, []);
  assert.equal(rowFor(rows, 'Delete', B)?.message, 'Not deleted: Process 0a links to it and is being kept');
});

test('a cycle through a target held for a group is not edited: the other members stay too', async () => {
  const tenant = scenario([seed(A, [B], { dependencies: GROUP_CLAIM }), seed(B, [A])]);
  const { rows, plan } = await run(tenant, [A, B]);
  assert.deepEqual(plan?.linkCycles, []);
  assert.equal(tenant.callsTo('saveModel').length, 0);
  assert.deepEqual(rowsOf(rows, 'Delete').map((r) => r.status), ['Skipped', 'Skipped']);
});

// ---------------------------------------------------------------- R16, the live test's shape

test('R16 in miniature: backwards chains, a cycle, a control, and a never-published holder saved only', async () => {
  const [one, two, three, four, c1, c2, g1, n1, t1] = ['11', '12', '13', '14', '21', '22', '31', '41', '42'].map(id) as [string, string, string, string, string, string, string, string, string];
  const tenant = scenario([
    seed(one, [], { archived: true }),
    seed(two, [one], { archived: true }),
    seed(three, [four], { archived: true }),
    seed(four, [], { archived: true }),
    seed(c1, [c2]),
    seed(c2, [c1]),
    seed(g1),
    seed(n1, [t1], { modelOverrides: { Version: '0.1', ProcessRevisionStateId: 1 } }),
    seed(t1),
  ]);
  const { rows } = await run(tenant, [one, two, four, three, c1, c2, g1, t1]);

  assert.equal(tenant.deleted.length, 8);
  assert.ok(tenant.exists(n1), 'the holder is not a target');
  assert.equal(tenant.isArchived(n1), false);
  assert.equal(tenant.callsTo('publishNow', n1).length, 0);
  assert.match(rowFor(rows, 'RemoveReferences', n1)?.message ?? '', /SavedUnpublished/);
  assert.match(rowFor(rows, 'RemoveReferences', c1)?.message ?? '', /break a link cycle/);
  assert.match(rowFor(rows, 'RemoveReferences', c2)?.message ?? '', /break a link cycle/);
  assert.equal(rowsOf(rows, 'Delete').filter((r) => r.message !== 'Deleted').length, 0, 'everything in one pass');
  assert.ok(tenant.deletedGroups.includes(TEMP.uniqueId));
});

test('a model with no UniqueId gives a site with an empty holder, which is no edge', async () => {
  const tenant = scenario([{ uniqueId: A, name: 'Process 0a', groupId: HOME.id, model: { Name: 'Nameless', Version: '1.0', ProcessRevisionStateId: 3, ProcessProcedures: { ProcessLink: [{ Id: 1, LinkedProcessUniqueId: B }] } } }, seed(B)], { linkRules: false });
  const { plan } = await run(tenant, [A, B]);
  assert.deepEqual(plan?.linkEdges, []);
  assert.equal(tenant.deleted.length, 2);
});
