// A real Bulk Delete whose session dies at the pre-delete archive, after the archived
// holder was restored and both references removed. Expect the page to ask for a new
// sign-in, and after it the plan kept in this browser to offer "Finish it", which archives
// the holder again and removes the holding group. Restart the mock first.

import { connect } from './cdp.mjs';

const MOCK = 'http://localhost:4999/tenant';
const b = await connect();
await b.signIn();
await b.go('/delete', `!!document.querySelector('#ids')`, 'delete page');
// A textarea, which $set (an input's value setter) cannot fill.
await b.js(`(() => { const el = document.querySelector('#ids'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '6'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await b.js(`$btn('Build the plan')`);
await b.until(`document.body.innerText.includes('Delete for real')`, 'dry run plan');
await b.js(`$set('#typed', 'DELETE'); true`);
await fetch(`${MOCK}/_expire?on=ArchiveProcess`);
await b.js(`$btn('Run the delete')`);
await b.until(`document.body.innerText.includes('Permanent deletion')`, 'the final confirmation');
await b.js(`$btn('Delete 1 process')`);
await b.until(`!document.body.innerText.includes('Running') || /sign in/i.test(document.body.innerText)`, 'the run to die');
console.log('--- AFTER THE SESSION DIED ---\n' + (await b.js(`document.querySelector('main')?.innerText ?? document.body.innerText`)));

await fetch(`${MOCK}/_revive`);
await b.signIn();
await b.go('/delete', `document.body.innerText.includes('did not finish') || !!document.querySelector('#ids')`, 'delete page again');
console.log('--- SIGNED IN AGAIN ---\n' + (await b.js(`document.querySelector('main').innerText`)).split('\n').slice(0, 8).join('\n'));
await b.js(`$btn('Finish it')`);
await b.until(`document.body.innerText.includes('interrupted run is finished')`, 'the resumed unwind');
console.log('--- FINISHED ---\n' + (await b.js(`document.querySelector('main').innerText`)));
const writes = (await b.sent()).filter((l) => /^(PUT|POST) /.test(l) && !l.includes('oauth2'));
console.log('--- writes sent ---\n' + writes.map((w) => w.slice(0, 150)).join('\n'));
b.close();
