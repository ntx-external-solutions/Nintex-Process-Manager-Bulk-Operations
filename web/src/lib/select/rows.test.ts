import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addBrowseLevel, emptyBrowseTree } from './browse.ts';
import { TREE_LEVELS } from './fixtures.ts';
import { visibleRows } from './rows.ts';
import { EMPTY_SELECTION, toggle } from './selection.ts';

function tree(...parents: Array<string | null>) {
  let t = emptyBrowseTree();
  for (const p of parents) t = addBrowseLevel(t, p, TREE_LEVELS[p ?? ''] ?? []);
  return t;
}

test('the recorded tree renders top level first, children only when expanded', () => {
  const t = tree(null, 'g-fin', 'g-ap');
  const rows = visibleRows(t, EMPTY_SELECTION, new Set(['g-fin']));
  assert.deepEqual(
    rows.map((r) => [r.depth, r.node.title]),
    [
      [0, 'Finance'],
      [1, 'Accounts Payable'],
      [1, 'Month-end close'],
      [1, 'Expense claims'],
      [1, 'Expense claims::Contractors'],
      [1, 'Onboarding'],
      [0, 'People'],
      [0, 'Policies'],
    ],
  );
});

test('an expanded group whose level is not read yet shows as loading', () => {
  const rows = visibleRows(tree(null), EMPTY_SELECTION, new Set(['g-hr']));
  const people = rows.find((r) => r.node.key === 'g-hr');
  assert.equal(people?.expanded, true);
  assert.equal(people?.loading, true);
});

test('document groups and shortcuts are drawn, tagged and not checkable', () => {
  const rows = visibleRows(tree(null, 'g-fin'), EMPTY_SELECTION, new Set(['g-fin']));
  const docs = rows.find((r) => r.node.key === 'g-docs');
  assert.equal(docs?.selectable, false);
  assert.equal(docs?.expandable, false);
  assert.equal(docs?.tag, 'documents');
  const shortcut = rows.find((r) => r.node.key === 'g-fin>p-onb');
  assert.equal(shortcut?.selectable, false);
  assert.equal(shortcut?.tag, 'linked-process');
});

test('rows carry the tri-state check', () => {
  const t = tree(null, 'g-fin', 'g-ap');
  let s = toggle(t, EMPTY_SELECTION, t.nodes.get('g-fin')!);
  s = toggle(t, s, t.nodes.get('g-ap>p-pay')!);
  const rows = visibleRows(t, s, new Set(['g-fin', 'g-ap']));
  const check = (key: string) => rows.find((r) => r.node.key === key)?.check;
  assert.equal(check('g-fin'), 'mixed');
  assert.equal(check('g-ap'), 'mixed');
  assert.equal(check('g-ap>p-pay'), 'unchecked');
  assert.equal(check('g-ap>p-inv'), 'checked');
  assert.equal(check('g-hr'), 'unchecked');
});

test('a group listed inside its own subtree is drawn, not opened forever (F3)', () => {
  const looped = addBrowseLevel(tree(null, 'g-fin'), 'g-ap', [...TREE_LEVELS['g-ap']!, TREE_LEVELS['']![0]!]);
  const rows = visibleRows(looped, EMPTY_SELECTION, new Set(['g-fin', 'g-ap']));
  assert.ok(rows.length < 50, 'the walk ends');
  assert.equal(rows.filter((r) => r.node.key === 'g-fin' && r.expanded).length, 1, 'opened once');
});

test('the document pages draw groups only: no processes, document groups or shortcuts (W8)', () => {
  const t = tree(null, 'g-fin', 'g-ap');
  const rows = visibleRows(t, EMPTY_SELECTION, new Set(['g-fin']), { groupsOnly: true });
  assert.deepEqual(
    rows.map((r) => [r.depth, r.node.title]),
    [
      [0, 'Finance'],
      [1, 'Accounts Payable'],
      [0, 'People'],
    ],
    'Policies is a document group in the recorded tree',
  );
  assert.ok(rows.every((r) => r.node.kind === 'group' && r.selectable));
});
