// W5 phase 3 (hold): what the ported suites do not reach on their own. The restore's
// failure paths, the snapshot bookkeeping the unwind keys off, the warnings a run raises
// before its first change, and the two things Cowork's review of phase 2 asked the dry
// run to show: archived holders with no group, and links the API counts twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileDependencies, parseDependencyResponse } from './claims.ts';
import { restoreProcess } from './executor.ts';
import { groupExistsCoverageLines, type OrphanedGroupProcess } from './groups.ts';
import { orphanedTargetWarningLines } from './holdingGroup.ts';
import { markSnapshotRestored, newDependencyPlan, processStateSnapshot, type PlanLedgerRow } from './ledger.ts';
import type { DeleteIndex, DeleteIndexEntry } from './model.ts';
import { planSummaryLines } from './planner.ts';
import type { ReferenceSite } from './references.ts';
import { FakeTenant } from './testing/fakeTenant.ts';

const A = 'abab0000-0000-0000-0000-00000000000a';
const B = 'abab0000-0000-0000-0000-00000000000b';
const C = 'abab0000-0000-0000-0000-00000000000c';

// ---------------------------------------------------------------- the restore

test('a refused restore carries its status, and a dead session is rethrown', async () => {
  const tenant = new FakeTenant({ processes: [{ uniqueId: A, name: 'Alpha', archived: true, groupId: 100 }], missingGroupIds: [7] });
  const refused = await restoreProcess(tenant, A, 7);
  assert.deepEqual(refused, { ok: false, failure: 'Endpoint', statusCode: 500 }, 'an endpoint failure, with the status for the row');

  tenant.fail = (call) => (call.op === 'restore' ? { status: 401, message: 'signed out' } : null);
  await assert.rejects(
    restoreProcess(tenant, A, 100, { isFatal: () => 'Signed out.' }),
    'a dead session ends the run rather than reading as a refused restore',
  );
  tenant.fail = undefined;

  assert.deepEqual(await restoreProcess(tenant, A, 100), { ok: true, failure: null, statusCode: 0 });
  assert.equal(tenant.isArchived(A), false);
});

test('a restore with nowhere to go is never sent', async () => {
  const tenant = new FakeTenant({ processes: [{ uniqueId: A, name: 'Alpha', archived: true, groupId: 100 }] });
  assert.equal((await restoreProcess(tenant, A, null)).failure, 'MissingGroup', 'no group is the same as a group that is gone');
  assert.equal(tenant.callsTo('restore').length, 0);
});

// ---------------------------------------------------------------- the snapshot

const indexOf = (...rows: Array<Partial<DeleteIndexEntry> & Pick<DeleteIndexEntry, 'uniqueId' | 'name'>>): DeleteIndex =>
  new Map(
    rows.map((r) => [
      r.uniqueId.toLowerCase(),
      {
        isArchived: true,
        groupId: 100,
        groupUniqueId: null,
        groupName: '',
        groupExists: true,
        numericId: null,
        groupExistsReported: true,
        ...r,
      },
    ]),
  );

test('the snapshot takes the group UniqueId from the map, then the listing, and marks what the hold restored', () => {
  const index = indexOf(
    { uniqueId: A, name: 'Alpha', groupId: 100 },
    { uniqueId: B, name: 'Bravo', groupId: 200, groupUniqueId: 'group-200-from-listing' },
    { uniqueId: C, name: 'Charlie', groupId: 300 },
  );
  const snapshot = processStateSnapshot(index, [A.toUpperCase(), B, C, 'not-indexed'], new Map([['100', 'group-100-from-map']]));
  assert.equal(snapshot.size, 3, 'an id the index does not hold is left out');
  assert.equal(snapshot.get(A)?.originalGroupUniqueId, 'group-100-from-map', 'the map, as the script resolves it');
  assert.equal(snapshot.get(B)?.originalGroupUniqueId, 'group-200-from-listing', 'then the listing, which the app index carries');
  assert.equal(snapshot.get(C)?.originalGroupUniqueId, '', 'and empty when neither knows');

  markSnapshotRestored(snapshot, A.toUpperCase(), 999);
  assert.equal(snapshot.get(A)?.restoredByThisRun, true, 'the unwind keys off this');
  assert.equal(snapshot.get(A)?.isArchivedNow, false);
  assert.equal(snapshot.get(A)?.wasArchived, true, 'and what it was before is not touched');
  markSnapshotRestored(snapshot, 'not-there');
  markSnapshotRestored(null, A);
  assert.equal(snapshot.get(B)?.restoredByThisRun, false, 'nothing else is marked');
});

// ---------------------------------------------------------------- warnings before the first change

test('the orphaned-target warning counts targets, names each, and mentions the holding group only when there is one', () => {
  const orphans: OrphanedGroupProcess[] = [
    { uniqueId: B, name: 'Bravo', originalGroupId: 1, isArchived: true },
    { uniqueId: A, name: 'Alpha', originalGroupId: 832, isArchived: false },
  ];
  const lines = orphanedTargetWarningLines(orphans, 20, 'Holding');
  assert.equal(lines[0], 'TARGETS WHOSE GROUP NO LONGER EXISTS');
  assert.match(lines.join('\n'), /2 of 20 target\(s\) belong to a group that no longer exists/);
  assert.ok(lines.indexOf(`  Alpha  (${A})`) < lines.indexOf(`  Bravo  (${B})`), 'sorted by name');
  assert.match(lines.join('\n'), /active; group 832 is gone/);
  assert.match(lines.join('\n'), /inside 'Holding'/);
  assert.doesNotMatch(orphanedTargetWarningLines(orphans, 0, '').join('\n'), /inside/, 'no holding group named, none mentioned');
  assert.match(orphanedTargetWarningLines(orphans, 0, '').join('\n'), /2 of 2 target/, 'an unknown total counts the orphans');
  assert.deepEqual(orphanedTargetWarningLines([], 20, 'Holding'), [], 'no orphans, no warning');
});

test('a coverage gap is said out loud; full coverage says nothing', () => {
  assert.match(groupExistsCoverageLines({ total: 2, reported: 0, missing: 2, orphans: 0, state: 'None' }).join(' '), /does not report groupExists/);
  assert.match(groupExistsCoverageLines({ total: 3, reported: 2, missing: 1, orphans: 0, state: 'Mixed' }).join(' '), /1 of 3 listing row/);
  assert.deepEqual(groupExistsCoverageLines({ total: 3, reported: 3, missing: 0, orphans: 1, state: 'Full' }), []);
  assert.deepEqual(groupExistsCoverageLines(null), []);
});

// ---------------------------------------------------------------- the dry run's two new sections

const holderRow = (r: Partial<PlanLedgerRow> & Pick<PlanLedgerRow, 'uniqueId' | 'name'>): PlanLedgerRow => ({
  numericId: null,
  wasArchived: true,
  originalGroupUniqueId: '',
  originalGroupId: 1,
  originalGroupExists: false,
  restoredByThisRun: false,
  role: 'Holder',
  parkedInHoldingGroup: false,
  denormalized: false,
  deleted: false,
  ...r,
});

test('archived holders with no group are named in a preview, before anyone runs a delete', () => {
  const plan = newDependencyPlan('https://example.invalid/t', [C]);
  plan.status = 'PlannedIncomplete';
  plan.ledger = [
    holderRow({ uniqueId: A, name: 'Alpha' }),
    holderRow({ uniqueId: B, name: 'Bravo', originalGroupExists: true, originalGroupId: 500 }),
    holderRow({ uniqueId: C, name: 'Charlie', role: 'Target' }),
  ];
  const shown = planSummaryLines(plan, null).join('\n');
  assert.match(shown, /Archived holders with no group: 1\./, 'counts holders only: a holder with a group and a target are not among them');
  assert.match(shown, /parks them in the holding group, reads them there, and archives them again/);
  assert.match(shown, new RegExp(`Alpha  \\(${A}\\)\\n\\s+group 1 is gone; not restored by this preview`), 'named, with the group that is gone');
  assert.doesNotMatch(shown, /Bravo  \(/);
});

test('a real run says which of them it parked and which blocked it', () => {
  const plan = newDependencyPlan('https://example.invalid/t', [C]);
  plan.ledger = [
    holderRow({ uniqueId: A, name: 'Alpha', restoredByThisRun: true, parkedInHoldingGroup: true }),
    holderRow({ uniqueId: B, name: 'Bravo' }),
  ];
  plan.orphanedHolders = [{ uniqueId: B, name: 'Bravo', originalGroupId: 1, reason: 'refused' }];
  const shown = planSummaryLines(plan, null).join('\n');
  assert.match(shown, /group 1 is gone; parked in the holding group for this run/);
  assert.match(shown, /group 1 is gone; could not be held, which blocks the run/);
});

test('links the API counts twice are listed apart from the mismatches that are different', () => {
  const linkSite = (holder: string, target: string, i: number) =>
    ({
      holderUniqueId: holder,
      targetUniqueId: target,
      path: `ProcessProcedures.ProcessLink[${i}].LinkedProcessUniqueId`,
      bucket: 'ProcessLink',
      category: 'Link',
      action: 'Remove',
      matchedField: 'LinkedProcessUniqueId',
      elementId: i,
      isChild: false,
    }) as ReferenceSite;
  const links = (related: string, n: number) => [{ Type: 'Linked Process', Dependencies: Array.from({ length: n }, () => ({ Name: 'x', UniqueId: related })) }];

  const doubled = reconcileDependencies({
    queriedUniqueId: C,
    relatedUniqueId: A,
    claims: parseDependencyResponse(links(A, 2), C),
    sites: [linkSite(A, C, 0)],
    relatedIsArchived: false,
  });
  const different = reconcileDependencies({
    queriedUniqueId: C,
    relatedUniqueId: B,
    claims: parseDependencyResponse(links(B, 3), C),
    sites: [linkSite(B, C, 0)],
    relatedIsArchived: false,
  });

  const plan = newDependencyPlan('https://example.invalid/t', [C]);
  plan.ledger = [
    holderRow({ uniqueId: A, name: 'Alpha', wasArchived: false, originalGroupExists: true }),
    holderRow({ uniqueId: B, name: 'Bravo', wasArchived: false, originalGroupExists: true }),
    holderRow({ uniqueId: C, name: 'Charlie', role: 'Target', wasArchived: false, originalGroupExists: true }),
  ];
  plan.reconciliation = [...doubled, ...different];
  const shown = planSummaryLines(plan, null).join('\n');

  // Since W5 phase 4, claimed 3 located 1 is an over-claim (something was located), not a
  // mismatch that blocks: R11's third pair, a variation's one Decision[0] claimed 3 times.
  assert.doesNotMatch(shown, /RECONCILIATION MISMATCHES/, 'nothing here has nothing located');
  assert.match(shown, /CLAIMED MORE THAN FOUND \(1\):/, 'the different one is an over-claim');
  assert.match(shown, /LINKS THE DEPENDENCY API COUNTS TWICE \(1\):/, 'the doubled one is listed under its own heading');
  const overClaims = shown.slice(shown.indexOf('CLAIMED MORE THAN FOUND'), shown.indexOf('LINKS THE DEPENDENCY API'));
  assert.match(overClaims, /-> Bravo\s+claimed 3, located 1/);
  assert.doesNotMatch(overClaims, /-> Alpha/);
  assert.match(shown.slice(shown.indexOf('LINKS THE DEPENDENCY API')), /-> Alpha\s+claimed 2, located 1/);

  // A plan file from before either field existed lists everything as a mismatch, as it did.
  plan.reconciliation = plan.reconciliation.map(({ doubleCounted: _, overClaim: __, ...r }) => r as (typeof plan.reconciliation)[number]);
  assert.match(planSummaryLines(plan, null).join('\n'), /RECONCILIATION MISMATCHES \(2\):/);
});
