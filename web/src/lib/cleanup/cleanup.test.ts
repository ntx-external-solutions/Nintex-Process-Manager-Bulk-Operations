import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Journal, step } from '../exec/journal.ts';
import { createControls } from '../exec/runner.ts';
import type { TreeItem } from '../pm/types.ts';
import type { CoveredGroup } from '../select/resolve.ts';
import type { IndexEntry } from '../tenant/state.ts';
import { gatherFacts } from './facts.ts';
import { planCleanup, type CleanupDecision, type GroupFacts } from './plan.ts';
import { runCleanup, settleCleanup, type CleanupGateway } from './run.ts';

function group(uniqueId: string, parentUniqueId: string | null, depth: number): CoveredGroup {
  return { uniqueId, id: depth * 100 + uniqueId.length, title: uniqueId.toUpperCase(), parentUniqueId, path: [], depth };
}

function item(uniqueId: string, itemType: string): TreeItem {
  return {
    id: 1,
    uniqueId,
    title: uniqueId,
    itemType: itemType as TreeItem['itemType'],
    itemOrder: 0,
    hasChild: null,
    totalSubgroups: null,
    totalStakeholderUsers: null,
    totalPermissionRoles: null,
    totalPermissionUsers: null,
    variationSetId: null,
  };
}

const EMPTY: GroupFacts = { children: [], documents: { total: 0, names: [] }, archived: [] };

/** top > mid > leaf, all covered by the selection. */
const TOP = group('top', null, 0);
const MID = group('mid', 'top', 1);
const LEAF = group('leaf', 'mid', 2);

function decide(facts: Record<string, Partial<GroupFacts>>, candidates = [TOP, MID, LEAF]) {
  return planCleanup(
    candidates,
    new Map(Object.entries(facts).map(([id, f]) => [id, { ...EMPTY, ...f }])),
  );
}

const actions = (d: CleanupDecision[]) => d.map((x) => [x.group.uniqueId, x.action]);

// ---------------------------------------------------------------- planning

test('a group left empty is deleted, with the archived processes it orphans', () => {
  const d = decide({ leaf: { archived: [{ uniqueId: 'a-1', name: 'Petty cash' }] } }, [LEAF]);
  assert.deepEqual(actions(d), [['leaf', 'delete']]);
  assert.deepEqual(d[0]?.action === 'delete' ? d[0].orphans : null, [{ uniqueId: 'a-1', name: 'Petty cash' }]);
});

test('after a delete, nested: an emptied group goes, one with a document stays, one with a held-back process is offered with a warning', () => {
  // W6 reuses W2b as it is: an archived process left in a group (a target the run held
  // back) does not keep the group, but the warning names it. A document does keep it.
  const DOCS = group('docs', 'top', 1);
  const facts = new Map([
    ['top', { ...EMPTY, children: [item('mid', 'group'), item('docs', 'group')] }],
    ['mid', { ...EMPTY, children: [item('leaf', 'group')] }],
    ['leaf', { ...EMPTY, archived: [{ uniqueId: 'a-1', name: 'Petty cash' }] }],
    ['docs', { ...EMPTY, documents: { total: 1, names: ['Policy.pdf'] } }],
  ]);
  const d = planCleanup([TOP, MID, LEAF, DOCS], facts);
  assert.deepEqual(actions(d), [
    ['leaf', 'delete'],
    ['mid', 'delete'],
    ['docs', 'keep'],
    ['top', 'keep'],
  ]);
  const byId = new Map(d.map((x) => [x.group.uniqueId, x]));
  const leaf = byId.get('leaf');
  assert.deepEqual(leaf?.action === 'delete' ? leaf.orphans : null, [{ uniqueId: 'a-1', name: 'Petty cash' }], 'the held-back process is named in the warning');
  const docs = byId.get('docs');
  assert.match(docs?.action === 'keep' ? docs.reason : '', /1 document: 'Policy\.pdf'\. Documents, archived or not, stop a group from being deleted/);
  const top = byId.get('top');
  assert.match(top?.action === 'keep' ? top.reason : '', /1 subgroup that is kept: 'docs'/);
});

test('a group holding a document is kept, and says so', () => {
  const d = decide({ leaf: { documents: { total: 2, names: ['Policy.pdf', 'Old form.docx'] } } }, [LEAF]);
  assert.deepEqual(actions(d), [['leaf', 'keep']]);
  assert.match(d[0]?.action === 'keep' ? d[0].reason : '', /2 documents: 'Policy.pdf', 'Old form.docx'/);
});

test('a group still holding an active process is kept', () => {
  const d = decide({ leaf: { children: [item('Pay a supplier', 'inprogress-process')] } }, [LEAF]);
  assert.deepEqual(actions(d), [['leaf', 'keep']]);
  assert.match(d[0]?.action === 'keep' ? d[0].reason : '', /1 active process: 'Pay a supplier'/);
});

test('a shortcut keeps a group: deleting it would act through a process homed elsewhere', () => {
  const d = decide({ leaf: { children: [item('Onboarding', 'linked-process')] } }, [LEAF]);
  assert.match(d[0]?.action === 'keep' ? d[0].reason : '', /shortcut/);
});

test('nested groups are decided and deleted deepest first', () => {
  const d = decide({
    top: { children: [item('mid', 'group')] },
    mid: { children: [item('leaf', 'group')] },
    leaf: {},
  });
  assert.deepEqual(actions(d), [
    ['leaf', 'delete'],
    ['mid', 'delete'],
    ['top', 'delete'],
  ]);
});

test('a kept subgroup keeps every group above it', () => {
  const d = decide({
    top: { children: [item('mid', 'group')] },
    mid: { children: [item('leaf', 'group')] },
    leaf: { children: [item('Still here', 'process')] },
  });
  assert.deepEqual(actions(d), [
    ['leaf', 'keep'],
    ['mid', 'keep'],
    ['top', 'keep'],
  ]);
  assert.match(d[1]?.action === 'keep' ? d[1].reason : '', /subgroup that is kept: 'leaf'/);
});

test('a subgroup the selection did not cover keeps its parent', () => {
  const d = decide({ mid: { children: [item('not-selected', 'group')] } }, [MID]);
  assert.deepEqual(actions(d), [['mid', 'keep']]);
});

test('contents or documents that could not be read keep the group', () => {
  assert.deepEqual(actions(decide({ leaf: { children: null } }, [LEAF])), [['leaf', 'keep']]);
  assert.deepEqual(actions(decide({ leaf: { documents: null } }, [LEAF])), [['leaf', 'keep']]);
  assert.deepEqual(actions(planCleanup([LEAF], new Map())), [['leaf', 'keep']]);
});

// ---------------------------------------------------------------- facts

test('facts come from the tree, the documents and the archived index', async () => {
  const index = new Map<string, IndexEntry>([
    ['a-1', { uniqueId: 'a-1', name: 'Petty cash', isArchived: true, groupId: 1, groupUniqueId: 'LEAF', groupName: '', groupExists: true }],
    ['a-2', { uniqueId: 'a-2', name: 'Active one', isArchived: false, groupId: 1, groupUniqueId: 'leaf', groupName: '', groupExists: true }],
  ]);
  const facts = await gatherFacts(
    {
      childItems: async () => [],
      groupDocuments: async () => Promise.reject(new Error('HTTP 500')),
    },
    [LEAF],
    index,
  );
  assert.deepEqual(facts.get('leaf'), { children: [], documents: null, archived: [{ uniqueId: 'a-1', name: 'Petty cash' }] });
});

// ---------------------------------------------------------------- running

function gateway(options: { levels?: Record<string, TreeItem[]>; refuse?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const g: CleanupGateway = {
    async childItems(id) {
      calls.push(`read ${id}`);
      return options.levels?.[id ?? ''] ?? [];
    },
    async deleteGroup(id) {
      calls.push(`delete ${id}`);
      if (options.refuse?.[id]) throw options.refuse[id];
      return {};
    },
  };
  return { g, calls };
}

const journal = () => Journal.start('run', 'tenant', 1, null);

test('deletes go deepest first, one at a time, each after a fresh read', async () => {
  const decisions = decide({
    top: { children: [item('mid', 'group')] },
    mid: { children: [item('leaf', 'group')] },
    leaf: { archived: [{ uniqueId: 'a-1', name: 'Petty cash' }] },
  });
  // The re-read of mid still shows leaf, which this run has just deleted.
  const h = gateway({ levels: { mid: [item('leaf', 'group')], top: [item('mid', 'group')] } });
  const rows = await runCleanup(h.g, journal(), decisions, createControls());
  assert.deepEqual(h.calls, ['read leaf', 'delete leaf', 'read mid', 'delete mid', 'read top', 'delete top']);
  assert.deepEqual(
    rows.map((r) => [r.objectType, r.operation, r.objectId, r.status]),
    [
      ['ProcessGroup', 'DeleteGroup', 'leaf', 'Success'],
      ['Process', 'GroupDeleted', 'a-1', 'Orphaned'],
      ['ProcessGroup', 'DeleteGroup', 'mid', 'Success'],
      ['ProcessGroup', 'DeleteGroup', 'top', 'Success'],
    ],
  );
  assert.match(rows[0]?.message ?? '', /1 archived process can no longer be restored/);
});

test('a group that gained something since the preview is kept, not deleted', async () => {
  const h = gateway({ levels: { leaf: [item('New one', 'inprogress-process')] } });
  const rows = await runCleanup(h.g, journal(), decide({ leaf: {} }, [LEAF]), createControls());
  assert.equal(rows[0]?.status, 'Skipped');
  assert.match(rows[0]?.message ?? '', /not empty any more/);
  assert.deepEqual(h.calls, ['read leaf']);
});

test('a 409 from the tenant is Blocked with the document names, and never retried', async () => {
  const refusal = Object.assign(new Error('Process Manager returned 409'), {
    status: 409,
    detail: JSON.stringify({
      errorCode: 'AssociatedContents',
      caption: 'Unable to Delete Group',
      additionalInfos: { documents: ['Old form.docx (archived)'] },
    }),
  });
  const h = gateway({ refuse: { leaf: refusal } });
  const j = journal();
  const rows = await runCleanup(h.g, j, decide({ leaf: { archived: [{ uniqueId: 'a-1', name: 'P' }] } }, [LEAF]), createControls());
  assert.equal(rows.length, 1, 'no orphan row for a group that was not deleted');
  assert.equal(rows[0]?.status, 'Blocked');
  assert.equal(rows[0]?.statusCode, '409');
  assert.match(rows[0]?.message ?? '', /Unable to Delete Group\. It still holds document 'Old form.docx \(archived\)'/);
  assert.equal(h.calls.filter((c) => c.startsWith('delete')).length, 1);
  assert.equal(j.phaseOf(step.deleteGroup('leaf')), 'fail');
});

test('kept groups get a row each, with the reason', async () => {
  const rows = await runCleanup(gateway().g, journal(), decide({ leaf: { documents: { total: 1, names: ['A'] } } }, [LEAF]), createControls());
  assert.equal(rows[0]?.status, 'Skipped');
  assert.match(rows[0]?.message ?? '', /^Kept\. It holds 1 document/);
});

test('a dead session stops the cleanup and the rest are kept with a reason', async () => {
  const dead = Object.assign(new Error('Not signed in.'), { signedOut: true });
  const decisions = decide({ top: { children: [item('mid', 'group')] }, mid: { children: [item('leaf', 'group')] }, leaf: {} });
  const h = gateway({ refuse: { leaf: dead } });
  const rows = await runCleanup(h.g, journal(), decisions, createControls());
  assert.deepEqual(rows.map((r) => [r.objectId, r.status]), [
    ['leaf', 'Failed'],
    ['mid', 'Skipped'],
    ['top', 'Skipped'],
  ]);
  assert.match(rows[1]?.message ?? '', /Not attempted: Your session ended/);
});

// ---------------------------------------------------------------- final read

test('the final read overrules the calls, and orphan rows follow the group', async () => {
  const decisions = decide(
    { mid: { children: [], archived: [{ uniqueId: 'a-m', name: 'M' }] }, leaf: { archived: [{ uniqueId: 'a-l', name: 'L' }] } },
    [MID, LEAF],
  );
  const refusal = Object.assign(new Error('500'), { status: 500 });
  const rows = await runCleanup(gateway({ refuse: { mid: refusal } }).g, journal(), decisions, createControls());
  assert.deepEqual(rows.map((r) => [r.objectId, r.status]), [
    ['leaf', 'Success'],
    ['a-l', 'Orphaned'],
    ['mid', 'Failed'],
  ]);

  // Afterwards: leaf is somehow still under mid, and mid is gone from top.
  const settled = settleCleanup(rows, decisions, new Map([
    ['mid', [item('leaf', 'group')]],
    ['top', []],
  ]));
  assert.deepEqual(settled.map((r) => [r.objectId, r.status]), [
    ['leaf', 'Failed'],
    ['mid', 'Success'],
    ['a-m', 'Orphaned'],
  ]);
});
