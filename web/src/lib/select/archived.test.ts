import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProcessListItem, ProcessListPage } from '../pm/processes.ts';
import {
  ARCHIVED_LIST_TYPE,
  ARCHIVED_PAGE_SIZE,
  groupArchived,
  groupsNeedingPaths,
  loadArchived,
  loadGroupPaths,
  ORPHANED_BUCKET,
  readGroupExists,
  toArchivedProcess,
} from './archived.ts';
import { ARCHIVED_ROWS, archivedPage } from './fixtures.ts';

function rows() {
  return ARCHIVED_ROWS.map(toArchivedProcess).filter((p) => p !== null);
}

test('only an explicit false means the group is gone', () => {
  assert.deepEqual(readGroupExists(false), { exists: false, reported: true });
  assert.deepEqual(readGroupExists('False'), { exists: false, reported: true });
  assert.deepEqual(readGroupExists('0'), { exists: false, reported: true });
  assert.deepEqual(readGroupExists(0), { exists: false, reported: true });
  assert.deepEqual(readGroupExists(true), { exists: true, reported: true });
  assert.deepEqual(readGroupExists('true'), { exists: true, reported: true });
});

test('absent is not false', () => {
  assert.deepEqual(readGroupExists(undefined), { exists: true, reported: false });
  assert.deepEqual(readGroupExists(null), { exists: true, reported: false });
  assert.deepEqual(readGroupExists(''), { exists: true, reported: false });
});

test('orphans are bucketed by the flag, including one with a real group id', () => {
  const view = groupArchived(rows());
  const orphaned = view.buckets.find((b) => b.key === ORPHANED_BUCKET);
  assert.deepEqual(orphaned?.processes.map((p) => p.uniqueId).sort(), ['a-4', 'a-5']);
  // a-5 reports groupId 977, a real-looking id. A groupId === 1 test would miss it.
  assert.equal(orphaned?.processes.find((p) => p.uniqueId === 'a-5')?.groupId, 977);
  assert.equal(view.orphaned, 2);
});

test('groupId 1 alone does not make a process an orphan', () => {
  const row = { ...(ARCHIVED_ROWS[3] as ProcessListItem), groupExists: true };
  const view = groupArchived([toArchivedProcess(row)!]);
  assert.equal(view.orphaned, 0);
  assert.equal(view.buckets[0]?.key, 'g-tenant');
});

test('the orphaned bucket comes last and the rest are grouped by original group', () => {
  const view = groupArchived(rows());
  assert.deepEqual(
    view.buckets.map((b) => [b.label, b.processes.map((p) => p.uniqueId)]),
    [
      ['Accounts Payable', ['a-2', 'a-3']],
      ['Finance', ['a-6', 'a-1']],
      ['Group no longer exists', ['a-5', 'a-4']],
    ],
  );
  assert.equal(view.total, 6);
});

test('a row with no flag is grouped normally and counted as unreported', () => {
  const view = groupArchived(rows());
  assert.equal(view.unreported, 1);
  assert.ok(view.buckets.find((b) => b.key === 'g-fin')?.processes.some((p) => p.uniqueId === 'a-6'));
});

test('a bucket is labelled with the tree path when the tree knows the group', () => {
  const view = groupArchived(rows(), (groupUniqueId) =>
    groupUniqueId === 'g-ap' ? ['Finance', 'Accounts Payable'] : null,
  );
  assert.ok(view.buckets.some((b) => b.label === 'Finance / Accounts Payable'));
  assert.ok(view.buckets.some((b) => b.label === 'Finance'));
});

test('the listing is read with the archived list type until a short page', async () => {
  const asked: Array<[number, number]> = [];
  const full = (page: number): ProcessListPage => ({
    items: Array.from({ length: page === 1 ? ARCHIVED_PAGE_SIZE : 3 }, (_, i) => ({
      ...(ARCHIVED_ROWS[0] as ProcessListItem),
      processUniqueId: `p${page}-${i}`,
    })),
    totalItemCount: ARCHIVED_PAGE_SIZE + 3,
  });
  const loaded = await loadArchived(async (page, listType) => {
    asked.push([page, listType]);
    return full(page);
  });
  assert.deepEqual(asked, [
    [1, ARCHIVED_LIST_TYPE],
    [2, ARCHIVED_LIST_TYPE],
  ]);
  assert.equal(loaded.length, ARCHIVED_PAGE_SIZE + 3);
});

test('an id that appears on two pages is kept once', async () => {
  const loaded = await loadArchived(async (page) =>
    page === 1
      ? { items: Array.from({ length: ARCHIVED_PAGE_SIZE }, () => ARCHIVED_ROWS[0] as ProcessListItem), totalItemCount: 1 }
      : archivedPage(1),
  );
  assert.equal(loaded.length, ARCHIVED_ROWS.length);
});

test('a page that keeps coming back full stops at the cap', async () => {
  let calls = 0;
  await loadArchived(
    async () => {
      calls++;
      return { items: Array.from({ length: ARCHIVED_PAGE_SIZE }, () => ARCHIVED_ROWS[0] as ProcessListItem), totalItemCount: 0 };
    },
    { maxPages: 3 },
  );
  assert.equal(calls, 3);
});

test('paths are read once per live group, and a failed or empty one falls back', async () => {
  const asked: string[] = [];
  const processes = rows();
  const ids = groupsNeedingPaths(processes);
  // Orphans have no group to ask about.
  assert.deepEqual(ids.sort(), ['g-ap', 'g-fin']);
  const paths = await loadGroupPaths([...ids, 'g-ap'], async (id) => {
    asked.push(id);
    if (id === 'g-fin') throw new Error('HTTP 500');
    return ['Finance', 'Accounts Payable'];
  });
  assert.deepEqual(asked.sort(), ['g-ap', 'g-fin']);
  const view = groupArchived(processes, (id) => paths.get(id) ?? null);
  assert.deepEqual(view.buckets.map((b) => b.label), ['Finance', 'Finance / Accounts Payable', 'Group no longer exists']);
});
