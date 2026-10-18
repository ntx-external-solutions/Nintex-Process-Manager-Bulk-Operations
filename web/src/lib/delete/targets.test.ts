import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTargetIds, targetsFromCsv } from './targets.ts';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

test('a results file is read as a target file through its ObjectID column', () => {
  const read = targetsFromCsv(`﻿ObjectType,ObjectID,Name\r\nProcess,${A},Alpha\r\nProcess,${B},Bravo\r\n,,\r\n`);
  assert.deepEqual(read, { ids: [A, B], rowCount: 2, headers: ['ObjectType', 'ObjectID', 'Name'], idColumnMissing: false });
});

test('rows under headers it cannot read are reported as that, not as an empty file', () => {
  assert.deepEqual(targetsFromCsv('Process Name,Owner\nAlpha,x\n'), {
    ids: [],
    rowCount: 1,
    headers: ['Process Name', 'Owner'],
    idColumnMissing: true,
  });
  assert.equal(targetsFromCsv('ProcessID\n').idColumnMissing, false, 'an empty file is just empty');
});

test('numeric ids resolve through the listing; unknown ones are reported; each process once', () => {
  const index = new Map([
    [A, { uniqueId: A, numericId: 1001 }],
    [B, { uniqueId: B, numericId: 1002 }],
  ]);
  const C = '33333333-3333-3333-3333-333333333333';
  assert.deepEqual(resolveTargetIds([' 1001 ', A.toUpperCase(), C, '999', 'nonsense', ''], index), {
    uniqueIds: [A, C],
    unknown: ['999', 'nonsense'],
  });
});
