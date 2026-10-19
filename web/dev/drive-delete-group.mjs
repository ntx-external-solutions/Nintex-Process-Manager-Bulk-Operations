// Delete by group (W6): check Retired in the tree. Expect two targets, Old thing (active,
// archived first) and Old retired step (archived from Retired, which the tree never
// shows), both deleted, an Archive row for Old thing, then Retired offered for deletion
// and deleted, with a DeleteGroup row. Restart the mock first: this changes its state.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/delete', `document.body.innerText.includes('Choose what to delete')`, 'delete page');
await b.until(`!!document.querySelector('button[aria-label="Expand Finance"]')`, 'the tree');
await b.js(`document.querySelector('button[aria-label="Expand Finance"]').click(); true`);
await b.until(`!!document.querySelector('input[aria-label="Select Retired"]')`, 'Finance opened');
await b.js(`$check('Select Retired')`);
await b.js(`$btn('Build the plan')`);
await b.until(`document.body.innerText.includes('Delete for real') || document.body.innerText.includes('Problem')`, 'dry run plan');
console.log('--- PLAN (top) ---\n' + (await b.js(`document.querySelector('main').innerText`)).split('\n').slice(0, 24).join('\n'));
await b.js(`$set('#typed', 'DELETE'); true`);
await b.js(`$btn('Run the delete')`);

const asked = [];
for (;;) {
  await b.until(
    `document.body.innerText.includes('Delete finished') || document.body.innerText.includes('did not finish') || [...document.querySelectorAll('.panel.warning h2')].some((h) => !h.textContent.startsWith('3.'))`,
    'a question or the end',
  );
  if (await b.js(`document.body.innerText.includes('Delete finished') || document.body.innerText.includes('did not finish')`)) break;
  const title = await b.js(`[...document.querySelectorAll('.panel.warning h2')].map((h) => h.textContent).find((t) => !t.startsWith('3.')) ?? ''`);
  asked.push(title);
  if (title === 'Permanent deletion') await b.js(`[...document.querySelectorAll('button')].find((x) => /^Delete \\d+ process/.test(x.textContent.trim())).click(); true`);
  else await b.js(`$btn('Stop and put things back')`);
  await new Promise((r) => setTimeout(r, 300));
}
console.log('--- QUESTIONS ---\n' + (asked.join('\n') || '(none)'));

await b.until(`document.body.innerText.includes('Delete the groups this emptied')`, 'the cleanup offer');
await b.js(`$btn('Check which groups are empty')`);
await b.until(`document.body.innerText.includes('would be deleted') || document.body.innerText.includes('None of the groups')`, 'the cleanup review');
console.log('--- CLEANUP REVIEW ---\n' + (await b.js(`[...document.querySelectorAll('h2')].find((h) => h.textContent.startsWith('4.')).parentElement.innerText`)));
await b.js(`[...document.querySelectorAll('label.inline input')].find((i) => i.closest('.panel')).click(); true`);
await b.js(`$btn('Delete 1 group')`);
await b.until(`/\\d+ groups? deleted, \\d+ kept/.test(document.body.innerText)`, 'the cleanup to finish');
console.log('--- RESULT ---\n' + (await b.js(`document.querySelector('main').innerText`)));
console.log('--- RESULTS FILE ---\n' + (await b.resultsCsv()));
const writes = (await b.sent()).filter((l) => /^(PUT|POST) /.test(l) && !l.includes('oauth2'));
console.log('--- writes sent ---\n' + writes.map((w) => w.slice(0, 160)).join('\n'));
b.close();
