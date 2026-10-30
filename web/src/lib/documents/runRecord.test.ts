// W8 follow-up: a document run whose session dies or whose tab closes can be finished.
// The page keeps a run record; signed in again, every row is settled against a fresh read,
// and an interrupted Delete documents run goes on to its confirmation or puts back what it
// archived. Nothing is sent again on the record's word.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultRow, type ResultRow } from '../exec/report.ts';
import { createControls } from '../exec/runner.ts';
import type { ProcessIndex } from '../tenant/state.ts';
import { runDocumentArchive, type DocumentTarget } from './archive.ts';
import { recoverDelete } from './delete.ts';
import type { DocumentEntry } from './list.ts';
import { interruptedRepairRow } from './repair.ts';
import { inFlightOf, inFlightRows, loadRecord, recorder, type DocumentRunRecord, type RecordStore } from './runRecord.ts';

const d = (n: number) => `20000000-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;
const target = (n: number, isArchived = false): DocumentTarget => ({
  documentId: n, uniqueId: d(n), name: `Doc ${n}`, path: [], groupId: 7, groupUniqueId: null, isArchived, chosen: 'By id', location: 'Cloud', type: 'PDF',
});
const entry = (n: number, isArchived: boolean): [string, DocumentEntry] => [
  d(n),
  { documentId: n, uniqueId: d(n), name: `Doc ${n}`, primaryGroupUniqueId: null, primaryGroupName: '', isArchived, isPending: false, location: 'Cloud', type: 'PDF' },
];
const row = (n: number, operation: string, status: string, message = 'm'): ResultRow =>
  resultRow({ objectType: 'Document', objectId: d(n), name: `Doc ${n}`, operation, status, message, groupId: 7 });

function memoryStore(): RecordStore & { value: string | null } {
  const store = {
    value: null as string | null,
    read: () => store.value,
    write: (v: string) => {
      store.value = v;
    },
    clear: () => {
      store.value = null;
    },
  };
  return store;
}

const base = (more: Partial<DocumentRunRecord> = {}): DocumentRunRecord => ({ page: 'delete', tenant: 't', runId: 'r', startedAt: 1, rows: [], inFlight: null, ...more });

test('the record is written as the run goes, read back only for its own page and tenant, and a broken store never stops a run', () => {
  const store = memoryStore();
  const rec = recorder(store, base({ rows: [row(1, 'Delete', 'Skipped')] }));
  assert.equal(loadRecord(store, 't', 'delete')?.rows.length, 1, 'written before the first write');
  rec.save({ inFlight: inFlightOf('Delete', [target(2)]) });
  assert.deepEqual(loadRecord(store, 't', 'delete')?.inFlight, { operation: 'Delete', items: [{ uniqueId: d(2), name: 'Doc 2', groupId: 7 }] });
  assert.equal(loadRecord(store, 'other tenant', 'delete'), null);
  assert.equal(loadRecord(store, 't', 'archive'), null);
  store.value = '{not json';
  assert.equal(loadRecord(store, 't', 'delete'), null);
  rec.clear();
  assert.equal(store.value, null);

  const broken: RecordStore = {
    read: () => null,
    write: () => {
      throw new Error('quota');
    },
    clear: () => {
      throw new Error('quota');
    },
  };
  assert.doesNotThrow(() => recorder(broken, base()).save({ rows: [] }));
});

test('the batch runner reports each batch before it is sent and its rows after, which is what the record keeps', async () => {
  const events: string[] = [];
  await runDocumentArchive(
    { properties: async () => ({ attachedProcesses: [], attachedTrainings: [], isArchived: false }), archive: async () => ({ errors: [] }) },
    [target(1), target(2)],
    createControls(),
    { index: new Map() as ProcessIndex, onBatch: (e) => events.push(e.sending ? `sending ${e.sending.length}` : `rows ${e.rows.length}`) },
  );
  assert.deepEqual(events, ['sending 2', 'rows 2', 'rows 2']);
});

test('a call that was out when the run died is decided by the lists read now', () => {
  const after = new Map([entry(1, true), entry(2, false), entry(4, false)]);
  const archive = inFlightRows(base({ inFlight: inFlightOf('Archive', [target(1), target(2), target(3)]) }), after);
  assert.deepEqual(archive.map((r) => [r.status, r.message.slice(0, 40)]), [
    ['Success', 'Archived. The run was interrupted while '],
    ['Skipped', 'Not attempted, or not taken: the run was'],
    ['Unverified', 'The run was interrupted while this call '],
  ]);
  const del = inFlightRows(base({ inFlight: inFlightOf('Delete', [target(3), target(4)]) }), after);
  assert.deepEqual(del.map((r) => r.status), ['Success', 'Skipped']);
  const restore = inFlightRows(base({ rows: [row(1, 'Restore', 'Failed')], inFlight: inFlightOf('Restore', [target(1), target(2)]) }), after);
  assert.deepEqual(restore.map((r) => [r.objectId, r.status]), [[d(2), 'Success']], 'a document with a row already keeps it');
});

test('a delete run that died in its archive phase goes on to the confirmation with what it archived, and records the rest', () => {
  const record = base({
    rows: [row(9, 'Delete', 'Skipped', 'Attached to 1 process: A.'), row(1, 'Archive', 'Success')],
    inFlight: inFlightOf('Archive', [target(2)]),
    delete: { toArchive: [target(1), target(2), target(3)], alreadyArchived: [target(4, true)], groups: [], confirmed: false },
  });
  const after = new Map([entry(1, true), entry(2, true), entry(3, false), entry(4, true)]);
  const r = recoverDelete(record, after)!;
  assert.deepEqual(r.between.toDelete.map((t) => t.documentId), [4, 1, 2]);
  assert.deepEqual(r.between.archivedByRun.map((t) => t.documentId), [1, 2]);
  assert.deepEqual(r.priorRows.map((x) => `${x.operation} ${x.objectId.slice(-1)} ${x.status}`), [
    'Delete 9 Skipped',
    'Archive 1 Success',
    'Archive 2 Success',
    'Archive 3 Skipped',
  ]);
  assert.match(r.priorRows[3]!.message, /^Not attempted: the run was interrupted before it was archived/);
});

test('a delete run that died mid-delete: what went is confirmed, what was never reached is offered again, what was held is put back', () => {
  const record = base({
    rows: [
      row(1, 'Archive', 'Success'),
      row(2, 'Archive', 'Success'),
      row(3, 'Archive', 'Success'),
      row(4, 'Delete', 'Success'),
      row(1, 'Delete', 'Skipped', 'Attached since the plan was built.'),
      row(5, 'Delete', 'Skipped', 'Not attempted: Your session ended.'),
      row(7, 'Delete', 'Failed', 'The delete call failed (Your session ended.). The final read says whether it took effect.'),
      row(8, 'Delete', 'Failed', 'Process Manager refused: Locked'),
    ],
    inFlight: inFlightOf('Delete', [target(2), target(3)]),
    delete: {
      toArchive: [target(1), target(2), target(3)],
      alreadyArchived: [target(4, true), target(5, true), target(6, true), target(7, true), target(8, true)],
      groups: [],
      confirmed: true,
    },
  });
  // 2 went; 3's call never took; 6 was restored by someone meanwhile; 7's call got no answer; 8 was refused.
  const after = new Map([entry(1, true), entry(3, true), entry(5, true), entry(6, false), entry(7, true), entry(8, true)]);
  const r = recoverDelete(record, after)!;
  assert.deepEqual(r.between.toDelete.map((t) => t.documentId), [5, 7, 3], 'never reached, not taken, or no answer; never the refused one');
  assert.deepEqual(r.between.archivedByRun.map((t) => t.documentId), [1, 3], 'put back unless deleted now');
  const rows = r.priorRows.map((x) => `${x.operation} ${x.objectId.slice(-1)} ${x.status}`);
  assert.ok(rows.includes('Delete 2 Success'));
  assert.ok(rows.includes('Delete 1 Skipped'), 'a held document keeps its row and is not retried');
  assert.ok(!rows.includes('Delete 5 Skipped') && !rows.includes('Delete 3 Skipped'), 'the rows of what is offered again give way to the new ones');
  assert.ok(rows.includes('Delete 6 Skipped'), 'restored meanwhile: not deleted');
  assert.equal(r.allTargets.length, 8);
  assert.equal(recoverDelete(base(), after), null, 'a record with no targets cannot be resumed');
});

test('a process whose repair was under way is decided by reading it back', async () => {
  const model = (refs: number[]) => ({
    Version: '1.2',
    ProcessRevisionStateId: 1,
    ProcessProcedures: { Form: refs.map((n) => ({ DocumentId: n, DocumentUniqueId: d(n), Text: `Doc ${n}` })) },
  });
  const list = async () => ({ items: [{ documentId: 1, documentUniqueId: d(1), documentName: 'Doc 1' }], totalItemCount: 1 });
  const item = { uniqueId: d(50), name: 'Pay a supplier', groupId: 3 };
  const clean = await interruptedRepairRow({ readModel: async () => ({ kind: 'model', model: model([1]), processActions: null }), list }, item);
  assert.deepEqual([clean.objectType, clean.operation, clean.status], ['Process', 'RepairDocumentReference', 'Success']);
  assert.match(clean.message, /no dead reference left \(open draft 1\.2 over version 1\.0\)/);
  const left = await interruptedRepairRow({ readModel: async () => ({ kind: 'model', model: model([1, 9]), processActions: null }), list }, item);
  assert.equal(left.status, 'Skipped');
  assert.match(left.message, /still finds 1 dead reference .* Scan again to repair it\.$/);
  const unread = await interruptedRepairRow({ readModel: async () => Promise.reject(new Error('401')), list }, item);
  assert.equal(unread.status, 'Unverified');
});
