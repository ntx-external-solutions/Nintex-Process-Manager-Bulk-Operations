// Ported from Tests/Test-Dependencies.ps1: "A process that no source can name". The
// collateral list's assertions are in collateral.test.ts.
//
// `Format-NpmProcessName` is ported as the naming rule inside resultRow (exec/report.ts),
// so those assertions run now against it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultRow } from '../exec/report.ts';
import { isRealName, selectDisplayName, UNKNOWN_NAME } from './names.ts';
import { PHASE } from './phases.ts';

// Synthetic: the id of a process absent from the baseline, the index and every claim.
const GHOST = 'ffff0000-0000-0000-0000-0000000000ff';

const formatted = (name: string) => resultRow({ objectId: GHOST, name, operation: 'Delete', status: 'Success' }).name;

test('a name is used as-is, and a missing one is said in words', () => {
  assert.equal(formatted('Real Name'), 'Real Name', 'a real name is used as-is');
  assert.equal(formatted(''), UNKNOWN_NAME, 'an empty name says so explicitly');
  assert.equal(formatted(GHOST), UNKNOWN_NAME, 'a "name" that is only the id is not a name');
  assert.match(UNKNOWN_NAME, /not in any process list/, 'and the marker says why there is no name');
});

test('a label is real only when it carries information', { skip: PHASE.checkpoints }, () => {
  assert.equal(isRealName('Real Name', GHOST), true, 'a real name carries information');
  assert.equal(isRealName('', GHOST), false, 'an empty one does not');
  assert.equal(isRealName(GHOST, GHOST), false, 'nor does the id');
  assert.equal(isRealName(UNKNOWN_NAME, GHOST), false, 'nor does the marker itself');
});

test('the fullest real name wins, and the marker never does', { skip: PHASE.checkpoints }, () => {
  // Longest wins, because the group listing truncates a variation to its master.
  assert.equal(
    selectDisplayName([{ name: 'Order Handling' }, { name: 'Order Handling :: Partner' }], GHOST),
    'Order Handling :: Partner',
    'the fuller name wins where two producers disagree',
  );
  // But the marker is longer than most real names and must not win on length.
  assert.equal(
    selectDisplayName([{ name: UNKNOWN_NAME }, { name: 'Short' }], GHOST),
    'Short',
    'the no-name marker never beats a real name, however short',
  );
  assert.equal(
    selectDisplayName([{ name: '' }, { name: GHOST }], GHOST),
    UNKNOWN_NAME,
    'and when nothing names it, the label says so',
  );
  assert.equal(selectDisplayName([], GHOST), UNKNOWN_NAME, 'no rows at all is the same answer');
});
