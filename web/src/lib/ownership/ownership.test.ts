import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Journal, step } from '../exec/journal.ts';
import { createControls } from '../exec/runner.ts';
import type { OwnershipState, SetOwnershipRequest, SetOwnershipResult } from '../pm/ownership.ts';
import type { DirectoryUser } from '../pm/scim.ts';
import { parseOwnershipCsv, type OwnershipCsvRow } from './csv.ts';
import {
  buildOwnershipPlan,
  directoryOf,
  ownershipPreviewRows,
  publishCount,
  resolveCell,
  unresolvedUsernames,
  type OwnershipPlan,
  type PublishChoice,
} from './plan.ts';
import { runOwnership, settleOwnership, type OwnershipGateway } from './run.ts';

const P1 = '00000001-0000-4000-8000-000000000001';
const P2 = '00000002-0000-4000-8000-000000000002';
const P3 = '00000003-0000-4000-8000-000000000003';

const USERS: DirectoryUser[] = [
  { userId: 101, logon: 'ann@example.com', displayName: 'Ann Owner', active: true },
  { userId: 102, logon: 'bob@example.com', displayName: 'Bob Expert', active: true },
  { userId: 103, logon: 'gone@example.com', displayName: 'Gone User', active: false },
  { userId: 104, logon: 'twin@example.com', displayName: 'Twin One', active: true },
  { userId: 105, logon: 'TWIN@example.com', displayName: 'Twin Two', active: true },
];
const DIRECTORY = directoryOf(USERS);

// ------------------------------------------------------------------- csv

test('the csv takes the script\'s column names, in any case, with a BOM', () => {
  const parsed = parseOwnershipCsv(`﻿process id,OWNER,expertusername\r\n${P1},ann@example.com,\r\n${P2},,bob@example.com\r\n,,\r\n`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.rows, [
    { line: 2, processId: P1, owner: 'ann@example.com', expert: null },
    { line: 3, processId: P2, owner: null, expert: 'bob@example.com' },
  ]);
});

test('the first non-blank of several matching columns wins, as in the script', () => {
  const parsed = parseOwnershipCsv(`ProcessID,NewOwner,Owner\n${P1},,ann@example.com\n${P2},bob@example.com,ann@example.com\n`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.rows.map((r) => r.owner), ['ann@example.com', 'bob@example.com']);
});

test('a file with no id column, or no rows, is refused with the reason', () => {
  const noId = parseOwnershipCsv('Name,Owner\nX,ann@example.com\n');
  assert.equal(noId.ok, false);
  assert.match(noId.ok ? '' : noId.problem, /No process id column.*Name, Owner.*ProcessID/);
  assert.equal(parseOwnershipCsv('ProcessID,Owner\n').ok, false);
  assert.equal(parseOwnershipCsv('').ok, false);
});

test('ids that are not GUIDs are listed for the warning', () => {
  const parsed = parseOwnershipCsv(`ID,Owner\n1234,ann@example.com\n${P1},ann@example.com\n`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.nonGuidIds, ['1234']);
});

// ----------------------------------------------------------------- cells

test('cell rules: blank is unchanged, keywords unassign, numbers are ids, logons ignore case', () => {
  assert.deepEqual(resolveCell(null, DIRECTORY), { kind: 'unchanged' });
  assert.deepEqual(resolveCell('  ', DIRECTORY), { kind: 'unchanged' });
  for (const keyword of ['unassigned', 'Unassign', 'NONE', 'n/a', 'NA']) {
    assert.deepEqual(resolveCell(keyword, DIRECTORY), { kind: 'set', user: { id: 2, name: 'Needs to be reassigned N/A' }, inactive: false }, keyword);
  }
  assert.deepEqual(resolveCell('102', DIRECTORY), { kind: 'set', user: { id: 102, name: 'Bob Expert' }, inactive: false });
  assert.deepEqual(resolveCell('ANN@example.com', DIRECTORY), { kind: 'set', user: { id: 101, name: 'Ann Owner' }, inactive: false });
  assert.deepEqual(resolveCell('gone@example.com', DIRECTORY), { kind: 'set', user: { id: 103, name: 'Gone User' }, inactive: true });
});

test('a username nobody has, an id nobody has, and a logon two accounts share are invalid', () => {
  assert.equal(resolveCell('nobody@example.com', DIRECTORY).kind, 'invalid');
  assert.equal(resolveCell('999', DIRECTORY).kind, 'invalid');
  const twin = resolveCell('twin@example.com', DIRECTORY);
  assert.ok(twin.kind === 'invalid');
  assert.match(twin.reason, /more than one account/);
  const rows: OwnershipCsvRow[] = [
    { line: 2, processId: P1, owner: 'nobody@example.com', expert: 'NOBODY@example.com' },
    { line: 3, processId: P2, owner: 'ann@example.com', expert: '999' },
  ];
  assert.deepEqual(unresolvedUsernames(rows, DIRECTORY).map((u) => u.value), ['nobody@example.com', '999']);
});

// ------------------------------------------------------------------ plan

function state(over: Partial<OwnershipState> = {}): OwnershipState {
  return {
    uniqueId: P1,
    name: 'Pay a supplier',
    version: '2.0',
    revisionEditId: 500,
    revisionStateId: 3,
    isArchived: false,
    owner: { id: 7, name: 'Old Owner' },
    expert: { id: 8, name: 'Old Expert' },
    canSave: true,
    canPublishAfterEdit: true,
    canSubmitForApprovalAfterEdit: false,
    ...over,
  };
}

function reads(states: Record<string, OwnershipState | Error>) {
  const calls: string[] = [];
  return {
    calls,
    reads: {
      async ownership(id: string) {
        calls.push(id);
        const s = states[id];
        if (s instanceof Error) throw s;
        if (!s) throw Object.assign(new Error('Not found'), { status: 404 });
        return s;
      },
      isFatal: (e: unknown) => ((e as { signedOut?: boolean }).signedOut ? 'Session ended.' : null),
    },
  };
}

const plan = (rows: OwnershipCsvRow[], states: Record<string, OwnershipState | Error>, publish: PublishChoice = 'match-state') =>
  buildOwnershipPlan(rows, DIRECTORY, reads(states).reads, { publish });

test('rows the script skips are skipped with its reasons, and never read', async () => {
  const r = reads({});
  const p = await buildOwnershipPlan(
    [
      { line: 2, processId: null, owner: 'ann@example.com', expert: null },
      { line: 3, processId: P1, owner: null, expert: null },
      { line: 4, processId: P2, owner: 'ann@example.com', expert: 'nobody@example.com' },
      { line: 5, processId: '1234', owner: 'ann@example.com', expert: null },
    ],
    DIRECTORY,
    r.reads,
    { publish: 'match-state' },
  );
  assert.deepEqual(r.calls, []);
  assert.deepEqual(p.changes, []);
  assert.deepEqual(
    p.skipped.map((s) => [s.objectId, s.status, s.message]),
    [
      ['', 'Skipped', 'Missing ProcessID (line 2)'],
      [P1, 'Skipped', 'No owner/expert provided (line 3)'],
      // The whole row, as in the script: half of what it asked for is not what it asked for.
      [P2, 'Skipped', "expert 'nobody@example.com' not found (line 4)"],
      ['1234', 'Skipped', p.skipped[3]!.message],
    ],
  );
  assert.match(p.skipped[3]!.message, /Not a process UniqueId \(GUID\).*line 5/);
});

test('a process named on several rows is read and written once, the last non-blank cell winning', async () => {
  const r = reads({ [P1]: state() });
  const p = await buildOwnershipPlan(
    [
      { line: 2, processId: P1, owner: 'ann@example.com', expert: 'ann@example.com' },
      { line: 3, processId: P1.toUpperCase(), owner: null, expert: 'bob@example.com' },
    ],
    DIRECTORY,
    r.reads,
    { publish: 'match-state' },
  );
  assert.deepEqual(r.calls, [P1]);
  assert.equal(p.changes.length, 1);
  assert.deepEqual(p.changes[0]?.lines, [2, 3]);
  assert.deepEqual(p.changes[0]?.owner?.after, { id: 101, name: 'Ann Owner' });
  assert.deepEqual(p.changes[0]?.expert?.after, { id: 102, name: 'Bob Expert' });
});

test('a role already set is not saved again; a stale display name is', async () => {
  const already = await plan([{ line: 2, processId: P1, owner: 'ann@example.com', expert: null }], {
    [P1]: state({ owner: { id: 101, name: 'Ann Owner' } }),
  });
  assert.deepEqual(already.changes, []);
  assert.match(already.skipped[0]?.message ?? '', /^Already set: Owner Ann Owner \(id 101\)/);

  const renamed = await plan([{ line: 2, processId: P1, owner: 'ann@example.com', expert: null }], {
    [P1]: state({ owner: { id: 101, name: 'Ann Maiden' } }),
  });
  assert.equal(renamed.changes.length, 1);
  assert.equal(renamed.changes[0]?.expert, null, 'a blank cell leaves the role alone');
});

test('unreadable, missing and archived processes are reported, and a dead session stops planning', async () => {
  const p = await plan(
    [
      { line: 2, processId: P1, owner: 'ann@example.com', expert: null },
      { line: 3, processId: P2, owner: 'ann@example.com', expert: null },
      { line: 4, processId: P3, owner: 'ann@example.com', expert: null },
    ],
    { [P2]: Object.assign(new Error('boom'), { status: 500, tenantMessage: 'Server busy' }), [P3]: state({ uniqueId: P3, isArchived: true }) },
  );
  assert.deepEqual(p.skipped.map((s) => [s.objectId, s.status, s.statusCode]), [
    [P1, 'Failed', '404'],
    [P2, 'Failed', '500'],
    [P3, 'Skipped', ''],
  ]);
  assert.match(p.skipped[0]!.message, /Process not found/);
  assert.match(p.skipped[1]!.message, /Server busy/);
  assert.match(p.skipped[2]!.message, /Archived/);

  await assert.rejects(
    plan([{ line: 2, processId: P1, owner: 'ann@example.com', expert: null }], { [P1]: Object.assign(new Error('gone'), { signedOut: true }) }),
    /gone/,
  );
});

test('how each process is written follows its state, the choice and the permissions', async () => {
  const one = async (s: Partial<OwnershipState>, publish: PublishChoice = 'match-state') => {
    const p = await plan([{ line: 2, processId: P1, owner: 'ann@example.com', expert: null }], { [P1]: state(s) }, publish);
    return p.changes[0]?.writePath ?? `${p.skipped[0]?.status}: ${p.skipped[0]?.message}`;
  };
  assert.equal(await one({}), 'publish-direct');
  assert.equal(await one({ canPublishAfterEdit: false, canSubmitForApprovalAfterEdit: true }), 'submit-then-publish');
  assert.match(await one({ canPublishAfterEdit: false }), /^Blocked: Published, but you can neither publish it nor submit it/);
  assert.equal(await one({}, 'save-only'), 'save-only');
  // In progress is only ever saved: its draft may hold edits that are not ours to publish.
  assert.equal(await one({ revisionStateId: 1, version: '2.1' }), 'save-only');
  assert.match(await one({ revisionStateId: 2 }), /^Blocked: Awaiting approval/);
  assert.match(await one({ canSave: false }), /^Blocked: You do not have permission/);
});

test('the preview says what changes and what the write does, in the script\'s words', async () => {
  const p = await plan(
    [
      { line: 2, processId: P1, owner: 'ann@example.com', expert: 'unassigned' },
      { line: 3, processId: P2, owner: 'gone@example.com', expert: null },
    ],
    { [P1]: state(), [P2]: state({ uniqueId: P2, name: 'Approve an invoice', expert: null }) },
    'save-only',
  );
  const rows = ownershipPreviewRows(p);
  assert.equal(rows[0]?.status, 'Preview');
  assert.equal(
    rows[0]?.message,
    "Would update 'Pay a supplier' - Owner: Old Owner (id 7) -> Ann Owner (id 101); Expert: Old Expert (id 8) -> Needs to be reassigned N/A (id 2). Saved as a draft. The published version shows the old owner and expert until someone publishes it.",
  );
  assert.match(rows[1]?.message ?? '', /Gone User \(id 103\) \(inactive in the directory\)/);
  assert.equal(publishCount(p), 0);
});

// ------------------------------------------------------------------- run

function gateway(options: { conflict?: string[]; refuseSave?: Record<string, unknown>; refusePublish?: Record<string, unknown>; noRevision?: string[] } = {}) {
  const calls: string[] = [];
  const sent: SetOwnershipRequest[] = [];
  const g: OwnershipGateway = {
    async setOwnership(request): Promise<SetOwnershipResult> {
      calls.push(`save ${request.processUniqueId}`);
      sent.push(request);
      const refusal = options.refuseSave?.[request.processUniqueId];
      if (refusal) throw refusal;
      if (options.conflict?.includes(request.processUniqueId)) {
        return { ok: false, conflict: { expected: request.expectedRevisionEditId, actual: request.expectedRevisionEditId + 1 } };
      }
      return { ok: true, revisionEditId: options.noRevision?.includes(request.processUniqueId) ? null : request.expectedRevisionEditId + 1 };
    },
    async publishNow(id, revision, message) {
      calls.push(`publish ${id} ${revision} ${message}`);
      const refusal = options.refusePublish?.[id];
      if (refusal) throw refusal;
      return {};
    },
  };
  return { g, calls, sent };
}

const journal = () => Journal.start('run', 'tenant', 1, null);
const DESCRIPTION = 'Owners moved to the new team';

async function threePlan(): Promise<OwnershipPlan> {
  return plan(
    [
      { line: 2, processId: P1, owner: 'ann@example.com', expert: null },
      { line: 3, processId: P2, owner: null, expert: 'bob@example.com' },
      { line: 4, processId: P3, owner: 'ann@example.com', expert: null },
    ],
    {
      [P1]: state(),
      [P2]: state({ uniqueId: P2, name: 'Approve an invoice', canPublishAfterEdit: false, canSubmitForApprovalAfterEdit: true }),
      [P3]: state({ uniqueId: P3, name: 'Month-end close', revisionStateId: 1, version: '0.3' }),
    },
  );
}

test('each process is saved once and published only when its write path says so, with the description', async () => {
  const p = await threePlan();
  const { g, calls, sent } = gateway();
  const rows = await runOwnership(g, journal(), p, createControls(), { changeDescription: DESCRIPTION, concurrency: 1 });
  assert.deepEqual(calls, [`save ${P1}`, `publish ${P1} 501 ${DESCRIPTION}`, `save ${P2}`, `publish ${P2} 501 ${DESCRIPTION}`, `save ${P3}`]);
  assert.deepEqual(sent.map((s) => [s.submitForApproval, s.expectedRevisionEditId, s.owner?.id ?? null, s.expert?.id ?? null]), [
    [false, 500, 101, null],
    [true, 500, null, 102],
    [false, 500, 101, null],
  ]);
  assert.deepEqual(rows.map((r) => [r.objectId, r.operation, r.status]), [
    [P1, 'UpdateOwnership', 'Success'],
    [P2, 'UpdateOwnership', 'Success'],
    [P3, 'UpdateOwnership', 'Success'],
  ]);
  assert.match(rows[2]!.message, /already in progress, so it is not published/);
});

test('a run without a change description sends nothing', async () => {
  const { g, calls } = gateway();
  await assert.rejects(runOwnership(g, journal(), await threePlan(), createControls(), { changeDescription: ' ' }), /change description/);
  assert.deepEqual(calls, []);
});

test('an edit since the preview is skipped, a 4xx is Blocked, and a failed publish says the change is a draft', async () => {
  const p = await threePlan();
  const { g, calls } = gateway({
    conflict: [P1],
    refuseSave: { [P3]: Object.assign(new Error('HTTP 403'), { status: 403, tenantMessage: 'No permission' }) },
    refusePublish: { [P2]: Object.assign(new Error('HTTP 400'), { status: 400, tenantMessage: 'A message must be added when publishing' }) },
  });
  const rows = await runOwnership(g, journal(), p, createControls(), { changeDescription: DESCRIPTION, concurrency: 1 });
  assert.equal(calls.filter((c) => c.startsWith(`publish ${P1}`)).length, 0, 'a conflicted save is never published');
  const by = (id: string) => rows.find((r) => r.objectId === id)!;
  assert.equal(by(P1).status, 'Skipped');
  assert.match(by(P1).message, /Changed by someone else since the preview \(revision 500, now 501\)/);
  assert.equal(by(P2).status, 'Failed');
  assert.match(by(P2).message, /Saved, but not published: HTTP 400 refused by the tenant: A message must be added/);
  assert.equal(by(P2).statusCode, '400');
  assert.equal(by(P3).status, 'Blocked');
  assert.equal(by(P3).statusCode, '403');
});

test('a save whose new revision cannot be read is not published', async () => {
  const p = await threePlan();
  const { g, calls } = gateway({ noRevision: [P1] });
  const rows = await runOwnership(g, journal(), p, createControls(), { changeDescription: DESCRIPTION, concurrency: 1 });
  assert.equal(calls.some((c) => c.startsWith(`publish ${P1}`)), false);
  assert.match(rows[0]!.message, /new revision id could not be read, so it was not published/);
});

test('a dead session stops the run, and everything after it gets a row', async () => {
  const p = await threePlan();
  const { g, calls } = gateway({ refuseSave: { [P1]: Object.assign(new Error('signed out'), { signedOut: true }) } });
  const rows = await runOwnership(g, journal(), p, createControls(), { changeDescription: DESCRIPTION, concurrency: 1 });
  assert.deepEqual(calls, [`save ${P1}`]);
  assert.deepEqual(rows.map((r) => r.status), ['Failed', 'Skipped', 'Skipped']);
  assert.match(rows[1]!.message, /^Not attempted: Your session ended/);
});

test('a step already in the journal is not sent again', async () => {
  const p = await threePlan();
  const j = journal();
  j.append({ step: step.update(P1), kind: 'process.update', phase: 'begin' });
  const { g, calls } = gateway();
  const rows = await runOwnership(g, j, p, createControls(), { changeDescription: DESCRIPTION, concurrency: 1 });
  assert.equal(calls.some((c) => c.includes(P1)), false);
  assert.equal(rows[0]?.status, 'Skipped');
});

// ---------------------------------------------------------------- settle

test('the final read decides every row', async () => {
  const p = await threePlan();
  const j = journal();
  const { g } = gateway({ refuseSave: { [P3]: Object.assign(new Error('timeout'), { status: 504 }) } });
  const rows = await runOwnership(g, j, p, createControls(), { changeDescription: DESCRIPTION, concurrency: 1 });
  const after = new Map<string, OwnershipState | null>([
    // Saved and published, but an approval queue holds it.
    [P1, state({ owner: { id: 101, name: 'Ann Owner' }, revisionStateId: 2 })],
    // The publish was accepted and the read cannot confirm it.
    [P2, null],
    // Reported a 504, but the save landed. It needed no publish.
    [P3, state({ uniqueId: P3, owner: { id: 101, name: 'Ann Owner' }, revisionStateId: 1 })],
  ]);
  const settled = settleOwnership(rows, p, j, after);
  assert.deepEqual(settled.map((r) => [r.objectId, r.status]), [
    [P1, 'Pending'],
    [P2, 'Unverified'],
    [P3, 'Success'],
  ]);
  assert.match(settled[2]!.message, /Confirmed by the final read, although the run reported/);
});

test('a reported success the final read contradicts is Failed; a failed save that landed but was due a publish is too', async () => {
  const p = await threePlan();
  const j = journal();
  const { g } = gateway({ refuseSave: { [P1]: Object.assign(new Error('timeout'), { status: 504 }) } });
  const rows = await runOwnership(g, j, p, createControls(), { changeDescription: DESCRIPTION, concurrency: 1 });
  const after = new Map<string, OwnershipState | null>([
    [P1, state({ owner: { id: 101, name: 'Ann Owner' } })],
    [P2, state({ uniqueId: P2, expert: { id: 8, name: 'Old Expert' } })],
    [P3, state({ uniqueId: P3, owner: { id: 101, name: 'Ann Owner' }, revisionStateId: 1 })],
  ]);
  const settled = settleOwnership(rows, p, j, after);
  assert.equal(settled[0]?.status, 'Failed');
  assert.match(settled[0]!.message, /but not published, because the run reported/);
  assert.equal(settled[1]?.status, 'Failed');
  assert.match(settled[1]!.message, /final read shows Expert Old Expert \(id 8\)/);
  assert.equal(settled[2]?.status, 'Success');
});
