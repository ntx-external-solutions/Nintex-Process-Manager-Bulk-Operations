// Update owners and experts from a CSV against the mock, choosing "Match current state",
// printing the plan and results. Start the app with SCIM_BASE_URL pointing at the mock.
// Expect: Outright saved and published (one PUT, one Publish), Needs approval saved only
// (it is in progress), Elsewhere set to the unassigned placeholder and published, and
// rows skipped for an unknown username, a non-GUID id, a row with no owner or expert, and
// an archived process (F4). Each skipped row is named from the listings.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const csv = join(mkdtempSync(join(tmpdir(), 'ownership-')), 'owners.csv');
writeFileSync(
  csv,
  [
    'ProcessID,NewOwner,NewExpert',
    `${id(1)},ann@example.com,`,
    `${id(2)},,bob@example.com`,
    `${id(3)},nobody@example.com,`,
    `${id(5)},unassigned,`,
    '1234,ann@example.com,',
    `${id(6)},,`,
    `${id(7)},ann@example.com,`,
  ].join('\r\n'),
);

const b = await connect();
await b.signIn();
await b.go('/ownership', `!!document.querySelector('input[type=file]')`, 'upload');
await b.upload('input[type=file]', csv);
await b.until(`document.body.innerText.includes('owners.csv: 7 rows')`, 'file read');
await b.js(`$set('#scim','scim-key'); true`);
await b.js(`[...document.querySelectorAll('input[type=radio]')][1].click(); true`);
await b.js(`$btn('Preview the changes')`);
await b.until(`document.body.innerText.includes('Check the plan')`, 'plan');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
console.log('--- PLAN ---\n' + (await b.js(`[...document.querySelectorAll('.panel')].map(p=>p.innerText).join('\\n---\\n')`)));
await b.js(`$set('#change','Owners moved to the new team'); true`);
await b.js(`$btn('Update 3 processes')`);
await b.js(`$btn('Yes, update')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
console.log('--- RESULTS ---\n' + (await b.js(`document.querySelector('main').innerText`)));
console.log('--- writes ---\n' + (await b.sent()).filter((l) => /^(PUT|POST) /.test(l)).map((l) => l.slice(0, 160)).join('\n'));
b.close();
