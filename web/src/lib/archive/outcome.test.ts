import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultIsFatal } from '../exec/runner.ts';
import { archiveOne, statusFor, type ArchiveGateway, type ArchiveState } from './outcome.ts';

const ID = '00000001-0000-4000-8000-000000000001';

/** Shaped like the browser gateway's PmRequestError. */
function tenantError(status: number | null, tenantMessage: string | null = null, signedOut = false) {
  return Object.assign(new Error(status === null ? 'Could not reach the server.' : `Process Manager returned ${status}`), {
    status,
    tenantMessage,
    signedOut,
  });
}

interface Script {
  archive?: () => Promise<unknown>;
  state?: () => Promise<ArchiveState>;
  publish?: () => Promise<unknown>;
}

function gateway(script: Script) {
  const calls: string[] = [];
  const g: ArchiveGateway = {
    async archive(id, comment) {
      calls.push(`archive ${id} "${comment}"`);
      return script.archive ? script.archive() : { accepted: true };
    },
    async archiveState(id) {
      calls.push(`state ${id}`);
      if (!script.state) throw new Error('state not scripted');
      return script.state();
    },
    async publishNow(id, rev) {
      calls.push(`publish ${id} ${rev}`);
      return script.publish ? script.publish() : { actionUrl: '/x' };
    },
  };
  return { g, calls };
}

const run = (s: Script, approvalOverride = true) => {
  const h = gateway(s);
  return archiveOne(h.g, ID, 'Retired in bulk', { approvalOverride, isFatal: defaultIsFatal }).then((o) => ({
    ...o,
    calls: h.calls,
  }));
};

const state = (isArchived: boolean | null, revisionEditId: number | null = 10133): (() => Promise<ArchiveState>) =>
  async () => ({ found: true, isArchived, revisionEditId });

test('archived outright: no override is sent', async () => {
  const o = await run({ state: state(true) });
  assert.equal(o.outcome, 'Archived');
  assert.equal(o.success, true);
  assert.deepEqual(o.calls, [`archive ${ID} "Retired in bulk"`, `state ${ID}`]);
  assert.equal(statusFor(o.outcome), 'Success');
});

test('a 200 that is still pending is overridden with the revision read after the archive', async () => {
  const o = await run({ state: state(false, 10133) });
  assert.equal(o.outcome, 'Overridden');
  assert.equal(o.overridden, true);
  // 10133 is the post-archive revision; the publish must use it, not a pre-archive one.
  assert.deepEqual(o.calls.slice(-1), [`publish ${ID} 10133`]);
  assert.equal(statusFor(o.outcome), 'Overridden');
});

test('a pending archive with the override withheld is reported as pending', async () => {
  const o = await run({ state: state(false) }, false);
  assert.equal(o.outcome, 'PendingApproval');
  assert.equal(o.success, false);
  assert.equal(o.calls.some((c) => c.startsWith('publish')), false);
  assert.equal(statusFor(o.outcome), 'Pending');
});

test('a pending archive whose override fails stays pending, with the tenant status', async () => {
  const o = await run({ state: state(false), publish: async () => Promise.reject(tenantError(500, 'Server busy')) });
  assert.equal(o.outcome, 'PendingApproval');
  assert.equal(o.statusCode, 500);
  assert.match(o.message, /override failed \(HTTP 500\): Server busy/);
});

test('pending with no revision id cannot be overridden and says so', async () => {
  const o = await run({ state: state(false, null) });
  assert.equal(o.outcome, 'PendingApproval');
  assert.match(o.message, /no revision id came back/);
});

test('isArchived absent is not read as pending: the override is speculative', async () => {
  const o = await run({ state: state(null) });
  assert.equal(o.outcome, 'Overridden');
});

test('a failed speculative override does not count against an accepted archive', async () => {
  const o = await run({ state: state(null), publish: async () => Promise.reject(tenantError(400, 'Not pending')) });
  assert.equal(o.outcome, 'Archived');
  assert.equal(o.success, true);
  assert.match(o.message, /speculative approval override failed \(HTTP 400\): Not pending/);
});

test('isArchived absent with the override withheld is an accepted archive, no publish', async () => {
  const o = await run({ state: state(null) }, false);
  assert.equal(o.outcome, 'Archived');
  assert.equal(o.calls.some((c) => c.startsWith('publish')), false);
});

test('absent field and no revision id: accepted, nothing to publish', async () => {
  const o = await run({ state: state(null, null) });
  assert.equal(o.outcome, 'Archived');
  assert.match(o.message, /no revision id came back, so no override was sent/);
});

test('a 404 from the active read after the archive means it left the active side', async () => {
  const o = await run({ state: async () => ({ found: false, isArchived: null, revisionEditId: null }) });
  assert.equal(o.outcome, 'Archived');
  assert.match(o.message, /no longer returns it/);
});

test('an unreadable process after the archive is reported as unknown, not guessed', async () => {
  const o = await run({ state: async () => Promise.reject(tenantError(500)) });
  assert.equal(o.outcome, 'PendingApproval');
  assert.equal(o.success, false);
  assert.match(o.message, /state is unknown/);
  assert.equal(o.calls.some((c) => c.startsWith('publish')), false);
});

test('a 400 is a refusal carrying the tenant message, and nothing else is called', async () => {
  const o = await run({
    archive: async () => Promise.reject(tenantError(400, 'The process owner is a disabled user')),
  });
  assert.equal(o.outcome, 'Refused');
  assert.equal(o.statusCode, 400);
  assert.equal(o.detail, 'The process owner is a disabled user');
  assert.equal(o.message, 'HTTP 400 refused by the tenant: The process owner is a disabled user');
  assert.equal(o.calls.length, 1);
  assert.equal(statusFor(o.outcome), 'Blocked');
});

test('a 403 is a refusal too, not a dead session', async () => {
  const o = await run({ archive: async () => Promise.reject(tenantError(403, 'Not allowed')) });
  assert.equal(o.outcome, 'Refused');
});

test('a 500 is a failure, with the status', async () => {
  const o = await run({ archive: async () => Promise.reject(tenantError(500)) });
  assert.equal(o.outcome, 'Failed');
  assert.match(o.message, /Archive call failed \(HTTP 500\)/);
  assert.equal(statusFor(o.outcome), 'Failed');
});

test('no response at all is a failure that says so rather than printing HTTP 0', async () => {
  const o = await run({ archive: async () => Promise.reject(tenantError(null)) });
  assert.equal(o.outcome, 'Failed');
  assert.match(o.message, /no response/);
});

test('a dead session is rethrown so the run stops, at any of the three calls', async () => {
  for (const s of [
    { archive: async () => Promise.reject(tenantError(null, null, true)) },
    { state: async () => Promise.reject(tenantError(null, null, true)) },
    { state: state(false), publish: async () => Promise.reject(tenantError(null, null, true)) },
  ] satisfies Script[]) {
    await assert.rejects(run(s), /Could not reach/);
  }
});
