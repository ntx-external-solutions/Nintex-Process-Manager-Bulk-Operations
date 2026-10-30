// W7: the id input Bulk Delete and Bulk Archive share. Typed ids, or a CSV with any of
// the accepted id headers, including this app's own results files. Ids only, never names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../csv/parse.ts';
import { resultRow, resultsToCsv } from '../exec/report.ts';
import {
  CSV_ID_COLUMNS,
  csvReadNote,
  ID_TEMPLATE_CSV,
  linesText,
  looksLikeId,
  resolveTargetIds,
  targetsFromCsv,
  typedIds,
} from './ids.ts';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

test('a results file is read as a target file through its ObjectID column', () => {
  const read = targetsFromCsv(`﻿ObjectType,ObjectID,Name\r\nProcess,${A},Alpha\r\nProcess,${B},Bravo\r\n,,\r\n`);
  assert.deepEqual(read, {
    ids: [A, B],
    rowCount: 2,
    headers: ['ObjectType', 'ObjectID', 'Name'],
    idColumnMissing: false,
    duplicates: 0,
    noIdLines: [],
    nameColumn: null,
  });
});

test('every accepted id header is read, whatever its case', () => {
  for (const column of CSV_ID_COLUMNS) {
    for (const header of [column, column.toUpperCase(), column.toLowerCase()]) {
      assert.deepEqual(targetsFromCsv(`Owner,${header}\nx,${A}\n`).ids, [A], header);
    }
  }
});

test('Excel output: a BOM, CRLF and quoted cells', () => {
  const read = targetsFromCsv(`﻿"Process Name","ProcessID"\r\n"Pay, then file","${A}"\r\n"Say ""hi""",${B}\r\n`);
  assert.deepEqual(read.headers, ['Process Name', 'ProcessID'], 'the BOM is not part of the first header');
  assert.deepEqual(read.ids, [A, B]);
});

test('a duplicate id is dropped and counted, whatever its case', () => {
  const read = targetsFromCsv(`ProcessID\n${A}\n${B}\n${A.toUpperCase()}\n${A}\n`);
  assert.deepEqual(read.ids, [A, B]);
  assert.equal(read.duplicates, 2);
});

test('a row with no id is listed by its line in the file, counting a quoted cell that spans lines', () => {
  const read = targetsFromCsv(`Name,ProcessID\r\nAlpha,${A}\r\n"Two\r\nlines",\r\n\r\nBravo,${B}\r\nCharlie,\r\n`);
  assert.deepEqual(read.ids, [A, B]);
  assert.deepEqual(read.noIdLines, [3, 7], 'the blank line 5 is skipped, not reported');
  assert.equal(read.idColumnMissing, false, 'the id column is there, just empty on those rows');
  assert.match(csvReadNote('ids.csv', read), /^ids\.csv: 4 row\(s\) read, 2 id\(s\) found, 2 row\(s\) with no id \(lines 3 and 7\)\. This replaced what was in the box\.$/);
});

test('a file with names but no ids says why names are not used and where to get ids', () => {
  const read = targetsFromCsv('Process Name,Owner\nAlpha,x\nBravo,y\n');
  assert.equal(read.idColumnMissing, true);
  assert.equal(read.nameColumn, 'Process Name');
  assert.deepEqual(read.ids, []);
  const note = csvReadNote('names.csv', read);
  assert.match(note, /found no id column/);
  assert.match(note, /name column \(Process Name\), but processes are picked by id only: names are not unique/);
  assert.match(note, /results file from this app has the ids in ObjectID/);
  assert.match(note, /Nothing was put in the box/);

  const other = csvReadNote('other.csv', targetsFromCsv('Owner,Expert\nx,y\n'));
  assert.match(other, /Columns in the file: Owner, Expert\./);
  assert.equal(targetsFromCsv('ProcessID\n').idColumnMissing, false, 'an empty file is just empty');
});

test('one of this app’s own results files reads back, as the operator downloads it', () => {
  const csv = '﻿' + resultsToCsv([
    resultRow({ objectId: C, name: 'Gone', operation: 'Resolve', status: 'Skipped', message: 'Not found' }),
    resultRow({ objectId: A, name: 'Alpha', operation: 'Archive', status: 'Archived', message: 'Archived from Finance', groupId: 12 }),
    resultRow({ objectId: B, name: 'Bravo, with a comma', operation: 'Archive', status: 'Failed', message: 'Refused', statusCode: 400 }),
    resultRow({ objectId: A, name: 'Alpha', operation: 'VariationWarning', status: 'Accepted', message: 'x' }),
  ]);
  const read = targetsFromCsv(csv);
  assert.deepEqual(read.ids, [C, A, B]);
  assert.equal(read.duplicates, 1);
  assert.match(csvReadNote('archive-results.csv', read), /4 row\(s\) read, 3 id\(s\) found, 1 duplicate\(s\) dropped\./);
});

test('the template is one column headed ProcessID, and reads back', () => {
  assert.deepEqual(parseCsv(ID_TEMPLATE_CSV), [['ProcessID']]);
  assert.deepEqual(targetsFromCsv(`${ID_TEMPLATE_CSV}${A}\r\n`).ids, [A]);
});

test('typed ids split on lines, commas, semicolons and spaces', () => {
  assert.deepEqual(typedIds(` ${A}\n1001, ${B};\r\n\n42 `), [A, '1001', B, '42']);
  assert.equal(looksLikeId(A), true);
  assert.equal(looksLikeId('1001'), true);
  assert.equal(looksLikeId('Pay a supplier'), false);
});

test('line lists stay short', () => {
  assert.equal(linesText([4]), 'line 4');
  assert.equal(linesText([4, 9, 12]), 'lines 4, 9 and 12');
  assert.equal(linesText([1, 2, 3, 4, 5], 2), 'lines 1, 2 and 3 more');
});

test('numeric ids resolve through the listing; unknown ones are reported; each process once', () => {
  const index = new Map([
    [A, { uniqueId: A, numericId: 1001 }],
    [B, { uniqueId: B, numericId: 1002 }],
  ]);
  assert.deepEqual(resolveTargetIds([' 1001 ', A.toUpperCase(), C, '999', 'nonsense', ''], index), {
    uniqueIds: [A, C],
    unknown: ['999', 'nonsense'],
  });
});
