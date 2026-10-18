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
const OTHER_ID = '00000003-0000-4000-8000-000000000003';

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

test('the only writes are archive, publish, group delete, move, ownership, and the delete run\'s four', () => {
  // Adding a write has to be a decision made here, not a side effect of a new case. The
  // delete run's writes arrived with the unwind (W5 phase 7), not before.
  assert.deepEqual([...WRITE_OPERATIONS].sort(), [
    'group.create',
    'group.delete',
    'node.move',
    'process.archive',
    'process.delete',
    'process.publishNow',
    'process.restore',
    'process.save',
    'process.setOwnership',
  ]);
});

// ----------------------------------------------------------------- the delete run's writes

const SAVE = {
  op: 'process.save',
  processUniqueId: PROCESS,
  processJson: JSON.stringify({ UniqueId: PROCESS, Name: 'First Process' }),
  changeDescription: 'Automated dependency removal',
  submitForApproval: false,
  suppressChangeNotification: true,
};

test('a save may only carry the model of the process it names', () => {
  assert.equal(parseOperation(SAVE).ok, true);
  const other = parseOperation({ ...SAVE, processJson: JSON.stringify({ UniqueId: OTHER_ID }) });
  assert.ok(!other.ok);
  assert.match(other.error, /UniqueId must be the process named/);
  assert.equal(parseOperation({ ...SAVE, processJson: '{not json' }).ok, false);
  assert.equal(parseOperation({ ...SAVE, processJson: { UniqueId: PROCESS } }).ok, false, 'an object, which the tenant would drop');
  assert.equal(parseOperation({ ...SAVE, extra: 1 }).ok, false);
});

test('a save is sent as the update envelope, the model as a string, never published', async () => {
  const h = harness([undefined]);
  const parsed = parseOperation(SAVE);
  assert.ok(parsed.ok);
  await execute(h.ctx, parsed.operation);
  assert.equal(h.calls[0]?.method, 'PUT');
  assert.match(h.calls[0]?.url ?? '', new RegExp(`/Api/v1/Processes/${PROCESS}$`));
  const body = JSON.parse(h.calls[0]?.body ?? '{}') as Record<string, unknown>;
  assert.equal(typeof body['ProcessJson'], 'string');
  assert.equal(body['DoPublish'], false);
  assert.equal(body['SuppressChangeNotification'], true);
});

test('restore, delete and create each name at most one thing', async () => {
  assert.equal(parseOperation({ op: 'process.restore', processUniqueId: PROCESS, processGroupId: 830 }).ok, true);
  assert.equal(parseOperation({ op: 'process.restore', processUniqueId: PROCESS, processGroupId: '830' }).ok, false);
  assert.equal(parseOperation({ op: 'process.restore', processUniqueId: `${PROCESS},${OTHER_ID}`, processGroupId: 830 }).ok, false);
  assert.equal(parseOperation({ op: 'process.delete', processUniqueId: PROCESS, processGroupUniqueId: null }).ok, true);
  assert.equal(parseOperation({ op: 'process.delete', processUniqueId: PROCESS, processGroupUniqueId: 'not-a-guid' }).ok, false);
  assert.equal(parseOperation({ op: 'group.create' }).ok, true);
  assert.equal(parseOperation({ op: 'group.create', parentUniqueId: OTHER_ID }).ok, false, 'top level only');

  const h = harness([undefined]);
  await execute(h.ctx, { op: 'process.delete', processUniqueId: PROCESS, processGroupUniqueId: null });
  assert.match(h.calls[0]?.url ?? '', /\/Process\/Edit\/DeleteProcess$/);
  assert.deepEqual(JSON.parse(h.calls[0]?.body ?? '{}'), { processUniqueId: PROCESS }, 'no group key when none is known');

  const r = harness([undefined]);
  await execute(r.ctx, { op: 'process.restore', processUniqueId: PROCESS, processGroupId: 830, once: true });
  assert.deepEqual(JSON.parse(r.calls[0]?.body ?? '{}'), { processUniqueId: PROCESS, processGroupId: '830' }, 'the group id as a string, as the script sent it');
});

test('a new group\'s numeric id is read from the top level of the tree', async () => {
  const h = harness([{ groupid: OTHER_ID }, { treeItems: [{ id: 830, uniqueId: OTHER_ID, title: 'New group' }], parentUniqueId: null }]);
  assert.deepEqual(await execute(h.ctx, { op: 'group.create' }), { id: 830, uniqueId: OTHER_ID });
  assert.deepEqual(JSON.parse(h.calls[0]?.body ?? '{}'), { parentProcessGroupUniqueId: '' });
});

// ----------------------------------------------------------------- ownership

const SET_OWNERSHIP = {
  op: 'process.setOwnership',
  processUniqueId: PROCESS,
  expectedRevisionEditId: 9180,
  owner: { id: 1084, name: 'Ann Owner' },
  expert: null,
  changeDescription: 'Owners moved to the new team',
  submitForApproval: false,
};

test('setting ownership names one process, a revision, and users by id and name only', () => {
  assert.ok(parseOperation(SET_OWNERSHIP).ok);
  const refused = (extra: Record<string, unknown>) => parseOperation({ ...SET_OWNERSHIP, ...extra }).ok;
  assert.equal(refused({ processUniqueId: [PROCESS] }), false);
  assert.equal(refused({ processUniqueIds: [PROCESS] }), false, 'no second process under another field');
  assert.equal(refused({ expectedRevisionEditId: '9180' }), false);
  assert.equal(refused({ owner: null, expert: null }), false, 'nothing to set');
  assert.equal(refused({ owner: { id: '1084', name: 'Ann' } }), false);
  assert.equal(refused({ owner: { id: 0, name: 'Ann' } }), false);
  assert.equal(refused({ owner: { id: 5, name: ' ' } }), false);
  assert.equal(refused({ owner: { id: 5, name: 'Ann', processJson: {} } }), false, 'nothing rides along on a user');
  assert.equal(refused({ changeDescription: ' ' }), false);
  assert.equal(refused({ submitForApproval: 'yes' }), false);
  assert.equal(refused({ suppressChangeNotification: false }), false, 'notifications are not the caller\'s to turn on');
  assert.equal(refused({ owner: null, expert: { id: 2, name: 'Needs to be reassigned N/A' } }), true);
});

test('the directory read takes the SCIM key and nothing else', () => {
  assert.ok(parseOperation({ op: 'users.directory', scimApiKey: 'key' }).ok);
  assert.equal(parseOperation({ op: 'users.directory' }).ok, false);
  assert.equal(parseOperation({ op: 'users.directory', scimApiKey: 'key', baseUrl: 'https://evil.example' }).ok, false);
  assert.equal(parseOperation({ op: 'process.ownership', processUniqueId: 'not-a-guid' }).ok, false);
});

test('setting ownership saves the model as a string, notifications suppressed, and returns the new revision', async () => {
  const h = harness([processResponse(), undefined, { latestProcessRevisionEditId: 9181 }]);
  const parsed = parseOperation(SET_OWNERSHIP);
  assert.ok(parsed.ok);
  assert.deepEqual(await execute(h.ctx, parsed.operation), { ok: true, revisionEditId: 9181 });
  assert.deepEqual(h.calls.map((c) => c.method), ['GET', 'PUT', 'GET']);
  const envelope = JSON.parse(h.calls[1]!.body!);
  assert.equal(typeof envelope.ProcessJson, 'string');
  const model = JSON.parse(envelope.ProcessJson);
  assert.equal(model.OwnerId, 1084);
  assert.equal(model.Owner, 'Ann Owner');
  assert.equal('ExpertId' in model, false, 'a role not named is left alone');
  assert.equal(model.Objective, 'Test', 'everything else passes through');
  assert.equal(envelope.SuppressChangeNotification, true);
  assert.equal(envelope.DoPublish, false);
  assert.equal(envelope.DoSubmitForApproval, false);
  assert.equal(envelope.ChangeDescription, 'Owners moved to the new team');
});

test('setting ownership refuses to write over an edit made since the preview', async () => {
  const h = harness([processResponse()]);
  const parsed = parseOperation({ ...SET_OWNERSHIP, expectedRevisionEditId: 9179 });
  assert.ok(parsed.ok);
  assert.deepEqual(await execute(h.ctx, parsed.operation), { ok: false, conflict: { expected: 9179, actual: 9180 } });
  assert.deepEqual(h.calls.map((c) => c.method), ['GET']);
});

test('the ownership read is compact: roles, revision and permissions, not the model', async () => {
  const response = processResponse();
  Object.assign(response.processJson, { OwnerId: 7, Owner: 'Old Owner', ExpertId: 0, Expert: '' });
  const h = harness([response]);
  assert.deepEqual(await execute(h.ctx, { op: 'process.ownership', processUniqueId: PROCESS }), {
    kind: 'process',
    state: {
      uniqueId: PROCESS,
      name: 'First Process',
      version: '2.0',
      revisionEditId: 9180,
      revisionStateId: 3,
      isArchived: null,
      owner: { id: 7, name: 'Old Owner' },
      expert: null,
      canSave: true,
      canPublishAfterEdit: false,
      canSubmitForApprovalAfterEdit: true,
    },
  });
});

test('the ownership read and write treat the 200 with no model as archived (F4)', async () => {
  const read = harness([{ success: true, isArchived: true }]);
  assert.deepEqual(await execute(read.ctx, { op: 'process.ownership', processUniqueId: PROCESS }), { kind: 'archived' });
  const write = harness([{ success: true, isArchived: true }]);
  const parsed = parseOperation(SET_OWNERSHIP);
  assert.ok(parsed.ok);
  assert.deepEqual(await execute(write.ctx, parsed.operation), { ok: false, archived: true });
  assert.deepEqual(write.calls.map((c) => c.method), ['GET'], 'nothing is saved over an archived process');
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

// ----------------------------------------------------------------- delete reads

test('the delete reads name one process, or a bounded batch of process ids', () => {
  for (const op of ['process.dependencies', 'process.model']) {
    assert.ok(parseOperation({ op, processUniqueId: PROCESS }).ok, op);
    assert.equal(parseOperation({ op, processUniqueId: [PROCESS] }).ok, false, op);
    assert.equal(parseOperation({ op, processUniqueId: PROCESS, searchBehavior: 1 }).ok, false, `${op}: nothing else rides along`);
  }
  assert.ok(parseOperation({ op: 'processes.archivedModels', processUniqueIds: [PROCESS, OTHER] }).ok);
  // The tenant refuses 21 or more with 400 (measured after W5 phase 3), so the proxy does too.
  assert.ok(parseOperation({ op: 'processes.archivedModels', processUniqueIds: Array.from({ length: 20 }, () => PROCESS) }).ok, '20 is the limit');
  for (const processUniqueIds of [[], ['not-a-guid'], Array.from({ length: 21 }, () => PROCESS), PROCESS]) {
    assert.equal(parseOperation({ op: 'processes.archivedModels', processUniqueIds }).ok, false, JSON.stringify(processUniqueIds).slice(0, 30));
  }
  for (const op of ['process.dependencies', 'process.model', 'processes.archivedModels']) {
    assert.equal(WRITE_OPERATIONS.includes(op as never), false, `${op} is a read`);
  }
});

test('the dependency check asks for both directions, and an empty answer is a clean check', async () => {
  const h = harness([undefined]);
  assert.equal(await execute(h.ctx, { op: 'process.dependencies', processUniqueId: PROCESS }), null);
  assert.match(h.calls[0]!.url, new RegExp(`/Api/v1/Processes/${PROCESS}/CheckProcessDependencies\\?searchBehavior=31$`));
});

test('the batch read repeats the id parameter and unwraps each model', async () => {
  const h = harness([{ data: [{ ProcessModel: { UniqueId: PROCESS } }, { ProcessModel: null }] }]);
  assert.deepEqual(await execute(h.ctx, { op: 'processes.archivedModels', processUniqueIds: [PROCESS, OTHER] }), [{ UniqueId: PROCESS }]);
  assert.match(h.calls[0]!.url, new RegExp(`/mobile/api/v1/processes\\?processUniqueIds=${PROCESS}&processUniqueIds=${OTHER}$`));
});

test('the model read gives the model, or says archived for the 200 with no model', async () => {
  const active = harness([processResponse()]);
  const read = (await execute(active.ctx, { op: 'process.model', processUniqueId: PROCESS })) as { kind: string; model?: { Name?: string } };
  assert.equal(read.kind, 'model');
  assert.equal(read.model?.Name, 'First Process');
  // Measured in S1, S2 and the W4 live test: an archived process answers 200 with only this.
  const archived = harness([{ success: true, isArchived: true }]);
  assert.deepEqual(await execute(archived.ctx, { op: 'process.model', processUniqueId: PROCESS }), { kind: 'archived' });
});
