// W8c: Restore documents. Not archived and a missing group keep a document out; the
// restore's 200 carries its failures in `errors`; and a results file of Archive or Delete
// documents feeds back in as the documents its run left archived.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createControls } from '../exec/runner.ts';
import type { DocumentBulkAnswer } from '../pm/documents.ts';
import { afterFileRead, EMPTY_ID_INPUT, targetsFromCsv } from '../select/ids.ts';
import type { PropertiesRead } from './archive.ts';
import { toDocumentProperties } from './holders.ts';
import type { DocumentEntry } from './list.ts';
import {
  buildDocumentRestorePlan,
  checkGroupsExist,
  GROUP_GONE,
  GROUP_UNKNOWN,
  NOT_ARCHIVED,
  restorePreviewRows,
  runDocumentRestore,
  settleDocumentRestore,
} from './restore.ts';
import { CHOSEN_FROM_ARCHIVED, type ChosenDocument } from './select.ts';

const g = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
const d = (n: number) => `20000000-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;

function entry(n: number, more: Partial<DocumentEntry> = {}): DocumentEntry {
  return { documentId: n, uniqueId: d(n), name: `Doc ${n}`, primaryGroupUniqueId: g(1), primaryGroupName: 'Group 1', isArchived: true, isPending: false, location: 'Cloud', type: 'PDF', ...more };
}
const chosen = (e: DocumentEntry): ChosenDocument => ({ entry: e, chosen: CHOSEN_FROM_ARCHIVED });
const props = (archived: boolean): PropertiesRead => toDocumentProperties({ isArchived: archived, attachedProcesses: [{ processName: 'Held', processUniqueId: d(99) }], primaryProcessGroupId: 7 });

test('the plan restores archived documents whose group exists, attachments or not; not archived and a missing group are left out', () => {
  const docs = [entry(1), entry(2, { isArchived: false }), entry(3, { primaryGroupUniqueId: g(2) }), entry(4, { primaryGroupUniqueId: g(3) }), entry(5, { primaryGroupUniqueId: null }), entry(6)];
  const properties = new Map<string, PropertiesRead>([
    [d(1), props(true)],
    [d(2), props(false)],
    [d(3), props(true)],
    [d(4), props(true)],
    [d(5), props(true)],
    [d(6), { error: '500' }],
  ]);
  const groups = new Map<string, boolean | { error: string }>([
    [g(1), true],
    [g(2), false],
    [g(3), { error: 'timeout' }],
  ]);
  const plan = buildDocumentRestorePlan({ chosen: docs.map(chosen), paths: new Map([[g(1), ['Finance', 'Forms']]]), properties, groups });
  assert.deepEqual(plan.targets.map((t) => [t.name, t.path.join(' / '), t.groupId]), [['Doc 1', 'Finance / Forms', 7]], 'attached, and restored anyway: restoring is always safe');
  assert.deepEqual(plan.skipped.map((r) => [r.name, r.operation, r.status, r.message.slice(0, 40)]), [
    ['Doc 2', 'Restore', 'Skipped', NOT_ARCHIVED],
    ['Doc 3', 'Restore', 'Skipped', GROUP_GONE],
    ['Doc 4', 'Restore', 'Skipped', 'Could not check that its group still exi'],
    ['Doc 5', 'Restore', 'Skipped', GROUP_UNKNOWN.slice(0, 40)],
    ['Doc 6', 'Restore', 'Skipped', 'Could not read it (500), so it is not re'],
  ]);
  assert.deepEqual(restorePreviewRows(plan).map((r) => r.status), ['Skipped', 'Skipped', 'Skipped', 'Skipped', 'Skipped', 'Preview']);
});

test('a group whose breadcrumb comes back empty is gone; a failed read is unknown; a dead session ends the check', async () => {
  const crumbs: Record<string, string[] | Error> = { [g(1)]: ['Finance'], [g(2)]: [], [g(3)]: new Error('timeout') };
  const breadcrumb = async (id: string) => {
    const answer = crumbs[id]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const checked = await checkGroupsExist([g(1), g(2), g(3), g(1).toUpperCase()], breadcrumb, { errorText: (e) => (e as Error).message });
  assert.deepEqual([...checked], [[g(1), true], [g(2), false], [g(3), { error: 'timeout' }]]);
  const signedOut = Object.assign(new Error('signed out'), { signedOut: true });
  await assert.rejects(
    checkGroupsExist([g(1)], async () => {
      throw signedOut;
    }, { isFatal: (e) => (e as { signedOut?: boolean }).signedOut === true }),
    /signed out/,
  );
});

test('the run sends batches of up to 50 with no re-check, and every errors entry in the 200 is a row; the final read settles them', async () => {
  const sent: number[][] = [];
  let reads = 0;
  const gateway = {
    properties: async () => {
      reads++;
      return {};
    },
    restore: async (ids: number[]): Promise<DocumentBulkAnswer> => {
      sent.push(ids);
      return { errors: ids.includes(2) ? [{ documentId: 2, errorCode: 'NotArchived' }, { documentId: 3, errorCode: 'NotFound' }] : [] };
    },
  };
  const targets = Array.from({ length: 51 }, (_, i) =>
    buildDocumentRestorePlan({ chosen: [chosen(entry(i + 1))], paths: new Map(), properties: new Map([[d(i + 1), props(true)]]), groups: new Map([[g(1), true]]) }).targets[0]!,
  );
  const rows = await runDocumentRestore(gateway, targets, createControls(), {});
  assert.deepEqual(sent.map((b) => b.length), [50, 1]);
  assert.equal(reads, 0, 'attachments do not matter, so nothing is re-read');
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.operation, r.status, r.message]), [
    ['Restore', 'Success', 'Restored.'],
    ['Restore', 'Failed', 'Process Manager refused: NotArchived'],
    ['Restore', 'Failed', 'Process Manager refused: NotFound'],
  ]);
  const after = new Map([
    [d(1), entry(1, { isArchived: false })],
    [d(2), entry(2, { isArchived: false })],
    [d(4), entry(4, { isArchived: true })],
  ]);
  assert.deepEqual(settleDocumentRestore(rows.slice(0, 5), after).map((r) => [r.status, r.message.slice(0, 30)]), [
    ['Success', 'Restored.'],
    ['Success', 'Restored, confirmed by the fin'],
    ['Failed', 'Process Manager refused: NotFo'],
    ['Failed', 'Restore reported success, but '],
    ['Unverified', 'Restore was accepted, but neit'],
  ]);
});

test('a Delete documents results file fed back in gives only the documents its run archived and left archived', () => {
  const file = [
    '"ObjectType","ObjectID","Name","Operation","Status","Message","GroupId","StatusCode"',
    `"Document","${d(1)}","Archived then kept","Archive","Success","Archived.","7",""`,
    `"Document","${d(1)}","Archived then kept","Delete","Skipped","Not attempted: stopped","7",""`,
    `"Document","${d(2)}","Archived then deleted","Archive","Success","Archived.","7",""`,
    `"Document","${d(2)}","Archived then deleted","Delete","Success","Deleted.","7",""`,
    `"Document","${d(3)}","Archived then put back","Archive","Success","Archived.","7",""`,
    `"Document","${d(3)}","Archived then put back","Restore","Success","Put back","7",""`,
    `"Document","${d(4)}","Archived before the run","Delete","Failed","Process Manager refused: Locked","7",""`,
    `"Document","${d(5)}","Held","Delete","Skipped","Attached to 1 process: A.","7",""`,
  ].join('\r\n');
  const read = targetsFromCsv(file, { onlyArchivedByRun: true });
  assert.deepEqual(read.ids, [d(1)]);
  assert.equal(read.resultsLeftOut, 4);
  const box = afterFileRead(EMPTY_ID_INPUT, 'document-delete-results.csv', file, 'restore');
  assert.equal(box.text, d(1));
  assert.match(box.note!, /4 document\(s\) left out: from a results file, only documents its run archived and did not delete or put back are taken/);

  // The other pages read every id, as before.
  assert.equal(targetsFromCsv(file).ids.length, 5);
  // A plain list of ids is not a results file, so nothing is left out.
  assert.deepEqual(targetsFromCsv(`DocumentID\r\n${d(4)}\r\n`, { onlyArchivedByRun: true }).ids, [d(4)]);
  // A results file in which nothing was archived by the run says so and leaves the box alone.
  const none = afterFileRead({ ...EMPTY_ID_INPUT, text: 'kept' }, 'f.csv', [file.split('\r\n')[0], file.split('\r\n')[7]].join('\r\n'), 'restore');
  assert.equal(none.text, 'kept');
  assert.match(none.note!, /no document was archived by its run and left archived/);
});
