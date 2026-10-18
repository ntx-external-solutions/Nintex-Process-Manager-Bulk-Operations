import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../csv/parse.ts';
import { countByStatus, RESULT_COLUMNS, resultRow, resultsToCsv, UNKNOWN_NAME } from './report.ts';

const ID = '00000001-0000-4000-8000-000000000001';

test('the columns are the script\'s, in its order', () => {
  // A results file from either tool must read the same, and round-trip as a target file.
  assert.deepEqual(
    [...RESULT_COLUMNS],
    ['ObjectType', 'ObjectID', 'Name', 'Operation', 'Status', 'Message', 'GroupId', 'StatusCode'],
  );
});

test('a row is never named by its own id', () => {
  assert.equal(resultRow({ objectId: ID, name: ID, operation: 'Archive', status: 'Success' }).name, UNKNOWN_NAME);
  assert.equal(
    resultRow({ objectId: ID, name: ID.toUpperCase(), operation: 'Archive', status: 'Success' }).name,
    UNKNOWN_NAME,
  );
  assert.equal(resultRow({ objectId: ID, name: '  ', operation: 'Archive', status: 'Success' }).name, UNKNOWN_NAME);
  assert.equal(resultRow({ objectId: ID, operation: 'Archive', status: 'Success' }).name, UNKNOWN_NAME);
  assert.equal(
    resultRow({ objectId: ID, name: 'Onboarding', operation: 'Archive', status: 'Success' }).name,
    'Onboarding',
  );
});

test('group id and status code are blank where they do not apply', () => {
  const row = resultRow({ objectId: ID, name: 'P', operation: 'Archive', status: 'Success', statusCode: 0 });
  assert.equal(row.groupId, '');
  assert.equal(row.statusCode, '');
  assert.equal(row.objectType, 'Process');

  const refused = resultRow({
    objectId: ID,
    name: 'P',
    operation: 'Archive',
    status: 'Blocked',
    groupId: 333,
    statusCode: 400,
  });
  assert.equal(refused.groupId, '333');
  assert.equal(refused.statusCode, '400');
});

test('the CSV round-trips, commas and quotes included', () => {
  const rows = [
    resultRow({
      objectId: ID,
      name: 'Hire, onboard and "induct"',
      operation: 'Archive',
      status: 'Blocked',
      message: 'HTTP 400 refused by the tenant: owner is a disabled user',
      groupId: 12,
      statusCode: 400,
    }),
  ];
  const parsed = parseCsv(resultsToCsv(rows));
  assert.deepEqual(parsed[0], [...RESULT_COLUMNS]);
  assert.deepEqual(parsed[1], [
    'Process',
    ID,
    'Hire, onboard and "induct"',
    'Archive',
    'Blocked',
    'HTTP 400 refused by the tenant: owner is a disabled user',
    '12',
    '400',
  ]);
});

test('statuses are counted in vocabulary order, and unknown ones are flagged, not dropped', () => {
  const row = (status: string) => resultRow({ objectId: ID, name: 'P', operation: 'Archive', status });
  const counts = countByStatus(
    [row('Failed'), row('Success'), row('Success'), row('Mystery')],
    ['Success', 'Pending', 'Failed'],
  );
  assert.deepEqual(counts, [
    { status: 'Success', count: 2, unexpected: false },
    { status: 'Failed', count: 1, unexpected: false },
    { status: 'Mystery', count: 1, unexpected: true },
  ]);
});
