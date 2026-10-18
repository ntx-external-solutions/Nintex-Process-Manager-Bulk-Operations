// W5 phase 5 (checkpoints): what the ported suites do not reach on their own. The gate's
// three answers and the rows each one writes, a checkpoint that does not ask twice, the
// reversal's paths past the two the script's tests cover, the shared write-path rules,
// and the hard stop on an incomplete plan (Cowork's review of phase 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failureOf } from '../archive/outcome.ts';
import { chooseWritePath, writeStateOf } from '../pm/writePath.ts';
import { incompletePlanStop } from './bulkDelete.ts';
import {
  ACCEPTANCE_AUTHORITY,
  COLLATERAL_REVERSAL_COMMENT,
  decideCollateral,
  newCollateral,
  restoreCollateral,
  variationWarning,
  variationWarningLines,
  type CollateralChange,
  type CollateralGateway,
} from './collateral.ts';
import { collateralGateway } from './executor.ts';
import { newDependencyPlan } from './ledger.ts';
import { FakeTenant } from './testing/fakeTenant.ts';
import { mockIndex } from './testing/index.ts';

const TARGET = 'abab0000-0000-0000-0000-00000000000a';
const MASTER = 'abab0000-0000-0000-0000-00000000000b';
const OTHER = 'abab0000-0000-0000-0000-00000000000c';

const before = () =>
  mockIndex([
    { uniqueId: TARGET, name: 'Payments :: AU', isArchived: true, groupId: 500 },
    { uniqueId: MASTER, name: 'Payments', isArchived: false, groupId: 500 },
    { uniqueId: OTHER, name: 'Unrelated', isArchived: true, groupId: 600 },
  ]);

// The hold restored the target; its master followed it into the archive.
const afterHold = () =>
  mockIndex([
    { uniqueId: TARGET, name: 'Payments :: AU', isArchived: false, groupId: 900 },
    { uniqueId: MASTER, name: 'Payments', isArchived: true, groupId: 500 },
    { uniqueId: OTHER, name: 'Unrelated', isArchived: true, groupId: 600 },
  ]);

const masterArchived = (): CollateralChange[] => newCollateral({ baseline: before(), fresh: afterHold(), expected: [TARGET] });

// ---------------------------------------------------------------- the checkpoint

test('a checkpoint reports only what an earlier one did not raise', () => {
  const first = masterArchived();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.uniqueId, MASTER);
  assert.equal(first[0]?.originalGroupExists, true, 'the group it came from is carried');
  assert.equal(
    newCollateral({ baseline: before(), fresh: afterHold(), expected: [TARGET], alreadyRaised: first }).length,
    0,
    'an approved change is still changed, and is not put to the operator again',
  );
  assert.equal(newCollateral({ baseline: null, fresh: afterHold(), expected: [TARGET] }).length, 0, 'no baseline, no checkpoint');
});

test('no gate stops the run, with a Failed row per change and nothing deleted', async () => {
  const outcome = await decideCollateral(masterArchived(), 'after holding archived targets', {});
  assert.equal(outcome.proceed, false, 'stopping is the default');
  assert.equal(outcome.rows.length, 1);
  assert.equal(outcome.rows[0]?.operation, 'Collateral');
  assert.equal(outcome.rows[0]?.status, 'Failed');
  assert.match(outcome.rows[0]?.message ?? '', /\(Archived\); after holding archived targets; run stopped before anything was deleted/);
  assert.equal(outcome.rows[0]?.groupId, '500', 'the group it is in now');
  assert.match(outcome.lines.join('\n'), /COLLATERAL CHANGES DETECTED[\s\S]*Payments  \(abab[\s\S]*Nothing has been deleted/);
});

test('a gate that answers no stops, and one that answers yes records the acceptance at the gate', async () => {
  const asked: string[] = [];
  const no = await decideCollateral(masterArchived(), 'after archiving targets, before deleting', {
    gate: (_c, phase) => {
      asked.push(phase);
      return false;
    },
  });
  assert.equal(no.proceed, false);
  assert.deepEqual(asked, ['after archiving targets, before deleting'], 'the gate is told which checkpoint is asking');

  const yes = await decideCollateral(masterArchived(), 'after archiving targets, before deleting', { gate: async () => true });
  assert.equal(yes.proceed, true);
  assert.equal(yes.rows[0]?.status, 'Accepted', 'an authorisation, not a fault');
  assert.ok(yes.rows[0]?.message.includes(ACCEPTANCE_AUTHORITY.atGate), 'says who let it through');
  assert.match(yes.lines.at(-1) ?? '', /still put back/);
});

test('approval in advance carries on without asking, and says so on each row', async () => {
  const outcome = await decideCollateral(masterArchived(), 'after holding archived targets', {
    acceptCollateral: true,
    gate: () => assert.fail('approved in advance, so nobody is asked'),
  });
  assert.equal(outcome.proceed, true);
  assert.equal(outcome.rows[0]?.status, 'Accepted');
  assert.equal(
    outcome.rows[0]?.message,
    `Changed without being a target (Archived) after holding archived targets; ${ACCEPTANCE_AUTHORITY.inAdvance}, so the run continued`,
  );
});

test('nothing changed carries on with no rows', async () => {
  const outcome = await decideCollateral([], 'after holding archived targets', {});
  assert.deepEqual([outcome.proceed, outcome.rows.length], [true, 0]);
});

// ---------------------------------------------------------------- the reversal

function recordingGateway(answers: { restore?: boolean; archive?: boolean } = {}) {
  const calls: string[] = [];
  const gateway: CollateralGateway = {
    restore: async (id, groupId, exists) => {
      calls.push(`restore ${id} ${groupId} ${exists}`);
      return answers.restore === false ? { ok: false, statusCode: 500 } : { ok: true, statusCode: null };
    },
    archive: async (id, comment) => {
      calls.push(`archive ${id} ${comment}`);
      return answers.archive === false ? { ok: false, message: 'HTTP 409 refused by the tenant: Locked', statusCode: 409 } : { ok: true, message: '', statusCode: null };
    },
  };
  return { gateway, calls };
}

const change = (over: Partial<CollateralChange>): CollateralChange => ({
  uniqueId: MASTER,
  name: 'Payments',
  change: 'Archived',
  wasArchived: false,
  isArchivedNow: true,
  originalGroupId: 500,
  originalGroupExists: true,
  currentGroupId: 500,
  ...over,
});

test('an archived master is restored into its own group, and the row says where', async () => {
  const { gateway, calls } = recordingGateway();
  const rows = await restoreCollateral(gateway, [change({})]);
  assert.deepEqual(calls, [`restore ${MASTER} 500 true`]);
  assert.equal(rows[0]?.operation, 'ReverseCollateral');
  assert.equal(rows[0]?.status, 'Success');
  assert.equal(rows[0]?.message, 'Restored to group 500');
  assert.equal(rows[0]?.groupId, '500');

  const failed = await restoreCollateral(recordingGateway({ restore: false }).gateway, [change({ currentGroupId: 1 })]);
  assert.equal(failed[0]?.status, 'Failed');
  assert.match(failed[0]?.message ?? '', /still archived\. Restore it manually to group 500/);
  assert.equal(failed[0]?.statusCode, '500', "the restore's status");
  assert.equal(failed[0]?.groupId, '1', 'where it still is');
});

test('an un-archived process is archived again, and a refusal says it is still active', async () => {
  const unarchived = change({ change: 'Unarchived', wasArchived: true, isArchivedNow: false });
  const { gateway, calls } = recordingGateway();
  const rows = await restoreCollateral(gateway, [unarchived]);
  assert.deepEqual(calls, [`archive ${MASTER} ${COLLATERAL_REVERSAL_COMMENT}`]);
  assert.equal(rows[0]?.status, 'Success');

  const refused = await restoreCollateral(recordingGateway({ archive: false }).gateway, [unarchived]);
  assert.equal(refused[0]?.status, 'Failed');
  assert.match(refused[0]?.message ?? '', /still ACTIVE\. HTTP 409 refused by the tenant: Locked/);
  assert.equal(refused[0]?.statusCode, '409');
});

test('a move and a disappearance are reported, never acted on', async () => {
  const { gateway, calls } = recordingGateway();
  const rows = await restoreCollateral(gateway, [
    change({ change: 'Moved', wasArchived: false, isArchivedNow: false, currentGroupId: 900 }),
    change({ uniqueId: OTHER, name: 'Unrelated', change: 'Disappeared', wasArchived: true, isArchivedNow: null, currentGroupId: null }),
  ]);
  assert.deepEqual(calls, [], 'nothing is sent');
  assert.equal(rows[0]?.status, 'Skipped');
  assert.match(rows[0]?.message ?? '', /Moved from group 500 to 900\. Move it back manually/);
  assert.equal(rows[1]?.status, 'Failed');
  assert.match(rows[1]?.message ?? '', /disappeared/);
});

test("a dead session during the reversal's restore ends the run", async () => {
  const tenant = new FakeTenant({ processes: [{ uniqueId: MASTER, name: 'Payments', archived: true, groupId: 500 }] });
  tenant.fail = (call) => (call.op === 'restore' ? { status: 401 } : null);
  const isFatal = (error: unknown) => (failureOf(error).status === 401 ? 'Signed out.' : null);
  await assert.rejects(restoreCollateral(collateralGateway(tenant, { isFatal }), [change({})]));
});

// ---------------------------------------------------------------- the variation warning text

test('the variation warning names the target, the master at risk first, and says it is a heuristic', () => {
  const lines = variationWarningLines(
    variationWarning([
      { targetUniqueId: TARGET, targetName: 'Payments :: AU', targetGroupId: 500, baseName: 'Payments', relativeUniqueId: OTHER, relativeName: 'Payments', relativeGroupId: 700, relativeIsArchived: true, signal: 'name' },
      { targetUniqueId: TARGET, targetName: 'Payments :: AU', targetGroupId: 500, baseName: 'Payments', relativeUniqueId: MASTER, relativeName: 'Payments', relativeGroupId: 500, relativeIsArchived: false, signal: 'name' },
    ]),
  );
  assert.match(lines[1] ?? '', /^1 target\(s\) are named like variations, with 2 candidate master\(s\)/);
  assert.match(lines[3] ?? '', new RegExp(`${MASTER}\\) - active, group 500  <-- can be archived by this run$`));
  assert.match(lines[4] ?? '', /archived, group 700$/);
  assert.match(lines.at(-1) ?? '', /name heuristic/);
  assert.deepEqual(variationWarningLines(null), []);
});

// ---------------------------------------------------------------- the write path, shared with ownership

test('the write path reads the process, and falls back to the version only without a revision state', () => {
  const admin = { CanSave: true, CanPublishAfterEdit: true, CanSubmitForApprovalAfterEdit: true };
  assert.equal(chooseWritePath(writeStateOf({ ProcessRevisionStateId: 3, Version: '2.0' }, admin), { publish: 'match-state' }), 'publish-direct');
  assert.equal(chooseWritePath(writeStateOf({ ProcessRevisionStateId: 1, Version: '2.1' }, admin), { publish: 'match-state' }), 'save-only');
  assert.equal(chooseWritePath(writeStateOf({ Version: '3.0' }, admin), { publish: 'match-state' }), 'publish-direct', 'a published version, no state');
  assert.equal(chooseWritePath(writeStateOf({ Version: '0.4' }, admin), { publish: 'match-state' }), 'save-only', 'never published, no state');
  assert.deepEqual(chooseWritePath(writeStateOf({ ProcessRevisionStateId: 3 }, null), { publish: 'match-state' }), { refused: 'cannot-save' });
  assert.deepEqual(
    chooseWritePath(writeStateOf({ ProcessRevisionStateId: 2 }, admin), { publish: 'match-state' }),
    { refused: 'awaiting-approval' },
    'ownership never edits under a pending review',
  );
});

// ---------------------------------------------------------------- an incomplete plan stops a real run

test('an incomplete plan stops a real run, naming every process the scan could not read', () => {
  const plan = newDependencyPlan('https://example.invalid/tenant', [TARGET]);
  assert.equal(incompletePlanStop({ ...plan, status: 'Planned' }), null, 'a complete plan may run');

  const stop = incompletePlanStop({
    ...plan,
    status: 'PlannedIncomplete',
    incompleteReasons: ['The Input/Output scan could not read 2 process(es), listed above.'],
    unreadByScan: [
      { uniqueId: MASTER, name: 'Payments', status: 400, error: 'Bad request' },
      { uniqueId: OTHER, name: '', status: 0, error: 'No response' },
    ],
  });
  assert.match(stop ?? '', /stops before changing anything/);
  assert.match(stop ?? '', /could not read 2 process/);
  assert.ok(stop?.includes(`Payments (${MASTER}, HTTP 400)`), 'each unread process by name, id and status');
  assert.ok(stop?.includes(`(name unavailable; not in any process list) (${OTHER})`), 'and by id when nothing names it');
  assert.ok(incompletePlanStop({ ...plan, status: 'PlannedIncomplete' }), 'a plan from before the reasons were recorded stops too');
});
