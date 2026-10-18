import { test } from 'node:test';
import assert from 'node:assert/strict';

import { notPorted } from '../phases.ts';
import { readFixture } from './fixtures.ts';

test('the PowerShell fixtures are read in place, fresh each time', () => {
  const a = readFixture<{ UniqueId: string; ProcessProcedures: unknown }>('ActionCustomerRequest.json');
  const b = readFixture<{ UniqueId: string }>('ActionCustomerRequest.json');
  assert.match(a.UniqueId, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
  for (const name of ['AllBuckets.json', 'DependencyTest.json'] as const) {
    assert.equal(typeof readFixture<{ UniqueId: string }>(name).UniqueId, 'string', name);
  }
});

test('a stub says which phase will port it', () => {
  assert.throws(() => notPorted('hold'), /Not ported yet \(W5 hold/);
});
