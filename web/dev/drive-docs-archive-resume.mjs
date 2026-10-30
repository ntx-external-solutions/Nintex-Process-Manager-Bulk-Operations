// Archive documents (W8 follow-up) whose session dies at the bulk archive: tick two
// documents from the list, have the mock expire the session at the call, and run. Expect
// the record kept, and after signing in again "Show its results" settling both rows from
// a fresh read (still active, so the archive did not take), then the record gone.
// Restart the mock first.

import { connect } from './cdp.mjs';

const MOCK = 'http://localhost:4999/tenant';
const fail = (what) => {
  console.error(`FAIL: ${what}`);
  process.exitCode = 1;
};
const expect = (ok, what) => (ok ? console.log(`ok: ${what}`) : fail(what));

const b = await connect();
await b.signIn();
await b.js(`localStorage.clear(); true`);
await b.go('/documents/archive', `!!document.querySelector('input[aria-label="Select Library"]')`, 'archive page');
await b.js(`$btn('From the document list')`);
await b.until(`!!document.querySelector('input[aria-label="Select document Free notes.txt"]')`, 'the document list');
await b.js(`$check('Select document Free notes.txt'); $check('Select document Supplier link'); true`);
await b.js(`$btn('Preview what would be archived')`);
await b.until(`document.body.innerText.includes('Would be archived')`, 'plan');
await fetch(`${MOCK}/_expire?on=bulk/archive`);
await b.js(`$btn('Archive 2 documents')`);
await b.js(`$btn('Yes, archive')`);
await b.until(`document.body.innerText.includes('Download the results') || /sign in/i.test(document.body.innerText)`, 'the run to die');
expect(await b.js(`!!localStorage.getItem('npmbo.documents.archive')`), 'the run record is kept');

await fetch(`${MOCK}/_revive`);
await b.signIn();
await b.go('/documents/archive', `document.body.innerText.includes('did not finish')`, 'the offer to finish');
expect(!(await b.js(`!!document.querySelector('input[aria-label="Select Library"]')`)), 'nothing new can be chosen until the earlier run is dealt with');
await b.js(`$btn('Show its results')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
expect(rows.length === 2 && rows.every((r) => /"Archive","Failed","The archive call failed/.test(r)), 'both rows, settled: the archive did not take');
expect(await b.js(`document.body.innerText.includes('results of an interrupted run')`), 'the screen says these are an interrupted run’s results');
expect(!(await b.js(`!!localStorage.getItem('npmbo.documents.archive')`)), 'the record is gone');
b.close();
