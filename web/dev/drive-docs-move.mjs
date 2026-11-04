// Move documents (W9) against the mock: check Library in the tree, tick the document only
// associated with it, upload a CSV, move everything to Other.
// Expect: Library's documents and the ticked Shared template move, attached ones included.
// Left out: Pending memo, until its tick; Draft-only form (its read has no reference, so a save would wipe
// it); Retired guide (tagged); Supplier link (a link); Old policy (archived); an id that matches nothing. Refused by
// tenant fails on its own. Every save keeps the name, reference and review frequency, and
// Shared template keeps its association with Manuals. Restart the mock first: this changes
// its state.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UNKNOWN = id(777);
const csv = join(mkdtempSync(join(tmpdir(), 'docs-move-')), 'documents-to-move.csv');
writeFileSync(csv, ['DocumentID', id(100), id(210), '101', UNKNOWN].join('\r\n') + '\r\n');

const fail = (what) => {
  console.error(`FAIL: ${what}`);
  process.exitCode = 1;
};
const expect = (ok, what) => (ok ? console.log(`ok: ${what}`) : fail(what));

const b = await connect();
await b.signIn();
await b.go('/documents/move', `!!document.querySelector('[role=tablist]')`, 'move page');
expect(await b.js(`[...document.querySelectorAll('nav a')].some((a) => a.textContent.includes('Move documents'))`), 'Move documents is in the side nav');
const tabs = await b.js(`[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent).join('|')`);
expect(/From the tree/.test(tabs) && /By id or CSV/.test(tabs) && /document list/.test(tabs), 'by group, from the list, and by CSV');

await b.until(`!!document.querySelector('input[aria-label="Move into Other"]')`, 'the destination picker');
await b.js(`$check('Move into Other')`);
await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids-file input[type=file]')`, 'the CSV upload');
await b.upload('#ids-file input[type=file]', csv);
await b.until(`document.body.innerText.includes('documents-to-move.csv:')`, 'file read');

await b.js(`$btn('From the tree')`);
await b.until(`!!document.querySelector('input[aria-label="Select Library"]')`, 'the tree');
await b.js(`$check('Select Library')`);
await b.js(`$btn('Preview what would move')`);
await b.until(`document.body.innerText.includes('Only associated with a checked group')`, 'the associated-only list');
expect(await b.js(`!document.querySelector('[role=tablist]') && document.body.innerText.includes('Some documents only link to a checked group')`), 'the question has the page to itself, with no bounce back to the selection');
await b.js(`$check('Include document Shared template.docx')`);
await b.js(`$btn('Preview what would move')`);
await b.until(`document.body.innerText.includes('Check the plan')`, 'plan');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
const plan = await b.js(`document.querySelector('main').innerText`);
console.log('--- PLAN ---\n' + plan);
expect(/7 documents would move to Other/.test(plan), 'seven to move, to Other');
expect(/Payables checklist\.xlsx\s+Library \/ Manuals/.test(plan), 'an attached document is in the plan, with where it is now');
expect(/Pending memo\.docx: Pending in Process Manager/.test(plan), 'a pending document is left out');
expect(/Draft-only form\.docx: Its properties did not give its reference number/.test(plan), 'a record that could not be sent back whole is left out');
expect(/Supplier link: A linked document/.test(plan), 'a link is left out');
expect(/Retired guide\.pdf: It has tags/.test(plan), 'a tagged document is left out');
expect(/Old policy\.pdf: Archived\. Restore it first/.test(plan), 'an archived document is left out');
expect(plan.includes(`${UNKNOWN}: Document not found`), 'an unknown id is left out');
expect((await b.sent()).filter((l) => l.startsWith('POST') && l.includes('/properties')).length === 0, 'the plan writes nothing');

await b.js(`$check('Also move the pending documents')`);
await b.until(`document.body.innerText.includes('8 documents would move to Other')`, 'the plan with the pending document');
const ticked = await b.js(`document.querySelector('main').innerText`);
expect(/Pending memo\.docx\s+Library\s+\S+\s+From the tree \(pending\)/.test(ticked), 'ticked, the pending document moves and the plan says it is pending');

await b.js(`$btn('Move 8 documents')`);
await b.js(`$btn('Yes, move 8 documents now')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
const rowOf = (n) => rows.find((r) => r.includes(id(n))) ?? '';
expect(/"UpdateLocation","Success","Moved from Library \/ Manuals to Other\."/.test(rowOf(201)), 'an attached document moved, confirmed');
expect(/"UpdateLocation","Success","Moved from Finance \/ Forms to Other\."/.test(rowOf(100)), 'the CSV’s document moved');
expect(/"UpdateLocation","Failed"/.test(rowOf(208)), 'the save the tenant refused is Failed');
expect(/"UpdateLocation","Success"/.test(rowOf(206)), 'the pending document moved once ticked');
for (const n of [202, 204, 210, 101]) expect(/"UpdateLocation","Skipped"/.test(rowOf(n)), `${n} has a Skipped row`);
expect(rows.some((r) => r.includes(UNKNOWN) && r.includes('"Resolve","Skipped"')), 'the unknown id has a Resolve row');

const saves = (await b.sent()).filter((l) => l.startsWith('POST') && l.includes('/properties'));
expect(saves.length === 8 && saves.every((l) => l.includes('name="PrimaryProcessGroupId"\r\n\r\n903\r\n')), 'eight saves, each to Other');
const of = (n) => saves.find((l) => l.includes(`/documents/${n}/properties`)) ?? '';
expect(/name="ReferenceNo"\r\n\r\nREF-205\r\n/.test(of(205)), 'the reference went back unchanged');
expect(/name="DocumentReviewFreqMonths"\r\n\r\n12\r\n/.test(of(205)), 'the review frequency went back unchanged');
expect(/name="DocumentName"\r\n\r\nFree notes\.txt\r\n/.test(of(205)), 'the name went back unchanged');
expect(of(201).includes('{"selected":[]}'), 'the group of the process it is attached to does not become an association');
expect(of(209).includes('{"selected":[908]}'), 'the association with Manuals went back; the old primary and the inherited root did not');
b.close();
