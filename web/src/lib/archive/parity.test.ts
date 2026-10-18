/**
 * Parity with the script's Mode 1 tests (Tests/Test-BulkArchive.ps1).
 *
 * The unit tests beside this file cover each function's branches. These replay the
 * script's scenarios against a stateful mock tenant, the way the PowerShell file does,
 * so each assertion it makes that this app is meant to share has a counterpart here.
 * Where the app deliberately differs (collateral is reported, not reversed; see the W2
 * report), the test asserts what the app does instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countByStatus, resultsToCsv, type ResultRow } from '../exec/report.ts';
import { Journal } from '../exec/journal.ts';
import { createControls, defaultIsFatal } from '../exec/runner.ts';
import { parseCsv } from '../csv/parse.ts';
import { execute, parseOperation } from '../pm/operations.ts';
import { tenantMessage, type PmContext } from '../pm/client.ts';
import { proxyError } from '../pm/proxyError.ts';
import type { ProcessListItem } from '../pm/processes.ts';
import type { ResolvedProcess } from '../select/resolve.ts';
import { ARCHIVED_ROWS } from '../select/fixtures.ts';
import { INDEX_PAGE_SIZE, loadProcessIndex, type IndexEntry, type ProcessIndex } from '../tenant/state.ts';
import { browserArchiveGateway, PmRequestError } from '../ui/gateway.ts';
import { archiveOne, ARCHIVE_STATUSES, failureOf, type ArchiveGateway } from './outcome.ts';
import { buildArchivePlan, previewRows, type ArchivePlan } from './plan.ts';
import { collateralRows, manualReviewCsvRows, runArchive, settleFromFinalRead } from './run.ts';

// The script's layout: group 100 holds three processes (one a variation) and has a
// subgroup 110 holding two more; the variation's master lives in group 200.
const P1 = '00000001-0000-4000-8000-000000000001';
const P2 = '00000001-0000-4000-8000-000000000002';
const VAR = '00000001-0000-4000-8000-000000000003';
const S1 = '00000001-0000-4000-8000-000000000004';
const S2 = '00000001-0000-4000-8000-000000000005';
const MASTER = '00000002-0000-4000-8000-000000000001';
const F1 = '0000000f-0000-4000-8000-000000000001';

const DISABLED_USER = 'The process owner or expert is a disabled user.';
const STALE_LINK = 'One or more linked documents could not be validated.';

function tenantError(status: number, tenantMessage: string | null) {
  return Object.assign(new Error(`Process Manager returned ${status}`), { status, tenantMessage, signedOut: false });
}

/** The script's Reset-ArchiveTenant, as an object. */
function mockTenant() {
  const names = new Map<string, string>([
    [P1, 'Borrow a book'],
    [P2, 'Return a book'],
    [VAR, 'Expense claims :: Contractors'],
    [S1, 'Catalogue an accession'],
    [S2, 'Retire a record'],
    [MASTER, 'Expense claims'],
    [F1, 'Filler 1'],
  ]);
  const groupOf = new Map<string, number>([
    [P1, 100],
    [P2, 100],
    [VAR, 100],
    [S1, 110],
    [S2, 110],
    [MASTER, 200],
    [F1, 300],
  ]);
  const t = {
    names,
    groupOf,
    archived: new Map<string, boolean>([...names.keys()].map((id) => [id, false])),
    /** Process id -> the reason the tenant refuses it with a 400. */
    refuse: new Map<string, string>(),
    /** An accepted archive is left Pending Archive Approval until the override. */
    approvalsPending: false,
    publishFails: false,
    /** Says yes to the archive (and the override) and does nothing. */
    stubborn: new Set<string>(),
    /** The listings stop returning these once archived. */
    vanishOnArchive: new Set<string>(),
    vanished: new Set<string>(),
    /** Archiving a variation drags its master: the coupling rounds 2 to 4 found. */
    coupling: new Map<string, string>([[VAR, MASTER]]),
    archiveCalls: [] as string[],
    comments: [] as string[],
    publishCalls: [] as Array<{ id: string; revision: number; message: string }>,
  };

  const gateway: ArchiveGateway = {
    async archive(id, comment) {
      t.archiveCalls.push(id);
      t.comments.push(comment);
      const reason = t.refuse.get(id);
      if (reason !== undefined) throw tenantError(400, reason);
      if (!t.approvalsPending && !t.stubborn.has(id)) t.archived.set(id, true);
      if (t.vanishOnArchive.has(id)) t.vanished.add(id);
      const master = t.coupling.get(id);
      if (master !== undefined) t.archived.set(master, true);
      return { ok: true };
    },
    async archiveState(id) {
      return { found: true, isArchived: t.archived.get(id) ?? false, revisionEditId: 10133 };
    },
    async publishNow(id, revision, message) {
      t.publishCalls.push({ id, revision, message });
      if (t.publishFails) throw tenantError(500, 'The publish could not be completed.');
      if (!t.stubborn.has(id)) t.archived.set(id, true);
      return { actionUrl: '/x' };
    },
  };

  /** Both listings as the index sees them. Neither is complete: a vanished id is in neither. */
  const index = (): ProcessIndex =>
    new Map(
      [...names.keys()]
        .filter((id) => !t.vanished.has(id))
        .map((id): [string, IndexEntry] => [
          id.toLowerCase(),
          {
            uniqueId: id,
            name: names.get(id) ?? '',
            isArchived: t.archived.get(id) ?? false,
            groupId: groupOf.get(id) ?? null,
            groupUniqueId: `g-${groupOf.get(id)}`,
            groupName: `Group ${groupOf.get(id)}`,
            groupExists: true,
          },
        ]),
    );

  // Not a spread: the flags are set on this object after it is returned.
  return Object.assign(t, { gateway, index });
}

type Tenant = ReturnType<typeof mockTenant>;

function resolved(t: Tenant, ...ids: string[]): { processes: ResolvedProcess[]; excluded: [] } {
  return {
    processes: ids.map((uniqueId, i) => ({
      uniqueId,
      id: i + 1,
      title: t.names.get(uniqueId) ?? '',
      itemType: 'process',
      groupUniqueId: `g-${t.groupOf.get(uniqueId)}`,
      groupId: t.groupOf.get(uniqueId) ?? null,
      path: [`Group ${t.groupOf.get(uniqueId)}`],
      variationSetId: null,
    })),
    excluded: [],
  };
}

/** The page's apply path: baseline, run, final read, settle, collateral. */
async function apply(t: Tenant, plan: ArchivePlan, variationsAccepted = false): Promise<ResultRow[]> {
  const baseline = t.index();
  const draft = await runArchive(t.gateway, Journal.start('run', 'tenant', 1, null), plan, createControls(), {
    changeDescription: 'Bulk Cleanup.',
    approvalOverride: true,
    variationsAccepted,
    baseline,
    concurrency: 1,
  });
  const after = t.index();
  return [...settleFromFinalRead(draft, after), ...collateralRows(baseline, after, plan.targets.map((x) => x.uniqueId))];
}

const where = (rows: readonly ResultRow[], f: (r: ResultRow) => boolean) => rows.filter(f);

// ------------------------------------------------- the server's own words

test('a JSON body with no recognised field, and a padded plain-text body, keep their text', () => {
  assert.equal(tenantMessage('{"unexpected":1}'), '{"unexpected":1}');
  assert.equal(tenantMessage('  Bad Request  '), 'Bad Request');
  assert.equal(tenantMessage(''), null);
});

test('nothing thrown at all still yields a failure to report, not an exception', () => {
  assert.deepEqual(
    { status: failureOf(null).status, detail: failureOf(null).detail },
    { status: 0, detail: null },
  );
});

/** Browser, proxy route and tenant in one process, as in pm/proxyError.test.ts. */
function wire(tenant: (url: string) => Response) {
  const tenantCalls: string[] = [];
  const ctx: PmContext = {
    baseUrl: 'https://demo.promapp.com',
    tenant: 'tenant',
    token: 't',
    fetch: (async (url: string) => {
      tenantCalls.push(String(url));
      return tenant(String(url));
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

test('a refused call carries its status and the reason the server gave, not the status line', async () => {
  const w = wire(() => Response.json({ message: DISABLED_USER }, { status: 400 }));
  try {
    await assert.rejects(browserArchiveGateway().archive(P1, 'Bulk Cleanup.'), (e: unknown) => {
      assert.ok(e instanceof PmRequestError);
      assert.equal(e.signedOut, false);
      assert.equal(e.status, 400);
      assert.equal(e.tenantMessage, DISABLED_USER);
      // The error keeps its own generic meaning; the tenant's words ride alongside.
      assert.match(e.message, /returned 400/);
      return true;
    });

    const o = await archiveOne(browserArchiveGateway(), P1, 'Bulk Cleanup.', { approvalOverride: true, isFatal: defaultIsFatal });
    assert.equal(o.outcome, 'Refused');
    assert.equal(o.detail, DISABLED_USER);
    assert.equal(o.message, `HTTP 400 refused by the tenant: ${DISABLED_USER}`);
  } finally {
    w.restore();
  }
});

test('a successful call through the same path still succeeds', async () => {
  const w = wire((url) =>
    url.includes('ArchiveProcess')
      ? Response.json({ ok: true })
      : Response.json({ processJson: { isArchived: true, ProcessRevisionEditId: 10133 }, processActions: {} }),
  );
  try {
    const o = await archiveOne(browserArchiveGateway(), P1, 'Bulk Cleanup.', { approvalOverride: true, isFatal: defaultIsFatal });
    assert.equal(o.outcome, 'Archived');
    assert.equal(o.detail, null);
  } finally {
    w.restore();
  }
});

// ------------------------------------------------- enumerating

test('the index sweep pages past the first response and keeps every process', async () => {
  const filler = Array.from({ length: 250 }, (_, i) => `ffff0000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const others = [P1, P2, VAR, S1, S2, MASTER];
  const active: ProcessListItem[] = [...others, ...filler].map((id) => ({
    ...(ARCHIVED_ROWS[0] as ProcessListItem),
    processUniqueId: id,
    processName: `Process ${id.slice(-4)}`,
    groupId: filler.includes(id) ? 300 : 100,
  }));
  const index = await loadProcessIndex(async (page, listType) => {
    const items = listType === 0 ? active.slice((page - 1) * INDEX_PAGE_SIZE, page * INDEX_PAGE_SIZE) : [];
    return { items, totalItemCount: listType === 0 ? active.length : 0 };
  });
  assert.equal(index.size, 256);
  assert.equal([...index.values()].filter((e) => e.groupId === 300).length, 250);
});

// ------------------------------------------------- the outcome

test('outcome details the unit tests leave implicit', async () => {
  // Refused: not a success, and nothing reaches the override.
  let t = mockTenant();
  t.refuse.set(P1, DISABLED_USER);
  const refusal = await archiveOne(t.gateway, P1, 'c', { approvalOverride: true, isFatal: defaultIsFatal });
  assert.equal(refusal.success, false);
  assert.equal(t.archived.get(P1), false);
  assert.equal(t.publishCalls.length, 0);

  // A 5xx is Failed, and keeps its status and words.
  const fault = await archiveOne(
    { ...t.gateway, archive: async () => Promise.reject(tenantError(503, 'The service is temporarily unavailable.')) },
    P2,
    'c',
    { approvalOverride: true, isFatal: defaultIsFatal },
  );
  assert.equal(fault.outcome, 'Failed');
  assert.equal(fault.statusCode, 503);
  assert.equal(fault.detail, 'The service is temporarily unavailable.');

  // Pending detected and overridden: archived, by exactly one publish.
  t = mockTenant();
  t.approvalsPending = true;
  const overridden = await archiveOne(t.gateway, P1, 'Bulk Cleanup.', { approvalOverride: true, isFatal: defaultIsFatal });
  assert.equal(overridden.outcome, 'Overridden');
  assert.equal(overridden.success, true);
  assert.deepEqual(t.publishCalls, [{ id: P1, revision: 10133, message: 'Bulk Cleanup.' }]);
  assert.equal(t.archived.get(P1), true);

  // The override fails: pending, and not reported as archived.
  t = mockTenant();
  t.approvalsPending = true;
  t.publishFails = true;
  const stuck = await archiveOne(t.gateway, P1, 'c', { approvalOverride: true, isFatal: defaultIsFatal });
  assert.equal(stuck.outcome, 'PendingApproval');
  assert.equal(stuck.success, false);
  assert.equal(stuck.statusCode, 500);

  // No approvals: archived outright, with no override.
  t = mockTenant();
  const plain = await archiveOne(t.gateway, P1, 'c', { approvalOverride: true, isFatal: defaultIsFatal });
  assert.equal(plain.outcome, 'Archived');
  assert.equal(plain.overridden, false);
  assert.equal(t.publishCalls.length, 0);
});

// ------------------------------------------------- scenarios

test('scenario: a clean group archives, and nothing else moves', async () => {
  const t = mockTenant();
  const rows = await apply(t, buildArchivePlan(resolved(t, S1, S2), t.index()));

  assert.deepEqual(t.archiveCalls, [S1, S2]);
  assert.equal(t.archived.get(S1) && t.archived.get(S2), true);
  assert.equal(t.archived.get(P1), false);
  assert.deepEqual([...new Set(t.comments)], ['Bulk Cleanup.']);
  assert.equal(where(rows, (r) => r.operation === 'Archive' && r.status === 'Success').length, 2);
  assert.equal(where(rows, (r) => r.status === 'Failed').length, 0);
  assert.equal(where(rows, (r) => r.operation === 'Collateral').length, 0);
});

test('scenario: the composition risk is caught before anything is sent', async () => {
  const t = mockTenant();
  const plan = buildArchivePlan(resolved(t, P1, P2, VAR), t.index());

  assert.deepEqual(plan.variations.map((v) => [v.relativeUniqueId, v.relativeName]), [[MASTER, 'Expense claims']]);
  await assert.rejects(apply(t, plan), /variation warnings/);
  assert.equal(t.archiveCalls.length, 0);
  assert.equal(t.archived.get(MASTER), false);
  assert.equal(t.archived.get(P1), false);

  // Named in the preview's results file, by id.
  const warnings = where(previewRows(plan), (r) => r.operation === 'VariationWarning');
  assert.deepEqual(warnings.map((r) => r.objectId), [MASTER]);
});

test('scenario: accepting the variation warning lets the run proceed and records it', async () => {
  const t = mockTenant();
  const rows = await apply(t, buildArchivePlan(resolved(t, P1, P2, VAR), t.index()), true);

  assert.ok(t.archiveCalls.length > 0);
  const warn = where(rows, (r) => r.operation === 'VariationWarning');
  assert.equal(warn.length, 1);
  assert.equal(warn[0]?.status, 'Accepted');
  assert.equal(warn[0]?.objectId, MASTER);

  // The script puts the master back. This app reports it instead (W2 report).
  const collateral = where(rows, (r) => r.objectId === MASTER && r.operation === 'Collateral');
  assert.equal(collateral.length, 1);
  assert.equal(collateral[0]?.status, 'Unreversed');
});

test('scenario: a master the name heuristic misses is still caught after the run', async () => {
  const t = mockTenant();
  t.names.set(MASTER, 'Recruitment advertising (renamed)');
  const plan = buildArchivePlan(resolved(t, P1, P2, VAR), t.index());
  assert.deepEqual(plan.variations, []);

  const rows = await apply(t, plan);
  assert.equal(t.archiveCalls.length, 3);
  assert.ok(!t.archiveCalls.includes(MASTER));

  const caught = where(rows, (r) => r.objectId === MASTER && r.operation === 'Collateral');
  assert.equal(caught.length, 1);
  assert.match(caught[0]?.message ?? '', /was archived during this run \(it was in group 200\)/);
  assert.equal(t.archived.get(P1) && t.archived.get(P2) && t.archived.get(VAR), true);
});

test('scenario: the preview changes nothing and names what it would archive', () => {
  const t = mockTenant();
  const rows = previewRows(buildArchivePlan(resolved(t, S1, S2), t.index()));
  assert.equal(t.archiveCalls.length, 0);
  assert.equal(where(rows, (r) => r.status === 'Preview').length, 2);
});

test('scenario: an archive call that says yes and does nothing is reported from the tenant state', async () => {
  const t = mockTenant();
  t.stubborn.add(S2);
  const rows = await apply(t, buildArchivePlan(resolved(t, S1, S2), t.index()));

  const stubborn = where(rows, (r) => r.objectId === S2 && r.operation === 'Archive')[0];
  assert.equal(stubborn?.status, 'Failed');
  assert.match(stubborn?.message ?? '', /still active/);
  assert.equal(where(rows, (r) => r.objectId === S1)[0]?.status, 'Success');
});

test('scenario: a refusal does not stop the batch', async () => {
  const t = mockTenant();
  t.refuse.set(S2, STALE_LINK);
  const rows = where(await apply(t, buildArchivePlan(resolved(t, S1, S2, F1), t.index())), (r) => r.operation === 'Archive');

  assert.deepEqual(t.archiveCalls, [S1, S2, F1]);
  assert.equal(where(rows, (r) => r.status === 'Blocked').length, 1);
  assert.equal(where(rows, (r) => r.status === 'Success').length, 2);
  assert.equal(where(rows, (r) => r.status === 'Failed').length, 0);

  const blocked = where(rows, (r) => r.status === 'Blocked')[0];
  assert.equal(blocked?.objectId, S2);
  assert.equal(blocked?.name, 'Retire a record');
  assert.match(blocked?.message ?? '', /linked documents/);
  assert.match(blocked?.message ?? '', /400/);
  assert.equal(blocked?.statusCode, '400');
  assert.equal(blocked?.groupId, '110');
  assert.equal(t.archived.get(S1) && t.archived.get(F1), true);
  assert.equal(t.archived.get(S2), false);
});

test('scenario: archived, but in neither listing, is Unverified with its name', async () => {
  const t = mockTenant();
  t.vanishOnArchive.add(S2);
  const rows = where(await apply(t, buildArchivePlan(resolved(t, S1, S2), t.index())), (r) => r.operation === 'Archive');

  const ghost = where(rows, (r) => r.objectId === S2)[0];
  assert.equal(ghost?.status, 'Unverified');
  assert.match(ghost?.message ?? '', /could not be confirmed/);
  assert.equal(ghost?.name, 'Retire a record');
  assert.equal(where(rows, (r) => r.objectId === S1)[0]?.status, 'Success');
  assert.equal(where(rows, (r) => r.status === 'Failed').length, 0);
});

test('scenario: no Blocked or Unverified row in a mixed run is named by its id', async () => {
  const t = mockTenant();
  t.refuse.set(S1, DISABLED_USER);
  t.vanishOnArchive.add(S2);
  const rows = await apply(t, buildArchivePlan(resolved(t, S1, S2), t.index()));

  assert.ok(rows.length > 0);
  assert.equal(where(rows, (r) => r.name === r.objectId).length, 0);
  assert.equal(where(rows, (r) => r.status === 'Blocked').length, 1);
  assert.equal(where(rows, (r) => r.status === 'Unverified').length, 1);
});

// ------------------------------------------------- the results file and the review list

test('the summary counts every archive status, and the review list holds only refusals', () => {
  const row = (objectId: string, name: string, status: string, extra: Partial<ResultRow> = {}): ResultRow => ({
    objectType: 'Process', objectId, name, operation: 'Archive', status, message: status, groupId: '', statusCode: '', ...extra,
  });
  const mixed = [
    row(P1, 'Borrow a book', 'Success'),
    row(P2, 'Return a book', 'Overridden'),
    row(S1, 'Catalogue an accession', 'Pending'),
    row(S2, 'Retire a record', 'Unverified'),
    row(VAR, 'Expense claims :: Contractors', 'Blocked', {
      groupId: '100',
      statusCode: '400',
      message: `HTTP 400 refused by the tenant: ${DISABLED_USER}`,
    }),
  ];

  const counts = countByStatus(mixed, ARCHIVE_STATUSES);
  for (const status of ['Success', 'Overridden', 'Pending', 'Unverified', 'Blocked']) {
    assert.deepEqual(counts.find((c) => c.status === status), { status, count: 1, unexpected: false });
  }

  const written = parseCsv(resultsToCsv(mixed));
  assert.equal(written.length - 1, 5);
  assert.ok(written[0]?.includes('StatusCode'));

  const review = manualReviewCsvRows(mixed, '');
  assert.equal(review.length - 1, 1);
  const [header, first] = review;
  assert.deepEqual(header?.slice(0, 5), ['ObjectID', 'Name', 'GroupId', 'StatusCode', 'Reason']);
  assert.deepEqual(first?.slice(0, 4), [VAR, 'Expense claims :: Contractors', '100', '400']);
  assert.match(first?.[4] ?? '', /disabled user/);

  // Nothing refused: the list is its header alone, and the page offers no download.
  assert.equal(manualReviewCsvRows([row(P1, 'Borrow a book', 'Success')], '').length, 1);
});
