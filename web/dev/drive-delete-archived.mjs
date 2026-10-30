// The archived view as a way in (W6), as a dry run: tick Old retired step in the archived
// list and Pinned by id. Expect the plan to show one target archived first and one already
// archived, each saying how it was chosen, and no write of any kind sent.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/delete', `document.body.innerText.includes('Choose what to delete')`, 'delete page');
await b.js(`$btn('From the archived list')`);
await b.until(`!!document.querySelector('input[aria-label="Select Old retired step"]')`, 'the archived list');
console.log('--- ARCHIVED LIST ---\n' + (await b.js(`document.querySelector('.archived').innerText`)));
await b.js(`$check('Select Old retired step')`);
await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids')`, 'the ids box');
await b.js(`(() => { const el = document.querySelector('#ids'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '9'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await b.js(`$btn('Build the plan')`);
await b.until(`document.body.innerText.includes('Delete for real') || document.body.innerText.includes('Problem')`, 'dry run plan');
console.log('--- PLAN ---\n' + (await b.js(`document.querySelector('main').innerText`)).split('\n').slice(0, 30).join('\n'));
const writes = (await b.sent()).filter((l) => /^(PUT|POST) /.test(l) && !l.includes('oauth2'));
console.log('--- writes sent ---\n' + (writes.length === 0 ? '(none)' : writes.join('\n')));
b.close();
