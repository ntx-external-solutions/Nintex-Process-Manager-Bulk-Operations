import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PmContext } from './client.ts';
import {
  execute,
  parseOperation,
  type ProcessSummary,
  WRITE_OPERATIONS,
} from './operations.ts';

const PROCESS = '00000001-0000-4000-8000-000000000001';

function processResponse() {
  return {
    processJson: {
      Id: 1537,
      UniqueId: PROCESS,
      Name: 'First Process',
      GroupId: 815,
      GroupUniqueId: '00000002-0000-4000-8000-000000000002',
      Group: 'Example Group',
      Version: '2.0',
      Objective: 'Test',
      ProcessRevisionEditId: 9180,
      ProcessRevisionStateId: 3,
      ProcessGroupItems: {
        ProcessGroup: {
          Id: 815,
          UniqueId: '00000002-0000-4000-8000-000000000002',
          Name: 'Example Group',
        },
        ProcessGroupShortcut: null,
      },
    },
    processActions: {
      CanSave: true,
      CanPublishAfterEdit: false,
      CanSubmitForApprovalAfterEdit: true,
    },
  };
}

function harness(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (payload === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const ctx: PmContext = {
    baseUrl: 'https://demo.promapp.com',
    tenant: 'tenant',
    token: 'tok',
    fetch: fetchImpl,
    sleep: async () => {},
  };
  return { ctx, calls };
}

// ------------------------------------------------------------- allowlisting

test('an unknown operation is refused', () => {
  const result = parseOperation({ op: 'groups.delete', uniqueId: 'x' });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /Unknown operation/);
});

test('there is no way to name a URL', () => {
  // The whole point of the allowlist: no caller-supplied path can reach fetch.
  for (const attempt of [
    { op: 'raw', url: 'https://evil.example/' },
    { op: 'groups.tree', url: 'https://evil.example/', parentUniqueId: null, path: '/anything' },
  ]) {
    const result = parseOperation(attempt);
    if (result.ok) {
      assert.equal('url' in result.operation, false);
      assert.equal('path' in result.operation, false);
    }
  }
});

test('the allowlist starts read-only', () => {
  // W0's done-when: no write operation. Archive arrives in W2 and has to be added
  // to WRITE_OPERATIONS on purpose, which is the decision this test makes visible.
  assert.deepEqual(WRITE_OPERATIONS, []);
});

test('no archive, delete or publish operation can be named yet', () => {
  for (const op of [
    'process.archive',
    'process.delete',
    'process.publish',
    'process.publishNow',
    'groups.delete',
    'groups.move',
  ]) {
    const result = parseOperation({ op, processUniqueId: PROCESS, uniqueId: PROCESS });
    assert.equal(result.ok, false, op);
  }
});

test('non-object bodies are refused', () => {
  for (const bad of [null, 'string', 42, []]) {
    assert.equal(parseOperation(bad).ok, false);
  }
});

test('groups.tree accepts null for the root level', () => {
  const result = parseOperation({ op: 'groups.tree', parentUniqueId: null });
  assert.ok(result.ok);
  assert.deepEqual(result.operation, { op: 'groups.tree', parentUniqueId: null });
});

test('groups.tree rejects a non-string parent', () => {
  assert.equal(parseOperation({ op: 'groups.tree', parentUniqueId: 42 }).ok, false);
});

// -------------------------------------------------------------- execution

test('process.summary returns only what the planner needs', async () => {
  const h = harness([processResponse()]);
  const summary = (await execute(h.ctx, {
    op: 'process.summary',
    processUniqueId: PROCESS,
  })) as ProcessSummary;

  assert.equal(summary.revisionStateId, 3);
  assert.equal(summary.homeGroupName, 'Example Group');
  assert.equal(summary.canSave, true);
  // The full process document must not travel to the browser.
  assert.equal('processJson' in (summary as object), false);
  assert.equal('Objective' in (summary as object), false);
});

// ---------------------------------------------------------------- listing

test('processes.list requires a positive integer page', () => {
  assert.equal(parseOperation({ op: 'processes.list', page: 0 }).ok, false);
  assert.equal(parseOperation({ op: 'processes.list', page: 1.5 }).ok, false);
  assert.equal(parseOperation({ op: 'processes.list', page: '1' }).ok, false);
  assert.ok(parseOperation({ op: 'processes.list', page: 1 }).ok);
});

test('processes.list defaults to active processes', () => {
  const result = parseOperation({ op: 'processes.list', page: 1 });
  assert.ok(result.ok);
  assert.deepEqual(result.operation, { op: 'processes.list', page: 1, listType: 0 });
});

test('processes.list sends the paging parameters the endpoint needs', async () => {
  const h = harness([{ items: [], totalItemCount: 0 }]);
  await execute(h.ctx, { op: 'processes.list', page: 3, listType: 7 });
  assert.match(h.calls[0]!.url, /\/Bff\/Process\/api\/v1\/processes\?/);
  assert.match(h.calls[0]!.url, /Page=3/);
  assert.match(h.calls[0]!.url, /PageSize=200/);
  assert.match(h.calls[0]!.url, /ListType=7/);
});
