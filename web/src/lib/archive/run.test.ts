import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Journal, step } from '../exec/journal.ts';
import type { ResultRow } from '../exec/report.ts';
import { createControls } from '../exec/runner.ts';
import type { VariationSet } from '../pm/processes.ts';
import type { IndexEntry, ProcessIndex } from '../tenant/state.ts';
import type { ArchiveGateway, ArchiveState } from './outcome.ts';
import { buildArchivePlan, targetsInVariationSets, type ArchivePlan } from './plan.ts';
import { collateralRows, manualReviewCsvRows, processLink, runArchive, settleFromFinalRead } from './run.ts';

function entry(uniqueId: string, name: string, isArchived: boolean, groupId = 10): IndexEntry {
  return { uniqueId, name, isArchived, groupId, groupUniqueId: `g-${groupId}`, groupName: 'G', groupExists: true };
}

function index(...entries: IndexEntry[]): ProcessIndex {
  return new Map(entries.map((e) => [e.uniqueId.toLowerCase(), e]));
}

function plan(...ids: string[]): ArchivePlan {
  return {
    targets: ids.map((id) => ({
      uniqueId: id,
      name: `Process ${id}`,
      groupUniqueId: 'g-10',
      groupId: 10,
      path: ['Finance'],
      inIndex: true,
    })),
    groups: [],
    skipped: [],
    excluded: [],
    variations: [],
    unreadVariationSets: [],
  };
}

/** Each id gets its own behaviour; the default archives outright. */
function gateway(behaviour: Record<string, Partial<{ archive: () => Promise<unknown>; state: ArchiveState; publish: () => Promise<unknown> }>> = {}) {
  const calls: string[] = [];
  const g: ArchiveGateway = {
    async archive(id) {
      calls.push(`archive ${id}`);
      return behaviour[id]?.archive ? behaviour[id].archive() : {};
    },
    async archiveState(id) {
      calls.push(`state ${id}`);
      return behaviour[id]?.state ?? { found: true, isArchived: true, revisionEditId: 1 };
    },
    async publishNow(id) {
      calls.push(`publish ${id}`);
      return behaviour[id]?.publish ? behaviour[id].publish() : {};
    },
  };
  return { g, calls };
}

const journal = () => Journal.start('run', 'tenant', 1, null);
const options = (baseline: ProcessIndex = index()) => ({
  changeDescription: 'Bulk archive',
  approvalOverride: true,
  variationsAccepted: false,
  baseline,
});

function byId(rows: readonly ResultRow[], id: string, operation = 'Archive'): ResultRow {
  const row = rows.find((r) => r.objectId === id && r.operation === operation);
  assert.ok(row, `no ${operation} row for ${id}`);
  return row;
}

test('every target gets one row, with the change description sent once per call', async () => {
  const h = gateway();
  const rows = await runArchive(h.g, journal(), plan('a', 'b'), createControls(), options());
  assert.deepEqual(rows.map((r) => [r.objectId, r.status]), [
    ['a', 'Success'],
    ['b', 'Success'],
  ]);
  assert.match(byId(rows, 'a').message, /^Archived from Finance$/);
});

test('a refusal does not stop the batch, and keeps its status code', async () => {
  const refusal = Object.assign(new Error('400'), { status: 400, tenantMessage: 'Linked document no longer exists' });
  const h = gateway({ a: { archive: async () => Promise.reject(refusal) } });
  const rows = await runArchive(h.g, journal(), plan('a', 'b'), createControls(), options());
  assert.equal(byId(rows, 'a').status, 'Blocked');
  assert.equal(byId(rows, 'a').statusCode, '400');
  assert.equal(byId(rows, 'b').status, 'Success');
});

test('a dead session stops the run and every unattempted target still gets a row', async () => {
  const dead = Object.assign(new Error('Not signed in.'), { signedOut: true });
  const h = gateway({ a: { archive: async () => Promise.reject(dead) } });
  const rows = await runArchive(h.g, journal(), plan('a', 'b', 'c'), createControls(), { ...options(), concurrency: 1 });
  assert.equal(byId(rows, 'a').status, 'Failed');
  assert.match(byId(rows, 'b').message, /Not attempted: Your session ended/);
  assert.equal(byId(rows, 'c').status, 'Skipped');
  assert.deepEqual(h.calls, ['archive a']);
});

test('a target archived since the plan was built is not sent', async () => {
  const h = gateway();
  const rows = await runArchive(h.g, journal(), plan('a'), createControls(), options(index(entry('a', 'A', true))));
  assert.equal(byId(rows, 'a').status, 'Skipped');
  assert.deepEqual(h.calls, []);
});

test('a step already in the journal is not sent twice', async () => {
  const j = journal();
  j.append({ step: step.archive('a'), kind: 'process.archive', phase: 'begin' });
  const h = gateway();
  const rows = await runArchive(h.g, j, plan('a'), createControls(), options());
  assert.equal(byId(rows, 'a').status, 'Skipped');
  assert.deepEqual(h.calls, []);
});

test('each archive is journaled begin then commit or fail', async () => {
  const j = journal();
  const refusal = Object.assign(new Error('400'), { status: 400 });
  const h = gateway({ b: { archive: async () => Promise.reject(refusal) } });
  await runArchive(h.g, j, plan('a', 'b'), createControls(), options());
  assert.equal(j.phaseOf(step.archive('a')), 'commit');
  assert.equal(j.phaseOf(step.archive('b')), 'fail');
});

test('variation warnings must be accepted before anything is sent', async () => {
  const p = plan('a');
  p.variations.push({
    targetUniqueId: 'a',
    targetName: 'X::Y',
    relativeUniqueId: 'm',
    relativeName: 'X',
    relativeGroupId: 3,
    relativeIsArchived: false,
    signal: 'name',
  });
  const h = gateway();
  await assert.rejects(runArchive(h.g, journal(), p, createControls(), options()), /variation warnings/);
  assert.deepEqual(h.calls, []);

  const rows = await runArchive(h.g, journal(), p, createControls(), { ...options(), variationsAccepted: true });
  assert.equal(byId(rows, 'm', 'VariationWarning').status, 'Accepted');
});

// ----------------------------------------------------------- final read

test('a call that reported failure but took effect is settled as Success', async () => {
  const rows = settleFromFinalRead(
    [
      { objectType: 'Process', objectId: 'a', name: 'A', operation: 'Archive', status: 'Failed', message: 'Archive call failed (HTTP 500): boom', groupId: '10', statusCode: '500' },
    ],
    index(entry('a', 'A', true)),
  );
  assert.equal(rows[0]?.status, 'Success');
  assert.match(rows[0]?.message ?? '', /confirmed by the final read, although the run reported: Archive call failed/);
});

test('a 200 that is still pending at the end stays Pending', async () => {
  const h = gateway({ a: { state: { found: true, isArchived: false, revisionEditId: 5 } } });
  const draft = await runArchive(h.g, journal(), plan('a'), createControls(), { ...options(), approvalOverride: false });
  assert.equal(byId(draft, 'a').status, 'Pending');
  const settled = settleFromFinalRead(draft, index(entry('a', 'A', false)));
  assert.equal(byId(settled, 'a').status, 'Pending');
});

test('success that the final read contradicts becomes Failed', () => {
  const rows = settleFromFinalRead(
    [{ objectType: 'Process', objectId: 'a', name: 'A', operation: 'Archive', status: 'Overridden', message: 'ok', groupId: '', statusCode: '' }],
    index(entry('a', 'A', false)),
  );
  assert.equal(rows[0]?.status, 'Failed');
  assert.equal(rows[0]?.message, 'Archive reported success but the process is still active');
});

test('success for a process neither listing returns is Unverified, not Failed', () => {
  const rows = settleFromFinalRead(
    [{ objectType: 'Process', objectId: 'a', name: 'A', operation: 'Archive', status: 'Success', message: 'ok', groupId: '', statusCode: '' }],
    index(),
  );
  assert.equal(rows[0]?.status, 'Unverified');
});

test('skipped and non-archive rows are left alone by the final read', () => {
  const skipped: ResultRow = { objectType: 'Process', objectId: 'a', name: 'A', operation: 'Archive', status: 'Skipped', message: 'Already archived', groupId: '', statusCode: '' };
  const warning: ResultRow = { ...skipped, operation: 'VariationWarning', status: 'Accepted' };
  assert.deepEqual(settleFromFinalRead([skipped, warning], index(entry('a', 'A', true))), [skipped, warning]);
});

// ----------------------------------------------------------- collateral

test('a non-target archived during the run is reported for manual attention', () => {
  const baseline = index(entry('a', 'A', false), entry('m', 'Master', false, 3), entry('q', 'Quiet', false));
  const after = index(entry('a', 'A', true), entry('m', 'Master', true, 3), entry('q', 'Quiet', false));
  const rows = collateralRows(baseline, after, ['a']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.objectId, 'm');
  assert.equal(rows[0]?.operation, 'Collateral');
  assert.equal(rows[0]?.status, 'Unreversed');
  assert.match(rows[0]?.message ?? '', /was archived during this run \(it was in group 3\)/);
});

test('a target is never collateral, even when the baseline did not list it', () => {
  const rows = collateralRows(index(), index(entry('a', 'A', true)), ['a']);
  // Targets are expected changes, so nothing is reported for them.
  assert.deepEqual(rows, []);
});

// ----------------------------------------------------------- review file

test('the manual review file lists refusals with a link to each process', () => {
  const rows: ResultRow[] = [
    { objectType: 'Process', objectId: 'a', name: 'A', operation: 'Archive', status: 'Blocked', message: 'HTTP 400 refused by the tenant: disabled owner', groupId: '10', statusCode: '400' },
    { objectType: 'Process', objectId: 'b', name: 'B', operation: 'Archive', status: 'Success', message: 'Archived', groupId: '10', statusCode: '' },
  ];
  const out = manualReviewCsvRows(rows, 'https://demo.promapp.com/tenant/');
  assert.deepEqual(out, [
    ['ObjectID', 'Name', 'GroupId', 'StatusCode', 'Reason', 'Link'],
    ['a', 'A', '10', '400', 'HTTP 400 refused by the tenant: disabled owner', 'https://demo.promapp.com/tenant/Process/a'],
  ]);
  assert.equal(processLink('', 'a'), '');
});

// ----------------------------------------------------------- plan

test('the plan skips archived processes and names variation siblings from the set', () => {
  const idx = index(
    entry('p-close', 'Month-end close', true),
    entry('p-exp', 'Expense claims', false),
    entry('p-exp-c', 'Expense claims :: Contractors', false),
    entry('p-exp-s', 'Expense claims :: Staff', false),
  );
  const resolved = {
    processes: [
      { uniqueId: 'p-close', id: 1, title: 'Month-end close', itemType: 'process', groupUniqueId: 'g-fin', groupId: 1, path: ['Finance'], variationSetId: null },
      { uniqueId: 'p-exp-c', id: 2, title: 'Expense claims', itemType: 'process', groupUniqueId: 'g-fin', groupId: 1, path: ['Finance'], variationSetId: 5 },
    ],
    excluded: [{ uniqueId: 'p-onb', title: 'Onboarding', itemType: 'linked-process', path: ['Finance'], reason: 'shortcut' }],
  };
  const sets = new Map<string, VariationSet>([
    [
      'p-exp-c',
      {
        id: 5,
        name: 'Expense claims',
        group: { id: 1, name: 'Finance', uniqueId: 'g-fin' },
        self: { uniqueId: 'p-exp-c', variationName: 'Contractors', isArchived: false },
        // Neither sibling is in the tree; only the set names them.
        others: [
          { uniqueId: 'p-exp-s', variationName: 'Staff', isArchived: false },
          { uniqueId: 'p-exp-x', variationName: 'Visitors', isArchived: true },
        ],
      },
    ],
  ]);
  const p = buildArchivePlan(resolved, idx, sets, new Map([['p-close', 'not a target anyway']]));
  assert.deepEqual(p.targets.map((t) => t.uniqueId), ['p-exp-c']);
  assert.equal(p.skipped.find((r) => r.objectId === 'p-close')?.message, 'Already archived');
  assert.equal(p.skipped.find((r) => r.objectId === 'p-onb')?.operation, 'Select');
  assert.deepEqual(
    p.variations.map((v) => [v.relativeUniqueId, v.relativeName, v.signal]),
    [
      ['p-exp-s', 'Expense claims :: Staff', 'set'],
      // Not in either listing: named from the set itself.
      ['p-exp-x', 'Expense claims :: Visitors', 'set'],
      // The name heuristic still runs and finds the master.
      ['p-exp', 'Expense claims', 'name'],
    ],
  );
  // An unreadable set is reported only for a target.
  assert.deepEqual(p.unreadVariationSets, []);
});

test('a target whose variation set could not be read is listed as such', () => {
  const resolved = {
    processes: [{ uniqueId: 'v', id: 1, title: 'V', itemType: 'process', groupUniqueId: 'g', groupId: 1, path: [], variationSetId: 9 }],
    excluded: [],
  };
  assert.deepEqual(targetsInVariationSets(resolved.processes), ['v']);
  const p = buildArchivePlan(resolved, index(entry('v', 'V', false)), new Map(), new Map([['v', 'HTTP 500']]));
  assert.deepEqual(p.unreadVariationSets, [{ uniqueId: 'v', name: 'V', error: 'HTTP 500' }]);
});
