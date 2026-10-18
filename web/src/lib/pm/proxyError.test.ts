import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runArchive } from '../archive/run.ts';
import type { ArchivePlan } from '../archive/plan.ts';
import { Journal } from '../exec/journal.ts';
import { createControls } from '../exec/runner.ts';
import { browserArchiveGateway, browserGateway, PmRequestError } from '../ui/gateway.ts';
import type { PmContext } from './client.ts';
import { execute, parseOperation } from './operations.ts';
import { proxyError } from './proxyError.ts';
import { ScimError } from './scim.ts';

const A = '00000001-0000-4000-8000-000000000001';
const B = '00000002-0000-4000-8000-000000000002';
const C = '00000003-0000-4000-8000-000000000003';

/**
 * The browser, the proxy route and the tenant in one process: `/api/pm` requests are
 * parsed and executed as the route does, against a tenant that answers every call with
 * `tenant()`, and failures go through `proxyError`.
 */
function wire(tenant: () => Response) {
  const tenantCalls: string[] = [];
  const ctx: PmContext = {
    baseUrl: 'https://demo.promapp.com',
    tenant: 'tenant',
    token: 'dead',
    fetch: (async (url: string) => {
      tenantCalls.push(String(url));
      return tenant();
    }) as unknown as typeof fetch,
    sleep: async () => {},
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const parsed = parseOperation(JSON.parse(String(init?.body)));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    try {
      return Response.json({ ok: true, result: await execute(ctx, parsed.operation) });
    } catch (error) {
      const failure = proxyError(error);
      return Response.json(failure.body, { status: failure.status });
    }
  }) as typeof fetch;
  return { tenantCalls, restore: () => (globalThis.fetch = original) };
}

function plan(...ids: string[]): ArchivePlan {
  return {
    targets: ids.map((uniqueId) => ({ uniqueId, name: `Process ${uniqueId.slice(7, 8)}`, groupUniqueId: 'g', groupId: 10, path: ['Finance'], inIndex: true })),
    groups: [],
    skipped: [],
    excluded: [],
    variations: [],
    unreadVariationSets: [],
  };
}

// R12, measured with an invalid token: ArchiveProcess and GET /Api/v1/Processes/{id}
// answer 302 to the sign-in page. Followed, that page arrived as a 2xx HTML body.
const REDIRECT = () => new Response(null, { status: 302, headers: { location: '/tenant/Account/Login' } });
const SIGN_IN_PAGE = () => new Response('<!DOCTYPE html><html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });

for (const [what, tenant] of [
  ['a 302 to the sign-in page', REDIRECT],
  ['the sign-in page itself', SIGN_IN_PAGE],
] as const) {
  test(`${what} mid-run signs the operator out and stops the run`, async () => {
    const w = wire(tenant);
    try {
      const rows = await runArchive(browserArchiveGateway(), Journal.start('r', 't', 1, null), plan(A, B, C), createControls(), {
        changeDescription: 'Retired',
        approvalOverride: false,
        variationsAccepted: false,
        baseline: new Map(),
        concurrency: 1,
      });
      assert.equal(w.tenantCalls.length, 1, 'nothing after the first refusal is sent');
      assert.deepEqual(rows.map((r) => r.status), ['Failed', 'Skipped', 'Skipped']);
      assert.match(rows[0]!.message, /Your session ended/);
      assert.doesNotMatch(rows[0]!.message, /\.\./);
      assert.match(rows[1]!.message, /^Not attempted: Your session ended/);
    } finally {
      w.restore();
    }
  });

  test(`${what} on a read reaches the browser as signedOut, not "Unexpected error"`, async () => {
    const w = wire(tenant);
    try {
      await assert.rejects(browserGateway().processSummary(A), (e: unknown) => e instanceof PmRequestError && e.signedOut);
    } finally {
      w.restore();
    }
  });
}

test('a 403 stays a refusal of one call, with the tenant\'s words', async () => {
  const w = wire(() => Response.json({ message: 'You cannot archive this process' }, { status: 403 }));
  try {
    await assert.rejects(
      browserGateway().processSummary(A),
      (e: unknown) => e instanceof PmRequestError && !e.signedOut && e.status === 403 && e.tenantMessage === 'You cannot archive this process',
    );
  } finally {
    w.restore();
  }
});

test('a SCIM key the directory refuses is not a dead session', () => {
  assert.deepEqual(proxyError(new ScimError('bad key', 401)), { status: 400, body: { error: 'bad key' } });
  assert.equal(proxyError(new SyntaxError('x')).status, 500);
});
