// Delete documents (W8 follow-up) whose session dies as the delete goes out: check Old
// forms and Spent, archive, confirm, and have the mock expire the session at the bulk
// delete. Expect the done screen to say the run can be finished, and after signing in
// again the page to offer "Finish it". Finishing reads the lists, finds the delete never
// took, and asks again for a typed DELETE naming the four documents the delete never
// reached. Then: two deleted, Tenant keeps refused and put back, Late holder (held by the
// first re-check) put back, Locked archive failed. One row per document and operation,
// and the record gone afterwards. Restart the mock first.

import { connect } from './cdp.mjs';

const MOCK = 'http://localhost:4999/tenant';
const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fail = (what) => {
  console.error(`FAIL: ${what}`);
  process.exitCode = 1;
};
const expect = (ok, what) => (ok ? console.log(`ok: ${what}`) : fail(what));

const b = await connect();
await b.signIn();
await b.js(`localStorage.clear(); true`);
await b.go('/documents/delete', `!!document.querySelector('input[aria-label="Select Old forms"]')`, 'tree');
await b.js(`$check('Select Old forms'); $check('Select Spent'); true`);
await b.js(`$btn('Preview what would be deleted')`);
await b.until(`document.body.innerText.includes('Only associated with a checked group')`, 'the associated-only list');
await b.js(`$btn('Preview what would be deleted')`);
await b.until(`document.body.innerText.includes('Check the plan')`, 'plan');
await b.js(`$btn('Archive 3 documents, then confirm the delete')`);
await b.js(`$btn('Yes, archive 3 documents')`);
await b.until(`document.body.innerText.includes('Type DELETE to delete them')`, 'the confirmation');

// The session dies at the bulk delete itself: the call goes out and is refused.
await fetch(`${MOCK}/_expire?on=documents/bulk`);
await b.js(`$set('#typed', 'DELETE'); true`);
await b.js(`$btn('Delete 5 documents permanently')`);
await b.until(`document.body.innerText.includes('Download the results') || /sign in/i.test(document.body.innerText)`, 'the run to die');
const died = await b.js(`document.querySelector('main')?.innerText ?? document.body.innerText`);
console.log('--- AFTER THE SESSION DIED ---\n' + died);
expect(/still archived/.test(died) && /open Delete documents to finish the run/.test(died), 'the done screen says how to finish the run');
expect(await b.js(`!!localStorage.getItem('npmbo.documents.delete')`), 'the run record is kept');

await fetch(`${MOCK}/_revive`);
await b.signIn();
await b.go('/documents/delete', `document.body.innerText.includes('did not finish') || !!document.querySelector('input[aria-label="Select Old forms"]')`, 'delete page again');
const offer = await b.js(`document.querySelector('main').innerText`);
console.log('--- SIGNED IN AGAIN ---\n' + offer.split('\n').slice(0, 8).join('\n'));
expect(/An earlier run did not finish/.test(offer), 'the page offers to finish it');
await b.js(`$btn('Finish it')`);
await b.until(`document.body.innerText.includes('Type DELETE to delete them')`, 'the confirmation again');
const confirm = await b.js(`document.querySelector('main').innerText`);
console.log('--- CONFIRM AGAIN ---\n' + confirm);
expect(/This finishes a run that was interrupted/.test(confirm), 'it says it is finishing an interrupted run');
expect(/Permanently delete 4 documents/.test(confirm) && !/Late holder\.pdf\s+Old forms/.test(confirm.split('Permanently delete')[1] ?? ''), 'the four the delete never reached, not the held one');
expect(confirm.includes("Don't delete; put back the 3 documents this run archived"), 'the way out still puts back');
expect((await b.sent()).filter((l) => /^DELETE /.test(l)).length === 1, 'nothing sent again before the confirmation');
await b.js(`$set('#typed', 'DELETE'); true`);
await b.js(`$btn('Delete 4 documents permanently')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');

const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
const keyOf = (r) => r.split('","').slice(1, 2)[0] + '|' + r.split('","')[3];
expect(new Set(rows.map(keyOf)).size === rows.length, 'one row per document and operation');
const rowOf = (n, op) => rows.find((r) => r.includes(id(n)) && r.includes(`"${op}"`)) ?? '';
for (const n of [212, 213, 214]) expect(/"Archive","Success"/.test(rowOf(n, 'Archive')), `${n}: the archive row kept`);
for (const n of [212, 217]) expect(/"Delete","Success","Deleted\."/.test(rowOf(n, 'Delete')), `${n} deleted`);
expect(/"Delete","Skipped","Attached since the plan was built/.test(rowOf(213, 'Delete')), 'the held document keeps its row');
expect(/"Delete","Skipped","Process Manager refused: still attached"/.test(rowOf(214, 'Delete')), 'the tenant kept one');
expect(/"Delete","Failed","Process Manager refused: Locked"/.test(rowOf(215, 'Delete')), 'a refusal');
for (const n of [213, 214]) expect(/"Restore","Success","Put back/.test(rowOf(n, 'Restore')), `${n} put back`);
expect(!(await b.js(`!!localStorage.getItem('npmbo.documents.delete')`)), 'the record is gone once the run is finished');
b.close();
