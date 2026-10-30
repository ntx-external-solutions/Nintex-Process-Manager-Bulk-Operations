// Delete documents (W8b) against the mock: check Old forms and Spent in the tree (groups
// only), leave the archived document only associated with Old forms unticked, tick an
// archived document from the archived list, upload a CSV of two held documents, build the
// plan, archive, confirm with a typed DELETE, delete, and offer the cleanup.
// Expect: phase 1 archives Obsolete form, Late holder and Tenant keeps; phase 2 deletes
// those and Locked archive, Spent sheet and Archived manual. Late holder is dropped by the
// delete's re-check (attached since the plan) and Tenant keeps is refused inside a 200
// (ProcessAttachment), so both are Skipped and put back with Restore rows. Locked archive
// fails inside a 200 and, archived before the run, is left archived. Retired guide (held by
// an archived process) and Draft-only form (in a draft) are left out. The cleanup deletes
// Spent and keeps Old forms, which the archived Borrowed archive is associated with.
// Restart the mock first: this changes its state.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const csv = join(mkdtempSync(join(tmpdir(), 'docs-delete-')), 'document-ids.csv');
writeFileSync(csv, `DocumentID\r\n202\r\n${id(204)}\r\n`);

const fail = (what) => {
  console.error(`FAIL: ${what}`);
  process.exitCode = 1;
};
const expect = (ok, what) => (ok ? console.log(`ok: ${what}`) : fail(what));

const b = await connect();
await b.signIn();
await b.go('/documents/delete', `!!document.querySelector('input[aria-label="Select Old forms"]')`, 'tree');
expect(await b.js(`[...document.querySelectorAll('nav a')].some((a) => a.textContent.includes('Delete documents'))`), 'Delete documents is in the side nav');
await b.js(`$check('Select Old forms'); $check('Select Spent'); true`);
await b.js(`$btn('Preview what would be deleted')`);
await b.until(`document.body.innerText.includes('Only associated with a checked group')`, 'the associated-only list');
const treePanel = await b.js(`document.body.innerText`);
expect(/hold 5 documents as their primary group \(2 archived\)/.test(treePanel), 'five documents, two archived, in Old forms and Spent');
expect(/Borrowed archive\.pdf \(archived\)/.test(treePanel), 'the archived associated-only document, left unticked');

await b.js(`$btn('From the archived list')`);
await b.until(`!!document.querySelector('input[aria-label="Select archived document Archived manual.pdf"]')`, 'the archived list');
expect(await b.js(`document.body.innerText.includes('Library / Manuals')`), 'the archived list is bucketed by group path');
await b.js(`$check('Select archived document Archived manual.pdf')`);

await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids-file input[type=file]')`, 'the CSV upload');
await b.upload('#ids-file input[type=file]', csv);
await b.until(`document.body.innerText.includes('document-ids.csv:')`, 'file read');

await b.js(`$btn('Preview what would be deleted')`);
await b.until(`document.body.innerText.includes('Check the plan')`, 'plan');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
const plan = await b.js(`document.querySelector('main').innerText`);
console.log('--- PLAN ---\n' + plan);
expect(/Phase 1: archived, then deleted \(3\)/.test(plan), 'three active documents archived first');
expect(/Phase 2: already archived, deleted \(3\)/.test(plan), 'three archived documents');
expect(/Archived manual\.pdf\s+Library \/ Manuals\s+PDF\s+Cloud\s+From the archived list/.test(plan), 'Archived manual from the archived list');
expect(plan.includes('Retired guide.pdf: Attached to 1 process: Old retired step (archived).'), 'held by an archived process');
expect(plan.includes('Draft-only form.docx: In the unpublished draft of Needs approval.'), 'only in a draft, found by the scan');
expect(!plan.includes('Borrowed archive'), 'the unticked associated-only document is not in the plan');

await b.js(`$btn('Archive 3 documents, then confirm the delete')`);
await b.js(`$btn('Yes, archive 3 documents')`);
await b.until(`document.body.innerText.includes('Type DELETE to delete them')`, 'the confirmation');
const confirm = await b.js(`document.querySelector('main').innerText`);
console.log('--- CONFIRM ---\n' + confirm);
expect(/Permanently delete 6 documents/.test(confirm), 'six named for deletion');
expect(await b.js(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('permanently')).disabled`), 'the delete waits for the typed DELETE');
expect(confirm.includes("Don't delete; put back the 3 documents this run archived"), 'a way out that puts back');
const beforeDelete = (await b.sent()).filter((l) => /^DELETE .*documents\/bulk/.test(l));
expect(beforeDelete.length === 0, 'nothing deleted before the confirmation');
await b.js(`$set('#typed', 'DELETE'); true`);
await b.js(`$btn('Delete 6 documents permanently')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');

const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
const rowOf = (n, op) => rows.find((r) => r.includes(id(n)) && r.includes(`"${op}"`)) ?? '';
for (const n of [212, 213, 214]) expect(/"Archive","Success"/.test(rowOf(n, 'Archive')), `${n} archived in phase 1`);
for (const n of [212, 217, 211]) expect(/"Delete","Success","Deleted\."/.test(rowOf(n, 'Delete')), `${n} deleted`);
expect(/"Delete","Skipped","Attached since the plan was built\. Attached to 1 process: Elsewhere\."/.test(rowOf(213, 'Delete')), 'the delete re-check drops the late holder');
expect(/"Delete","Skipped","Process Manager refused: still attached"/.test(rowOf(214, 'Delete')), 'ProcessAttachment inside a 200 is Skipped');
expect(/"Delete","Failed","Process Manager refused: Locked"/.test(rowOf(215, 'Delete')), 'a refusal inside a 200 is Failed');
for (const n of [213, 214]) expect(/"Restore","Success","Put back: this run archived it, and it was not deleted\."/.test(rowOf(n, 'Restore')), `${n} put back`);
expect(rowOf(215, 'Restore') === '', 'archived before the run, so not restored');
expect(/"Delete","Skipped","Attached to 1 process: Old retired step \(archived\)\."/.test(rowOf(202, 'Delete')), 'the held document has a Skipped row');
expect(rows.every((r) => r.startsWith('"Document"')), 'every row is about a document');

const deletes = (await b.sent()).filter((l) => /^DELETE .*documents\/bulk/.test(l));
console.log('--- bulk delete calls ---\n' + deletes.join('\n'));
expect(deletes.length === 1 && /"documentIds":\[215,217,211,212,214\]/.test(deletes[0].replace(/\s/g, '')), 'one batch, without the late holder');

await b.until(`document.body.innerText.includes('Delete the groups this emptied')`, 'the cleanup offer');
await b.js(`$btn('Check which groups are empty')`);
await b.until(`document.body.innerText.includes('would be deleted') || document.body.innerText.includes('None of the groups')`, 'the cleanup review');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
const review = await b.js(`[...document.querySelectorAll('h2')].find((h) => h.textContent.startsWith('4.')).parentElement.innerText`);
console.log('--- CLEANUP REVIEW ---\n' + review);
expect(/1 group would be deleted/.test(review) && review.includes('Spent'), 'Spent would be deleted');
expect(review.includes('Old forms') && review.includes("'Borrowed archive.pdf (archived)'"), 'Old forms counts the archived document only associated with it');
await b.js(`[...document.querySelectorAll('label.inline input')].find((i) => i.closest('.panel')).click(); true`);
await b.js(`$btn('Delete 1 group')`);
await b.until(`/\\d+ groups? deleted, \\d+ kept/.test(document.body.innerText)`, 'the cleanup to finish');
const groupDeletes = (await b.sent()).filter((l) => l.includes('DeleteGroup'));
expect(groupDeletes.length === 1 && groupDeletes[0].includes(id(911)), 'only Spent was sent for deletion');
b.close();
