// A Bulk Delete dry run against the mock: plan the deletion of Old thing. Expect one
// process to edit (Elsewhere, a ProcessLink), the archived holder's hidden Input found by
// the archive scan, the plan marked incomplete, and no write of any kind sent.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/delete', `!!document.querySelector('#ids')`, 'dry run page');
await b.js(`(() => { const el = document.querySelector('#ids'); const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(el, '6'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await b.js(`$btn('Build the plan')`);
await b.until(`document.body.innerText.includes('Download the plan') || document.body.innerText.includes('Problem')`, 'plan');
console.log('--- PLAN ---\n' + (await b.js(`document.querySelector('main').innerText`)));
const writes = (await b.sent()).filter((l) => /^(PUT|POST) /.test(l) && !l.includes('oauth2'));
console.log('--- writes sent ---\n' + (writes.length === 0 ? '(none)' : writes.join('\n')));
b.close();
