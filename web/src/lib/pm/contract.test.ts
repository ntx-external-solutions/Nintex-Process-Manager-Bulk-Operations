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
import { getLatestRevision, publishProcess } from './processes.ts';

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
  await publishProcess(h.ctx, '00000001-0000-4000-8000-000000000001', 9182);
  assert.equal(h.calls[0]!.body, '{"ProcessRevisionEditId":"9182","IsPublishNow":true}');
});

test('getLatestRevision reads the cheap concurrency check', async () => {
  const h = harness([{ latestProcessRevisionEditId: 9174 }]);
  const result = await getLatestRevision(h.ctx, '00000001-0000-4000-8000-000000000001');
  assert.equal(result.latestProcessRevisionEditId, 9174);
  assert.match(h.calls[0]!.url, /\/bff\/Process\/api\/v1\/processes\/00000001.*\/revisions\/latest$/);
});
