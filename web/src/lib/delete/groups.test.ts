// Ported from Tests/Test-Dependencies.ps1: the flag and orphan assertions of "Processes
// whose group no longer exists", and "Whether the tenant reports groupExists at all".
// The group enumeration is from Tests/Test-BulkArchive.ps1, "Enumerating a group":
// Mode 1 shares it with delete-by-group.
//
// The listing reports groupExists per row. False means the group was deleted while the
// process sat in the archive, and RestoreProcess answers HTTP 500 for a destination
// group that is not there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readGroupExists } from '../select/archived.ts';
import type { IndexEntry } from '../tenant/state.ts';
import { findOrphanedGroupProcesses, groupDescendantIds, groupExistsCoverage, processesInGroups, type CoverageEntry } from './groups.ts';
import { PHASE } from './phases.ts';
import { orphanedGroupIndex } from './testing/index.ts';

test('only an explicit false says the group is gone', () => {
  // ConvertTo-NpmGroupExists is ported as readGroupExists(...).exists.
  assert.equal(readGroupExists(null).exists, true, 'an unreported flag is read as "the group is there"');
  assert.equal(readGroupExists(true).exists, true, 'true is true');
  assert.equal(readGroupExists(false).exists, false, 'false is false');
  assert.equal(readGroupExists('False').exists, false, 'the string False counts, because JSON round-trips it');
  assert.equal(readGroupExists('true').exists, true, 'the string true counts');
  assert.equal(readGroupExists('').exists, true, 'an empty string is not a claim that the group is gone');
  assert.equal(readGroupExists(0).exists, false, 'numeric 0 counts as false');
});

test('orphans are found by the flag, not by groupId 1', () => {
  const index = orphanedGroupIndex();
  const ids = [...index.values()].map((e) => e.uniqueId);

  const orphans = findOrphanedGroupProcesses(index, ids);
  assert.equal(orphans.length, 2, 'both orphaned rows are found');
  assert.equal(
    orphans.filter((o) => o.originalGroupId === 832).length,
    1,
    'an orphan in a real numeric group is found, so the test is not groupId -eq 1',
  );
  assert.equal(orphans.filter((o) => o.name === 'Group is fine').length, 0, 'groupId 1 with the flag set true is not an orphan');
  assert.equal(
    orphans.filter((o) => o.name === 'Flag not reported').length,
    0,
    'a row that never reported the flag is not treated as an orphan',
  );
  assert.equal(findOrphanedGroupProcesses(null, ids).length, 0, 'a null index yields nothing rather than throwing');
});

// ---------------------------------------------------------------- coverage
// Absent and false are not the same claim. Control flow reads absence as "the group is
// there", which degrades gracefully, but the report has to be able to say a zero is
// unmeasured rather than clean.

const coverage = (...rows: CoverageEntry[]) => new Map(rows.map((r, i) => [String(i), r]));

test('a listing that reports the flag everywhere is fully covered', () => {
  const cov = groupExistsCoverage(
    coverage({ groupExists: false, groupExistsReported: true }, { groupExists: true, groupExistsReported: true }),
  );
  assert.equal(cov.state, 'Full', 'a listing that reports the flag everywhere is fully covered');
  assert.equal(cov.orphans, 1, 'and the orphan count means what it says');
  assert.equal(cov.missing, 0, 'with nothing unreported');
});

test('a listing that never reports the flag offers no orphan detection', () => {
  const cov = groupExistsCoverage(
    coverage({ groupExists: true, groupExistsReported: false }, { groupExists: true, groupExistsReported: false }),
  );
  assert.equal(cov.state, 'None', 'a listing that never reports it offers no orphan detection');
  assert.equal(cov.orphans, 0, 'and its zero is unmeasured, not clean');
  assert.equal(cov.missing, 2, 'every row is unreported');
});

test('a listing that reports the flag on some rows is its own case', () => {
  const cov = groupExistsCoverage(
    coverage(
      { groupExists: false, groupExistsReported: true },
      { groupExists: true, groupExistsReported: true },
      { groupExists: true, groupExistsReported: false },
    ),
  );
  assert.equal(cov.state, 'Mixed', 'some rows carrying the flag and some not is its own case');
  assert.equal(cov.missing, 1, 'and the unreported rows are counted');
  assert.equal(cov.reported, 2, 'alongside the reported ones');
});

test('no index, or an empty one, has no coverage', () => {
  assert.equal(groupExistsCoverage(null).state, 'None', 'a null index reports no coverage rather than throwing');
  assert.equal(groupExistsCoverage(new Map()).state, 'None', 'and so does an empty one');
});

// ---------------------------------------------------------------- enumerating a group
// The script's old path made one unpaginated breadcrumb call, so a group larger than one
// response was silently partly archived. The index is the enumeration now.

const tree = [
  { id: 100, parentId: null },
  { id: 110, parentId: 100 },
  { id: 200, parentId: null },
  { id: 300, parentId: null },
];

test('a group is itself, or itself and every group beneath it', () => {
  assert.deepEqual(groupDescendantIds(tree, 100, false), ['100'], 'without subgroups a group is just itself');
  const withSubs = groupDescendantIds(tree, 100);
  assert.equal(withSubs.length, 2, 'with subgroups it is the group and its descendants');
  assert.equal(withSubs[0], '100', 'the root comes first');
  assert.ok(withSubs.includes('110'), 'and the child is included');
  assert.equal(groupDescendantIds(tree, null).length, 0, 'a null group id yields nothing rather than everything');
  assert.deepEqual(groupDescendantIds(tree, '100'), groupDescendantIds(tree, 100), '"100" and 100 are the same group');

  const cyclic = [
    { id: 1, parentId: 2 },
    { id: 2, parentId: 1 },
  ];
  assert.equal(groupDescendantIds(cyclic, 1).length, 2, 'a cycle in the group tree terminates instead of hanging');
});

test('the processes in a group come from the index, whole, and archived only when asked', () => {
  const entry = (i: number, groupId: number, isArchived = false): IndexEntry => ({
    uniqueId: `eeee0000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    name: `P${String(i).padStart(3, '0')}`,
    isArchived,
    groupId,
    groupUniqueId: null,
    groupName: '',
    groupExists: true,
  });
  const rows = [
    ...Array.from({ length: 250 }, (_, i) => entry(i, 300)),
    entry(900, 100),
    entry(901, 100),
    entry(902, 100, true),
    entry(903, 110),
    entry(904, 200),
  ];
  const index = new Map(rows.map((r) => [r.uniqueId.toLowerCase(), r]));

  assert.equal(processesInGroups(index, ['300']).length, 250, 'a group larger than one page is enumerated whole');
  assert.equal(processesInGroups(index, [100]).length, 2, 'an archived process is not offered again');
  assert.equal(processesInGroups(index, [100], true).length, 3, 'unless the caller asks for archived ones too');
  assert.equal(processesInGroups(index, groupDescendantIds(tree, 100)).length, 3, 'and the subgroup is included when its id is');
  assert.deepEqual(
    processesInGroups(index, [100, 110]).map((e) => e.name),
    ['P900', 'P901', 'P903'],
    'sorted by name',
  );
  assert.equal(processesInGroups(null, [100]).length, 0, 'a null index yields nothing');
  assert.equal(processesInGroups(index, [null]).length, 0, 'and so does no group');
});
