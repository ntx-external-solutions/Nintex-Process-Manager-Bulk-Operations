// The session dies between the preview and the run (R12). Expect the run to stop on the
// first archive, every process to get a row, and the page to ask for a new sign-in,
// never "Unexpected error". Only the first batch, already in flight, reaches the mock.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/archive', `!!document.querySelector('input[aria-label="Select Finance"]')`, 'tree');
await b.js(`$check('Select Finance')`);
await b.js(`$btn('Preview what would be archived')`);
await b.until(`document.body.innerText.includes('Would be archived')`, 'plan');
await fetch('http://localhost:4999/tenant/_expire?mode=redirects');
await b.js(`$set('#change','Retired in bulk test'); true`);
await b.js(`$btn('Archive 5')`);
await b.js(`$btn('Yes, archive')`);
await b.until(`/Download the results|session ended|Sign in again|Unexpected error/i.test(document.body.innerText)`, 'the run to end');
console.log('--- PAGE ---\n' + (await b.js(`document.querySelector('main').innerText`)));
console.log('--- ArchiveProcess calls ---\n' + (await b.sent()).filter((l) => l.includes('ArchiveProcess')).join('\n'));
b.close();
