// W9: Move documents. The save replaces the whole record, so most of these pin what must
// not change: a field the read didn't carry refuses the move, and never goes out blank.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultRow } from '../exec/report.ts';
import { createControls } from '../exec/runner.ts';
import {
  documentMoveForm,
  MOVE_ALREADY_THERE,
  MOVE_ARCHIVED,
  MOVE_AUTOMATED_FORM,
  MOVE_LINK,
  MOVE_PENDING,
  MOVE_TAGGED,
  moveDocument,
  type DocumentMoveAnswer,
} from '../pm/documents.ts';
import type { DocumentTarget } from './archive.ts';
import type { DocumentEntry } from './list.ts';
import {
  buildDocumentMovePlan,
  movePreviewRows,
  moveInFlightRows,
  readForMove,
  runDocumentMove,
  settleDocumentMove,
  type MoveDestination,
  type MoveRead,
} from './move.ts';
import type { DocumentRunRecord } from './runRecord.ts';
import { CHOSEN_BY_ID, type ChosenDocument } from './select.ts';

const g = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
const d = (n: number) => `20000000-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;
const destination: MoveDestination = { id: 77, uniqueId: g(9), path: ['Finance', 'Forms'] };

// The shape of a captured read, with synthetic values.
const record = (more: Record<string, unknown> = {}) => ({
  primaryProcessGroupId: 500,
  associatedGroups: [{ key: 'Old', value: 500 }, { key: 'Top', value: 1 }, { key: 'Other', value: 501 }, { key: 'Forms', value: 77 }],
  implicitlyAssociatedGroups: [500, 1],
  associatedTags: [],
  associatedSystemTags: [],
  isAutomatedForm: false,
  isArchived: false,
  documentLocationType: 'Cloud',
  documentName: 'Expense form',
  documentType: 'Image',
  referenceNumber: 'REF-1',
  documentReview: { doOverrideDocumentReviewFreq: true, documentReviewFreqMonths: 6 },
  ...more,
});
const without = (field: string) => {
  const r: Record<string, unknown> = record();
  delete r[field];
  return r;
};

function entry(n: number, more: Partial<DocumentEntry> = {}): DocumentEntry {
  return { documentId: n, uniqueId: d(n), name: `Doc ${n}`, primaryGroupUniqueId: g(1), primaryGroupName: 'Old', isArchived: false, isPending: false, location: 'Cloud', type: 'PDF', ...more };
}
const chosen = (e: DocumentEntry): ChosenDocument => ({ entry: e, chosen: CHOSEN_BY_ID });
const target = (n: number): DocumentTarget => ({ documentId: n, uniqueId: d(n), name: `Doc ${n}`, path: ['Old'], groupId: 500, groupUniqueId: g(1), isArchived: false, chosen: CHOSEN_BY_ID, location: 'Cloud', type: 'PDF' });

test('the form changes the primary group and sends everything else back as it came', () => {
  assert.deepEqual(documentMoveForm(record(), 77), {
    form: {
      DoOverrideDocumentReviewFreq: 'true',
      DocumentReviewFreqMonths: '6',
      ReferenceNo: 'REF-1',
      DocumentName: 'Expense form',
      DocumentType: 'Image',
      PrimaryProcessGroupId: '77',
      GroupList: '{"selected":[501]}',
    },
  });
});

test('a real association survives; the primary, the old primary, inherited groups and the destination do not go back', () => {
  const built = documentMoveForm(record({ associatedGroups: [{ key: 'Old', value: 500 }, { key: 'Top', value: 1 }, { key: 'A', value: 7 }, { key: 'A again', value: 7 }, { key: 'B', value: 8 }, { key: 'Forms', value: 77 }] }), 77);
  assert.ok('form' in built);
  assert.equal(built.form['GroupList'], '{"selected":[7,8]}');
});

test('gives the form the browser sent for a captured move: no override, months kept, blank reference, nothing selected', () => {
  const built = documentMoveForm(
    record({
      primaryProcessGroupId: 500,
      associatedGroups: [{ key: 'Old', value: 500 }],
      implicitlyAssociatedGroups: [500],
      referenceNumber: '',
      documentReview: { doOverrideDocumentReviewFreq: false, documentReviewFreqMonths: 12 },
    }),
    77,
  );
  assert.deepEqual(built, {
    form: {
      DoOverrideDocumentReviewFreq: 'false',
      DocumentReviewFreqMonths: '12',
      ReferenceNo: '',
      DocumentName: 'Expense form',
      DocumentType: 'Image',
      PrimaryProcessGroupId: '77',
      GroupList: '{"selected":[]}',
    },
  });
});

test('an attached document: the group its process lives in is implied, and stays out of the list', () => {
  const built = documentMoveForm(record({ associatedGroups: [{ key: 'Old', value: 500 }, { key: 'Top', value: 1 }] }), 77);
  assert.ok('form' in built);
  assert.equal(built.form['GroupList'], '{"selected":[]}');
});

test('a group linked as well as primary is what GroupList holds, as in the captured link', () => {
  const built = documentMoveForm(record({ associatedGroups: [{ key: 'Old', value: 500 }, { key: 'Linked', value: 80 }], implicitlyAssociatedGroups: [500] }), 77);
  assert.ok('form' in built);
  assert.equal(built.form['GroupList'], '{"selected":[80]}');
});

test('a blank reference and no review override are real values, not missing ones', () => {
  const built = documentMoveForm(record({ referenceNumber: '', documentReview: { doOverrideDocumentReviewFreq: false, documentReviewFreqMonths: null }, associatedGroups: [] }), 77);
  assert.ok('form' in built);
  assert.equal(built.form['ReferenceNo'], '');
  assert.equal(built.form['DoOverrideDocumentReviewFreq'], 'false');
  assert.equal(built.form['DocumentReviewFreqMonths'], '');
  assert.equal(built.form['GroupList'], '{"selected":[]}');
});

test('every field a save sends back refuses the move when the read did not carry it', () => {
  const cases: Array<[string, string]> = [
    ['documentName', 'its name'],
    ['documentType', 'its document type'],
    ['referenceNumber', 'its reference number'],
    ['documentReview', 'its review frequency setting'],
    ['associatedGroups', 'its associated groups'],
    ['implicitlyAssociatedGroups', 'its implicit groups'],
    ['associatedTags', 'its tags'],
    ['associatedSystemTags', 'its tags'],
    ['isAutomatedForm', 'whether it is an automated form'],
    ['documentLocationType', 'its location type'],
    ['primaryProcessGroupId', 'its primary group'],
  ];
  for (const [field, words] of cases) {
    const built = documentMoveForm(without(field), 77);
    assert.ok('refused' in built, field);
    assert.ok(built.refused.includes(`did not give ${words},`), `${field}: ${built.refused}`);
  }
});

test('values a save could not send back faithfully refuse it too', () => {
  for (const more of [
    { documentType: 3 },
    { associatedGroups: null },
    { associatedGroups: [{ key: 'No id', value: null }] },
    { implicitlyAssociatedGroups: null },
    { documentReview: { doOverrideDocumentReviewFreq: 'yes', documentReviewFreqMonths: 6 } },
    { documentReview: { doOverrideDocumentReviewFreq: true } },
    { documentReview: { doOverrideDocumentReviewFreq: true, documentReviewFreqMonths: '' } },
    { documentReview: { doOverrideDocumentReviewFreq: true, documentReviewFreqMonths: null } },
    // Top level is not where the read keeps them.
    { documentReview: null, doOverrideDocumentReviewFreq: true, documentReviewFreqMonths: 6 },
  ]) {
    assert.ok('refused' in documentMoveForm(record(more), 77), JSON.stringify(more));
  }
});

test('archived, pending, already there and linked documents are refused by name', () => {
  assert.deepEqual(documentMoveForm(record({ isArchived: true }), 77), { refused: MOVE_ARCHIVED });
  assert.deepEqual(documentMoveForm(record({ isPending: true }), 77), { refused: MOVE_PENDING });
  assert.deepEqual(documentMoveForm(record({ primaryProcessGroupId: 77 }), 77), { refused: MOVE_ALREADY_THERE });
  assert.deepEqual(documentMoveForm(record({ documentLocationType: 'External' }), 77), { refused: MOVE_LINK });
});

test('a tag of either kind and an automated form refuse the move: the captured form has no field for them', () => {
  assert.deepEqual(documentMoveForm(record({ associatedTags: [{ key: 'tag', value: 1 }] }), 77), { refused: MOVE_TAGGED });
  assert.deepEqual(documentMoveForm(record({ associatedSystemTags: [{ key: 'system', value: 2 }] }), 77), { refused: MOVE_TAGGED });
  assert.deepEqual(documentMoveForm(record({ isAutomatedForm: true }), 77), { refused: MOVE_AUTOMATED_FORM });
});

test('moveDocument reads, saves multipart to the document, and sends no save when refused', async () => {
  const calls: Array<{ url: string; method: string; body: unknown; contentType: string | undefined }> = [];
  let answer: Record<string, unknown> = record();
  const ctx = {
    baseUrl: 'https://pm.example',
    tenant: 't',
    token: 'x',
    fetch: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method ?? 'GET', body: init.body, contentType: headers['Content-Type'] });
      return init.method === 'POST' ? new Response(null, { status: 204 }) : new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch,
  };

  assert.deepEqual(await moveDocument(ctx, 41, 77), { moved: true });
  assert.deepEqual(calls.map((c) => [c.method, new URL(c.url).pathname]), [
    ['GET', '/t/bff/document/api/v1/documents/41/properties'],
    ['POST', '/t/bff/document/api/v1/documents/41/properties'],
  ]);
  const body = calls[1]!.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get('PrimaryProcessGroupId'), '77');
  assert.equal(body.get('DocumentName'), 'Expense form');
  assert.equal(calls[1]!.contentType, undefined, 'fetch sets it, with the boundary');

  calls.length = 0;
  answer = without('referenceNumber');
  const refused = (await moveDocument(ctx, 41, 77)) as Extract<DocumentMoveAnswer, { moved: false }>;
  assert.equal(refused.moved, false);
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
});

test('the plan moves what can be saved, attached or not, and says why the rest stay', async () => {
  const docs = [
    entry(1),
    entry(2, { isArchived: true }),
    entry(3, { isPending: true }),
    entry(4, { primaryGroupUniqueId: g(9).toUpperCase() }),
    entry(5),
    entry(6),
    entry(7),
  ];
  const answers = new Map<number, unknown>([
    [1, record({ attachedProcesses: [{ processName: 'Held', processUniqueId: d(99) }] })],
    [2, record()],
    [3, record()],
    [4, record()],
    [5, without('referenceNumber')],
    [7, record({ documentLocationType: 'External' })],
  ]);
  const reads = await readForMove(docs.map(chosen), async (id) => {
    if (!answers.has(id)) throw new Error('500');
    return answers.get(id);
  }, destination, { errorText: (e) => (e as Error).message });
  const plan = buildDocumentMovePlan({ chosen: docs.map(chosen), paths: new Map([[g(1), ['Top', 'Old']]]), reads, destination });

  assert.deepEqual(plan.targets.map((t) => [t.name, t.groupId, t.path.join(' / ')]), [['Doc 1', 500, 'Top / Old']]);
  assert.deepEqual(plan.skipped.map((r) => [r.name, r.operation, r.status, r.message.slice(0, 26)]), [
    ['Doc 2', 'UpdateLocation', 'Skipped', MOVE_ARCHIVED.slice(0, 26)],
    ['Doc 3', 'UpdateLocation', 'Skipped', MOVE_PENDING.slice(0, 26)],
    ['Doc 4', 'UpdateLocation', 'Skipped', MOVE_ALREADY_THERE],
    ['Doc 5', 'UpdateLocation', 'Skipped', 'Its properties did not giv'],
    ['Doc 6', 'UpdateLocation', 'Skipped', 'Could not read it (500), s'],
    ['Doc 7', 'UpdateLocation', 'Skipped', MOVE_LINK.slice(0, 26)],
  ]);
  const preview = movePreviewRows(plan).at(-1)!;
  assert.equal(preview.status, 'Preview');
  assert.equal(preview.message, 'Would move from Top / Old to Finance / Forms');
});

test('a dead session while reading ends the plan', async () => {
  const dead = new Error('signed out');
  await assert.rejects(
    readForMove([chosen(entry(1))], async () => { throw dead; }, destination, { isFatal: (e) => e === dead }),
    (e) => e === dead,
  );
});

test('the plan keeps ids that matched nothing first', () => {
  const resolveSkipped = [resultRow({ objectType: 'Document', objectId: 'x', name: 'n', operation: 'Resolve', status: 'Skipped', message: 'm' })];
  const reads = new Map<string, MoveRead>();
  const plan = buildDocumentMovePlan({ chosen: [], resolveSkipped, paths: new Map(), reads, destination });
  assert.equal(plan.skipped[0]!.operation, 'Resolve');
});

test('the run gives every target a row: moved, refused by the fresh read, or failed on its own', async () => {
  const sent: Array<[number, number]> = [];
  const rows = await runDocumentMove(
    {
      move: async (id, group) => {
        sent.push([id, group]);
        if (id === 2) return { moved: false, refused: MOVE_ARCHIVED };
        if (id === 3) throw new Error('boom');
        return { moved: true };
      },
    },
    [target(1), target(2), target(3), target(4), target(5)],
    destination,
    createControls(),
    { concurrency: 2 },
  );
  assert.deepEqual(sent.map(([, group]) => group), [77, 77, 77, 77, 77]);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [['Doc 1', 'Success'], ['Doc 2', 'Skipped'], ['Doc 3', 'Failed'], ['Doc 4', 'Success'], ['Doc 5', 'Success']]);
  assert.equal(rows[0]!.message, 'Moved from Old to Finance / Forms.');
  assert.equal(rows[0]!.groupId, '500', 'the group it left');
  assert.equal(rows[0]!.operation, 'UpdateLocation');
});

test('a dead session stops the run and the rest are not attempted', async () => {
  const controls = createControls({ isFatal: (e) => ((e as Error).message === 'dead' ? 'Your session ended.' : null) });
  const sent: number[] = [];
  const rows = await runDocumentMove(
    {
      move: async (id) => {
        sent.push(id);
        throw new Error('dead');
      },
    },
    [target(1), target(2), target(3)],
    destination,
    controls,
    { concurrency: 1 },
  );
  assert.deepEqual(sent, [1]);
  assert.deepEqual(rows.map((r) => r.status), ['Failed', 'Skipped', 'Skipped']);
  assert.equal(rows[1]!.message, 'Not attempted: Your session ended.');
});

test('the record names what is out before each call and clears it after', async () => {
  const events: Array<number | null> = [];
  await runDocumentMove({ move: async () => ({ moved: true }) }, [target(1), target(2)], destination, createControls(), {
    concurrency: 2,
    onBatch: (e) => events.push(e.sending === null ? null : e.sending.length),
  });
  assert.deepEqual(events, [2, null, null]);
});

test('settling: the group decides, whichever way the call reported', () => {
  const row = (n: number, status: string) => resultRow({ objectType: 'Document', objectId: d(n), name: `Doc ${n}`, operation: 'UpdateLocation', status, message: 'said', groupId: 500 });
  const after = new Map([
    [d(1), entry(1, { primaryGroupUniqueId: g(9) })],
    [d(2), entry(2)],
    [d(3), entry(3, { primaryGroupUniqueId: g(9) })],
    [d(5), entry(5)],
  ]);
  const settled = settleDocumentMove([row(1, 'Success'), row(2, 'Success'), row(3, 'Failed'), row(4, 'Success'), row(5, 'Failed'), row(6, 'Skipped')], after, destination);
  assert.deepEqual(settled.map((r) => r.status), ['Success', 'Failed', 'Success', 'Unverified', 'Failed', 'Skipped']);
  assert.equal(settled[1]!.message, 'The move was accepted, but the document is still in Old');
  assert.ok(settled[2]!.message.startsWith('Moved to Finance / Forms, confirmed by the final read'));
});

test('a call out when the run died is decided by the group now, and a row already written stands', () => {
  const rec: DocumentRunRecord = {
    page: 'move',
    tenant: 't',
    runId: 'r',
    startedAt: 1,
    rows: [resultRow({ objectType: 'Document', objectId: d(4), name: 'Doc 4', operation: 'UpdateLocation', status: 'Success', message: 'm', groupId: 500 })],
    inFlight: { operation: 'UpdateLocation', items: [1, 2, 3, 4].map((n) => ({ uniqueId: d(n), name: `Doc ${n}`, groupId: 500 })) },
    move: { destination },
  };
  const after = new Map([
    [d(1), entry(1, { primaryGroupUniqueId: g(9) })],
    [d(2), entry(2)],
    [d(4), entry(4, { primaryGroupUniqueId: g(9) })],
  ]);
  assert.deepEqual(moveInFlightRows(rec, after, destination).map((r) => [r.name, r.status]), [['Doc 1', 'Success'], ['Doc 2', 'Skipped'], ['Doc 3', 'Unverified']]);
  assert.deepEqual(moveInFlightRows({ ...rec, inFlight: null }, after, destination), []);
});
