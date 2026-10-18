// Archive Finance against the mock, then run folder cleanup, printing each screen.
// Expect: 5 archived or settled, then Retired deleted, Forms kept for its document,
// Policies kept for its archived document (F1), Payables kept for the refused process,
// and Finance kept because its subgroups were.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/archive', `!!document.querySelector('input[aria-label="Select Finance"]')`, 'tree');
await b.js(`$check('Select Finance')`);
await b.js(`$btn('Preview what would be archived')`);
await b.until(`document.body.innerText.includes('Would be archived')`, 'plan');
console.log('--- PLAN ---\n' + (await b.js(`document.querySelector('table.plan').innerText`)));
await b.js(`$set('#change','Retired in bulk test'); true`);
await b.js(`$btn('Archive 5')`);
await b.js(`$btn('Yes, archive')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
await b.js(`$btn('Check which groups are empty')`);
await b.until(`document.body.innerText.includes('would be deleted') || document.body.innerText.includes('None of the groups')`, 'cleanup review');
console.log('--- CLEANUP REVIEW ---\n' + (await b.js(`[...document.querySelectorAll('.panel')].slice(-3).map(p=>p.innerText).join('\\n---\\n')`)));
await b.js(`document.querySelector('label.inline input').click(); true`);
await b.js(`$btn('Delete 1 group')`);
await b.until(`/groups? deleted/.test(document.body.innerText)`, 'cleanup done');
console.log('--- RESULTS ---\n' + (await b.js(`document.querySelector('main').innerText`)));
console.log('--- DeleteGroup calls ---\n' + (await b.sent()).filter((l) => l.includes('DeleteGroup')).join('\n'));
b.close();
