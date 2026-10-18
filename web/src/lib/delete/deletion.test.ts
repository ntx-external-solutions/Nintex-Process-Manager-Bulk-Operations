// W5 phase 6 (delete): the archive pass, the two checkpoints around the deletes, the
// Delete rows, and what Cowork's review of phase 5 added: a holder with an open draft is
// refused unless ticked, and the targets it holds are left out of the delete.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ResultRow } from '../exec/report.ts';
import { chooseWritePath, writeStateOf } from '../pm/writePath.ts';
import type { Reconciliation } from './claims.ts';
import { ACCEPTANCE_AUTHORITY } from './collateral.ts';
import { deletePlanTargets, PRE_DELETE_ARCHIVE_COMMENT, removePlanReferences, type HeldBackTarget } from './executor.ts';
import { newDependencyPlan, tenantStateSnapshot, type DependencyPlan } from './ledger.ts';
import type { ProcessModel } from './model.ts';
import { buildDeletePlan, loadDeleteIndex, planSummaryLines } from './planner.ts';
import { FakeTenant, type FakeTenantOptions } from './testing/fakeTenant.ts';
import { readFixture } from './testing/fixtures.ts';

const SITE = 'https://example.invalid/tenant';
const HOME = { id: 100, uniqueId: 'group-home', name: 'Home' };
const T1 = 'dede0000-0000-0000-0000-000000000001';
const T2 = 'dede0000-0000-0000-0000-000000000002';
const MASTER = 'dede0000-0000-0000-0000-00000000000a';
const STRANDED = 'dede0000-0000-0000-0000-00000000000b';

const rowsOf = (rows: readonly ResultRow[], operation: string) => rows.filter((r) => r.operation === operation);

function tenantWith(options: FakeTenantOptions = {}) {
  return new FakeTenant({
    groups: [HOME],
    processes: [
      { uniqueId: T1, name: 'Raise invoice', groupId: HOME.id },
      { uniqueId: T2, name: 'Close account', groupId: HOME.id, archived: true },
      { uniqueId: MASTER, name: 'Something unrelated', groupId: HOME.id },
    ],
    ...options,
  });
}

interface TargetRow {
  uniqueId: string;
  name: string;
  wasArchived?: boolean;
  restoredByThisRun?: boolean;
}

/** A plan over the given targets, as the hold phase leaves it. No holders: removal is not under test here. */
function planFor(targets: readonly TargetRow[]): DependencyPlan {
  const plan = newDependencyPlan(SITE, targets.map((t) => t.uniqueId));
  plan.status = 'Planned';
  plan.ledger = targets.map((t) => ({
    uniqueId: t.uniqueId,
    name: t.name,
    numericId: null,
    wasArchived: t.wasArchived ?? false,
    originalGroupUniqueId: HOME.uniqueId,
    originalGroupId: HOME.id,
    originalGroupExists: true,
    restoredByThisRun: t.restoredByThisRun ?? false,
    role: 'Target',
    parkedInHoldingGroup: false,
    denormalized: false,
    deleted: false,
  }));
  return plan;
}

const baselineOf = async (tenant: FakeTenant) => tenantStateSnapshot(await loadDeleteIndex(tenant));

// ---------------------------------------------------------------- archive, then delete

test('each target is archived first, unless the run found it archived, then deleted with its group', async () => {
  const tenant = tenantWith();
  const plan = planFor([
    { uniqueId: T1, name: 'Raise invoice' },
    { uniqueId: T2, name: 'Close account', wasArchived: true },
  ]);
  const rows = await deletePlanTargets(tenant, plan);

  assert.equal(tenant.callsTo('archive', T1).length, 1, 'an active target is archived before its delete');
  assert.equal(tenant.callsTo('archive', T1)[0]?.comment, PRE_DELETE_ARCHIVE_COMMENT);
  assert.equal(tenant.callsTo('archive', T2).length, 0, 'one found archived and not restored is left as it is');
  assert.deepEqual(tenant.deleted, [T1, T2], 'both are deleted, in plan order');
  assert.equal(tenant.callsTo('deleteProcess', T1)[0]?.groupUniqueId, HOME.uniqueId, 'the group the ledger knows is sent');

  const deletes = rowsOf(rows, 'Delete');
  assert.equal(deletes.length, 2, 'one Delete row per target');
  assert.deepEqual(deletes.map((r) => [r.status, r.message]), [['Success', 'Deleted'], ['Success', 'Deleted']]);
  assert.equal(deletes[0]?.groupId, String(HOME.id), 'the row names the home group');
  assert.ok(plan.ledger.every((r) => r.deleted), 'each deleted target is marked, so the unwind does not try to re-archive it');
  assert.equal(tenant.callsTo('listProcesses').length, 0, 'no baseline, no checkpoint, no re-read');
});

test('a target restored by this run is archived again before its delete', async () => {
  const tenant = tenantWith();
  tenant.setArchived(T2, false);
  await deletePlanTargets(tenant, planFor([{ uniqueId: T2, name: 'Close account', wasArchived: true, restoredByThisRun: true }]));
  assert.equal(tenant.callsTo('archive', T2).length, 1);
  assert.deepEqual(tenant.deleted, [T2]);
});

test('a refused delete is a Failed row with the status, and the ledger is not marked', async () => {
  const tenant = tenantWith({ fail: (call) => (call.op === 'deleteProcess' && call.uniqueId === T1 ? { status: 409, message: 'In use' } : null) });
  const plan = planFor([
    { uniqueId: T1, name: 'Raise invoice' },
    { uniqueId: T2, name: 'Close account', wasArchived: true },
  ]);
  const rows = rowsOf(await deletePlanTargets(tenant, plan), 'Delete');

  assert.equal(rows[0]?.status, 'Failed');
  assert.equal(rows[0]?.message, 'Delete failed (HTTP 409)');
  assert.equal(rows[0]?.statusCode, '409');
  assert.equal(plan.ledger[0]?.deleted, false, 'so the unwind still puts it back');
  assert.equal(rows[1]?.status, 'Success', 'one refusal does not stop the others');
});

test('an archive that fails is logged with its reason, and the delete still goes ahead', async () => {
  const tenant = tenantWith({ fail: (call) => (call.op === 'archive' ? { status: 400, message: 'Locked by another user' } : null) });
  const plan = planFor([{ uniqueId: T1, name: 'Raise invoice' }]);
  const rows = await deletePlanTargets(tenant, plan);
  assert.match(plan.log.join(' '), /Raise invoice .* could not be archived before deletion: .*Locked by another user/);
  assert.equal(rowsOf(rows, 'Delete')[0]?.status, 'Success', 'the tenant decides, not the archive call');
});

test('a dead session during a delete ends the run rather than reading as a refusal', async () => {
  const tenant = tenantWith({ fail: (call) => (call.op === 'deleteProcess' ? { status: 401 } : null) });
  const isFatal = (error: unknown) => ((error as { status?: number }).status === 401 ? 'signed out' : null);
  await assert.rejects(deletePlanTargets(tenant, planFor([{ uniqueId: T1, name: 'Raise invoice' }]), { isFatal }));
});

// ---------------------------------------------------------------- the checkpoint between archive and delete

const masterFollowsArchive: FakeTenantOptions['after'] = (call, t) => {
  if (call.op === 'archive' && call.uniqueId === T1) t.setArchived(MASTER, true);
};

test('collateral from the archive pass stops the run before any delete when nobody accepts it', async () => {
  const tenant = tenantWith({ after: masterFollowsArchive });
  const tenantBaseline = await baselineOf(tenant);
  const plan = planFor([{ uniqueId: T1, name: 'Raise invoice' }]);
  const rows = await deletePlanTargets(tenant, plan, { tenantBaseline });

  assert.equal(tenant.deleted.length, 0, 'nothing is deleted');
  assert.equal(rowsOf(rows, 'Delete').length, 0, 'no Delete row, which is how the orchestrator knows it stopped');
  const collateral = rowsOf(rows, 'Collateral');
  assert.equal(collateral.length, 1);
  assert.equal(collateral[0]?.objectId, MASTER);
  assert.equal(collateral[0]?.status, 'Failed');
  assert.match(collateral[0]?.message ?? '', /\(Archived\); after archiving targets, before deleting; run stopped before anything was deleted/);
  assert.equal(plan.collateral.length, 1, 'recorded in the plan');
  assert.match(plan.log.join(' '), /COLLATERAL after archive phase: .* - Archived/);
});

test('collateral accepted at the gate is recorded as Accepted, then the run deletes and does not raise it again', async () => {
  const tenant = tenantWith({ after: masterFollowsArchive });
  const tenantBaseline = await baselineOf(tenant);
  const asked: string[] = [];
  const rows = await deletePlanTargets(tenant, planFor([{ uniqueId: T1, name: 'Raise invoice' }]), {
    tenantBaseline,
    onCollateral: (collateral, phase) => {
      asked.push(`${phase}: ${collateral.length}`);
      return true;
    },
    acceptanceAuthority: ACCEPTANCE_AUTHORITY.inAdvance,
  });

  assert.deepEqual(asked, ['after archiving targets, before deleting: 1'], 'asked once, at the pre-delete checkpoint only');
  const collateral = rowsOf(rows, 'Collateral');
  assert.equal(collateral.length, 1, 'the post-delete checkpoint does not raise it again');
  assert.equal(collateral[0]?.status, 'Accepted');
  assert.match(collateral[0]?.message ?? '', /accepted in advance on the preview/, 'with the authority the caller gave');
  assert.deepEqual(tenant.deleted, [T1]);
});

test('a change an earlier checkpoint raised is not asked about again', async () => {
  const tenant = tenantWith({ after: masterFollowsArchive });
  const tenantBaseline = await baselineOf(tenant);
  const plan = planFor([{ uniqueId: T1, name: 'Raise invoice' }]);
  plan.collateral.push({
    uniqueId: MASTER,
    name: 'Something unrelated',
    change: 'Archived',
    wasArchived: false,
    isArchivedNow: true,
    originalGroupId: HOME.id,
    currentGroupId: HOME.id,
    originalGroupExists: true,
  });
  const rows = await deletePlanTargets(tenant, plan, { tenantBaseline });
  assert.equal(rowsOf(rows, 'Collateral').length, 0);
  assert.deepEqual(tenant.deleted, [T1], 'so it does not stop the run either');
});

// ---------------------------------------------------------------- the checkpoint after the deletes

test('collateral the delete causes is reported as Failed and put back where it can be proved', async () => {
  const tenant = tenantWith({ after: (call, t) => call.op === 'deleteProcess' && call.uniqueId === T1 && t.setArchived(MASTER, true) });
  const tenantBaseline = await baselineOf(tenant);
  const plan = planFor([{ uniqueId: T1, name: 'Raise invoice' }]);
  const rows = await deletePlanTargets(tenant, plan, { tenantBaseline });

  assert.deepEqual(tenant.deleted, [T1], 'the delete happened; this checkpoint cannot prevent anything');
  const collateral = rowsOf(rows, 'Collateral');
  assert.equal(collateral.length, 1);
  assert.equal(collateral[0]?.status, 'Failed', 'so the run cannot finish reporting 0 failed');
  assert.match(collateral[0]?.message ?? '', /detected after deletion/);
  const reverse = rowsOf(rows, 'ReverseCollateral');
  assert.equal(reverse[0]?.status, 'Success');
  assert.equal(tenant.isArchived(MASTER), false, 'the master is active again');
  assert.equal(tenant.groupOf(MASTER), HOME.id, 'in its own group');
  assert.match(plan.log.join(' '), /COLLATERAL after delete phase/);
});

test('what the delete strands is read after the delete, not before', async () => {
  let deleted = false;
  const tenant = tenantWith({
    after: (call, t) => {
      if (call.op !== 'deleteProcess') return;
      deleted = true;
      t.add({ uniqueId: STRANDED, name: 'Grant permit', groupId: 999, listed: false });
    },
  });
  const tenantBaseline = await baselineOf(tenant);
  const plan = planFor([{ uniqueId: T1, name: 'Raise invoice' }]);
  const rows = await deletePlanTargets(tenant, plan, {
    tenantBaseline,
    // The holding group's listing, as the orchestrator reads it.
    getObservedUniqueIds: async () => (deleted ? [STRANDED] : []),
  });

  assert.equal(plan.collateral.length, 1);
  assert.equal(plan.collateral[0]?.uniqueId, STRANDED);
  assert.equal(plan.collateral[0]?.change, 'NotInBaseline');
  assert.equal(rowsOf(rows, 'ReverseCollateral')[0]?.status, 'Skipped', 'no before-state, so it is reported, not guessed at');
});

test('a holding-group listing that fails is logged, and the checkpoint still runs on the index', async () => {
  const tenant = tenantWith();
  const plan = planFor([{ uniqueId: T1, name: 'Raise invoice' }]);
  await deletePlanTargets(tenant, plan, {
    tenantBaseline: await baselineOf(tenant),
    getObservedUniqueIds: async () => {
      throw new Error('group listing unavailable');
    },
  });
  assert.match(plan.log.join(' '), /Could not list what the run left in the holding group before deleting/);
  assert.match(plan.log.join(' '), /Could not list what the run left behind/);
  assert.deepEqual(tenant.deleted, [T1]);
});

// ---------------------------------------------------------------- targets held back

test('a held-back target is neither archived nor deleted, and its row says why', async () => {
  const tenant = tenantWith();
  const heldBack: HeldBackTarget[] = [{ targetUniqueId: T1, holderUniqueId: MASTER, reason: 'Something unrelated has an unpublished draft' }];
  const rows = await deletePlanTargets(tenant, planFor([{ uniqueId: T1, name: 'Raise invoice' }]), { heldBack });

  assert.equal(tenant.callsTo('archive', T1).length, 0);
  assert.equal(tenant.deleted.length, 0);
  const row = rowsOf(rows, 'Delete')[0];
  assert.equal(row?.status, 'Skipped');
  assert.equal(row?.message, 'Not deleted: Something unrelated has an unpublished draft');
});

// ---------------------------------------------------------------- holders with an open draft (Cowork's review of phase 5)

type Fixture = ProcessModel & { UniqueId: string; Name: string };

const occurrences = (type: string, model: Fixture, n: number) => ({
  Type: type,
  Dependencies: Array.from({ length: n }, () => ({ Name: model.Name, UniqueId: model.UniqueId })),
});

/** The captured pair (executor.test.ts), with the holder carrying an open draft over 3.0. */
function draftTenant() {
  const holder = readFixture<Fixture>('ActionCustomerRequest.json');
  const target = readFixture<Fixture>('DependencyTest.json');
  const tenant = new FakeTenant({
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

async function draftPlan(tenant: FakeTenant, targetUniqueId: string) {
  const index = await loadDeleteIndex(tenant);
  return {
    index,
    plan: await buildDeletePlan(tenant, { siteUrl: SITE, targetUniqueIds: [targetUniqueId], index, holdingGroupId: 999, allowRestore: true }),
  };
}

test('the plan lists a holder with an open draft under its own heading, with the target it blocks', async () => {
  const { tenant, holder, target } = draftTenant();
  const { plan, index } = await draftPlan(tenant, target.UniqueId);

  assert.equal(plan.draftHolders?.length, 1);
  assert.equal(plan.draftHolders?.[0]?.holderUniqueId, holder.UniqueId);
  assert.equal(plan.draftHolders?.[0]?.version, '3.1');
  assert.deepEqual(plan.draftHolders?.[0]?.targetsBlocked, [target.UniqueId]);

  const lines = planSummaryLines(plan, index);
  const heading = lines.findIndex((l) => l.startsWith('HOLDERS WITH AN UNPUBLISHED DRAFT (1)'));
  assert.ok(heading >= 0, 'its own heading');
  assert.ok(lines.slice(heading).some((l) => l.includes(`blocks ${target.Name}`)), 'naming the target it blocks');
});

test('unticked, a draft holder is Failed before any save, and its target is left out of the delete', async () => {
  const { tenant, holder, target } = draftTenant();
  const { plan } = await draftPlan(tenant, target.UniqueId);
  const removal = await removePlanReferences(tenant, plan);

  assert.equal(tenant.callsTo('saveModel').length, 0, 'nothing is saved');
  const row = removal.results[0];
  assert.equal(row?.status, 'Failed');
  assert.match(row?.message ?? '', /has an unpublished draft; removing the reference would publish it/);
  assert.match(row?.message ?? '', /the target it holds is left out of the delete/);
  assert.deepEqual(removal.heldBack.map((h) => [h.targetUniqueId, h.holderUniqueId]), [[target.UniqueId, holder.UniqueId]]);
  assert.equal(removal.verificationFailed.length, 0, 'a known refusal does not stop the run at verification');

  const rows = await deletePlanTargets(tenant, plan, { heldBack: removal.heldBack });
  assert.equal(tenant.exists(target.UniqueId), true, 'the target survives');
  assert.equal(tenant.callsTo('archive', target.UniqueId).length, 0, 'and is not archived either');
  assert.equal(rowsOf(rows, 'Delete')[0]?.status, 'Skipped');
  assert.match(rowsOf(rows, 'Delete')[0]?.message ?? '', /unpublished draft/);
});

test('ticked, the draft is published with the removal, the row says so, and the target is deleted', async () => {
  const { tenant, holder, target } = draftTenant();
  const { plan } = await draftPlan(tenant, target.UniqueId);
  const removal = await removePlanReferences(tenant, plan, { publishDrafts: [holder.UniqueId.toUpperCase()] });

  assert.equal(tenant.callsTo('publishNow').length, 1, 'saved and published');
  assert.equal(removal.results[0]?.status, 'Success');
  assert.match(removal.results[0]?.message ?? '', /its open draft went live with the removal/);
  assert.equal(removal.heldBack.length, 0);

  const rows = await deletePlanTargets(tenant, plan, { heldBack: removal.heldBack });
  assert.equal(rowsOf(rows, 'Delete')[0]?.status, 'Success');
  assert.equal(tenant.exists(target.UniqueId), false);
});

test('the run decides from its own read: a draft opened after planning is refused just the same', async () => {
  const holder = readFixture<Fixture>('ActionCustomerRequest.json');
  const target = readFixture<Fixture>('DependencyTest.json');
  const { tenant } = draftTenant();
  const proc = tenant.process(holder.UniqueId);
  if (proc?.model) Object.assign(proc.model, { ProcessRevisionStateId: 3, Version: '3.0' });
  const { plan } = await draftPlan(tenant, target.UniqueId);
  assert.equal(plan.draftHolders?.length, 0, 'published when planned');

  if (proc?.model) Object.assign(proc.model, { ProcessRevisionStateId: 1, Version: '3.1' });
  const removal = await removePlanReferences(tenant, plan);
  assert.equal(removal.results[0]?.status, 'Failed');
  assert.equal(removal.heldBack.length, 1);
});

// ---------------------------------------------------------------- the shared write path's draft rule

test('an open draft is saved into by default, refused or published on request, and a 0.x draft is never refused', () => {
  const admin = { CanSave: true, CanPublishAfterEdit: true, CanSubmitForApprovalAfterEdit: true };
  const draft = writeStateOf({ ProcessRevisionStateId: 1, Version: '2.1' }, admin);
  assert.equal(draft.publishedVersionExists, true);
  assert.equal(chooseWritePath(draft, { publish: 'match-state' }), 'save-only', "ownership's rule is unchanged");
  assert.deepEqual(chooseWritePath(draft, { publish: 'match-state', openDraft: 'refuse' }), { refused: 'open-draft' });
  assert.equal(chooseWritePath(draft, { publish: 'match-state', openDraft: 'publish' }), 'publish-direct');
  assert.equal(chooseWritePath(draft, { publish: 'save-only', openDraft: 'publish' }), 'save-only', 'save-only still never publishes');

  const neverPublished = writeStateOf({ ProcessRevisionStateId: 1, Version: '0.4' }, admin);
  assert.equal(neverPublished.publishedVersionExists, false);
  assert.equal(chooseWritePath(neverPublished, { publish: 'match-state', openDraft: 'refuse' }), 'save-only');

  const unknown = writeStateOf({ ProcessRevisionStateId: 1 }, admin);
  assert.equal(unknown.publishedVersionExists, undefined);
  assert.deepEqual(chooseWritePath(unknown, { publish: 'match-state', openDraft: 'refuse' }), { refused: 'open-draft' }, 'unknown is treated as published');
});

// ---------------------------------------------------------------- the summary counts pairs reconciled across categories

test('the summary says how many pairs reconciled across categories, near the top', () => {
  const plan = newDependencyPlan(SITE, [T1]);
  const rec = (relatedUniqueId: string, category: Reconciliation['category'], status: Reconciliation['status']): Reconciliation => ({
    queriedUniqueId: T1,
    relatedUniqueId,
    category,
    claimed: 1,
    located: 0,
    expected: 0,
    suppressed: false,
    status,
    doubleCounted: false,
    note: '',
  });
  // Two rows of one pair, and one of another: two pairs.
  plan.reconciliation = [rec(T2, 'Link', 'MatchAcrossCategories'), rec(T2, 'Input', 'MatchAcrossCategories'), rec(MASTER, 'Link', 'MatchAcrossCategories')];
  const lines = planSummaryLines(plan, null);
  assert.ok(lines.slice(0, 5).some((l) => l.includes('2 pair(s) reconciled across categories')), 'on the count line');
  assert.ok(lines.some((l) => l.startsWith('PAIRS RECONCILED ACROSS CATEGORIES (2)')));
});

// ---------------------------------------------------------------- held back before anything is removed (Cowork's review of phase 6)

const H1 = 'dede0000-0000-0000-0000-0000000000c1';
const H2 = 'dede0000-0000-0000-0000-0000000000c2';
const T3 = 'dede0000-0000-0000-0000-000000000003';

/** A holder linking to each given target once, published at 2.0 or carrying a draft over it. */
function linker(uniqueId: string, targets: readonly string[], draft: boolean): ProcessModel {
  return {
    UniqueId: uniqueId,
    Name: uniqueId === H1 ? 'Draft holder' : 'Clean holder',
    Version: draft ? '2.1' : '2.0',
    ProcessRevisionStateId: draft ? 1 : 3,
    ProcessProcedures: { ProcessLink: targets.map((t, i) => ({ Id: i + 1, LinkedProcessUniqueId: t })) },
  };
}

/** H2 (clean) comes first in the work list and holds T1 and T3; H1 (draft) holds T1. */
function orderingCase(options: FakeTenantOptions = {}) {
  const tenant = new FakeTenant({
    processes: [
      { uniqueId: H2, name: 'Clean holder', model: linker(H2, [T1, T3], false) },
      { uniqueId: H1, name: 'Draft holder', model: linker(H1, [T1], true) },
      { uniqueId: T1, name: 'Raise invoice' },
      { uniqueId: T3, name: 'Send reminder' },
    ],
    ...options,
  });
  const plan = planFor([
    { uniqueId: T1, name: 'Raise invoice' },
    { uniqueId: T3, name: 'Send reminder' },
  ]);
  const holderRow = (uniqueId: string, name: string) => ({ ...plan.ledger[0]!, uniqueId, name, role: 'Holder' as const });
  plan.ledger.push(holderRow(H2, 'Clean holder'), holderRow(H1, 'Draft holder'));
  plan.workItems = [
    { holderUniqueId: H2, sites: [], targetsAffected: [T1, T3] },
    { holderUniqueId: H1, sites: [], targetsAffected: [T1] },
  ];
  return { tenant, plan };
}

const links = (tenant: FakeTenant, holder: string) =>
  ((tenant.modelOf(holder)?.['ProcessProcedures'] as { ProcessLink: { LinkedProcessUniqueId: string }[] }).ProcessLink ?? []).map(
    (l) => l.LinkedProcessUniqueId,
  );

test('a clean holder listed before a draft holder keeps its link to the target the draft keeps alive', async () => {
  const { tenant, plan } = orderingCase();
  const removal = await removePlanReferences(tenant, plan);

  assert.deepEqual(removal.heldBack.map((h) => h.targetUniqueId), [T1], 'T1 is held back before any save');
  assert.deepEqual(links(tenant, H2), [T1], 'H2 lost its link to T3, which is deleted, and kept its link to T1, which is not');
  assert.equal(tenant.callsTo('saveModel', H1).length, 0, 'the draft holder is not saved');
  assert.equal(removal.results.find((r) => r.objectId === H1)?.status, 'Failed');
  assert.equal(removal.verificationFailed.length, 0);

  const rows = await deletePlanTargets(tenant, plan, { heldBack: removal.heldBack });
  assert.deepEqual(tenant.deleted, [T3]);
  assert.equal(rowsOf(rows, 'Delete').find((r) => r.objectId === T1)?.status, 'Skipped');
});

test('a holder whose every target is kept is not edited at all', async () => {
  const { tenant, plan } = orderingCase();
  plan.workItems[0] = { holderUniqueId: H2, sites: [], targetsAffected: [T1] };
  const removal = await removePlanReferences(tenant, plan);
  const row = removal.results.find((r) => r.objectId === H2);
  assert.equal(row?.status, 'Skipped');
  assert.equal(row?.message, 'Not edited: every target it references is being kept');
  assert.equal(tenant.callsTo('saveModel').length, 0);
});

test('a draft opened between the check and the save is still refused, and the log names what was edited for nothing', async () => {
  // Both holders clean at the check; H1 opens a draft once H2 has been saved.
  const { tenant, plan } = orderingCase({
    after: (call, t) => {
      if (call.op !== 'publishNow' || call.uniqueId !== H2) return;
      const model = t.process(H1)?.model;
      if (model) Object.assign(model, { ProcessRevisionStateId: 1, Version: '2.1' });
    },
  });
  const h1 = tenant.process(H1)?.model;
  if (h1) Object.assign(h1, { ProcessRevisionStateId: 3, Version: '2.0' });

  const removal = await removePlanReferences(tenant, plan);
  assert.equal(tenant.callsTo('saveModel', H1).length, 0, 'the backstop sends nothing');
  const row = removal.results.find((r) => r.objectId === H1);
  assert.equal(row?.status, 'Failed');
  assert.match(row?.message ?? '', /A draft was opened after the check/);
  assert.deepEqual(removal.heldBack.map((h) => h.targetUniqueId), [T1]);
  assert.match(plan.log.join(' '), /Draft holder opened a draft after the check, so Raise invoice .* is kept, but its references were already removed from: Clean holder/);
});
