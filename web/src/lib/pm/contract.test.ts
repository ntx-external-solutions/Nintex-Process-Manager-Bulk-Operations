/**
 * Contract tests.
 *
 * Request shapes are asserted against what the live product actually sent, and
 * response fixtures are lifted verbatim from the HAR captures described in process-group-manager's DESIGN.md.
 * The point is to fail here rather than against a customer tenant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PmContext } from './client.ts';
import { getChildGroups } from './groups.ts';
import { getArchiveState, getLatestRevision, getVariationSet, publishProcess } from './processes.ts';

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

function harness(responses: unknown[]) {
  const calls: Call[] = [];
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
    tenant: '0123456789abcdef0123456789abcdef',
    token: 'tok',
    fetch: fetchImpl,
    sleep: async () => {},
  };
  return { ctx, calls };
}

// ---------------------------------------------------------------- groups

test('getChildGroups sends an empty uniqueId for the root level', async () => {
  const h = harness([{ treeItems: [], parentUniqueId: null }]);
  await getChildGroups(h.ctx, null);
  assert.match(h.calls[0]!.url, /GetChildProcessGroupTreeItems\?uniqueId=$/);
});

test('getChildGroups parses a real tree response', async () => {
  // Verbatim from the group-creation capture.
  const fixture = {
    treeItems: [
      {
        id: 1537,
        uniqueId: '00000001-0000-4000-8000-000000000001',
        title: 'Copy of First Process',
        itemType: 'inprogress-process',
        itemOrder: 0,
        hasChild: null,
        totalSubgroups: null,
        totalStakeholderUsers: null,
        totalPermissionRoles: null,
        totalPermissionUsers: null,
        variationSetId: null,
      },
      {
        id: 815,
        uniqueId: '00000002-0000-4000-8000-000000000002',
        title: 'Example Group',
        itemType: 'group',
        itemOrder: 1,
        hasChild: true,
        totalSubgroups: 1,
        totalStakeholderUsers: 0,
        totalPermissionRoles: 1,
        totalPermissionUsers: 0,
        variationSetId: null,
      },
    ],
    parentUniqueId: '00000003-0000-4000-8000-000000000003',
  };
  const h = harness([fixture]);
  const result = await getChildGroups(h.ctx, '00000003-0000-4000-8000-000000000003');
  assert.equal(result.treeItems?.length, 2);
  assert.equal(result.treeItems?.[1]?.itemType, 'group');
});

// ---------------------------------------------------------------- processes

test('publishProcess sends the revision id as a string', async () => {
  // processJson carries it as a number; this endpoint wants a string.
  const h = harness([{ actionUrl: '/tenant/Process/00000001' }]);
  await publishProcess(h.ctx, '00000001-0000-4000-8000-000000000001', 9182, 'Bulk archive');
  assert.equal(
    h.calls[0]!.body,
    '{"ProcessRevisionEditId":"9182","IsPublishNow":true,"PublishMessage":"Bulk archive"}',
  );
});

test('getLatestRevision reads the cheap concurrency check', async () => {
  const h = harness([{ latestProcessRevisionEditId: 9174 }]);
  const result = await getLatestRevision(h.ctx, '00000001-0000-4000-8000-000000000001');
  assert.equal(result.latestProcessRevisionEditId, 9174);
  assert.match(h.calls[0]!.url, /\/bff\/Process\/api\/v1\/processes\/00000001.*\/revisions\/latest$/);
});

// ---------------------------------------------------------------- archive state

function answering(status: number, body: unknown) {
  return harnessWith(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function harnessWith(respond: () => Promise<Response>) {
  const ctx: PmContext = {
    baseUrl: 'https://demo.promapp.com',
    tenant: 'tenant',
    token: 'tok',
    fetch: (async () => respond()) as unknown as typeof fetch,
    sleep: async () => {},
  };
  return ctx;
}

const ARCHIVED_ID = '00000001-0000-4000-8000-000000000001';

test('getArchiveState reads isArchived and the revision off the model', async () => {
  const state = await getArchiveState(
    answering(200, { processJson: { isArchived: false, ProcessRevisionEditId: 10133 }, processActions: {} }),
    ARCHIVED_ID,
  );
  assert.deepEqual(state, { found: true, isArchived: false, revisionEditId: 10133 });
});

test('getArchiveState falls back to the envelope, and matches the field case-insensitively', async () => {
  const state = await getArchiveState(
    answering(200, { IsArchived: true, processJson: { ProcessRevisionEditId: 7 } }),
    ARCHIVED_ID,
  );
  assert.deepEqual(state, { found: true, isArchived: true, revisionEditId: 7 });
});

test('getArchiveState reports an absent field as null, not false', async () => {
  const state = await getArchiveState(answering(200, { processJson: { ProcessRevisionEditId: 7 } }), ARCHIVED_ID);
  assert.equal(state.isArchived, null);
});

test('getArchiveState treats a 404 as having left the active side', async () => {
  assert.deepEqual(await getArchiveState(answering(404, { message: 'Not found' }), ARCHIVED_ID), {
    found: false,
    isArchived: null,
    revisionEditId: null,
  });
});

test('getArchiveState lets any other failure through', async () => {
  await assert.rejects(getArchiveState(answering(400, { message: 'Bad' }), ARCHIVED_ID), /returned 400/);
});

// ---------------------------------------------------------------- variation sets

test('getVariationSet reads the set beside processJson, siblings included', async () => {
  const set = await getVariationSet(
    answering(200, {
      processJson: { Name: 'Review' },
      variationSetData: {
        Id: 38,
        Name: 'Review',
        VariationGroupId: 1,
        Type: 1,
        Group: { Id: 12, Name: 'Security', UniqueId: 'g-sec' },
        VariedProcess: { ProcessUniqueId: 'v-internal', VariationName: 'Internal', IsArchived: false },
        OtherVariedProcesses: [{ ProcessUniqueId: 'v-partner', VariationName: 'Partner', IsArchived: false }],
        IsVariationSetInDraftState: false,
      },
    }),
    ARCHIVED_ID,
  );
  assert.deepEqual(set, {
    id: 38,
    name: 'Review',
    group: { id: 12, name: 'Security', uniqueId: 'g-sec' },
    self: { uniqueId: 'v-internal', variationName: 'Internal', isArchived: false },
    others: [{ uniqueId: 'v-partner', variationName: 'Partner', isArchived: false }],
  });
});

test('getVariationSet is null for a process in no set', async () => {
  assert.equal(await getVariationSet(answering(200, { processJson: {} }), ARCHIVED_ID), null);
  assert.equal(await getVariationSet(answering(200, { processJson: {}, variationSetData: null }), ARCHIVED_ID), null);
});
