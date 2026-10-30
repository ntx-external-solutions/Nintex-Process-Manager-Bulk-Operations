// Repair document references (W8d) against the mock: scan, tick the three active
// processes with dead references (leaving the open draft's publish box unticked), repair.
// Expect: the scan lists Outright (published), Needs approval (open draft over 1.0) and
// Elsewhere, and reports Archived input apart with no box. Outright's reference to an
// archived document is not dead. In the run, Outright and Elsewhere are saved and
// published; Needs approval is saved into its draft and not published; Elsewhere's form,
// whose document reappeared after the scan, is left alone. Restart the mock first: this
// changes its state.

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const fail = (what) => {
  console.error(`FAIL: ${what}`);
  process.exitCode = 1;
};
const expect = (ok, what) => (ok ? console.log(`ok: ${what}`) : fail(what));

const b = await connect();
await b.signIn();
await b.go('/documents/repair', `document.body.innerText.includes('Scan for dead references')`, 'repair page');
expect(await b.js(`[...document.querySelectorAll('nav a')].some((a) => a.textContent.includes('Repair document references'))`), 'Repair document references is in the side nav');
await b.js(`$btn('Scan for dead references')`);
await b.until(`document.body.innerText.includes('What the scan found')`, 'the scan');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
const found = await b.js(`document.querySelector('main').innerText`);
console.log('--- FOUND ---\n' + found);
expect(/3 active processes and 1 archived process point at a document that no\s+longer exists/.test(found), 'three active, one archived');
expect(/Outright\s+Finance · published, version 2\.0\s+Image 'Deleted diagram' in activity 1 \(document 230\)/.test(found), 'Outright, published, with its dead image');
expect(!found.includes("Form 'Old policy'"), 'a reference to an archived document is not dead');
expect(/Needs approval\s+Finance · open draft 1\.1 over version 1\.0\s+Image 'Deleted chart'/.test(found), 'Needs approval, an open draft');
expect(/Elsewhere[\s\S]*Form 'Reappeared form' in activity 1 \(document 232\)[\s\S]*Image 'Deleted photo'/.test(found), 'Elsewhere, with both its missing documents');
expect(/Archived input\s+Other · archived, version 1\.0\s+Image 'Deleted logo' \(document 234\)/.test(found), 'the archived process is reported');
expect(!(await b.js(`!!document.querySelector('input[aria-label="Repair Archived input"]')`)), 'the archived process is not offered');
expect(await b.js(`!!document.querySelector('input[aria-label="Publish the draft of Needs approval"]')`), 'the open draft has a publish box');
expect(!(await b.js(`!!document.querySelector('input[aria-label="Publish the draft of Outright"]')`)), 'a published process has none');
expect((await b.sent()).every((l) => !/^(PUT|POST) .*\/Api\/v1\/Processes/.test(l)), 'the scan wrote nothing');

await b.js(`$check('Tick every active process')`);
await b.js(`$btn('Repair 3 processes')`);
await b.js(`$btn('Yes, repair 3 processes now')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
const rowOf = (n) => rows.find((r) => r.includes(id(n))) ?? '';
expect(rows.length === 3 && rows.every((r) => r.startsWith('"Process"') && r.includes('"RepairDocumentReference"')), 'one RepairDocumentReference row per process');
expect(/"Success","Removed 1 dead reference \(Image 'Deleted diagram' in activity 1 \(document 230\)\)\. Saved and published as version 3\.0\."/.test(rowOf(1)), 'Outright saved and published');
expect(/"Success","Removed 1 dead reference \(Image 'Deleted chart'.*\)\. Saved into the open draft; publish it in Process Manager when the draft’s owner is ready\. Saved as version 1\.2\."/.test(rowOf(2)), 'Needs approval saved into its draft, not published');
expect(/Removed 1 dead reference \(Image 'Deleted photo'.*Saved and published as version 2\.0\. 1 left alone, because its document exists again: Form 'Reappeared form'/.test(rowOf(5)), 'Elsewhere repaired, the reappeared form left alone');

const writes = (await b.sent()).filter((l) => /^(PUT|POST) .*\/Api\/v1\/Processes/.test(l));
console.log('--- process writes ---\n' + writes.map((w) => w.slice(0, 120)).join('\n'));
expect(writes.filter((w) => w.startsWith('PUT')).length === 3, 'three saves');
const publishes = writes.filter((w) => w.includes('/Publish'));
expect(publishes.length === 2 && !publishes.some((w) => w.includes(id(2))), 'two publishes, never the open draft');
const saved = writes.find((w) => w.startsWith(`PUT /Api/v1/Processes/${id(5)}`)) ?? '';
expect(saved.includes('Reappeared form') && !saved.includes('Deleted photo') && saved.includes('LinkedProcessUniqueId'), 'only the dead item left the saved model');
expect(saved.includes('Removed references to deleted documents'), 'the default change description');

// A second scan finds nothing left on the active processes.
await b.js(`$btn('Scan again')`);
await b.until(`document.body.innerText.includes('What the scan found')`, 'the second scan');
expect(/0 active processes and 1 archived process/.test(await b.js(`document.querySelector('main').innerText`)), 'nothing left to repair');
b.close();
