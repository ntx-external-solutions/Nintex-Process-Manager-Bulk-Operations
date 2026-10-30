// W8b: Delete documents. Active targets are archived first; nothing attached is archived or
// deleted; the delete's 200 carries its failures in `errors`; and a document the run
// archived but did not delete is put back.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createControls } from '../exec/runner.ts';
import type { DocumentBulkAnswer } from '../pm/documents.ts';
import type { IndexEntry, ProcessIndex } from '../tenant/state.ts';
import { type DocumentTarget, type PropertiesRead } from './archive.ts';
import {
  afterArchivePhase,
  buildDocumentDeletePlan,
  deletePreviewRows,
  leftArchived,
  NOT_ARCHIVED_ANY_MORE,
  NOT_CONFIRMED,
  putBack,
  runArchivePhase,
  runDeletePhase,
  settleDocumentDelete,
  STILL_ATTACHED,
  type DocumentDeleteGateway,
} from './delete.ts';
import { toDocumentProperties } from './holders.ts';
import type { DocumentEntry } from './list.ts';
import type { ReferenceScan } from './references.ts';
import { CHOSEN_BY_ID, CHOSEN_FROM_TREE, type ChosenDocument } from './select.ts';

const g = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
const d = (n: number) => `20000000-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;
const p = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const INDEX: ProcessIndex = new Map(
  (
    [
      { uniqueId: p(1), name: 'Pay a supplier', isArchived: false, groupId: 1, groupUniqueId: g(1), groupName: 'G', groupExists: true },
      { uniqueId: p(2), name: 'Old payroll', isArchived: true, groupId: 1, groupUniqueId: g(1), groupName: 'G', groupExists: true },
      { uniqueId: p(3), name: 'Close the month', isArchived: false, groupId: 1, groupUniqueId: g(1), groupName: 'G', groupExists: true },
    ] satisfies IndexEntry[]
  ).map((e) => [e.uniqueId.toLowerCase(), e]),
);

function entry(n: number, name: string, more: Partial<DocumentEntry> = {}): DocumentEntry {
  return { documentId: n, uniqueId: d(n), name, primaryGroupUniqueId: g(1), primaryGroupName: 'Group 1', isArchived: false, isPending: false, location: 'Cloud', type: 'PDF', ...more };
}
const chosen = (e: DocumentEntry, how = CHOSEN_FROM_TREE): ChosenDocument => ({ entry: e, chosen: how });

// ------------------------------------------------------------------ planning

test('the plan archives active targets first and deletes archived ones straight away; anything attached, archived or not, is left out', () => {
  const docs = [
    entry(1, 'Active and free'),
    entry(2, 'Archived and free', { isArchived: true }),
    entry(3, 'Archived, held by an archived process', { isArchived: true }),
    entry(4, 'Archived, only in a draft', { isArchived: true }),
    entry(5, 'Used in training'),
    entry(6, 'Pending', { isPending: true }),
  ];
  const raw = (n: number, more: Record<string, unknown> = {}) =>
    toDocumentProperties({ attachedProcesses: [], attachedTrainings: [], isArchived: docs[n - 1]!.isArchived, isPending: docs[n - 1]!.isPending, primaryProcessGroupId: 7, ...more });
  const properties = new Map<string, PropertiesRead>([
    [d(1), raw(1)],
    [d(2), raw(2)],
    [d(3), raw(3, { attachedProcesses: [{ processName: 'Old payroll', processUniqueId: p(2) }] })],
    [d(4), raw(4)],
    [d(5), raw(5, { attachedTrainings: [{ name: 'Induction' }] })],
    [d(6), raw(6)],
  ]);
  // An archived document a draft points at breaks that process just as an active one does (spike).
  const scan: ReferenceScan = {
    holders: [{ uniqueId: p(3), name: 'Close the month', published: false, references: [{ documentId: 4, documentUniqueId: d(4), type: 'Form', text: 'x', path: '', segments: [] }] }],
    unread: [],
    read: 2,
  };
  const plan = buildDocumentDeletePlan({ chosen: docs.map((e) => chosen(e, CHOSEN_BY_ID)), paths: new Map(), properties, scan, index: INDEX });
  assert.deepEqual(plan.toArchive.map((t) => t.name), ['Active and free']);
  assert.deepEqual(plan.alreadyArchived.map((t) => t.name), ['Archived and free']);
  assert.deepEqual(plan.skipped.map((r) => [r.operation, r.status, r.name, r.message]), [
    ['Delete', 'Skipped', 'Archived, held by an archived process', 'Attached to 1 process: Old payroll (archived).'],
    ['Delete', 'Skipped', 'Archived, only in a draft', 'In the unpublished draft of Close the month.'],
    ['Delete', 'Skipped', 'Used in training', 'Used by training unit Induction.'],
    ['Delete', 'Skipped', 'Pending', 'Pending in Process Manager'],
  ]);
  assert.deepEqual(deletePreviewRows(plan).filter((r) => r.status === 'Preview').map((r) => [r.operation, r.message]), [
    ['Delete', 'Would be archived, then permanently deleted'],
    ['Delete', 'Archived already; would be permanently deleted'],
  ]);
});

// ------------------------------------------------------------------ running

interface FakeDoc {
  archived: boolean;
  attached: string[];
  /** Properties reads after which it is attached to Pay a supplier. */
  attachAfter?: number;
  reads: number;
  refuseDelete?: string;
  refuseArchive?: string;
}

/** A tenant in miniature, with the spike's answers: 200 and an `errors` entry per failure. */
function fakeTenant(docs: Record<number, FakeDoc>) {
  const calls: Array<[string, number[]]> = [];
  const bulk = (name: string, ids: number[], each: (doc: FakeDoc) => string | null): DocumentBulkAnswer => {
    calls.push([name, ids]);
    const errors: DocumentBulkAnswer['errors'] = [];
    for (const id of ids) {
      const doc = docs[id];
      const code = doc ? each(doc) : 'NotFound';
      if (code !== null) errors.push({ documentId: id, errorCode: code });
    }
    return { errors };
  };
  const gateway: DocumentDeleteGateway = {
    properties: async (id) => {
      const doc = docs[id]!;
      doc.reads++;
      if (doc.attachAfter !== undefined && doc.reads > doc.attachAfter && doc.attached.length === 0) doc.attached.push(p(1));
      return { isArchived: doc.archived, isPending: false, attachedTrainings: [], attachedProcesses: doc.attached.map((u) => ({ processName: INDEX.get(u)?.name, processUniqueId: u })) };
    },
    archive: async (ids) =>
      bulk('archive', ids, (doc) => {
        if (doc.refuseArchive) return doc.refuseArchive;
        doc.archived = true;
        return null;
      }),
    delete: async (ids) =>
      bulk('delete', ids, (doc) => {
        if (!doc.archived) return 'NotArchived';
        if (doc.refuseDelete) return doc.refuseDelete;
        if (doc.attached.length > 0) return 'ProcessAttachment';
        for (const [k, v] of Object.entries(docs)) if (v === doc) delete docs[Number(k)];
        return null;
      }),
    restore: async (ids) =>
      bulk('restore', ids, (doc) => {
        if (!doc.archived) return 'NotArchived';
        doc.archived = false;
        return null;
      }),
  };
  const index = () => new Map(Object.entries(docs).map(([k, v]) => [d(Number(k)), entry(Number(k), `Doc ${k}`, { isArchived: v.archived })]));
  return { gateway, calls, index };
}

const target = (n: number, more: Partial<DocumentTarget> = {}): DocumentTarget => ({
  documentId: n, uniqueId: d(n), name: `Doc ${n}`, path: [], groupId: 7, groupUniqueId: g(1), isArchived: false, chosen: CHOSEN_FROM_TREE, location: 'Cloud', type: 'PDF', ...more,
});
const fresh = (): FakeDoc => ({ archived: false, attached: [], reads: 0 });

test('a full run: archive, delete, and put back what was archived but not deleted; a refusal inside the 200 is a row', async () => {
  const docs: Record<number, FakeDoc> = {
    1: fresh(), // archived, deleted
    2: { ...fresh(), attachAfter: 2 }, // free at phase 1's re-check, attached by phase 2's
    3: { ...fresh(), refuseDelete: 'ProcessAttachment' }, // the tenant keeps it
    4: { ...fresh(), refuseArchive: 'Locked' }, // never archived, so never deleted
    5: { ...fresh(), archived: true }, // archived before the run, deleted
    6: { ...fresh(), archived: true, refuseDelete: 'Locked' }, // archived before the run, delete refused, left archived
  };
  const t = fakeTenant(docs);
  const plan = buildDocumentDeletePlan({
    chosen: [1, 2, 3, 4, 5, 6].map((n) => chosen(entry(n, `Doc ${n}`, { isArchived: n >= 5 }))),
    paths: new Map(),
    properties: new Map([1, 2, 3, 4, 5, 6].map((n) => [d(n), toDocumentProperties({ isArchived: n >= 5, attachedProcesses: [], attachedTrainings: [] })])),
    scan: { holders: [], unread: [], read: 3 },
    index: INDEX,
  });
  // The plan's own read of each document counts as the first.
  for (const doc of Object.values(docs)) doc.reads = 1;

  const archiveRows = await runArchivePhase(t.gateway, plan, createControls(), { index: INDEX });
  const between = afterArchivePhase(plan, archiveRows, t.index());
  assert.deepEqual(between.archiveRows.map((r) => [r.objectId, r.status]), [[d(1), 'Success'], [d(2), 'Success'], [d(3), 'Success'], [d(4), 'Failed']]);
  assert.deepEqual(between.toDelete.map((x) => x.documentId), [5, 6, 1, 2, 3], 'archived before the run first, then what phase 1 archived; never the one it failed to archive');
  assert.deepEqual(between.archivedByRun.map((x) => x.documentId), [1, 2, 3]);

  const deleteRows = await runDeletePhase(t.gateway, between.toDelete, createControls(), { index: INDEX });
  const del = (n: number) => deleteRows.find((r) => r.objectId === d(n))!;
  assert.deepEqual([del(1).status, del(5).status], ['Success', 'Success']);
  assert.deepEqual([del(2).status, del(2).message], ['Skipped', 'Attached since the plan was built. Attached to 1 process: Pay a supplier.']);
  assert.deepEqual([del(3).status, del(3).message], ['Skipped', STILL_ATTACHED]);
  assert.deepEqual([del(6).status, del(6).message], ['Failed', 'Process Manager refused: Locked']);
  assert.ok(!t.calls.find(([name]) => name === 'delete')![1].includes(2), 'the re-check kept it out of the call');

  const restoreRows = await putBack(t.gateway, between.archivedByRun, deleteRows, createControls(), {});
  assert.deepEqual(restoreRows.map((r) => [r.objectId, r.operation, r.status, r.message]), [
    [d(2), 'Restore', 'Success', 'Put back: this run archived it, and it was not deleted.'],
    [d(3), 'Restore', 'Success', 'Put back: this run archived it, and it was not deleted.'],
  ]);
  assert.equal(docs[6]!.archived, true, 'archived before the run, so left archived');

  const final = settleDocumentDelete([...between.archiveRows, ...deleteRows, ...restoreRows], t.index());
  assert.deepEqual(final.filter((r) => r.status === 'Success').map((r) => `${r.operation} ${r.objectId.slice(-1)}`).sort(), [
    'Archive 1', 'Archive 2', 'Archive 3', 'Delete 1', 'Delete 5', 'Restore 2', 'Restore 3',
  ]);
});

test('a delete the operator does not confirm puts back everything the run archived', async () => {
  const docs: Record<number, FakeDoc> = { 1: { ...fresh(), archived: true }, 2: { ...fresh(), archived: true } };
  const t = fakeTenant(docs);
  const rows = await putBack(t.gateway, [target(1)], [], createControls(), { why: NOT_CONFIRMED });
  assert.deepEqual(rows.map((r) => [r.operation, r.status, r.message]), [['Restore', 'Success', 'Put back: this run archived it, and the delete was not confirmed.']]);
  assert.deepEqual(t.calls, [['restore', [1]]], 'never the one archived before the run');
});

test('the delete re-check leaves out a document someone restored mid-run, and the 200\'s NotArchived and NotFound are rows', async () => {
  const docs: Record<number, FakeDoc> = { 1: fresh(), 2: { ...fresh(), archived: true }, 3: { ...fresh(), archived: true } };
  const t = fakeTenant(docs);
  // 2 is restored between its re-check and the call; 9 is gone.
  const realProps = t.gateway.properties;
  t.gateway.properties = async (id) => {
    const answer = await realProps(id);
    if (id === 2) docs[2]!.archived = false;
    return answer;
  };
  docs[9] = { ...fresh(), archived: true };
  const realDelete = t.gateway.delete;
  t.gateway.delete = async (ids) => {
    delete docs[9];
    return realDelete(ids);
  };
  const rows = await runDeletePhase(t.gateway, [target(1), target(2), target(9)], createControls(), { index: INDEX });
  assert.deepEqual(rows.map((r) => [r.objectId.slice(-1), r.status, r.message]), [
    ['1', 'Skipped', NOT_ARCHIVED_ANY_MORE],
    ['2', 'Failed', 'Process Manager refused: NotArchived'],
    ['9', 'Failed', 'Process Manager refused: NotFound'],
  ]);
  // A NotFound for a document the final read cannot find either: it is gone, which is what was asked.
  const settled = settleDocumentDelete(rows, t.index());
  assert.equal(settled.find((r) => r.objectId === d(9))!.status, 'Success');
  assert.equal(settled.find((r) => r.objectId === d(2))!.status, 'Failed');
});

test('the final read settles delete and restore rows', () => {
  const row = (n: number, operation: string, status: string) => ({
    objectType: 'Document', objectId: d(n), name: `Doc ${n}`, operation, status, message: 'm', groupId: '', statusCode: '',
  });
  const rows = [row(1, 'Delete', 'Success'), row(2, 'Delete', 'Success'), row(3, 'Delete', 'Failed'), row(3, 'Restore', 'Failed'), row(4, 'Restore', 'Success'), row(5, 'Restore', 'Success')];
  const after = new Map([
    [d(2), entry(2, 'Doc 2', { isArchived: true })],
    [d(4), entry(4, 'Doc 4', { isArchived: true })],
  ]);
  assert.deepEqual(settleDocumentDelete(rows as never, after).map((r) => [r.operation, r.status, r.message.slice(0, 40)]), [
    ['Delete', 'Success', 'm'],
    ['Delete', 'Failed', 'Delete reported success, but the documen'],
    ['Delete', 'Success', 'Deleted, confirmed by the final read, al'],
    ['Restore', 'Skipped', 'Not put back: the final read shows the d'],
    ['Restore', 'Failed', 'Restore reported success, but the docume'],
    ['Restore', 'Unverified', 'Restore was accepted, but neither docume'],
  ]);
});

test('a run that dies names what it archived and could not put back', async () => {
  const signedOut = Object.assign(new Error('signed out'), { signedOut: true });
  const docs: Record<number, FakeDoc> = { 1: fresh(), 2: fresh() };
  const t = fakeTenant(docs);
  t.gateway.delete = async () => {
    throw signedOut;
  };
  t.gateway.restore = async () => {
    throw signedOut;
  };
  const archivedByRun = [target(1), target(2)];
  for (const doc of Object.values(docs)) doc.archived = true;
  const controls = createControls();
  const deleteRows = await runDeletePhase(t.gateway, archivedByRun.map((x) => ({ ...x, isArchived: true })), controls, { index: INDEX });
  assert.ok(controls.stopped());
  const restoreRows = await putBack(t.gateway, archivedByRun, deleteRows, createControls(), {});
  assert.deepEqual(leftArchived(archivedByRun, [...deleteRows, ...restoreRows]).map((x) => x.documentId), [1, 2]);
});
