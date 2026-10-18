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

test('the only writes are archive, the approval override, deleting a group and moving a node', () => {
  // Adding a write has to be a decision made here, not a side effect of a new case.
  assert.deepEqual([...WRITE_OPERATIONS].sort(), ['group.delete', 'node.move', 'process.archive', 'process.publishNow']);
});

// ----------------------------------------------------------------- moves

const OTHER = '00000009-0000-4000-8000-000000000009';

test('a move names one node, a type this app moves, and its two parents', () => {
  const ok = parseOperation({ op: 'node.move', uniqueId: PROCESS, nodeType: 'inprogress-process', newParentUniqueId: OTHER, oldParentUniqueId: null });
  assert.ok(ok.ok);
  assert.deepEqual(ok.operation, { op: 'node.move', uniqueId: PROCESS, nodeType: 'inprogress-process', newParentUniqueId: OTHER, oldParentUniqueId: null });

  const refused = (extra: Record<string, unknown>) =>
    parseOperation({ op: 'node.move', uniqueId: PROCESS, nodeType: 'group', newParentUniqueId: OTHER, oldParentUniqueId: null, ...extra }).ok;
  assert.equal(refused({ uniqueId: [PROCESS] }), false);
  assert.equal(refused({ nodeType: 'linked-process' }), false, 'a shortcut would move the process it points at');
  assert.equal(refused({ nodeType: 'documentgroup' }), false);
  assert.equal(refused({ newParentUniqueId: PROCESS }), false, 'its own parent');
  assert.equal(refused({ newParentUniqueId: 'not-a-guid' }), false);
  assert.equal(refused({ moves: [] }), false, 'no second node under another field');
  assert.equal(refused({ nodeType: 'process', newParentUniqueId: null }), false, 'a process needs a group');
  assert.equal(refused({ newParentUniqueId: null }), true, 'a group can go to the top level');
});

test('a move sends exactly one node, with the type passed through', async () => {
  const h = harness([{ success: true, errors: [] }]);
  await execute(h.ctx, { op: 'node.move', uniqueId: PROCESS, nodeType: 'process', newParentUniqueId: OTHER, oldParentUniqueId: null });
  assert.match(h.calls[0]!.url, /\/Process\/Edit\/ReorderTreeNodes$/);
  assert.deepEqual(JSON.parse(h.calls[0]!.body!), [
    { NodeType: 'process', ParentUniqueId: OTHER, OriginalParentUniqueId: '', ChildUniqueId: PROCESS, Position: -1, SiblingUniqueId: null },
  ]);
});

test('the move pre-flight asks about one process and one destination', async () => {
  assert.equal(parseOperation({ op: 'process.validateMove', processUniqueId: PROCESS }).ok, false);
  assert.equal(parseOperation({ op: 'process.validateMove', processUniqueId: PROCESS, destinationGroupUniqueId: [OTHER] }).ok, false);
  const h = harness([{ isValid: true, isPrompt: false }]);
  await execute(h.ctx, { op: 'process.validateMove', processUniqueId: PROCESS, destinationGroupUniqueId: OTHER });
  assert.match(h.calls[0]!.url, new RegExp(`ValidateProcessAction\\?processUniqueId=${PROCESS}&actionType=11&processGroupUniqueId=${OTHER}&isShortcut=false$`));
});

test('viewer counts take a bounded list of numeric group ids', () => {
  assert.ok(parseOperation({ op: 'groups.viewers', groupIds: [1, 2] }).ok);
  for (const groupIds of [[1.5], ['1'], [0], 'x', Array.from({ length: 201 }, (_, i) => i + 1)]) {
    assert.equal(parseOperation({ op: 'groups.viewers', groupIds }).ok, false, JSON.stringify(groupIds).slice(0, 20));
  }
});

test('each group operation accepts exactly one group id and nothing else', () => {
  for (const op of ['group.delete', 'group.documents', 'group.breadcrumb']) {
    assert.ok(parseOperation({ op, groupUniqueId: PROCESS }).ok, op);
    for (const bad of [[PROCESS], `${PROCESS},${PROCESS}`, 'not-a-guid', null]) {
      assert.equal(parseOperation({ op, groupUniqueId: bad }).ok, false, `${op} ${JSON.stringify(bad)}`);
    }
    assert.equal(parseOperation({ op, groupUniqueId: PROCESS, groupUniqueIds: [PROCESS] }).ok, false);
    assert.equal(parseOperation({ op, groupUniqueId: PROCESS, includeSubgroups: true }).ok, false);
  }
});

test('deleting a group posts only its id', async () => {
  const h = harness([undefined]);
  assert.deepEqual(await execute(h.ctx, { op: 'group.delete', groupUniqueId: PROCESS }), { deleted: true });
  assert.match(h.calls[0]!.url, /\/Process\/Edit\/DeleteGroup$/);
  assert.equal(h.calls[0]!.body, `{"processGroupUniqueId":"${PROCESS}"}`);
});

test('no delete, restore, move or update operation can be named yet', () => {
  for (const op of ['process.delete', 'process.restore', 'process.update', 'groups.delete', 'groups.move', 'group.move', 'process.publish']) {
    const result = parseOperation({ op, processUniqueId: PROCESS, uniqueId: PROCESS });
    assert.equal(result.ok, false, op);
  }
});

// --------------------------------------------------------- one id per write

const ONE_ID_CASES: Array<[string, Record<string, unknown>]> = [
  ['process.archive', { comment: 'Bulk archive' }],
  ['process.publishNow', { processRevisionEditId: 10133, publishMessage: 'Bulk archive' }],
  ['process.archiveState', {}],
  ['process.variationSet', {}],
];

test('each process operation accepts exactly one id', () => {
  for (const [op, rest] of ONE_ID_CASES) {
    assert.ok(parseOperation({ op, processUniqueId: PROCESS, ...rest }).ok, op);
    for (const bad of [
      [PROCESS],
      [PROCESS, PROCESS],
      `${PROCESS},${PROCESS}`,
      `${PROCESS} `,
      '',
      'not-a-guid',
      42,
      null,
    ]) {
      assert.equal(parseOperation({ op, processUniqueId: bad, ...rest }).ok, false, `${op} ${JSON.stringify(bad)}`);
    }
  }
});

test('a second id cannot ride along under another field', () => {
  for (const [op, rest] of ONE_ID_CASES) {
    for (const extra of [{ processUniqueIds: [PROCESS] }, { ids: [PROCESS] }, { url: 'https://evil.example/' }]) {
      const result = parseOperation({ op, processUniqueId: PROCESS, ...rest, ...extra });
      assert.equal(result.ok, false, `${op} ${Object.keys(extra)[0]}`);
      if (!result.ok) assert.match(result.error, /unexpected field/);
    }
  }
});

test('archive needs the change description', () => {
  assert.equal(parseOperation({ op: 'process.archive', processUniqueId: PROCESS }).ok, false);
  assert.equal(parseOperation({ op: 'process.archive', processUniqueId: PROCESS, comment: '   ' }).ok, false);
  const ok = parseOperation({ op: 'process.archive', processUniqueId: PROCESS, comment: '  Retired  ' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.operation, { op: 'process.archive', processUniqueId: PROCESS, comment: 'Retired' });
});

test('the override needs a positive integer revision', () => {
  for (const bad of [0, -1, 1.5, '10133', null]) {
    assert.equal(
      parseOperation({ op: 'process.publishNow', processUniqueId: PROCESS, processRevisionEditId: bad, publishMessage: 'm' }).ok,
      false,
      String(bad),
    );
  }
});

test('archive posts the id and the comment, and nothing else', async () => {
  const h = harness([undefined]);
  const result = await execute(h.ctx, { op: 'process.archive', processUniqueId: PROCESS, comment: 'Retired' });
  assert.deepEqual(result, { accepted: true });
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]!.url, /\/Process\/Edit\/ArchiveProcess$/);
  assert.equal(h.calls[0]!.method, 'POST');
  assert.equal(h.calls[0]!.body, `{"processUniqueId":"${PROCESS}","comment":"Retired"}`);
});

test('the override publishes now, with the revision id as a string and a message', async () => {
  const h = harness([{ actionUrl: '/tenant/Process/x' }]);
  await execute(h.ctx, {
    op: 'process.publishNow',
    processUniqueId: PROCESS,
    processRevisionEditId: 10133,
    publishMessage: 'Retired',
  });
  assert.match(h.calls[0]!.url, new RegExp(`/Api/v1/Processes/${PROCESS}/Publish$`));
  assert.equal(
    h.calls[0]!.body,
    '{"ProcessRevisionEditId":"10133","IsPublishNow":true,"PublishMessage":"Retired"}',
  );
});

test('the override needs a publish message, since some tenants refuse a publish without one', () => {
  for (const publishMessage of [undefined, '', '   ']) {
    assert.equal(
      parseOperation({ op: 'process.publishNow', processUniqueId: PROCESS, processRevisionEditId: 1, publishMessage }).ok,
      false,
    );
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
