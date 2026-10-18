import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CANCELLED, createControls, defaultIsFatal, forEachBatched } from './runner.ts';

test('items run in batches no wider than the concurrency', async () => {
  let inFlight = 0;
  let widest = 0;
  const controls = createControls();
  const { results } = await forEachBatched(
    [1, 2, 3, 4, 5],
    controls,
    async (n) => {
      inFlight++;
      widest = Math.max(widest, inFlight);
      await Promise.resolve();
      inFlight--;
      return n * 10;
    },
    { concurrency: 2 },
  );
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.equal(widest, 2);
});

test('a stop lets the batch in flight finish and attempts nothing after it', async () => {
  const controls = createControls();
  const attempted: number[] = [];
  const { results, notAttempted } = await forEachBatched(
    [1, 2, 3, 4, 5],
    controls,
    async (n) => {
      attempted.push(n);
      if (n === 1) controls.stop('fatal');
      return n;
    },
    { concurrency: 2 },
  );
  // 2 was already sent with 1. Abandoning it would not unsend it.
  assert.deepEqual(attempted, [1, 2]);
  assert.deepEqual(results, [1, 2]);
  // Returned so each one still gets a results row.
  assert.deepEqual(notAttempted, [3, 4, 5]);
  assert.equal(controls.stoppedReason(), 'fatal');
});

test('an aborted signal reads as a cancellation with the standard reason', async () => {
  const abort = new AbortController();
  abort.abort();
  const controls = createControls({ signal: abort.signal });
  const { results, notAttempted } = await forEachBatched([1, 2], controls, async (n) => n);
  assert.deepEqual(results, []);
  assert.deepEqual(notAttempted, [1, 2]);
  assert.equal(controls.stoppedReason(), CANCELLED);
});

test('the first stop reason is the one kept', () => {
  const controls = createControls();
  controls.stop('session ended');
  controls.stop('cancelled');
  assert.equal(controls.stoppedReason(), 'session ended');
});

test('only a signed-out error is fatal by default', () => {
  assert.notEqual(defaultIsFatal({ signedOut: true }), null);
  assert.equal(defaultIsFatal({ signedOut: false }), null);
  assert.equal(defaultIsFatal(new Error('HTTP 400')), null);
  assert.equal(defaultIsFatal(null), null);
});

test('progress reports the last item of each batch', async () => {
  const seen: string[] = [];
  await forEachBatched(['a', 'b', 'c'], createControls(), async (s) => s, {
    concurrency: 2,
    label: (s) => s,
    onProgress: (p) => seen.push(`${p.done}/${p.total} ${p.label}`),
  });
  assert.deepEqual(seen, ['2/3 b', '3/3 c']);
});
