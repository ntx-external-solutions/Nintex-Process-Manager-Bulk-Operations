// W8d: Repair document references. A reference whose document is in neither list is
// dead; one to an archived document is not. The repair removes only what is still dead
// when it saves, publishes what was published, saves into an open draft unless the
// operator ticks it, and reads the process back.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DocumentListPage } from '../pm/documents.ts';
import type { ActiveRead } from '../pm/dependencies.ts';
import {
  deadReferencesIn,
  DRAFT_SAVED_NOTE,
  existingDocuments,
  removeReferences,
  repairProcess,
  scanForDeadReferences,
  stateText,
  type RepairGateway,
  type ScanProcess,
} from './repair.ts';
import { findDocumentReferences } from './references.ts';
import type { DocumentEntry } from './list.ts';

const d = (n: number) => `20000000-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;
const p = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function entry(n: number, archived = false): DocumentEntry {
  return { documentId: n, uniqueId: d(n), name: `Doc ${n}`, primaryGroupUniqueId: null, primaryGroupName: '', isArchived: archived, isPending: false, location: 'Cloud', type: 'PDF' };
}
const item = (n: number, text: string) => ({ Id: n * 10, DocumentId: n, DocumentUniqueId: d(n), Text: text });

/** A model with one activity holding these Forms and Images. */
function model(n: number, version: string, state: number, forms: unknown[], images: unknown[] = []) {
  return {
    UniqueId: p(n),
    Name: `Process ${n}`,
    Version: version,
    ProcessRevisionStateId: state,
    ProcessRevisionEditId: n * 100,
    Objective: 'kept as is',
    ProcessProcedures: { Activity: [{ Id: 1, Text: 'First' }, { Id: 2, Text: 'Second', ChildProcessProcedures: { Form: forms, Image: images } }] },
  };
}

// 1 and 2 exist (2 archived); 7, 8 and 9 do not.
const EXISTING = existingDocuments(new Map([entry(1), entry(2, true)].map((e) => [e.uniqueId, e])));

test('a reference to a document in neither list is dead; one to an archived document is not', () => {
  const dead = deadReferencesIn(model(1, '2.0', 3, [item(1, 'Live'), item(2, 'Archived'), item(7, 'Gone')], [{ DocumentId: 8, Text: 'No GUID' }]), EXISTING);
  assert.deepEqual(dead.map((r) => [r.type, r.text, r.activity]), [['Form', 'Gone', '2'], ['Image', 'No GUID', '2']]);
  assert.equal(stateText('2.0', 3), 'published, version 2.0');
  assert.equal(stateText('1.3', 1), 'open draft 1.3 over version 1.0');
  assert.equal(stateText('0.2', 1), 'draft 0.2, never published');
});

test('the scan lists active processes with a dead reference, reports archived ones apart, and skips the rest', async () => {
  const models: Record<string, ReturnType<typeof model>> = {
    [p(1)]: model(1, '2.0', 3, [item(7, 'Gone')]),
    [p(2)]: model(2, '1.1', 1, [item(1, 'Live')], [item(9, 'Gone from a draft')]),
    [p(3)]: model(3, '1.0', 3, [item(2, 'Archived doc')]),
    [p(5)]: model(5, '3.0', 3, [item(8, 'Gone, archived holder')]),
  };
  const proc = (n: number): ScanProcess => ({ uniqueId: p(n), name: `Process ${n}`, groupUniqueId: null, groupId: 4 });
  const archivedCalls: string[][] = [];
  const archived = [proc(5), ...Array.from({ length: 20 }, (_, i) => proc(60 + i))];
  const scan = await scanForDeadReferences({
    active: [proc(1), proc(2), proc(3), proc(4)],
    archived,
    readModel: async (id): Promise<ActiveRead> => {
      if (id === p(4)) throw new Error('500');
      return { kind: 'model', model: models[id]!, processActions: null };
    },
    readArchivedModels: async (ids) => {
      archivedCalls.push(ids);
      return ids.filter((id) => models[id]).map((id) => models[id]!);
    },
    existing: EXISTING,
  });
  assert.deepEqual(scan.active.map((b) => [b.name, b.version, b.revisionStateId, b.dead.map((r) => r.text)]), [
    ['Process 1', '2.0', 3, ['Gone']],
    ['Process 2', '1.1', 1, ['Gone from a draft']],
  ]);
  assert.deepEqual(scan.archived.map((b) => [b.name, b.archived, b.dead.map((r) => r.text)]), [['Process 5', true, ['Gone, archived holder']]]);
  assert.deepEqual(archivedCalls.map((c) => c.length), [20, 1], 'archived models in batches of 20');
  assert.deepEqual(scan.unread.filter((u) => !u.archived).map((u) => [u.name, u.error]), [['Process 4', '500']]);
  assert.equal(scan.unread.filter((u) => u.archived).length, 20, 'an archived process the batch read did not return is reported as unread');
});

test('removing references takes the items out of their arrays and touches nothing else', () => {
  const before = model(1, '2.0', 3, [item(7, 'Gone'), item(1, 'Live'), item(8, 'Also gone')], [item(9, 'Image gone')]);
  const dead = findDocumentReferences(before).filter((r) => r.documentId !== 1);
  const { model: after, removed } = removeReferences(before, dead);
  assert.equal(removed.length, 3);
  const expected = structuredClone(before);
  expected.ProcessProcedures.Activity[1]!.ChildProcessProcedures!.Form = [item(1, 'Live')];
  expected.ProcessProcedures.Activity[1]!.ChildProcessProcedures!.Image = [];
  assert.deepEqual(after, expected);
  assert.equal(before.ProcessProcedures.Activity[1]!.ChildProcessProcedures!.Form.length, 3, 'the original is not changed');
});

/** A tenant in miniature: saves bump the minor version and leave a draft; a publish makes the next major. */
function fakeTenant(models: Record<string, Record<string, unknown>>, docs: () => DocumentEntry[]) {
  const calls: string[] = [];
  const gateway: RepairGateway = {
    readModel: async (id) => ({ kind: 'model', model: structuredClone(models[id]!), processActions: { CanSave: true, CanPublishAfterEdit: true, CanSubmitForApprovalAfterEdit: true } }),
    saveModel: async (id, envelope) => {
      calls.push(`save ${id.slice(-2)}`);
      const saved = JSON.parse(envelope.ProcessJson) as Record<string, unknown>;
      const [major, minor] = String(saved['Version']).split('.').map(Number);
      models[id] = { ...saved, Version: `${major}.${minor! + 1}`, ProcessRevisionStateId: 1, ProcessRevisionEditId: Number(saved['ProcessRevisionEditId']) + 1 };
    },
    publishNow: async (id) => {
      calls.push(`publish ${id.slice(-2)}`);
      const m = models[id]!;
      models[id] = { ...m, Version: `${Number(String(m['Version']).split('.')[0]) + 1}.0`, ProcessRevisionStateId: 3 };
    },
    list: async (listType): Promise<DocumentListPage> => ({
      items: docs()
        .filter((e) => e.isArchived === (listType === 'Archived'))
        .map((e) => ({ documentId: e.documentId, documentUniqueId: e.uniqueId, documentName: e.name, isArchived: e.isArchived })),
      totalItemCount: null,
    }),
  };
  return { gateway, calls, models };
}

const target = (n: number, models: Record<string, Record<string, unknown>>, publishDraft = false) => ({
  uniqueId: p(n),
  name: `Process ${n}`,
  groupId: 4,
  dead: findDocumentReferences(models[p(n)]).filter((r) => r.documentId !== 1 && r.documentId !== 2),
  publishDraft,
});

test('a published process is saved and published; the read-back confirms nothing dead is left', async () => {
  const t = fakeTenant({ [p(1)]: model(1, '2.0', 3, [item(7, 'Gone'), item(2, 'Archived doc')]) }, () => [entry(1), entry(2, true)]);
  const row = await repairProcess(t.gateway, target(1, t.models));
  assert.deepEqual([row.objectType, row.operation, row.status], ['Process', 'RepairDocumentReference', 'Success']);
  assert.equal(row.message, "Removed 1 dead reference (Form 'Gone' in activity 2 (document 7)). Saved and published as version 3.0.");
  assert.deepEqual(t.calls, ['save 01', 'publish 01']);
  assert.equal(findDocumentReferences(t.models[p(1)]).length, 1, 'the reference to the archived document is kept');
});

test('an open draft is saved into, not published, by default; ticked, it is published with the repair', async () => {
  const t = fakeTenant({ [p(2)]: model(2, '1.1', 1, [item(9, 'Gone')]), [p(3)]: model(3, '1.4', 1, [item(9, 'Gone')]) }, () => [entry(1)]);
  const kept = await repairProcess(t.gateway, target(2, t.models));
  assert.equal(kept.status, 'Success');
  assert.equal(kept.message, `Removed 1 dead reference (Form 'Gone' in activity 2 (document 9)). ${DRAFT_SAVED_NOTE}. Saved as version 1.2.`);
  const ticked = await repairProcess(t.gateway, target(3, t.models, true));
  assert.match(ticked.message, /Saved and published as version 2\.0, with the open draft’s other changes\.$/);
  assert.deepEqual(t.calls, ['save 02', 'save 03', 'publish 03']);
});

test('a document that reappears between the scan and the save is left alone; with nothing left dead, nothing is saved', async () => {
  let docs = [entry(1)];
  const t = fakeTenant({ [p(1)]: model(1, '2.0', 3, [item(7, 'Back again'), item(8, 'Still gone')]), [p(4)]: model(4, '1.0', 3, [item(7, 'Back again')]) }, () => docs);
  const both = target(1, t.models);
  const only = target(4, t.models);
  docs = [entry(1), entry(7)];
  const row = await repairProcess(t.gateway, both);
  assert.match(row.message, /^Removed 1 dead reference \(Form 'Still gone'/);
  assert.match(row.message, /1 left alone, because its document exists again: Form 'Back again' in activity 2 \(document 7\)\.$/);
  assert.equal(findDocumentReferences(t.models[p(1)]).map((r) => r.text).join(), 'Back again');
  const none = await repairProcess(t.gateway, only);
  assert.deepEqual([none.status, none.message.slice(0, 54)], ['Skipped', 'No dead reference is left, so nothing was changed. 1 l']);
  assert.deepEqual(t.calls, ['save 01', 'publish 01'], 'the second process was never saved');
});

test('awaiting approval is left alone; a read-back that still has a dead reference is a failure', async () => {
  const t = fakeTenant({ [p(6)]: model(6, '1.1', 2, [item(9, 'Gone')]), [p(1)]: model(1, '2.0', 3, [item(9, 'Gone')]) }, () => [entry(1)]);
  const pending = await repairProcess(t.gateway, target(6, t.models));
  assert.equal(pending.status, 'Skipped');
  assert.match(pending.message, /awaiting approval/);
  // A save the tenant takes but does not apply.
  const original = t.gateway.saveModel;
  t.gateway.saveModel = async (id, envelope) => {
    const keep = structuredClone(t.models[id]!);
    await original(id, envelope);
    t.models[id] = { ...t.models[id]!, ProcessProcedures: keep['ProcessProcedures'] };
  };
  const stuck = await repairProcess(t.gateway, target(1, t.models));
  assert.equal(stuck.status, 'Failed');
  assert.match(stuck.message, /^Saved, but the read-back still has 1 dead reference/);
});
