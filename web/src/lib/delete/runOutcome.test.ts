import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reArchiveOperation } from './runOutcome.ts';

test('the unwind names a target, a holder and a parked holder apart', () => {
  assert.equal(reArchiveOperation('Target'), 'ReArchive');
  assert.equal(reArchiveOperation('Holder'), 'ReArchiveHolder');
  assert.equal(reArchiveOperation('Holder', true), 'ReArchiveOrphanedHolder');
  assert.equal(reArchiveOperation('Target', true), 'ReArchive', 'a parked target is still a target');
});
