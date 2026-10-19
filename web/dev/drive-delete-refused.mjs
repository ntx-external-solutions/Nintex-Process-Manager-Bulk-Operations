// The tenant refuses to delete an active target (R14's body). Expect an Archive row, then
// a Failed Delete row naming the holder and saying what archiving and the restore did
// ("Archiving published it as 2.0, and the restore opened 2.1."), and Pinned active again
// in its group. Restart the mock first.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/delete', `document.body.innerText.includes('Choose what to delete')`, 'delete page');
await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids')`, 'the ids box');
await b.js(`(() => { const el = document.querySelector('#ids'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '9'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await b.js(`$btn('Build the plan')`);
await b.until(`document.body.innerText.includes('Delete for real')`, 'dry run plan');
await b.js(`$set('#typed', 'DELETE'); true`);
await b.js(`$btn('Run the delete')`);
await b.until(`document.body.innerText.includes('Permanent deletion')`, 'the final confirmation');
await b.js(`$btn('Delete 1 process')`);
await b.until(`document.body.innerText.includes('Delete finished') || document.body.innerText.includes('did not finish')`, 'the end');
console.log('--- RESULTS FILE ---\n' + (await b.resultsCsv()));
const writes = (await b.sent()).filter((l) => /^(PUT|POST) /.test(l) && !l.includes('oauth2'));
console.log('--- writes sent ---\n' + writes.map((w) => w.slice(0, 160)).join('\n'));
b.close();
