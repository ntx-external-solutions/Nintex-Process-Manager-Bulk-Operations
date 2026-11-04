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
  MOVE_OTHER_LOCATION,
  MOVE_PENDING,
  moveDocument,
  type DocumentMoveAnswer,
} from '../pm/documents.ts';
import type { DocumentTarget } from './archive.ts';
import type { DocumentEntry } from './list.ts';
import {
  buildDocumentMovePlan,
  movePreviewRows,
  pendingChosen,
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
const fieldOf = (form: ReadonlyArray<readonly [string, string]>, name: string) => form.find(([n]) => n === name)?.[1];
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
    form: Object.entries({
      DoOverrideDocumentReviewFreq: 'true',
      DocumentReviewFreqMonths: '6',
      ReferenceNo: 'REF-1',
      DocumentName: 'Expense form',
      DocumentType: 'Image',
      PrimaryProcessGroupId: '77',
      GroupList: '{"selected":[501]}',
    }),
  });
});

test('a real association survives; the primary, the old primary, inherited groups and the destination do not go back', () => {
  const built = documentMoveForm(record({ associatedGroups: [{ key: 'Old', value: 500 }, { key: 'Top', value: 1 }, { key: 'A', value: 7 }, { key: 'A again', value: 7 }, { key: 'B', value: 8 }, { key: 'Forms', value: 77 }] }), 77);
  assert.ok('form' in built);
  assert.equal(fieldOf(built.form, 'GroupList'), '{"selected":[7,8]}');
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
    form: Object.entries({
      DoOverrideDocumentReviewFreq: 'false',
      DocumentReviewFreqMonths: '12',
      ReferenceNo: '',
      DocumentName: 'Expense form',
      DocumentType: 'Image',
      PrimaryProcessGroupId: '77',
      GroupList: '{"selected":[]}',
    }),
  });
});

test('an attached document: the group its process lives in is implied, and stays out of the list', () => {
  const built = documentMoveForm(record({ associatedGroups: [{ key: 'Old', value: 500 }, { key: 'Top', value: 1 }] }), 77);
  assert.ok('form' in built);
  assert.equal(fieldOf(built.form, 'GroupList'), '{"selected":[]}');
});

test('a group linked as well as primary is what GroupList holds, as in the captured link', () => {
  const built = documentMoveForm(record({ associatedGroups: [{ key: 'Old', value: 500 }, { key: 'Linked', value: 80 }], implicitlyAssociatedGroups: [500] }), 77);
  assert.ok('form' in built);
  assert.equal(fieldOf(built.form, 'GroupList'), '{"selected":[80]}');
});

test('a blank reference and no review override are real values, not missing ones', () => {
  const built = documentMoveForm(record({ referenceNumber: '', documentReview: { doOverrideDocumentReviewFreq: false, documentReviewFreqMonths: null }, associatedGroups: [] }), 77);
  assert.ok('form' in built);
  assert.equal(fieldOf(built.form, 'ReferenceNo'), '');
  assert.equal(fieldOf(built.form, 'DoOverrideDocumentReviewFreq'), 'false');
  assert.equal(fieldOf(built.form, 'DocumentReviewFreqMonths'), '');
  assert.equal(fieldOf(built.form, 'GroupList'), '{"selected":[]}');
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

test('archived, already there and network-linked documents are refused by name', () => {
  assert.deepEqual(documentMoveForm(record({ isArchived: true }), 77), { refused: MOVE_ARCHIVED });
  assert.deepEqual(documentMoveForm(record({ primaryProcessGroupId: 77 }), 77), { refused: MOVE_ALREADY_THERE });
  assert.deepEqual(documentMoveForm(record({ documentLocationType: 'Network' }), 77), { refused: MOVE_OTHER_LOCATION });
});

test('an automated form refuses the move: the captured form has no field for one', () => {
  assert.deepEqual(documentMoveForm(record({ isAutomatedForm: true }), 77), { refused: MOVE_AUTOMATED_FORM });
});

// The captured shape of a document with nothing optional set, so the whole form can be compared.
const plain = (more: Record<string, unknown> = {}) =>
  record({
    documentName: 'Example document',
    documentType: 'Information',
    referenceNumber: '',
    documentReview: { doOverrideDocumentReviewFreq: false, documentReviewFreqMonths: 12 },
    associatedGroups: [],
    ...more,
  });
const baseForm = [
  ['DoOverrideDocumentReviewFreq', 'false'],
  ['DocumentReviewFreqMonths', '12'],
  ['ReferenceNo', ''],
  ['DocumentName', 'Example document'],
  ['DocumentType', 'Information'],
  ['PrimaryProcessGroupId', '77'],
  ['GroupList', '{"selected":[]}'],
];

test('tags go back as one field per id after GroupList, in the order the browser sends them (W9b A4)', () => {
  const built = documentMoveForm(
    plain({ associatedTags: [{ key: 'one', value: 101 }, { key: 'two', value: 102 }], associatedSystemTags: [{ key: 'system', value: 201 }] }),
    77,
  );
  assert.deepEqual(built, {
    form: [...baseForm, ['AssociatedTags', '101'], ['AssociatedTags', '102'], ['AssociatedSystemTags', '201']],
  });
});

test('a document with only a system tag sends only that field, as the browser did moving one', () => {
  const built = documentMoveForm(plain({ associatedSystemTags: [{ key: 'system', value: 201 }] }), 77);
  assert.deepEqual(built, { form: [...baseForm, ['AssociatedSystemTags', '201']] });
});

test('a web link saves the same form as an upload, with no address field (W9c)', () => {
  const link = plain({ documentLocationType: 'External', documentPath: 'https://example.test/page', documentExtension: '', documentType: 'Guide' });
  const expected = baseForm.map(([name, value]) => [name, name === 'DocumentType' ? 'Guide' : value]);
  assert.deepEqual(documentMoveForm(link, 77), { form: expected });
});

test('a web link keeps its tags too: the tag fields do not depend on the location', () => {
  const built = documentMoveForm(plain({ documentLocationType: 'External', associatedTags: [{ key: 'one', value: 101 }] }), 77);
  assert.ok('form' in built);
  assert.equal(fieldOf(built.form, 'AssociatedTags'), '101');
});

test('a document with no tags sends no tag field at all, not an empty one (W9b A6)', () => {
  assert.deepEqual(documentMoveForm(plain(), 77), { form: baseForm });
});

test('a tag with no usable id refuses the move: sent without it, that tag would be wiped', () => {
  for (const bad of [{ key: 'no id' }, { key: 'null', value: null }, { key: 'zero', value: 0 }, { key: 'negative', value: -1 }, { key: 'word', value: 'abc' }, { key: 'fraction', value: 1.5 }, 'just a name']) {
    for (const list of ['associatedTags', 'associatedSystemTags']) {
      const built = documentMoveForm(record({ [list]: [{ key: 'good', value: 5 }, bad] }), 77);
      assert.ok('refused' in built, `${list}: ${JSON.stringify(bad)}`);
      assert.ok(built.refused.includes('did not give the id of a tag,'), built.refused);
    }
  }
});

test('a tag list that is not a list refuses the move', () => {
  for (const list of ['associatedTags', 'associatedSystemTags']) {
    for (const value of [null, 'a tag', { key: 'tag', value: 1 }]) {
      const built = documentMoveForm(record({ [list]: value }), 77);
      assert.ok('refused' in built && built.refused.includes('did not give its tags,'), `${list}: ${JSON.stringify(value)}`);
    }
  }
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

  // The list form is what lets a name repeat; a Record would have kept only the last tag.
  calls.length = 0;
  answer = record({ associatedTags: [{ key: 'one', value: 101 }, { key: 'two', value: 102 }], associatedSystemTags: [{ key: 'system', value: 201 }] });
  assert.deepEqual(await moveDocument(ctx, 41, 77), { moved: true });
  const tagged = calls[1]!.body as FormData;
  assert.deepEqual(tagged.getAll('AssociatedTags'), ['101', '102']);
  assert.deepEqual(tagged.getAll('AssociatedSystemTags'), ['201']);
  assert.deepEqual([...tagged.keys()].slice(-4), ['GroupList', 'AssociatedTags', 'AssociatedTags', 'AssociatedSystemTags']);

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
    [7, record({ documentLocationType: 'Network' })],
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
    ['Doc 7', 'UpdateLocation', 'Skipped', MOVE_OTHER_LOCATION.slice(0, 26)],
  ]);
  const preview = movePreviewRows(plan).at(-1)!;
  assert.equal(preview.status, 'Preview');
  assert.equal(preview.message, 'Would move from Top / Old to Finance / Forms');
});

test('pending documents stay out until the operator opts in, and then only those a save can send back', async () => {
  const docs = [entry(1), entry(2, { isPending: true }), entry(3, { isPending: true }), entry(4, { isPending: true, isArchived: true }), entry(5, { isPending: true })];
  const read = async (id: number) => {
    if (id === 3) return record({ documentLocationType: 'Network' });
    if (id === 5) return record({ associatedTags: [{ key: 'tag', value: 1 }] });
    return record();
  };
  const reads = await readForMove(docs.map(chosen), read, destination);
  const input = { chosen: docs.map(chosen), paths: new Map(), reads, destination };
  assert.equal(pendingChosen(input.chosen), 3, 'an archived one is not on offer');

  const off = buildDocumentMovePlan(input);
  assert.deepEqual(off.targets.map((t) => t.name), ['Doc 1']);
  assert.deepEqual(off.skipped.map((r) => r.message), [MOVE_PENDING, MOVE_PENDING, MOVE_ARCHIVED, MOVE_PENDING]);

  const on = buildDocumentMovePlan({ ...input, includePending: true });
  // Doc 5 is the W9b change: a pending document with tags was refused for its tags until now.
  assert.deepEqual(on.targets.map((t) => [t.name, t.chosen]), [['Doc 1', CHOSEN_BY_ID], ['Doc 2', `${CHOSEN_BY_ID} (pending)`], ['Doc 5', `${CHOSEN_BY_ID} (pending)`]]);
  assert.deepEqual(on.skipped.map((r) => r.message), [MOVE_OTHER_LOCATION, MOVE_ARCHIVED]);
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
