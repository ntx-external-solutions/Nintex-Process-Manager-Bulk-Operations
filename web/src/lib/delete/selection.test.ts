// W6: what a Bulk Delete is asked to delete, from the tree, the archived view and ids.
// Delete by group is the case that matters: a checked group takes in the archived
// processes whose group is in its subtree, which the tree never shows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupArchived, ORPHANED_BUCKET, type ArchivedProcess } from '../select/archived.ts';
import { addBrowseLevel, emptyBrowseTree, type BrowseTree } from '../select/browse.ts';
import { fixtureGateway, TREE_LEVELS } from '../select/fixtures.ts';
import { loadForSelection, resolveSelection } from '../select/resolve.ts';
import type { TreeItem } from '../pm/types.ts';
import type { VariationSet } from '../pm/processes.ts';
import { confirmArchivedOrphans } from './groups.ts';
import type { DependencyPlan } from './ledger.ts';
import { toggle, EMPTY_SELECTION, type Selection } from '../select/selection.ts';
import type { DeleteIndex, DeleteIndexEntry } from './model.ts';
import {
  applyVariationSets,
  deletePlacements,
  deleteVariations,
  groupsTheRunDeletedFrom,
  holderCountLine,
  previewHolders,
  resolveDeleteSelection,
  selectionIds,
  selectionSummary,
} from './selection.ts';

function fullTree(): BrowseTree {
  let tree = emptyBrowseTree();
  for (const parent of [null, 'g-fin', 'g-ap', 'g-empty', 'g-hr']) tree = addBrowseLevel(tree, parent, TREE_LEVELS[parent ?? ''] ?? []);
  return tree;
}

function pick(tree: BrowseTree, ...keys: string[]): Selection {
  let selection = EMPTY_SELECTION;
  for (const key of keys) selection = toggle(tree, selection, tree.nodes.get(key)!);
  return selection;
}

function resolved(tree: BrowseTree, selection: Selection) {
  const resolution = resolveSelection(tree, selection);
  assert.equal(resolution.status, 'complete');
  return resolution.status === 'complete' ? resolution : null;
}

const tree = fullTree();
const idOf = (key: string) => tree.nodes.get(key)!.id;

function entry(uniqueId: string, name: string, extra: Partial<DeleteIndexEntry> = {}): [string, DeleteIndexEntry] {
  return [
    uniqueId.toLowerCase(),
    { uniqueId, name, isArchived: false, groupId: null, groupUniqueId: null, groupName: '', groupExists: true, numericId: null, groupExistsReported: false, ...extra },
  ];
}

const INDEX: DeleteIndex = new Map([
  entry('p-close', 'Month-end close', { groupUniqueId: 'g-fin', groupId: idOf('g-fin') }),
  entry('p-pay', 'Pay a supplier', { groupUniqueId: 'g-ap', groupId: idOf('g-ap') }),
  entry('a-ap', 'Old supplier setup', { isArchived: true, groupUniqueId: 'g-ap', groupId: idOf('g-ap'), groupName: 'Accounts Payable', groupExistsReported: true }),
  // No UniqueId on the row: matched on the numeric id.
  entry('a-fin', 'Old close', { isArchived: true, groupId: idOf('g-fin'), groupName: 'Finance', groupExistsReported: true }),
  entry('a-hr', 'Old onboarding', { isArchived: true, groupUniqueId: 'g-hr', groupId: idOf('g-hr'), groupName: 'People', groupExistsReported: true }),
  // Listed as orphaned, naming a checked group: it is not taken in by the group.
  entry('a-orphan', 'Lost process', { isArchived: true, groupUniqueId: 'g-fin', groupId: 1, groupExists: false, groupExistsReported: true }),
  entry('42', 'Numeric', { isArchived: true, numericId: 42, groupUniqueId: 'g-hr', groupName: 'People' }),
]);

test('a checked group takes in its subtree from the tree and the archived processes whose group is in it', () => {
  const selection = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-fin')), index: INDEX });

  const bySource = (source: string) => selection.targets.filter((t) => t.source === source).map((t) => t.uniqueId);
  assert.deepEqual(bySource('tree').sort(), ['p-close', 'p-exp', 'p-exp-c', 'p-inv', 'p-pay']);
  assert.deepEqual(bySource('group'), ['a-fin', 'a-ap'], 'Finance before Finance / Accounts Payable');
  assert.equal(selection.targets.some((t) => t.uniqueId === 'a-hr'), false, 'a group nobody checked is not taken in');
  assert.equal(selection.targets.some((t) => t.uniqueId === 'a-orphan'), false, 'an orphan is picked from its own bucket, never by group');

  const archived = selection.targets.find((t) => t.uniqueId === 'a-ap')!;
  assert.equal(archived.phase, 'delete');
  assert.equal(archived.location, 'Finance / Accounts Payable');
  assert.equal(archived.groupUniqueId, 'g-ap');
  const active = selection.targets.find((t) => t.uniqueId === 'p-pay')!;
  assert.equal(active.phase, 'archive-then-delete', 'an active target is archived first');
  assert.equal(active.location, 'Finance / Accounts Payable');

  assert.deepEqual(selection.groups.map((g) => g.uniqueId), ['g-fin', 'g-ap', 'g-empty']);
  assert.deepEqual(selection.skipped.map((r) => [r.objectId, r.operation, r.status]), [['p-onb', 'Select', 'Skipped']], 'the shortcut is left out with a row');
});

test('a group with one subgroup unchecked does not take in that subgroup\'s archived processes', () => {
  const selection = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-fin', 'g-ap')), index: INDEX });
  assert.deepEqual(selection.targets.filter((t) => t.source === 'group').map((t) => t.uniqueId), ['a-fin']);
  assert.deepEqual(selection.groups.map((g) => g.uniqueId), ['g-fin']);
});

test('processes picked one by one take in no group and no archived process', () => {
  const selection = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-ap>p-pay')), index: INDEX });
  assert.deepEqual(selectionIds(selection), ['p-pay']);
  assert.deepEqual(selection.groups, []);
});

test('the archived view, ids and the tree add up, each process once, the first way in kept', () => {
  const selection = resolveDeleteSelection({
    tree: resolved(tree, pick(tree, 'g-ap')),
    archived: ['a-ap', 'a-orphan', 'gone-since'],
    ids: ['42', 'nope'],
    index: INDEX,
  });
  assert.deepEqual(
    selection.targets.map((t) => [t.uniqueId, t.source]),
    [
      ['p-pay', 'tree'],
      ['p-inv', 'tree'],
      ['a-ap', 'group'],
      ['a-orphan', 'archived'],
      ['42', 'ids'],
    ],
  );
  const orphan = selection.targets.find((t) => t.uniqueId === 'a-orphan')!;
  assert.equal(selection.targets.find((t) => t.uniqueId === '42')?.location, 'People', 'the listing\'s group name, with no path to hand');
  assert.equal(orphan.groupExists, false);
  assert.equal(orphan.location, '', 'no group to name');
  assert.deepEqual(
    selection.skipped.map((r) => [r.objectId, r.operation]),
    [
      ['gone-since', 'Resolve'],
      ['nope', 'Resolve'],
    ],
  );
  assert.match(selectionSummary(selection), /^5 process\(es\) to delete: 2 active, archived first; 3 already archived\. 1 archived process\(es\) come from the checked groups/);
});

// ---------------------------------------------------------------- which groups a finished run may offer

test('only checked groups a deleted target was in, and checked groups above them, are offered', () => {
  const selection = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-fin')), index: INDEX });
  assert.deepEqual(groupsTheRunDeletedFrom(selection, ['a-ap']).map((g) => g.uniqueId), ['g-fin', 'g-ap'], 'its group and the checked one above');
  assert.deepEqual(groupsTheRunDeletedFrom(selection, ['p-close']).map((g) => g.uniqueId), ['g-fin']);
  assert.deepEqual(groupsTheRunDeletedFrom(selection, []), [], 'nothing deleted, nothing offered');
  assert.equal(
    groupsTheRunDeletedFrom(selection, ['a-ap', 'p-close']).some((g) => g.uniqueId === 'g-empty'),
    false,
    'an empty group the run deleted nothing from is not offered',
  );
});

test('a deleted target picked outside any checked group offers nothing', () => {
  const selection = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-ap')), archived: ['a-hr'], index: INDEX });
  assert.deepEqual(groupsTheRunDeletedFrom(selection, ['a-hr']), []);
});

// ---------------------------------------------------------------- variations in the preview

test('the preview names every variation sibling that is not a target, and a master by name, once each', () => {
  const index: DeleteIndex = new Map([
    entry('p-exp', 'Expense claims', { groupId: 7 }),
    entry('p-exp-c', 'Expense claims::Contractors', { groupId: 7 }),
    entry('p-exp-x', 'Expense claims::Interns', { groupId: 9, isArchived: true }),
  ]);
  const sets = new Map([
    [
      'p-exp-c',
      {
        id: 5,
        name: 'Expense claims',
        group: null,
        self: null,
        others: [
          { uniqueId: 'p-exp', variationName: '', isArchived: false },
          { uniqueId: 'p-exp-x', variationName: 'Interns', isArchived: true },
        ],
      },
    ],
  ]);
  const found = deleteVariations(index, [{ uniqueId: 'p-exp-c', name: 'Expense claims::Contractors' }], sets);
  assert.deepEqual(
    found.map((m) => [m.relativeUniqueId, m.signal]),
    [
      ['p-exp', 'set'],
      ['p-exp-x', 'set'],
    ],
    'the master is found by both signals and listed once',
  );
  assert.deepEqual(deleteVariations(index, [{ uniqueId: 'p-exp-c', name: 'Expense claims::Contractors' }, { uniqueId: 'p-exp', name: 'Expense claims' }], sets).map((m) => m.relativeUniqueId), ['p-exp-x'], 'a sibling that is a target is not a warning');
});

test('a picked process is placed by the path the archived view read, where it has one', () => {
  const selection = resolveDeleteSelection({ archived: ['a-hr'], ids: ['42'], index: INDEX, groupPath: (g) => (g === 'g-hr' ? 'Company / People' : null) });
  assert.deepEqual(selection.targets.map((t) => t.location), ['Company / People', 'Company / People']);
});

// ---------------------------------------------------------------- a partly expanded tree

test('a checked group in a partly expanded tree takes in the levels nobody opened, active and archived', async () => {
  // Only the top level and Finance were opened; Accounts Payable and Retired were not.
  let partial = emptyBrowseTree();
  partial = addBrowseLevel(partial, null, TREE_LEVELS['']!);
  partial = addBrowseLevel(partial, 'g-fin', TREE_LEVELS['g-fin']!);
  const selection = pick(partial, 'g-fin');
  assert.equal(resolveSelection(partial, selection).status, 'incomplete', 'planning from the screen alone would miss levels');

  const { gateway, reads } = fixtureGateway();
  const loaded = await loadForSelection(gateway, partial, selection);
  assert.ok(reads.includes('g-ap') && reads.includes('g-empty'), 'the planner walks the unopened subtree');
  assert.equal(loaded.resolution.status, 'complete');
  const chosen = resolveDeleteSelection({ tree: loaded.resolution.status === 'complete' ? loaded.resolution : null, index: INDEX });

  assert.deepEqual(chosen.targets.filter((t) => t.source === 'tree').map((t) => t.uniqueId).sort(), ['p-close', 'p-exp', 'p-exp-c', 'p-inv', 'p-pay']);
  assert.deepEqual(chosen.targets.filter((t) => t.source === 'group').map((t) => t.uniqueId), ['a-fin', 'a-ap'], 'archived in the unopened Accounts Payable too');
  assert.equal(chosen.targets.find((t) => t.uniqueId === 'p-pay')?.phase, 'archive-then-delete');
});

// ---------------------------------------------------------------- what never enters a plan

test('shortcuts and document groups are not selectable and never become targets', () => {
  const docItem: TreeItem = { ...TREE_LEVELS['']![2]!, uniqueId: 'g-fin-docs', title: 'Finance forms' };
  let withDocs = emptyBrowseTree();
  for (const [parent, items] of [[null, TREE_LEVELS['']!], ['g-fin', [...TREE_LEVELS['g-fin']!, docItem]], ['g-ap', TREE_LEVELS['g-ap']!], ['g-empty', []]] as const) {
    withDocs = addBrowseLevel(withDocs, parent, items);
  }
  const docs = withDocs.nodes.get('g-docs')!;
  const shortcut = [...withDocs.nodes.values()].find((n) => n.uniqueId === 'p-onb' && n.itemType === 'linked-process')!;
  assert.deepEqual(toggle(withDocs, EMPTY_SELECTION, docs), EMPTY_SELECTION, 'a document group cannot be ticked');
  assert.deepEqual(toggle(withDocs, EMPTY_SELECTION, shortcut), EMPTY_SELECTION, 'a shortcut cannot be ticked');

  const chosen = resolveDeleteSelection({ tree: resolved(withDocs, pick(withDocs, 'g-fin')), index: INDEX });
  const ids = selectionIds(chosen);
  assert.equal(ids.includes('p-onb'), false, 'the shortcut under a checked group is not a target');
  assert.equal(ids.includes('g-fin-docs'), false);
  assert.equal(chosen.skipped.some((r) => r.objectId === 'g-fin-docs'), false, 'a document group is not even a row');
  assert.equal(chosen.skipped.find((r) => r.objectId === 'p-onb')?.status, 'Skipped');
});

// ---------------------------------------------------------------- the archived view's orphans

test('a false groupExists: false is moved to its real group by the model check, and a real orphan stays', async () => {
  const row = (uniqueId: string, name: string, extra: Partial<ArchivedProcess> = {}): ArchivedProcess => ({
    uniqueId, name, groupId: 1, groupUniqueId: null, groupName: 'Tenant', groupExists: false, groupExistsReported: true, ...extra,
  });
  const processes = [
    row('a-false', 'Wrongly orphaned'),
    row('a-real', 'Really orphaned'),
    row('a-unread', 'No model'),
    row('a-ok', 'In People', { groupId: 9, groupUniqueId: 'g-hr', groupName: 'People', groupExists: true }),
  ];
  const models: Record<string, unknown> = {
    'a-false': { UniqueId: 'a-false', ProcessGroupItems: { ProcessGroup: { Id: 9, UniqueId: 'g-hr', Name: 'People' } } },
    'a-real': { UniqueId: 'a-real', ProcessGroupItems: { ProcessGroup: { Id: 77, UniqueId: 'g-gone', Name: 'Deleted group' } } },
  };
  const asked: string[][] = [];
  const check = await confirmArchivedOrphans(
    {
      readArchivedModels: async (ids) => {
        asked.push([...ids]);
        return ids.map((id) => models[id]).filter((m) => m !== undefined) as never;
      },
      groupFound: async (g) => g === 'g-hr',
    },
    processes,
  );
  assert.deepEqual(asked, [['a-false', 'a-real', 'a-unread']], 'only the rows listed as orphaned are read');
  assert.deepEqual(check.corrections.map((c) => [c.uniqueId, c.group.uniqueId]), [['a-false', 'g-hr']]);
  assert.deepEqual(check.rows.map((r) => [r.objectId, r.operation, r.status]), [['a-false', 'GroupCheck', 'Warning']], 'the disagreement is logged');
  assert.match(check.rows[0]!.message, /says its group 1 no longer exists, but its model names group 'People' \(id 9\), which is in the tree/);

  const view = groupArchived(check.processes, (g) => (g === 'g-hr' ? ['Company', 'People'] : null));
  assert.deepEqual(
    view.buckets.map((b) => [b.label, b.processes.map((p) => p.uniqueId)]),
    [
      ['Company / People', ['a-ok', 'a-false']],
      ['Group no longer exists', ['a-unread', 'a-real']],
    ],
    'the corrected row sits under its real path; the orphans keep their own bucket',
  );
  assert.equal(view.buckets.at(-1)?.key, ORPHANED_BUCKET);

  // The plan places it in that group, and a checked People takes it in.
  const index: DeleteIndex = new Map([
    entry('a-false', 'Wrongly orphaned', { isArchived: true, groupId: 1, groupExists: false, groupExistsReported: true }),
  ]);
  const corrections = new Map(check.corrections.map((c) => [c.uniqueId.toLowerCase(), c.group]));
  const picked = resolveDeleteSelection({ archived: ['a-false'], index, corrections, groupPath: (g) => (g === 'g-hr' ? 'Company / People' : null) });
  assert.deepEqual([picked.targets[0]?.groupExists, picked.targets[0]?.location], [true, 'Company / People']);
  const byGroup = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-hr')), index, corrections });
  assert.equal(byGroup.targets.find((t) => t.uniqueId === 'a-false')?.source, 'group');
  assert.equal(resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-hr')), index }).targets.some((t) => t.uniqueId === 'a-false'), false, 'unconfirmed, it is not taken in');
});

// ---------------------------------------------------------------- variation sets

const SET_INDEX: DeleteIndex = new Map([
  ...INDEX,
  entry('p-exp', 'Expense claims', { groupUniqueId: 'g-fin', groupId: idOf('g-fin') }),
  entry('p-exp-c', 'Expense claims::Contractors', { groupUniqueId: 'g-fin', groupId: idOf('g-fin') }),
  entry('p-exp-x', 'Expense claims::Interns', { isArchived: true, groupUniqueId: 'g-hr', groupId: idOf('g-hr'), groupName: 'People', groupExistsReported: true }),
]);
const member = (uniqueId: string, variationName: string, isArchived = false) => ({ uniqueId, variationName, isArchived });
const SETS = new Map<string, VariationSet>([
  ['p-exp', { id: 5, name: 'Expense claims', group: null, self: null, others: [member('p-exp-c', 'Contractors'), member('p-exp-x', 'Interns', true)] }],
  ['p-exp-c', { id: 5, name: 'Expense claims', group: null, self: null, others: [member('p-exp', ''), member('p-exp-x', 'Interns', true)] }],
]);

test('a variation set only partly selected is left out by default, each sibling named', () => {
  const chosen = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-fin')), index: SET_INDEX });
  const { selection, reviews } = applyVariationSets(chosen, SET_INDEX, SETS);

  assert.equal(selection.targets.some((t) => t.uniqueId === 'p-exp' || t.uniqueId === 'p-exp-c'), false, 'both selected variations are left out');
  assert.ok(selection.targets.some((t) => t.uniqueId === 'p-close'), 'the rest of the group is untouched');
  assert.deepEqual(reviews.map((r) => [r.setId, r.whole, r.included, r.members.map((m) => [m.name, m.selected])]), [
    [5, false, false, [['Expense claims', true], ['Expense claims::Contractors', true], ['Expense claims::Interns', false]]],
  ], 'one review per set, however many targets are in it');
  const rows = selection.skipped.filter((r) => r.operation === 'Select' && r.status === 'Skipped' && /variation/.test(r.message));
  assert.deepEqual(rows.map((r) => r.objectId), ['p-exp', 'p-exp-c']);
  assert.match(rows[0]!.message, /set 'Expense claims', and 'Expense claims::Interns' in the same set is not selected/);
});

test('a ticked set is pulled in whole, and a whole set needs no tick', () => {
  const chosen = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-fin')), index: SET_INDEX });
  const { selection, reviews } = applyVariationSets(chosen, SET_INDEX, SETS, new Set([5]));
  const added = selection.targets.find((t) => t.uniqueId === 'p-exp-x');
  assert.deepEqual([added?.source, added?.phase, added?.location], ['variation', 'delete', 'People']);
  assert.ok(['p-exp', 'p-exp-c'].every((id) => selection.targets.some((t) => t.uniqueId === id)));
  assert.equal(reviews[0]?.included, true);
  assert.equal(selection.skipped.some((r) => /variation/.test(r.message)), false);
  assert.deepEqual(deleteVariations(SET_INDEX, selection.targets, SETS).filter((m) => m.signal === 'set'), [], 'no sibling is left to warn about');

  const whole = applyVariationSets(resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-fin>p-exp', 'g-fin>p-exp-c')), archived: ['p-exp-x'], index: SET_INDEX }), SET_INDEX, SETS);
  assert.equal(whole.selection.targets.length, 3);
  assert.equal(whole.reviews[0]?.whole, true);
});

// ---------------------------------------------------------------- holders, revalidation, the holding group

test('the preview names the holders edited, the draft holders skipped, and the targets they hold back', () => {
  const plan = {
    ledger: [
      { uniqueId: 'h-clean', name: 'Clean holder' },
      { uniqueId: 'h-draft', name: 'Draft holder' },
      { uniqueId: 'p-pay', name: 'Pay a supplier' },
    ],
    workItems: [
      { holderUniqueId: 'h-clean', sites: [{}, {}], targetsAffected: ['p-close'] },
      { holderUniqueId: 'h-draft', sites: [{}], targetsAffected: ['p-pay'] },
    ],
    draftHolders: [{ holderUniqueId: 'h-draft', name: 'Draft holder', version: '2.1', targetsBlocked: ['p-pay'] }],
  } as unknown as DependencyPlan;
  const holders = previewHolders(plan, INDEX);
  assert.deepEqual(holders.edited, [{ uniqueId: 'h-clean', name: 'Clean holder', sites: 2 }]);
  assert.deepEqual(holders.skipped.map((h) => [h.displayName, h.version]), [['Draft holder', '2.1']]);
  assert.deepEqual(holders.heldBack, [{ uniqueId: 'p-pay', name: 'Pay a supplier', holderUniqueId: 'h-draft', holderName: 'Draft holder' }]);
});

test('the plan summary counts only the holders it will edit, and names the skipped one (R15)', () => {
  const plan = {
    ledger: [
      { uniqueId: 'h-clean', name: 'Clean holder' },
      { uniqueId: 'h-draft', name: 'Draft holder' },
    ],
    workItems: [
      { holderUniqueId: 'h-clean', sites: [{}], targetsAffected: ['p-close'] },
      { holderUniqueId: 'h-draft', sites: [{}], targetsAffected: ['p-pay'] },
    ],
    draftHolders: [{ holderUniqueId: 'h-draft', name: 'Draft holder', version: '2.1', targetsBlocked: ['p-pay'] }],
  } as unknown as DependencyPlan;
  assert.equal(holderCountLine(previewHolders(plan, INDEX)), '2 holders: 1 to edit, 1 skipped (open draft)');
  assert.equal(holderCountLine({ edited: [{ uniqueId: 'h', name: 'H', sites: 1 }], skipped: [] }), '1 holder to edit');
  assert.equal(holderCountLine({ edited: [], skipped: [] }), '0 holders to edit');
});

test('the run re-reads each checked group and each tree target where the preview saw it', () => {
  const chosen = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-ap')), archived: ['a-hr'], index: INDEX });
  assert.deepEqual(
    deletePlacements(chosen).map((p) => [p.uniqueId, p.parentUniqueId]),
    [
      ['g-ap', 'g-fin'],
      ['g-empty', 'g-ap'],
      ['p-pay', 'g-ap'],
      ['p-inv', 'g-ap'],
    ],
    'archived targets are not in the tree, so not re-read here',
  );
});

test('the holding group is never offered for cleanup', () => {
  const selection = resolveDeleteSelection({ tree: resolved(tree, pick(tree, 'g-fin')), index: INDEX });
  assert.deepEqual(groupsTheRunDeletedFrom(selection, ['a-ap'], 'G-AP').map((g) => g.uniqueId), ['g-fin']);
});
