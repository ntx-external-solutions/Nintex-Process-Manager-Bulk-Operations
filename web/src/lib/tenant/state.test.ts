import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProcessListItem, ProcessListPage } from '../pm/processes.ts';
import { ARCHIVED_ROWS } from '../select/fixtures.ts';
import {
  ACTIVE_LIST_TYPE,
  ARCHIVED_LIST_TYPE,
  compareTenantState,
  INDEX_PAGE_SIZE,
  indexEntry,
  loadProcessIndex,
  type IndexEntry,
  type ProcessIndex,
} from './state.ts';

function row(processUniqueId: string, groupId = 10): ProcessListItem {
  return { ...(ARCHIVED_ROWS[0] as ProcessListItem), processUniqueId, processName: processUniqueId, groupId };
}

test('the index sweeps active then archived, and archived wins for an id in both', async () => {
  const asked: number[] = [];
  const pages: Record<number, ProcessListPage> = {
    [ACTIVE_LIST_TYPE]: { items: [row('A'), row('b')], totalItemCount: 2 },
    [ARCHIVED_LIST_TYPE]: { items: [row('b'), row('c')], totalItemCount: 2 },
  };
  const index = await loadProcessIndex(async (page, listType) => {
    asked.push(listType);
    return pages[listType]!;
  });
  assert.deepEqual(asked, [ACTIVE_LIST_TYPE, ARCHIVED_LIST_TYPE]);
  assert.equal(indexEntry(index, 'a')?.isArchived, false);
  assert.equal(indexEntry(index, 'B')?.isArchived, true);
  assert.equal(indexEntry(index, 'c')?.isArchived, true);
  assert.equal(indexEntry(index, 'missing'), null);
});

test('each sweep pages until a short page', async () => {
  const asked: Array<[number, number]> = [];
  await loadProcessIndex(async (page, listType) => {
    asked.push([listType, page]);
    const length = listType === ACTIVE_LIST_TYPE && page === 1 ? INDEX_PAGE_SIZE : 0;
    return { items: Array.from({ length }, (_, i) => row(`p${i}`)), totalItemCount: 0 };
  });
  assert.deepEqual(asked, [
    [ACTIVE_LIST_TYPE, 1],
    [ACTIVE_LIST_TYPE, 2],
    [ARCHIVED_LIST_TYPE, 1],
  ]);
});

function entry(uniqueId: string, isArchived: boolean, groupId = 10): IndexEntry {
  return { uniqueId, name: uniqueId, isArchived, groupId, groupUniqueId: null, groupName: '', groupExists: true };
}
const idx = (...e: IndexEntry[]): ProcessIndex => new Map(e.map((x) => [x.uniqueId.toLowerCase(), x]));

test('every kind of change is named, and expected changes are not collateral', () => {
  const baseline = idx(entry('t', false), entry('a', false), entry('u', true), entry('m', false, 1), entry('am', false, 1), entry('gone', false), entry('same', false));
  const after = idx(entry('t', true), entry('a', true), entry('u', false), entry('m', false, 2), entry('am', true, 2), entry('same', false));
  const changes = compareTenantState(baseline, after, ['T']).map((c) => [c.uniqueId, c.change]);
  assert.deepEqual(changes, [
    ['a', 'Archived'],
    ['u', 'Unarchived'],
    ['m', 'Moved'],
    ['am', 'ArchivedAndMoved'],
    ['gone', 'Disappeared'],
  ]);
});

test('something the run touched that the baseline never listed is NotInBaseline, once', () => {
  const changes = compareTenantState(idx(), idx(entry('x', true)), [], ['x', 'X']);
  assert.deepEqual(changes.map((c) => [c.uniqueId, c.change, c.isArchivedNow]), [['x', 'NotInBaseline', true]]);
});
