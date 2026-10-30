// F7 (R15): the progress line says when Process Manager is slow to answer, and stops
// saying so when it answers. The retry itself is in the proxy, out of the browser's sight.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SlowCalls, slowMessage, type Clock } from './slowCalls.ts';

function fakeClock() {
  let now = 0;
  const intervals = new Map<number, () => void>();
  let next = 1;
  const clock: Clock = {
    now: () => now,
    setInterval: (fn) => {
      intervals.set(next, fn);
      return next++;
    },
    clearInterval: (handle) => intervals.delete(handle as number),
  };
  return {
    clock,
    intervals,
    advance(ms: number) {
      now += ms;
      for (const fn of intervals.values()) fn();
    },
  };
}

test('a call that hangs past the threshold shows the slow status, which clears when it answers', () => {
  const t = fakeClock();
  const calls = new SlowCalls(t.clock, 15_000, 5_000);
  let changes = 0;
  calls.subscribe(() => changes++);

  const done = calls.begin();
  t.advance(10_000);
  assert.equal(calls.snapshot(), null, 'not slow yet');

  t.advance(5_000);
  assert.deepEqual(calls.snapshot(), { seconds: 15 });
  assert.match(slowMessage(calls.snapshot()!), /^Process Manager is slow to answer \(15s so far\)\. Still waiting, and a failed read is retried\.$/);

  t.advance(45_000);
  assert.deepEqual(calls.snapshot(), { seconds: 60 }, 'the waiting time moves, as in R15’s 60-second hang');

  done();
  assert.equal(calls.snapshot(), null, 'cleared as soon as the call answers');
  assert.equal(t.intervals.size, 0, 'no timer left running');
  assert.equal(changes, 3);
});

test('the status follows the oldest call still waiting, and a quick call never shows it', () => {
  const t = fakeClock();
  const calls = new SlowCalls(t.clock, 15_000, 5_000);

  const quick = calls.begin();
  t.advance(1_000);
  quick();
  assert.equal(calls.snapshot(), null);

  const slow = calls.begin();
  t.advance(10_000);
  const later = calls.begin();
  t.advance(5_000);
  assert.deepEqual(calls.snapshot(), { seconds: 15 });

  slow();
  assert.equal(calls.snapshot(), null, 'the newer call has waited only 5 seconds');
  later();
  later();
  assert.equal(calls.snapshot(), null, 'ending twice is harmless');
});

test('the snapshot is the same object until it changes', () => {
  const t = fakeClock();
  const calls = new SlowCalls(t.clock, 15_000, 5_000);
  calls.begin();
  t.advance(15_000);
  const first = calls.snapshot();
  calls.update();
  assert.equal(calls.snapshot(), first);
});
