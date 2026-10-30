// Restore documents (W8c) against the mock: tick three archived documents from the
// archived list, upload a Delete documents results file, build the plan, restore.
// Expect: from the file, only Run archived (archived by its run and left archived) and
// Expense form (archived by its run, active again now) are taken; the rest of the file is
// left out by the note. The plan restores Archived manual, Restore refused and Run
// archived, and leaves out Orphan archive (its group is gone) and Expense form (not
// archived). In the run, Restore refused fails inside a 200 and the other two are
// restored, confirmed by the final read. Restart the mock first: this changes its state.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const csv = join(mkdtempSync(join(tmpdir(), 'docs-restore-')), 'document-delete-results.csv');
// A Delete documents run that stopped after its archive phase.
writeFileSync(
  csv,
  '﻿' +
    [
      '"ObjectType","ObjectID","Name","Operation","Status","Message","GroupId","StatusCode"',
      `"Document","${id(220)}","Run archived.pdf","Archive","Success","Archived.","909",""`,
      `"Document","${id(220)}","Run archived.pdf","Delete","Skipped","Not attempted: Your session ended.","909",""`,
      `"Document","${id(100)}","Expense form.docx","Archive","Success","Archived.","905",""`,
      `"Document","${id(212)}","Obsolete form.docx","Archive","Success","Archived.","910",""`,
      `"Document","${id(212)}","Obsolete form.docx","Delete","Success","Deleted.","910",""`,
      `"Document","${id(215)}","Locked archive.pdf","Delete","Failed","Process Manager refused: Locked","910",""`,
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
await b.go('/documents/restore', `!!document.querySelector('[role=tablist]')`, 'restore page');
expect(await b.js(`[...document.querySelectorAll('nav a')].some((a) => a.textContent.includes('Restore documents'))`), 'Restore documents is in the side nav');
expect(!(await b.js(`[...document.querySelectorAll('[role=tab]')].some((t) => t.textContent.includes('From the tree'))`)), 'no tree tab');
await b.js(`$btn('From the archived list')`);
await b.until(`!!document.querySelector('input[aria-label="Select archived document Orphan archive.pdf"]')`, 'the archived list');
await b.js(`$check('Select archived document Archived manual.pdf'); $check('Select archived document Restore refused.pdf'); $check('Select archived document Orphan archive.pdf'); true`);

await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids-file input[type=file]')`, 'the CSV upload');
await b.upload('#ids-file input[type=file]', csv);
await b.until(`document.body.innerText.includes('document-delete-results.csv:')`, 'file read');
const note = await b.js(`document.body.innerText`);
expect(/2 id\(s\) found/.test(note) && /2 document\(s\) left out: from a results file, only documents its run archived and did not delete or put back are taken/.test(note), 'the file gives only what its run left archived');
expect((await b.js(`document.querySelector('#ids').value`)).split('\n').length === 2, 'two ids in the box');

await b.js(`$btn('Preview what would be restored')`);
await b.until(`document.body.innerText.includes('Check the plan')`, 'plan');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
const plan = await b.js(`document.querySelector('main').innerText`);
console.log('--- PLAN ---\n' + plan);
expect(/3 documents would be restored/.test(plan), 'three to restore');
expect(/Archived manual\.pdf\s+Library \/ Manuals\s+PDF\s+Cloud\s+From the archived list/.test(plan), 'back to its group, from the archived list');
expect(/Run archived\.pdf\s+Shared\s+PDF\s+Cloud\s+From document-delete-results\.csv/.test(plan), 'the run’s archived document, from the file');
expect(plan.includes('Orphan archive.pdf: Its group no longer exists'), 'a missing group is left out');
expect(plan.includes('Expense form.docx: Not archived'), 'an active document is left out');

await b.js(`$btn('Restore 3 documents')`);
await b.js(`$btn('Yes, restore 3 documents now')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
const rowOf = (n) => rows.find((r) => r.includes(id(n))) ?? '';
for (const n of [211, 220]) expect(/"Restore","Success","Restored\."/.test(rowOf(n)), `${n} restored`);
expect(/"Restore","Failed","Process Manager refused: Locked"/.test(rowOf(219)), 'a refusal inside a 200 is Failed');
expect(/"Restore","Skipped","Its group no longer exists"/.test(rowOf(218)), 'the orphan has a Skipped row');
expect(/"Restore","Skipped","Not archived"/.test(rowOf(100)), 'the active one has a Skipped row');
const writes = (await b.sent()).filter((l) => l.includes('bulk/restore'));
console.log('--- bulk/restore calls ---\n' + writes.join('\n'));
expect(writes.length === 1 && /"documentIds":\[211,219,220\]/.test(writes[0].replace(/\s/g, '')), 'one batch of three');
expect((await b.sent()).filter((l) => /\/documents\/\d+\/properties/.test(l)).length === 5, 'properties read once per chosen document, no re-check');
b.close();
