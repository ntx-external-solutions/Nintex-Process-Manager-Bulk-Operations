// Ported from Tests/Test-Dependencies.ps1: the flag and orphan assertions of "Processes
// whose group no longer exists", and "Whether the tenant reports groupExists at all".
//
// The listing reports groupExists per row. False means the group was deleted while the
// process sat in the archive, and RestoreProcess answers HTTP 500 for a destination
// group that is not there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readGroupExists } from '../select/archived.ts';
import { findOrphanedGroupProcesses, groupExistsCoverage, type CoverageEntry } from './groups.ts';
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

test('orphans are found by the flag, not by groupId 1', { skip: PHASE.hold }, () => {
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

test('a listing that reports the flag everywhere is fully covered', { skip: PHASE.hold }, () => {
  const cov = groupExistsCoverage(
    coverage({ groupExists: false, groupExistsReported: true }, { groupExists: true, groupExistsReported: true }),
  );
  assert.equal(cov.state, 'Full', 'a listing that reports the flag everywhere is fully covered');
  assert.equal(cov.orphans, 1, 'and the orphan count means what it says');
  assert.equal(cov.missing, 0, 'with nothing unreported');
});

test('a listing that never reports the flag offers no orphan detection', { skip: PHASE.hold }, () => {
  const cov = groupExistsCoverage(
    coverage({ groupExists: true, groupExistsReported: false }, { groupExists: true, groupExistsReported: false }),
  );
  assert.equal(cov.state, 'None', 'a listing that never reports it offers no orphan detection');
  assert.equal(cov.orphans, 0, 'and its zero is unmeasured, not clean');
  assert.equal(cov.missing, 2, 'every row is unreported');
});

test('a listing that reports the flag on some rows is its own case', { skip: PHASE.hold }, () => {
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

test('no index, or an empty one, has no coverage', { skip: PHASE.hold }, () => {
  assert.equal(groupExistsCoverage(null).state, 'None', 'a null index reports no coverage rather than throwing');
  assert.equal(groupExistsCoverage(new Map()).state, 'None', 'and so does an empty one');
});
