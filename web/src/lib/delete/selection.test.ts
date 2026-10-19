// W6: what a Bulk Delete is asked to delete, from the tree, the archived view and ids.
// Delete by group is the case that matters: a checked group takes in the archived
// processes whose group is in its subtree, which the tree never shows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addBrowseLevel, emptyBrowseTree, type BrowseTree } from '../select/browse.ts';
import { TREE_LEVELS } from '../select/fixtures.ts';
import { resolveSelection } from '../select/resolve.ts';
import { toggle, EMPTY_SELECTION, type Selection } from '../select/selection.ts';
import type { DeleteIndex, DeleteIndexEntry } from './model.ts';
import { deleteVariations, groupsTheRunDeletedFrom, resolveDeleteSelection, selectionIds, selectionSummary } from './selection.ts';

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
