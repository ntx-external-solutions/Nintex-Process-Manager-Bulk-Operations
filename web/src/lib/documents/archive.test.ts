// W8a: Archive documents. A document attached to anything (a process, active or archived;
// a training unit; a reference in an active process's draft) is never archived. The bulk
// call answers 200 when items fail, so every `errors` entry is a row.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createControls } from '../exec/runner.ts';
import type { ActiveRead } from '../pm/dependencies.ts';
import type { DocumentBulkAnswer, DocumentListPage } from '../pm/documents.ts';
import { csvReadNote, targetsFromCsv } from '../select/ids.ts';
import type { IndexEntry, ProcessIndex } from '../tenant/state.ts';
import {
  ALREADY_ARCHIVED,
  buildDocumentArchivePlan,
  PENDING,
  runDocumentArchive,
  settleDocumentArchive,
  type DocumentArchiveGateway,
  type DocumentTarget,
  type PropertiesRead,
} from './archive.ts';
import { holdersMessage, toDocumentProperties } from './holders.ts';
import { loadDocumentIndex, loadDocumentList, toDocumentEntry, type DocumentEntry } from './list.ts';
import { findDocumentReferences, scanProcessesForDocuments, type ReferenceScan } from './references.ts';
import {
  CHOSEN_BY_ID,
  CHOSEN_FROM_LIST,
  CHOSEN_FROM_TREE,
  combineChosen,
  DOCUMENT_NOT_FOUND,
  DOCUMENT_UNKNOWN_NAME,
  NOT_A_DOCUMENT_ID,
  resolveDocumentIds,
  splitByPrimaryGroup,
  type ChosenDocument,
} from './select.ts';

const g = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
const d = (n: number) => `20000000-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;
const p = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function entry(n: number, name: string, group: number, more: Partial<DocumentEntry> = {}): DocumentEntry {
  return { documentId: n, uniqueId: d(n), name, primaryGroupUniqueId: g(group), primaryGroupName: `Group ${group}`, isArchived: false, isPending: false, location: 'Cloud', type: 'PDF', ...more };
}

const INDEX: ProcessIndex = new Map(
  (
    [
      { uniqueId: p(1), name: 'Pay a supplier', isArchived: false, groupId: 1, groupUniqueId: g(1), groupName: 'G', groupExists: true },
      { uniqueId: p(2), name: 'Old payroll', isArchived: true, groupId: 1, groupUniqueId: g(1), groupName: 'G', groupExists: true },
      { uniqueId: p(3), name: 'Close the month', isArchived: false, groupId: 1, groupUniqueId: g(1), groupName: 'G', groupExists: true },
    ] satisfies IndexEntry[]
  ).map((e) => [e.uniqueId.toLowerCase(), e]),
);

const NO_SCAN: ReferenceScan = { holders: [], unread: [], read: 0 };
const free = (more: Record<string, unknown> = {}) => toDocumentProperties({ attachedProcesses: [], attachedTrainings: [], isArchived: false, isPending: false, primaryProcessGroupId: 7, ...more });
const chosen = (e: DocumentEntry, how = CHOSEN_FROM_TREE): ChosenDocument => ({ entry: e, chosen: how });

// ------------------------------------------------------------------ choosing

test('a checked group takes the documents whose primary group is in its subtree; associated-only ones are listed apart', () => {
  // The tenant's group filter is recursive and adds associated documents (spike).
  const listed = [entry(1, 'In the group', 1), entry(2, 'In a subgroup', 2), entry(3, 'Only associated', 9)];
  const split = splitByPrimaryGroup(listed, new Set([g(1).toUpperCase(), g(2)]));
  assert.deepEqual(split.inSubtree.map((e) => e.name), ['In the group', 'In a subgroup']);
  assert.deepEqual(split.associatedOnly.map((e) => e.name), ['Only associated']);
});

test('by id: a GUID is a documentUniqueId, a number a documentId, each document once; anything else is a Resolve row', () => {
  const index = new Map([entry(5, 'Policy', 1), entry(6, 'Archived form', 1, { isArchived: true })].map((e) => [e.uniqueId.toLowerCase(), e]));
  const r = resolveDocumentIds([d(5).toUpperCase(), '5', '6', '99', 'Policy', d(77)], index);
  assert.deepEqual(r.chosen.map((c) => [c.entry.name, c.chosen]), [['Policy', CHOSEN_BY_ID], ['Archived form', CHOSEN_BY_ID]]);
  assert.deepEqual(
    r.skipped.map((row) => [row.objectType, row.operation, row.status, row.objectId, row.name, row.message]),
    [
      ['Document', 'Resolve', 'Skipped', '99', DOCUMENT_UNKNOWN_NAME, DOCUMENT_NOT_FOUND],
      ['Document', 'Resolve', 'Skipped', 'Policy', DOCUMENT_UNKNOWN_NAME, NOT_A_DOCUMENT_ID],
      ['Document', 'Resolve', 'Skipped', d(77), DOCUMENT_UNKNOWN_NAME, DOCUMENT_NOT_FOUND],
    ],
    'a number is never a process id here, and a name is never matched',
  );
});

test('the three ways in add up, each document once, the first way kept', () => {
  const a = entry(1, 'A', 1);
  const b = entry(2, 'B', 1);
  const all = combineChosen([chosen(a)], [chosen(a, CHOSEN_FROM_LIST), chosen(b, CHOSEN_FROM_LIST)], [chosen(b, CHOSEN_BY_ID)]);
  assert.deepEqual(all.map((c) => [c.entry.name, c.chosen]), [['A', CHOSEN_FROM_TREE], ['B', CHOSEN_FROM_LIST]]);
});

test('a document results file feeds back in by its ObjectID, and the note names documents', () => {
  const csv = '﻿"ObjectType","ObjectID","Name","Operation","Status"\r\n"Document","' + d(4) + '","Policy","Archive","Failed"\r\n';
  assert.deepEqual(targetsFromCsv(csv).ids, [d(4)]);
  const named = targetsFromCsv('Name\r\nPolicy\r\n');
  assert.match(csvReadNote('names.csv', named, 'document'), /documents are picked by id only.*fill in DocumentID/);
});

// ------------------------------------------------------------------ the lists

test('the list is read in pages of 500 until a short page, and both lists make one index', async () => {
  const pages: Array<[string, number, string | null]> = [];
  const items = (from: number, n: number, archived = false) =>
    Array.from({ length: n }, (_, i) => ({ documentId: from + i, documentUniqueId: d(from + i), documentName: `Doc ${from + i}`, isArchived: archived }));
  const read = async (listType: 'All' | 'Archived', page: number, group: string | null): Promise<DocumentListPage> => {
    pages.push([listType, page, group]);
    if (listType === 'Archived') return { items: items(900, 2, true), totalItemCount: 2 };
    return page === 1 ? { items: items(1, 500), totalItemCount: 503 } : { items: items(501, 3), totalItemCount: 503 };
  };
  assert.equal((await loadDocumentList(read, 'All')).length, 503);
  const index = await loadDocumentIndex(read);
  assert.equal(index.size, 505);
  assert.equal(index.get(d(900))?.isArchived, true);
  assert.deepEqual(pages.slice(0, 2), [['All', 1, null], ['All', 2, null]]);
});

test('a list row is read case-insensitively, with its location and type said plainly', () => {
  const row = toDocumentEntry({ DocumentId: 3, DocumentUniqueId: d(3), DocumentName: 'Handbook.pdf', documentLocationType: 'External', isPending: true }, 'All');
  assert.deepEqual([row?.location, row?.type, row?.isPending, row?.isArchived], ['External link', 'PDF', true, false]);
  assert.equal(toDocumentEntry({ documentName: 'No id' }, 'All'), null, 'a row with no id cannot be acted on');
});

// ------------------------------------------------------------------ what holds a document

test('the walk finds a document reference anywhere under ProcessProcedures, not only where the spike saw them', () => {
  const model = {
    ProcessProcedures: {
      Activity: [
        { Id: 1, Text: 'Step', ChildProcessProcedures: { Form: [{ Id: 2, DocumentId: 5, DocumentUniqueId: d(5), Text: 'Claim form' }], Note: [{ Id: 3, Text: 'n' }] } },
      ],
      SomethingNew: { Deeper: [{ documentUniqueId: d(6), name: 'Elsewhere' }] },
    },
    // Outside ProcessProcedures is not a reference location.
    Objective: { DocumentId: 99 },
  };
  const refs = findDocumentReferences(model);
  assert.deepEqual(
    refs.map((r) => [r.documentId, r.documentUniqueId, r.type, r.text, r.path]),
    [
      [5, d(5), 'Form', 'Claim form', 'ProcessProcedures.Activity[0].ChildProcessProcedures.Form[0]'],
      [null, d(6), 'Deeper', 'Elsewhere', 'ProcessProcedures.SomethingNew.Deeper[0]'],
    ],
  );
  assert.deepEqual(refs[0]!.segments, ['ProcessProcedures', 'Activity', 0, 'ChildProcessProcedures', 'Form', 0]);
});

test('every attachment source skips the document, naming its holders', () => {
  const docs = [entry(1, 'Active holder', 1), entry(2, 'Archived holder', 1), entry(3, 'Training', 1), entry(4, 'Draft only', 1), entry(5, 'Free', 1)];
  const properties = new Map<string, PropertiesRead>([
    [d(1), free({ attachedProcesses: [{ processName: 'Pay a supplier', processUniqueId: p(1) }] })],
    [d(2), free({ attachedProcesses: [{ processName: 'Old payroll', processUniqueId: p(2) }, { processName: 'Pay a supplier', processUniqueId: p(1) }] })],
    [d(3), free({ attachedTrainings: [{ name: 'Induction' }] })],
    [d(4), free()],
    [d(5), free()],
  ]);
  // The draft reference: attachedProcesses misses it, the scan of models finds it.
  const scan: ReferenceScan = {
    holders: [{ uniqueId: p(3), name: 'Close the month', published: false, references: findDocumentReferences({ ProcessProcedures: { Form: [{ DocumentId: 4 }] } }) }],
    unread: [],
    read: 3,
  };
  const plan = buildDocumentArchivePlan({ chosen: docs.map((e) => chosen(e)), paths: new Map(), properties, scan, index: INDEX });
  assert.deepEqual(plan.targets.map((t) => [t.name, t.groupId]), [['Free', 7]]);
  assert.deepEqual(
    plan.skipped.map((r) => [r.name, r.operation, r.status, r.message]),
    [
      ['Active holder', 'Archive', 'Skipped', 'Attached to 1 process: Pay a supplier.'],
      ['Archived holder', 'Archive', 'Skipped', 'Attached to 2 processes: Old payroll (archived), Pay a supplier.'],
      ['Training', 'Archive', 'Skipped', 'Used by training unit Induction.'],
      ['Draft only', 'Archive', 'Skipped', 'In the unpublished draft of Close the month.'],
    ],
  );
});

test('a process both lists and the scan finds is named once; holders of several kinds are all named', () => {
  const props = free({ attachedProcesses: [{ processName: 'Pay a supplier', processUniqueId: p(1) }], attachedTrainings: [{ name: 'A' }, { name: 'B' }] });
  const refs = findDocumentReferences({ ProcessProcedures: { Form: [{ DocumentId: 1 }] } });
  assert.equal(
    holdersMessage(props, [{ uniqueId: p(1), name: 'Pay a supplier', published: false, references: refs }, { uniqueId: p(3), name: 'Close the month', published: false, references: refs }], INDEX),
    'Attached to 1 process: Pay a supplier. Used by 2 training units: A, B. In the unpublished draft of Close the month.',
  );
});

test('archived, pending and unreadable documents are left out, each with its reason', () => {
  const docs = [entry(1, 'Archived', 1, { isArchived: true }), entry(2, 'Pending', 1, { isPending: true }), entry(3, 'Unreadable', 1), entry(4, 'Pending per properties', 1)];
  const properties = new Map<string, PropertiesRead>([[d(3), { error: '500' }], [d(4), free({ isPending: true })]]);
  const plan = buildDocumentArchivePlan({ chosen: docs.map((e) => chosen(e)), paths: new Map(), properties, scan: NO_SCAN, index: INDEX });
  assert.equal(plan.targets.length, 0);
  assert.deepEqual(plan.skipped.map((r) => r.message.slice(0, 40)), [ALREADY_ARCHIVED, PENDING, 'Could not read what holds it (500), so i', PENDING]);
});

test('the scan reads every model, reports the ones it could not read, and stops for a dead session', async () => {
  const models: Record<string, ActiveRead> = {
    [p(1)]: { kind: 'model', model: { ProcessRevisionStateId: 3, ProcessProcedures: { Form: [{ DocumentId: 9 }] } }, processActions: null },
    [p(3)]: { kind: 'archived' },
  };
  let progress = 0;
  const scan = await scanProcessesForDocuments(
    [{ uniqueId: p(1), name: 'One' }, { uniqueId: p(2), name: 'Two' }, { uniqueId: p(3), name: 'Three' }],
    async (id) => {
      const read = models[id];
      if (!read) throw new Error('500');
      return read;
    },
    { concurrency: 2, errorText: (e) => (e as Error).message, onProgress: (done) => (progress = done) },
  );
  assert.deepEqual(scan.holders.map((h) => [h.name, h.published]), [['One', true]]);
  assert.deepEqual(scan.unread, [{ uniqueId: p(2), name: 'Two', error: '500' }]);
  assert.equal(scan.read, 1, 'a process archived since the list was read has no model to count');
  assert.equal(progress, 3);
  await assert.rejects(
    scanProcessesForDocuments([{ uniqueId: p(1), name: 'One' }], async () => { throw new Error('signed out'); }, { isFatal: () => true }),
    /signed out/,
  );
});

test('a plan with unread processes keeps them, so the page can refuse to run it', () => {
  const plan = buildDocumentArchivePlan({
    chosen: [chosen(entry(1, 'Free', 1))],
    paths: new Map([[g(1), ['Top', 'Group 1']]]),
    properties: new Map([[d(1), free()]]),
    scan: { holders: [], unread: [{ uniqueId: p(2), name: 'Two', error: '500' }], read: 2 },
    index: INDEX,
  });
  assert.deepEqual(plan.unreadProcesses.map((u) => u.name), ['Two']);
  assert.deepEqual(plan.targets[0]!.path, ['Top', 'Group 1']);
});

// ------------------------------------------------------------------ running

function fakeGateway(propsById: Record<number, Record<string, unknown>>, answers: DocumentBulkAnswer[] | ((ids: number[]) => DocumentBulkAnswer)) {
  const sent: number[][] = [];
  const gateway: DocumentArchiveGateway = {
    properties: async (id) => {
      const props = propsById[id];
      if (!props) throw new Error('404');
      return props;
    },
    archive: async (ids) => {
      sent.push(ids);
      return typeof answers === 'function' ? answers(ids) : (answers[sent.length - 1] ?? { errors: [] });
    },
  };
  return { gateway, sent };
}

const target = (n: number, more: Partial<DocumentTarget> = {}): DocumentTarget => ({ documentId: n, uniqueId: d(n), name: `Doc ${n}`, path: [], groupId: 7, groupUniqueId: g(7), isArchived: false, chosen: CHOSEN_FROM_TREE, location: 'Cloud', type: 'PDF', ...more });
const FREE_RAW = { attachedProcesses: [], attachedTrainings: [], isArchived: false };

test('batches of 50, each re-checked first: a document attached since the plan is dropped with its new holder', async () => {
  const targets = Array.from({ length: 52 }, (_, i) => target(i + 1));
  const props: Record<number, Record<string, unknown>> = Object.fromEntries(targets.map((t) => [t.documentId, FREE_RAW]));
  props[2] = { ...FREE_RAW, attachedProcesses: [{ processName: 'Pay a supplier', processUniqueId: p(1) }] };
  props[51] = { ...FREE_RAW, attachedTrainings: [{ name: 'Induction' }] };
  const { gateway, sent } = fakeGateway(props, []);
  const rows = await runDocumentArchive(gateway, targets, createControls(), { index: INDEX });
  assert.deepEqual(sent.map((b) => b.length), [49, 1]);
  assert.equal(sent[0]!.includes(2), false, 'never sent');
  const row = (n: number) => rows.find((r) => r.objectId === d(n))!;
  assert.equal(row(2).status, 'Skipped');
  assert.equal(row(2).message, 'Attached since the plan was built. Attached to 1 process: Pay a supplier.');
  assert.match(row(51).message, /Used by training unit Induction/);
  assert.equal(row(1).status, 'Success');
  assert.equal(rows.length, 52);
});

test('a 200 with errors gives each named document a Failed row with its code', async () => {
  const targets = [target(1), target(2), target(3)];
  const props = { 1: FREE_RAW, 2: FREE_RAW, 3: FREE_RAW };
  const { gateway } = fakeGateway(props, [{ errors: [{ documentId: 2, errorCode: 'NotFound' }, { documentId: 3, errorCode: 'Locked' }] }]);
  const rows = await runDocumentArchive(gateway, targets, createControls(), { index: INDEX });
  assert.deepEqual(rows.map((r) => [r.objectType, r.operation, r.status, r.message]), [
    ['Document', 'Archive', 'Success', 'Archived.'],
    ['Document', 'Archive', 'Failed', 'Process Manager refused: NotFound'],
    ['Document', 'Archive', 'Failed', 'Process Manager refused: Locked'],
  ]);
});

test('an error the answer does not tie to a document is carried on every row of its batch', async () => {
  const { gateway } = fakeGateway({ 1: FREE_RAW }, [{ errors: [{ documentId: null, errorCode: 'Unknown' }] }]);
  const rows = await runDocumentArchive(gateway, [target(1)], createControls(), { index: INDEX });
  assert.match(rows[0]!.message, /did not tie to a document in this batch \(Unknown\)/);
});

test('a re-check that fails skips the document; a dead session stops the run with the rest not attempted', async () => {
  const signedOut = Object.assign(new Error('signed out'), { signedOut: true });
  const gateway: DocumentArchiveGateway = {
    properties: async (id) => {
      if (id === 1) throw new Error('500');
      if (id === 51) throw signedOut;
      return FREE_RAW;
    },
    archive: async () => ({ errors: [] }),
  };
  const targets = Array.from({ length: 60 }, (_, i) => target(i + 1));
  const controls = createControls();
  const rows = await runDocumentArchive(gateway, targets, controls, { index: INDEX });
  assert.match(rows.find((r) => r.objectId === d(1))!.message, /Could not re-check what holds it straight before archiving \(500\)/);
  assert.equal(rows.filter((r) => r.status === 'Success').length, 49);
  const rest = rows.filter((r) => r.message.startsWith('Not attempted'));
  assert.equal(rest.length, 10, 'the whole second batch, none of it sent');
  assert.ok(controls.stopped());
});

test('a stopped run marks what it did not reach as not attempted', async () => {
  const abort = new AbortController();
  abort.abort();
  const { gateway, sent } = fakeGateway({ 1: FREE_RAW }, []);
  const rows = await runDocumentArchive(gateway, [target(1)], createControls({ signal: abort.signal }), { index: INDEX });
  assert.equal(sent.length, 0);
  assert.match(rows[0]!.message, /^Not attempted: Cancelled/);
});

test('the final read settles each row: a refusal that took effect is Success, a success that did not is Failed', async () => {
  const targets = [target(1), target(2), target(3), target(4)];
  const { gateway } = fakeGateway({ 1: FREE_RAW, 2: FREE_RAW, 3: FREE_RAW, 4: FREE_RAW }, [{ errors: [{ documentId: 2, errorCode: 'Timeout' }] }]);
  const rows = await runDocumentArchive(gateway, targets, createControls(), { index: INDEX });
  const after = new Map([
    [d(1), entry(1, 'Doc 1', 1, { isArchived: true })],
    [d(2), entry(2, 'Doc 2', 1, { isArchived: true })],
    [d(3), entry(3, 'Doc 3', 1)],
  ]);
  assert.deepEqual(settleDocumentArchive(rows, after).map((r) => [r.status, r.message.slice(0, 50)]), [
    ['Success', 'Archived.'],
    ['Success', 'Archived, confirmed by the final read, although th'],
    ['Failed', 'Archive reported success, but the document is stil'],
    ['Unverified', 'Archive was accepted, but neither document list re'],
  ]);
});
