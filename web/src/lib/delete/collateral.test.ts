// Ported from Tests/Test-Dependencies.ps1: "Collateral detection (process variations)",
// "Variation pre-flight heuristic", "Variation warning counts and ordering", "Processes
// the baseline never covered", the collateral assertions of "Processes whose group no
// longer exists", and the collateral list of "A process that no source can name".
//
// `Compare-TenantState` and `Find-VariationMaster` are already ported
// (tenant/state.ts, archive/plan.ts), so those assertions run now against the app's
// functions. The script diffs against `New-TenantStateSnapshot` of the index; the app
// diffs against the index itself (archive/run.ts), so these do too, and the snapshot's
// own assertions are in ledger.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findVariationMasters } from '../archive/plan.ts';
import { compareTenantState, type ProcessIndex } from '../tenant/state.ts';
import {
  collateralLines,
  restoreCollateral,
  variationWarning,
  type CollateralChange,
  type CollateralGateway,
  type VariationMasterHit,
} from './collateral.ts';
import { mockIndex, orphanedGroupIndex } from './testing/index.ts';

const targets = (...ids: string[]) => ids.map((uniqueId) => ({ uniqueId, name: '' }));

// ---------------------------------------------------------------- collateral detection
// A variation is its own record in its own group, and acting on one acts on its master.
// Nothing in the model or a list entry says so, so the only handle is a before/after
// diff of the whole tenant.

const TARGET = 'aaaa0000-0000-0000-0000-00000000000a'; // the variation being deleted
const MASTER = 'bbbb0000-0000-0000-0000-00000000000b'; // its master, in another group
const BYSTANDER = 'cccc0000-0000-0000-0000-00000000000c'; // unrelated, must not be flagged
const VANISH = 'dddd0000-0000-0000-0000-00000000000d';

const before = () =>
  mockIndex([
    { uniqueId: TARGET, numericId: 1, name: 'Order Handling (AU)', isArchived: true, groupId: 493 },
    { uniqueId: MASTER, numericId: 2, name: 'Order Handling', isArchived: false, groupId: 493 },
    { uniqueId: BYSTANDER, numericId: 3, name: 'Unrelated', isArchived: false, groupId: 200 },
    { uniqueId: VANISH, numericId: 4, name: 'Doomed', isArchived: false, groupId: 200 },
  ]);

// The Hold phase restores the target into temp group 831. The master follows it out of
// the archive, and an unrelated process vanishes.
const after = () =>
  mockIndex([
    { uniqueId: TARGET, numericId: 1, name: 'Order Handling (AU)', isArchived: false, groupId: 831 },
    { uniqueId: MASTER, numericId: 2, name: 'Order Handling', isArchived: true, groupId: 493 },
    { uniqueId: BYSTANDER, numericId: 3, name: 'Unrelated', isArchived: false, groupId: 200 },
  ]);

test('only unexpected changes are collateral, and each is named', () => {
  const collateral = compareTenantState(before(), after(), [TARGET]);
  assert.equal(collateral.length, 2, 'only the unexpected changes are reported');
  assert.equal(
    collateral.filter((c) => c.uniqueId === TARGET).length,
    0,
    'the target is expected to move and is not reported as collateral',
  );
  assert.equal(collateral.filter((c) => c.uniqueId === BYSTANDER).length, 0, 'an untouched process is not reported');

  const master = collateral.find((c) => c.uniqueId === MASTER);
  assert.equal(master?.change, 'Archived', 'the master is reported as newly archived');
  assert.equal(master?.wasArchived, false, 'the master was active before the run');
  assert.equal(master?.originalGroupId, 493, 'the home group is carried so it can be put back');

  const vanished = collateral.find((c) => c.uniqueId === VANISH);
  assert.equal(vanished?.change, 'Disappeared', 'a process that vanished from the tenant is caught');
});

test('a group move with no archive change is collateral too', () => {
  const moved = mockIndex([
    { uniqueId: TARGET, numericId: 1, name: 'Order Handling (AU)', isArchived: true, groupId: 493 },
    { uniqueId: MASTER, numericId: 2, name: 'Order Handling', isArchived: false, groupId: 831 },
    { uniqueId: BYSTANDER, numericId: 3, name: 'Unrelated', isArchived: false, groupId: 200 },
    { uniqueId: VANISH, numericId: 4, name: 'Doomed', isArchived: false, groupId: 200 },
  ]);
  const collateral = compareTenantState(before(), moved, [TARGET]);
  assert.equal(collateral.length, 1, 'a group move with no archive change is still collateral');
  assert.equal(collateral[0]?.change, 'Moved', 'it is classified as a move');
  assert.equal(collateral[0]?.currentGroupId, 831, 'the group it was parked in is named');
});

test('a clean run, and a run that changed only what it meant to, report nothing', () => {
  assert.equal(compareTenantState(before(), before(), [TARGET]).length, 0, 'an unchanged tenant produces no collateral');
  // Holders the run restored on purpose are expected, not collateral.
  assert.equal(
    compareTenantState(before(), after(), [TARGET, MASTER, VANISH]).length,
    0,
    'processes the run deliberately changed are excluded',
  );
});

// ---------------------------------------------------------------- variation pre-flight
// The only check that can PREVENT collateral damage, because it runs before the first
// mutation. Nothing in the API exposes the variation/master link; the naming convention
// "<master>::<variant>" does, imperfectly.

const VAR_A = '1111aaaa-0000-0000-0000-00000000000a'; // "Order Handling::AU"
const MAST_A = '2222bbbb-0000-0000-0000-00000000000b'; // "Order Handling"
const VAR_B = '3333cccc-0000-0000-0000-00000000000c'; // "Invoicing::NZ", master also a target
const MAST_B = '4444dddd-0000-0000-0000-00000000000d'; // "Invoicing"
const ORPHAN = '5555eeee-0000-0000-0000-00000000000e'; // "Shipping::EU", no master exists
const PLAIN = '6666ffff-0000-0000-0000-00000000000f'; // no separator at all

const varIndex = () =>
  mockIndex([
    { uniqueId: VAR_A, numericId: 1, name: 'Order Handling::AU', isArchived: true, groupId: 333 },
    { uniqueId: MAST_A, numericId: 2, name: 'Order Handling', isArchived: false, groupId: 100 },
    { uniqueId: VAR_B, numericId: 3, name: 'Invoicing::NZ', isArchived: true, groupId: 333 },
    { uniqueId: MAST_B, numericId: 4, name: 'Invoicing', isArchived: false, groupId: 100 },
    { uniqueId: ORPHAN, numericId: 5, name: 'Shipping::EU', isArchived: true, groupId: 333 },
    { uniqueId: PLAIN, numericId: 6, name: 'Just A Process', isArchived: true, groupId: 333 },
  ]);

test('a variation whose master is not a target is flagged, with the master described', () => {
  // Deleting the AU variation alone: its master is not a target, so warn.
  const hits = findVariationMasters(varIndex(), targets(VAR_A));
  assert.equal(hits.length, 1, 'a variation whose master is not a target is flagged');
  assert.equal(hits[0]?.relativeUniqueId, MAST_A, 'the master is identified by id');
  assert.equal(hits[0]?.relativeIsArchived, false, 'the master state is carried so the warning can describe it');
  assert.equal(hits[0]?.relativeGroupId, 100, 'the master group is carried too');
});

// Find-VariationMaster's BaseName, which findVariationMasters returns since phase 5.
test('the base name is the text before the separator', () => {
  const hits = findVariationMasters(varIndex(), targets(VAR_A)) as Array<Partial<VariationMasterHit>>;
  assert.equal(hits[0]?.baseName, 'Order Handling', 'the base name is the text before the separator');
});

test('only a variation with a master outside the targets warns', () => {
  // Deleting the variation AND its master: nothing surprising about that.
  assert.equal(findVariationMasters(varIndex(), targets(VAR_B, MAST_B)).length, 0, 'a master that is itself a target is not flagged');
  // A separator with no matching base name cannot warn about anything.
  assert.equal(findVariationMasters(varIndex(), targets(ORPHAN)).length, 0, 'a variation with no existing master is not flagged');
  assert.equal(findVariationMasters(varIndex(), targets(PLAIN)).length, 0, 'a process with no separator is not treated as a variation');
  // The whole set at once, which is how a real run calls it.
  assert.equal(
    findVariationMasters(varIndex(), targets(VAR_A, VAR_B, ORPHAN, PLAIN)).length,
    2,
    'both AU and NZ warn when neither master is a target',
  );
  assert.equal(findVariationMasters(varIndex(), []).length, 0, 'no targets, no warnings');
});

// Find-VariationMaster returns nothing for a null index, and so does findVariationMasters
// since phase 5.
test('a null index does not throw', () => {
  assert.equal(
    findVariationMasters(null as unknown as ProcessIndex, targets(VAR_A)).length,
    0,
    'a null index does not throw',
  );
});

test('the separator is configurable', () => {
  // A naming convention, not an API contract.
  const pipeIndex = mockIndex([
    { uniqueId: VAR_A, numericId: 1, name: 'Order Handling|AU', isArchived: true, groupId: 333 },
    { uniqueId: MAST_A, numericId: 2, name: 'Order Handling', isArchived: false, groupId: 100 },
  ]);
  assert.equal(
    findVariationMasters(pipeIndex, targets(VAR_A), '|').length,
    1,
    'the separator is configurable for tenants with another convention',
  );
  assert.equal(findVariationMasters(pipeIndex, targets(VAR_A)).length, 0, 'and the default does not match a different convention');
});

// ---------------------------------------------------------------- variation warning counts and ordering
// One row per (target, candidate master) pair, so the row count is not the target count.
// Reporting 13 "targets" for 3 targets is how a warning stops being read.

const MULTI_A = 'aaaa1111-0000-0000-0000-00000000001a';
const MULTI_B = 'bbbb1111-0000-0000-0000-00000000001b';
const CAND_1 = 'cccc1111-0000-0000-0000-00000000001c'; // active, same group as target
const CAND_2 = 'dddd1111-0000-0000-0000-00000000001d'; // archived
const CAND_3 = 'eeee1111-0000-0000-0000-00000000001e'; // active, different group

const multiIndex = () =>
  mockIndex([
    { uniqueId: MULTI_A, numericId: 1, name: 'Payments::AU', isArchived: true, groupId: 500 },
    { uniqueId: MULTI_B, numericId: 2, name: 'Payments::NZ', isArchived: true, groupId: 500 },
    { uniqueId: CAND_1, numericId: 3, name: 'Payments', isArchived: false, groupId: 500 },
    { uniqueId: CAND_2, numericId: 4, name: 'Payments', isArchived: true, groupId: 700 },
    { uniqueId: CAND_3, numericId: 5, name: 'payments', isArchived: false, groupId: 900 },
  ]);

test('one row per target and master pair', () => {
  const multi = findVariationMasters(multiIndex(), targets(MULTI_A, MULTI_B));
  // Two targets, three candidate masters each: six pairs, but only two targets.
  assert.equal(multi.length, 6, 'one row per target/master pair');
  assert.equal(new Set(multi.map((m) => m.targetUniqueId)).size, 2, 'the number of TARGETS is two, whatever the row count says');
  assert.equal(new Set(multi.map((m) => m.relativeUniqueId)).size, 3, 'and the number of distinct masters is three');
  // Case-insensitive name matching means 'payments' matches 'Payments::AU'.
  assert.ok(multi.some((m) => m.relativeUniqueId === CAND_3), 'a master differing only by case is still found');
});

// The target's group, which the warning orders by (Find-VariationMaster's TargetGroupId).
test('the target group is carried', () => {
  const multi = findVariationMasters(multiIndex(), targets(MULTI_A, MULTI_B)) as Array<Partial<VariationMasterHit>>;
  assert.equal(
    multi.find((m) => m.targetUniqueId === MULTI_A)?.targetGroupId,
    500,
    'the target group is carried so masters can be ordered by proximity',
  );
});

test('the warning counts targets, and lists the master at risk first', () => {
  const multi = findVariationMasters(multiIndex(), targets(MULTI_A, MULTI_B)) as VariationMasterHit[];
  const warning = variationWarning(multi);
  assert.equal(warning?.targetCount, 2, 'the warning counts targets, not pairs');
  assert.equal(warning?.masterCount, 3, 'and reports the master count separately');

  // Only an ACTIVE master can be collaterally archived, so it must sort first.
  const masters = warning?.targets.flatMap((t) => t.masters) ?? [];
  assert.equal(masters[0]?.relativeIsArchived, false, 'the first master listed is an active one, which is the one at risk');
  assert.equal(masters[0]?.atRisk, true, 'and it is marked as the row carrying the risk');
  assert.equal(masters.at(-1)?.relativeIsArchived, true, 'an archived master, which cannot be archived again, sorts last');
});

// ---------------------------------------------------------------- processes the baseline never covered
// The baseline is built from the two list sweeps and those sweeps are not complete. A
// process the run meets but that no sweep returned has no before-state, so it cannot be
// diffed, only reported.

const GHOST = '7777aaaa-0000-0000-0000-00000000000a';
const smallBase = () => mockIndex([{ uniqueId: TARGET, numericId: 1, name: 'Target', isArchived: true, groupId: 493 }]);
const smallAfter = () =>
  mockIndex([
    { uniqueId: TARGET, numericId: 1, name: 'Target', isArchived: true, groupId: 493 },
    { uniqueId: GHOST, numericId: 9, name: 'Ghost process', isArchived: false, groupId: 832 },
  ]);

test('a process the run met but the baseline never saw is reported as such', () => {
  const withGhost = compareTenantState(smallBase(), smallAfter(), [TARGET], [GHOST]);
  assert.equal(withGhost.length, 1, 'a process the run met but the baseline never saw is reported');
  assert.equal(withGhost[0]?.change, 'NotInBaseline', 'it gets its own category rather than a guessed one');
  assert.equal(withGhost[0]?.uniqueId, GHOST, 'it is named by id');
  assert.equal(withGhost[0]?.wasArchived, null, 'no before-state is invented for it');
  assert.equal(withGhost[0]?.currentGroupId, 832, 'where it is now is recorded');

  // Without the observed list there is nothing to notice it by.
  assert.equal(
    compareTenantState(smallBase(), smallAfter(), [TARGET]).length,
    0,
    'an unobserved absent process cannot be detected and is not invented',
  );
  // A target is expected even when it is not in the baseline.
  assert.equal(
    compareTenantState(smallBase(), smallAfter(), [TARGET, GHOST], [GHOST]).length,
    0,
    'an observed id that was expected is not reported',
  );
});

test('the reversal does not guess at a state it never recorded', async () => {
  const untouchable: CollateralGateway = {
    restore: () => assert.fail('a process with no before-state must not be restored'),
    archive: () => assert.fail('a process with no before-state must not be archived'),
  };
  const withGhost: CollateralChange[] = compareTenantState(smallBase(), smallAfter(), [TARGET], [GHOST]).map((c) => ({
    ...c,
    originalGroupExists: true,
  }));
  const rows = await restoreCollateral(untouchable, withGhost);
  assert.equal(rows.length, 1, 'the unbaselined process still produces a result row');
  assert.equal(rows[0]?.status, 'Skipped', 'it is skipped rather than guessed at');
});

// ---------------------------------------------------------------- the group a collateral row came from

const orphanAfter = () => {
  const index = orphanedGroupIndex();
  const restored = [...index.values()].find((e) => e.numericId === 12);
  if (restored) restored.isArchived = false;
  return index;
};

test('a collateral row is raised for the orphan that changed state', () => {
  const collateral = compareTenantState(orphanedGroupIndex(), orphanAfter(), []);
  assert.equal(collateral.length, 1, 'one process changed state');
});

// Compare-TenantState carries the baseline's groupExists onto every row, and so does
// compareTenantState since phase 5.
test('a collateral row knows whether its group still exists', () => {
  const collateral = compareTenantState(orphanedGroupIndex(), orphanAfter(), []) as Array<Partial<CollateralChange>>;
  assert.equal(
    collateral[0]?.originalGroupExists,
    false,
    'a collateral row knows whether the group it came from still exists',
  );
});

// ---------------------------------------------------------------- the collateral list, unnamed
// A NotInBaseline row with no name prints the marker, not a GUID twice.

test('an unnamed collateral row says so, and prints its id once', () => {
  const ghostId = 'ffff0000-0000-0000-0000-0000000000ff';
  const ghostRow: CollateralChange = {
    uniqueId: ghostId,
    name: '',
    change: 'NotInBaseline',
    wasArchived: null,
    isArchivedNow: false,
    originalGroupId: null,
    originalGroupExists: true,
    currentGroupId: 836,
  };
  const shown = collateralLines([ghostRow], 'test').join('\n');
  assert.match(shown, /not in any process list/, 'the collateral list says the name is unavailable');
  assert.ok(shown.includes(ghostId), 'while still printing the id, which is what identifies it');
  assert.equal(shown.split(ghostId).length - 1, 1, 'the id appears once, not twice over as name and id');
});
