// Move Payables, a published process and a process with an open draft into Other,
// printing the plan and results. Expect two ReorderTreeNodes calls: the draft is left
// unticked and recorded as Skipped.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/move', `!!document.querySelector('input[aria-label="Select Finance"]')`, 'tree');
await b.js(`document.querySelector('button[aria-label="Expand Finance"]').click(); true`);
await b.until(`!!document.querySelector('input[aria-label="Select Payables"]')`, 'Finance children');
await b.js(`$check('Select Payables'); $check('Select Outright'); $check('Select Needs approval'); true`);
await b.js(`document.querySelector('input[aria-label="Move into Other"]').click(); true`);
await b.js(`$btn('Preview the move')`);
await b.until(`document.body.innerText.includes('Check the plan')`, 'plan');
console.log('--- PLAN ---\n' + (await b.js(`[...document.querySelectorAll('.panel')].map(p=>p.innerText).join('\\n---\\n')`)));
await b.js(`$btn('Move 2 items')`);
await b.js(`$btn('Yes, move')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
console.log('--- RESULTS ---\n' + (await b.js(`document.querySelector('main').innerText`)));
console.log('--- ReorderTreeNodes calls ---\n' + (await b.sent()).filter((l) => l.includes('ReorderTreeNodes')).join('\n'));
b.close();
