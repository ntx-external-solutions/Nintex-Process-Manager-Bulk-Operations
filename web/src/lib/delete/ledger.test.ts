// Ported from Tests/Test-Dependencies.ps1: "Ledger and plan persistence", the baseline
// assertions of "Collateral detection (process variations)", and the snapshot, plan
// ledger and baseline assertions of "Processes whose group no longer exists".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDependencyResponse } from './claims.ts';
import {
  ledgerEntryFromModel,
  newDependencyPlan,
  parsePlan,
  processStateSnapshot,
  serializePlan,
  snapshotToPlanLedger,
  tenantStateSnapshot,
  type PlanLedgerRow,
} from './ledger.ts';
import type { ProcessModel } from './model.ts';
import { PHASE } from './phases.ts';
import { findProcessReferenceSites } from './references.ts';
import { readFixture } from './testing/fixtures.ts';
import { mockIndex, orphanedGroupIndex } from './testing/index.ts';

type Fixture = ProcessModel & { UniqueId: string; Name: string; GroupUniqueId: string };

const holder = () => readFixture<Fixture>('ActionCustomerRequest.json');
const target = () => readFixture<Fixture>('DependencyTest.json');

// ---------------------------------------------------------------- ledger and plan persistence

test('a ledger entry reads archive state and the original group from the model', () => {
  const model = holder();
  const entry = ledgerEntryFromModel(model);
  assert.equal(entry.wasArchived, false, 'StateId 1 reads as active');
  assert.equal(entry.originalGroupUniqueId, model.GroupUniqueId, 'the original group is captured for denormalisation');

  const archived = JSON.parse('{"UniqueId":"X","Name":"X","StateId":2,"GroupUniqueId":"G","GroupId":5}') as ProcessModel;
  assert.equal(ledgerEntryFromModel(archived).wasArchived, true, 'a non-active StateId reads as archived');
});

test('the plan survives a round trip through its file', () => {
  const holderModel = holder();
  const targetModel = target();
  const entry = ledgerEntryFromModel(holderModel);
  const row: PlanLedgerRow = { ...entry, numericId: null, role: 'Target', parkedInHoldingGroup: false };

  const plan = newDependencyPlan('https://example.promapp.com/t', [targetModel.UniqueId]);
  plan.ledger = [row];
  plan.claims = parseDependencyResponse(
    [
      { Type: 'Linked Process', Dependencies: [1, 2, 3].map(() => ({ Name: holderModel.Name, UniqueId: holderModel.UniqueId })) },
      { Type: 'Process Input', Dependencies: [{ Name: holderModel.Name, UniqueId: holderModel.UniqueId }] },
    ],
    targetModel.UniqueId,
  );
  plan.sites = [
    ...findProcessReferenceSites(holderModel, [targetModel.UniqueId]),
    ...findProcessReferenceSites(targetModel, [holderModel.UniqueId]),
  ];

  // The script's "written to disk" and "temp file moved into place" assertions have no
  // counterpart: the browser downloads the text, and the working ledger is in IndexedDB.
  const text = serializePlan(plan);
  assert.ok(text.length > 0, 'the plan serializes to a file the operator can download');

  const reloaded = parsePlan(text);
  assert.equal(reloaded?.claims.length, 4, 'claims survive the round trip');
  assert.equal(reloaded?.sites.length, 5, 'sites survive the round trip');
  assert.equal(reloaded?.targetUniqueIds[0], targetModel.UniqueId, 'targets survive the round trip');
  assert.equal(reloaded?.ledger[0]?.originalGroupUniqueId, holderModel.GroupUniqueId, 'the ledger survives the round trip');
});

test('a file that is not a plan reads as no plan', () => {
  assert.equal(parsePlan(''), null, 'importing a missing plan returns null rather than throwing');
});

// ---------------------------------------------------------------- the tenant baseline

const TARGET = 'aaaa0000-0000-0000-0000-00000000000a';
const MASTER = 'bbbb0000-0000-0000-0000-00000000000b';

test('the baseline covers the whole tenant', { skip: PHASE.checkpoints }, () => {
  const before = mockIndex([
    { uniqueId: TARGET, numericId: 1, name: 'Order Handling (AU)', isArchived: true, groupId: 493 },
    { uniqueId: MASTER, numericId: 2, name: 'Order Handling', isArchived: false, groupId: 493 },
    { uniqueId: 'cccc0000-0000-0000-0000-00000000000c', numericId: 3, name: 'Unrelated', isArchived: false, groupId: 200 },
    { uniqueId: 'dddd0000-0000-0000-0000-00000000000d', numericId: 4, name: 'Doomed', isArchived: false, groupId: 200 },
  ]);
  const baseline = tenantStateSnapshot(before);
  assert.equal(baseline.size, 4, 'the baseline covers every process in the tenant, not just the targets');
  assert.equal(baseline.get(TARGET)?.isArchived, true, 'the baseline records archive state');
  assert.equal(baseline.get(MASTER)?.groupId, 493, 'the baseline records the home group');
});

// ---------------------------------------------------------------- the groupExists flag through the snapshots

test('the pre-Hold snapshot records whether the home group still exists', () => {
  const index = orphanedGroupIndex();
  const ids = [...index.values()].map((e) => e.uniqueId);
  // The snapshot is what the unwind reads, so the flag has to survive the trip.
  const snapshot = processStateSnapshot(index, ids);
  assert.equal(snapshot.get('aaaaaaaa-0000-0000-0000-000000000002')?.originalGroupExists, false, 'the snapshot records that the home group is gone');
  assert.equal(snapshot.get('aaaaaaaa-0000-0000-0000-000000000003')?.originalGroupExists, true, 'and records that a present group is present');
  assert.equal(snapshot.get('aaaaaaaa-0000-0000-0000-000000000004')?.originalGroupExists, true, 'an unreported flag survives as "the group is there"');

  const planLedger = snapshotToPlanLedger(snapshot);
  assert.equal(
    planLedger.find((r) => r.originalGroupId === 832)?.originalGroupExists,
    false,
    'the plan ledger written before the first mutation carries it too',
  );
});

test('the tenant baseline carries the flag too', { skip: PHASE.checkpoints }, () => {
  // So a collateral unwind can see it as well.
  const baseline = tenantStateSnapshot(orphanedGroupIndex());
  assert.equal(baseline.get('aaaaaaaa-0000-0000-0000-000000000002')?.groupExists, false, 'the tenant baseline carries the flag');
});
