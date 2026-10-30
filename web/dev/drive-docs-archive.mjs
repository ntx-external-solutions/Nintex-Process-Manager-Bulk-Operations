// Archive documents (W8a) against the mock: check Library in the tree (groups only), tick
// the document only associated with it, tick a document from the list, upload a CSV of
// ids, build the plan, run it, and check the rows.
// Expect: the plan archives Free notes, Late attachment, Refused by tenant and Shared
// template from the tree and Supplier link from the list; it leaves out the document
// attached to an active process, the one attached to an archived process, the training
// unit's, the one only in a process's open draft, the pending one, the archived one from
// the file, and two ids that match nothing. In the run, Late attachment is dropped by its
// batch's re-check (attached since the plan), Refused by tenant fails inside a 200, and
// the other three are archived. Skipped rows at the top of the results.
// Restart the mock first: this changes its state.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const csv = join(mkdtempSync(join(tmpdir(), 'docs-archive-')), 'document-ids.csv');
// Excel's way: a BOM, CRLF and quoted cells.
writeFileSync(
  csv,
  '﻿' +
    [
      '"ObjectType","ObjectID","Name"',
      `"Document","${id(206)}","Pending memo.docx"`,
      `"Document","211","Archived manual.pdf"`,
      `"Document","${UNKNOWN}","Gone"`,
      `"Document","Expense-form.docx","By name"`,
      `"Document","${id(205)}","Free notes.txt"`,
    ].join('\r\n') +
    '\r\n',
);

const fail = (what) => {
  console.error(`FAIL: ${what}`);
  process.exitCode = 1;
};
const expect = (ok, what) => (ok ? console.log(`ok: ${what}`) : fail(what));

const b = await connect();
await b.signIn();
await b.go('/documents/archive', `!!document.querySelector('input[aria-label="Select Library"]')`, 'tree');
expect(!(await b.js(`!!document.querySelector('input[aria-label="Select Outright"]')`)), 'the tree shows groups only');
expect(await b.js(`[...document.querySelectorAll('nav a')].some((a) => a.textContent.includes('Archive documents'))`), 'Archive documents is in the side nav');
await b.js(`$check('Select Library')`);
await b.js(`$btn('Preview what would be archived')`);
await b.until(`document.body.innerText.includes('Only associated with a checked group')`, 'the associated-only list');
const treePanel = await b.js(`document.body.innerText`);
expect(/hold 8 active documents as their primary group/.test(treePanel), 'eight documents in Library and Manuals as their primary group');
expect(/Shared template\.docx\s+\(primary group: Shared\)/.test(treePanel), 'the associated-only document, labelled with its primary group');
await b.js(`$check('Include document Shared template.docx')`);

await b.js(`$btn('From the document list')`);
await b.until(`!!document.querySelector('input[aria-label="Select document Supplier link"]')`, 'the document list');
const listText = await b.js(`document.querySelector('table.plan').innerText`);
expect(/Supplier link\s+Shared\s+External link/.test(listText), 'the list shows group, location');
await b.js(`$check('Select document Supplier link'); $check('Select document Free notes.txt'); true`);

await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids-file input[type=file]')`, 'the CSV upload');
expect(await b.js(`document.body.innerText.includes('a number is a document id, never a process id')`), 'the box says a number is a document id');
expect(await b.js(`!!document.querySelector('a[download="document-ids-template.csv"]')`), 'a document template link');
await b.upload('#ids-file input[type=file]', csv);
await b.until(`document.body.innerText.includes('document-ids.csv:')`, 'file read');

await b.js(`$btn('Preview what would be archived')`);
await b.until(`document.body.innerText.includes('Would be archived')`, 'plan');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
const plan = await b.js(`document.querySelector('table.plan').innerText`);
console.log('--- PLAN ---\n' + plan);
const leftOut = await b.js(`[...document.querySelectorAll('details.panel')].map((d) => d.innerText).join('\\n')`);
console.log('--- LEFT OUT ---\n' + leftOut);
expect(/Free notes\.txt\s+Library \/ Manuals\s+TXT\s+Cloud\s+From the tree/.test(plan), 'Free notes from the tree, once');
expect(/Shared template\.docx\s+Shared\s+DOCX\s+Cloud\s+From the tree/.test(plan), 'the ticked associated-only document');
expect(/Supplier link\s+Shared\s+\s*External link\s+From the document list/.test(plan), 'Supplier link from the list');
expect(plan.includes('Late attachment.pdf') && plan.includes('Refused by tenant.pdf'), 'the two that fail later are free at plan time');
expect((plan.match(/\n/g) ?? []).length === 5, 'five documents would be archived');
expect(leftOut.includes('Payables checklist.xlsx: Attached to 1 process: Disabled owner.'), 'attached to an active process');
expect(leftOut.includes('Retired guide.pdf: Attached to 1 process: Old retired step (archived).'), 'attached to an archived process');
expect(leftOut.includes('Training handout.pdf: Used by training unit Induction.'), 'used by a training unit');
expect(leftOut.includes('Draft-only form.docx: In the unpublished draft of Needs approval.'), 'only in a draft, found by the scan');
expect(leftOut.includes('Pending memo.docx: Pending in Process Manager'), 'pending');
expect(leftOut.includes('Archived manual.pdf: Already archived'), 'archived, by its numeric id');
expect(leftOut.includes(`${UNKNOWN}: Document not found`) && leftOut.includes('Expense-form.docx: Not a document id'), 'ids that match nothing');
expect(await b.js(`document.body.innerText.includes('a draft reference added while the run is going is not caught')`), 'the plan says a mid-run draft reference is not caught');

await b.js(`$btn('Archive 5 documents')`);
await b.js(`$btn('Yes, archive')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
const rowOf = (n) => rows.find((r) => r.includes(id(n))) ?? '';
expect(rows.slice(0, 2).every((r) => r.includes('"Resolve","Skipped"')), 'the ids that matched nothing are the first rows');
expect(rows.findIndex((r) => r.includes('"Success"')) > rows.findLastIndex((r) => r.includes(`"Archive","Skipped","Attached to`)), 'the plan’s Skipped rows come before the run’s');
for (const n of [205, 209, 210]) expect(/^"Document",.*"Archive","Success","Archived\."/.test(rowOf(n)), `${id(n)} archived`);
expect(/"Archive","Skipped","Attached since the plan was built\. Attached to 1 process: Outright\."/.test(rowOf(207)), 'the re-check drops the late attachment');
expect(/"Archive","Failed","Process Manager refused: Locked"/.test(rowOf(208)), 'the refusal inside a 200 is a Failed row');
expect(rows.every((r) => r.startsWith('"Document"')), 'every row is about a document');

const writes = (await b.sent()).filter((l) => l.includes('bulk/archive'));
console.log('--- bulk/archive calls ---\n' + writes.join('\n'));
expect(writes.length === 1 && !writes[0].includes('207') && /"documentIds":\[205,208,209,210\]/.test(writes[0].replace(/\s/g, '')), 'one batch, without the late attachment');
b.close();
