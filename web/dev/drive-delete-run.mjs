// A real Bulk Delete against the mock: delete Old thing. Expect the holding group made,
// the archived holder restored in place and read, both references removed and published,
// the target archived then deleted, the holder archived again, the holding group removed,
// and the results to say so. Restart the mock first: this changes its state.

import { connect } from './cdp.mjs';

const b = await connect();
await b.signIn();
await b.go('/delete', `!!document.querySelector('#ids')`, 'delete page');
const type = (selector, value, proto = 'HTMLInputElement') =>
  b.js(
    `(() => { const el = document.querySelector('${selector}'); const s = Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set; s.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
await type('#ids', '6', 'HTMLTextAreaElement');
await b.js(`$btn('Build the plan')`);
await b.until(`document.body.innerText.includes('Delete for real')`, 'dry run plan');
await type('#typed', 'DELETE');
await b.js(`$btn('Run the delete')`);

// Answer each question as it comes; the only one expected is the final confirmation.
const asked = [];
for (;;) {
  await b.until(
    `document.body.innerText.includes('Delete finished') || document.body.innerText.includes('did not finish') || [...document.querySelectorAll('h2')].some((h) => h.closest('.panel.warning') && h.nextElementSibling && h.parentElement.querySelector('button'))`,
    'a question or the end',
  );
  if (await b.js(`document.body.innerText.includes('Delete finished') || document.body.innerText.includes('did not finish')`)) break;
  const title = await b.js(`[...document.querySelectorAll('.panel.warning h2')].map((h) => h.textContent).find((t) => t !== 'Delete for real' && !t.startsWith('3.')) ?? ''`);
  if (!title) {
    await new Promise((r) => setTimeout(r, 200));
    continue;
  }
  asked.push(title);
  if (title === 'Permanent deletion') await b.js(`$btn('Delete 1 process')`);
  else await b.js(`$btn('Stop and put things back')`);
  await new Promise((r) => setTimeout(r, 300));
}

console.log('--- QUESTIONS ---\n' + (asked.join('\n') || '(none)'));
console.log('--- RESULT ---\n' + (await b.js(`document.querySelector('main').innerText`)));
const writes = (await b.sent()).filter((l) => /^(PUT|POST) /.test(l) && !l.includes('oauth2'));
console.log('--- writes sent ---\n' + writes.map((w) => w.slice(0, 160)).join('\n'));
b.close();
