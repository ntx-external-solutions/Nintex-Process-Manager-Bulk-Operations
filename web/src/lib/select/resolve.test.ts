import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TreeItem } from '../pm/types.ts';
import { addBrowseLevel, emptyBrowseTree, type BrowseNode, type BrowseTree } from './browse.ts';
import { fixtureGateway, TREE_LEVELS } from './fixtures.ts';
import { loadForSelection, resolveSelection } from './resolve.ts';
import { checkState, EMPTY_SELECTION, toggle, type Selection } from './selection.ts';

/** The tree with the given levels read, in order. */
function treeWith(...parents: Array<string | null>): BrowseTree {
  let tree = emptyBrowseTree();
  for (const parent of parents) {
    tree = addBrowseLevel(tree, parent, TREE_LEVELS[parent ?? ''] ?? []);
  }
  return tree;
}

const FULL = [null, 'g-fin', 'g-ap', 'g-empty', 'g-hr'] as const;

function node(tree: BrowseTree, key: string): BrowseNode {
  const found = tree.nodes.get(key);
  assert.ok(found, `no node ${key}`);
  return found;
}

function click(tree: BrowseTree, selection: Selection, ...keys: string[]): Selection {
  let next = selection;
  for (const key of keys) next = toggle(tree, next, node(tree, key));
  return next;
}

function ids(tree: BrowseTree, selection: Selection): string[] {
  const resolution = resolveSelection(tree, selection);
  assert.equal(resolution.status, 'complete');
  return resolution.status === 'complete' ? resolution.processes.map((p) => p.uniqueId).sort() : [];
}

// ---------------------------------------------------------------- nesting

test('a checked group resolves to every process in every subgroup, with its path', () => {
  const tree = treeWith(...FULL);
  const selection = click(tree, EMPTY_SELECTION, 'g-fin');
  const resolution = resolveSelection(tree, selection);
  assert.equal(resolution.status, 'complete');
  if (resolution.status !== 'complete') return;

  assert.deepEqual(resolution.processes.map((p) => p.uniqueId).sort(), [
    'p-close',
    'p-exp',
    'p-exp-c',
    'p-inv',
    'p-pay',
  ]);
  const pay = resolution.processes.find((p) => p.uniqueId === 'p-pay');
  assert.deepEqual(pay?.path, ['Finance', 'Accounts Payable']);
  assert.equal(pay?.groupUniqueId, 'g-ap');
  assert.equal(pay?.groupId, node(tree, 'g-ap').id);
});

test('nothing is selected until something is checked', () => {
  assert.deepEqual(ids(treeWith(...FULL), EMPTY_SELECTION), []);
});

test('checking a single process selects only that process', () => {
  const tree = treeWith(...FULL);
  assert.deepEqual(ids(tree, click(tree, EMPTY_SELECTION, 'g-ap>p-pay')), ['p-pay']);
});

// -------------------------------------------------------- partial selection

test('a group checked and then one child unchecked resolves to the rest', () => {
  const tree = treeWith(...FULL);
  const selection = click(tree, EMPTY_SELECTION, 'g-fin', 'g-fin>p-close');
  assert.deepEqual(ids(tree, selection), ['p-exp', 'p-exp-c', 'p-inv', 'p-pay']);
  assert.equal(checkState(tree, selection, node(tree, 'g-fin')), 'mixed');
  assert.equal(checkState(tree, selection, node(tree, 'g-fin>p-close')), 'unchecked');
});

test('a whole subgroup can be unchecked out of a checked group', () => {
  const tree = treeWith(...FULL);
  const selection = click(tree, EMPTY_SELECTION, 'g-fin', 'g-ap');
  assert.deepEqual(ids(tree, selection), ['p-close', 'p-exp', 'p-exp-c']);
});

test('a process can be checked back inside an unchecked subgroup', () => {
  const tree = treeWith(...FULL);
  const selection = click(tree, EMPTY_SELECTION, 'g-fin', 'g-ap', 'g-ap>p-inv');
  assert.deepEqual(ids(tree, selection), ['p-close', 'p-exp', 'p-exp-c', 'p-inv']);
});

test('checking a mixed group makes the whole group checked again', () => {
  const tree = treeWith(...FULL);
  const selection = click(tree, EMPTY_SELECTION, 'g-fin', 'g-fin>p-close', 'g-fin');
  assert.equal(checkState(tree, selection, node(tree, 'g-fin')), 'checked');
  assert.equal(ids(tree, selection).length, 5);
  // The click cleared the exception rather than leaving a stale mark behind.
  assert.deepEqual([...selection.keys()], ['g-fin']);
});

test('unchecking every child one by one leaves the group mixed, not checked', () => {
  const tree = treeWith(...FULL);
  const selection = click(tree, EMPTY_SELECTION, 'g-empty');
  assert.equal(checkState(tree, selection, node(tree, 'g-empty')), 'checked');
  assert.equal(checkState(tree, selection, node(tree, 'g-ap')), 'mixed');
});

test('a mark that only restates the inherited state is not stored', () => {
  const tree = treeWith(...FULL);
  // Unchecking something that was never checked changes nothing.
  assert.deepEqual([...click(tree, EMPTY_SELECTION, 'g-fin>p-close', 'g-fin>p-close').keys()], []);
});

// ------------------------------------------------------- document groups and the rest

test('document groups cannot be checked, and are reported when a parent covers them', async () => {
  const tree = treeWith(...FULL);
  assert.deepEqual(click(tree, EMPTY_SELECTION, 'g-docs'), EMPTY_SELECTION);

  // No parent covers the top-level document group, so check everything else at the top.
  const selection = click(tree, EMPTY_SELECTION, 'g-fin', 'g-hr');
  const resolution = resolveSelection(tree, selection);
  assert.equal(resolution.status, 'complete');
  if (resolution.status !== 'complete') return;
  assert.equal(resolution.processes.some((p) => p.uniqueId === 'g-docs'), false);
});

test('a shortcut is never resolved as a process of the group it is listed in', () => {
  const tree = treeWith(...FULL);
  const resolution = resolveSelection(tree, click(tree, EMPTY_SELECTION, 'g-fin'));
  assert.equal(resolution.status, 'complete');
  if (resolution.status !== 'complete') return;
  assert.equal(resolution.processes.some((p) => p.uniqueId === 'p-onb'), false);
  const shortcut = resolution.excluded.find((e) => e.uniqueId === 'p-onb');
  assert.equal(shortcut?.itemType, 'linked-process');
  assert.match(shortcut?.reason ?? '', /shortcut/);
});

test('an unmeasured item type is excluded with a reason, not dropped silently', () => {
  const tree = treeWith(...FULL);
  const resolution = resolveSelection(tree, click(tree, EMPTY_SELECTION, 'g-hr'));
  assert.equal(resolution.status, 'complete');
  if (resolution.status !== 'complete') return;
  assert.deepEqual(resolution.processes.map((p) => p.uniqueId).sort(), ['p-off', 'p-onb']);
  assert.deepEqual(resolution.excluded.map((e) => e.uniqueId), ['p-emb']);
});

test('a process listed twice is resolved once', () => {
  // Month-end close listed a second time, under Accounts Payable.
  const levels: Record<string, TreeItem[]> = {
    ...TREE_LEVELS,
    'g-ap': [...(TREE_LEVELS['g-ap'] ?? []), TREE_LEVELS['g-fin']![1]!],
  };
  let tree = emptyBrowseTree();
  for (const parent of FULL) tree = addBrowseLevel(tree, parent, levels[parent ?? ''] ?? []);
  const resolution = resolveSelection(tree, click(tree, EMPTY_SELECTION, 'g-fin'));
  assert.equal(resolution.status, 'complete');
  if (resolution.status !== 'complete') return;
  assert.equal(resolution.processes.filter((p) => p.uniqueId === 'p-close').length, 1);
  assert.match(resolution.excluded.find((e) => e.uniqueId === 'p-close')?.reason ?? '', /acted on once/);
});

// ------------------------------------------------------------- loading

test('an unexpanded checked group is not resolved from what is on screen', () => {
  // Only the top level has been read, so Finance's contents are unknown.
  const tree = treeWith(null);
  const resolution = resolveSelection(tree, click(tree, EMPTY_SELECTION, 'g-fin'));
  assert.deepEqual(resolution, { status: 'incomplete', unloaded: ['g-fin'] });
});

test('loading reads exactly the levels the selection needs, then resolves', async () => {
  const { gateway, reads } = fixtureGateway();
  const top = treeWith(null);
  const { resolution } = await loadForSelection(gateway, top, click(top, EMPTY_SELECTION, 'g-fin'));
  assert.deepEqual(resolution.processes.map((p) => p.uniqueId).sort(), [
    'p-close',
    'p-exp',
    'p-exp-c',
    'p-inv',
    'p-pay',
  ]);
  // People was never needed, so never read.
  assert.deepEqual(reads, ['g-fin', 'g-ap', 'g-empty']);
});

test('a group whose server says it has no children is still read when checked', async () => {
  const { gateway, reads } = fixtureGateway();
  const tree = treeWith(null, 'g-fin', 'g-ap');
  const { resolution } = await loadForSelection(gateway, tree, click(tree, EMPTY_SELECTION, 'g-empty'));
  assert.deepEqual(resolution.processes, []);
  assert.deepEqual(reads, ['g-empty']);
});

test('loading starts from nothing when the top level has not been read', async () => {
  const { gateway, reads } = fixtureGateway();
  const { tree } = await loadForSelection(gateway, emptyBrowseTree(), EMPTY_SELECTION);
  assert.deepEqual(tree.roots, ['g-fin', 'g-hr', 'g-docs']);
  assert.deepEqual(reads, ['']);
});

// ------------------------------------------------------------- refresh

test('a re-read level drops what has gone, and keeps what was loaded below survivors', () => {
  let tree = treeWith(...FULL);
  const before = node(tree, 'g-ap').children.length;
  tree = addBrowseLevel(tree, 'g-fin', (TREE_LEVELS['g-fin'] ?? []).filter((i) => i.uniqueId !== 'p-close'));
  assert.equal(tree.nodes.has('g-fin>p-close'), false);
  assert.equal(node(tree, 'g-ap').children.length, before);
  assert.equal(node(tree, 'g-ap').childrenLoaded, true);
});

test('the same process under two groups is two nodes, so a mark on one is not a mark on both', () => {
  const tree = treeWith(...FULL);
  assert.ok(tree.nodes.has('g-fin>p-onb'));
  assert.ok(tree.nodes.has('g-hr>p-onb'));
  const selection = click(tree, EMPTY_SELECTION, 'g-hr>p-onb');
  assert.equal(checkState(tree, selection, node(tree, 'g-fin>p-onb')), 'unchecked');
});

test('the groups a selection covers are listed parents first, with depth', () => {
  const tree = treeWith(...FULL);
  const resolution = resolveSelection(tree, click(tree, EMPTY_SELECTION, 'g-fin', 'g-fin>p-close'));
  assert.equal(resolution.status, 'complete');
  if (resolution.status !== 'complete') return;
  assert.deepEqual(
    resolution.groups.map((g) => [g.title, g.depth, g.path.join('/')]),
    [
      ['Finance', 0, ''],
      ['Accounts Payable', 1, 'Finance'],
      ['Retired', 2, 'Finance/Accounts Payable'],
    ],
  );
});

test('a group that is only partly selected from outside is not covered', () => {
  const tree = treeWith(...FULL);
  const resolution = resolveSelection(tree, click(tree, EMPTY_SELECTION, 'g-ap>p-pay'));
  assert.equal(resolution.status, 'complete');
  if (resolution.status !== 'complete') return;
  assert.deepEqual(resolution.groups, []);
});
