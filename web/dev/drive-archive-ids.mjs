// Bulk Archive by id or CSV (W7) against the mock: check Payables in the tree, upload a
// results-file-shaped CSV, build the plan, run it, and check the rows.
// Expect: Disabled owner and Fails but works from the tree; Elsewhere and Pinned from the
// file (Fails but works is in both and is listed once, from the tree); Archived input left
// out as already archived, an unknown id left out as not found; the file note counting a
// duplicate and a row with no id by its line; Skipped rows at the top of the results; and
// the cleanup step offering only Payables, saying ids never make a group a candidate.
// Restart the mock first: this changes its state.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const csv = join(mkdtempSync(join(tmpdir(), 'archive-ids-')), 'earlier-results.csv');
// Excel's way: a BOM, CRLF and quoted cells. Line 7 is a group row with no process id.
writeFileSync(
  csv,
  '﻿' +
    [
      '"ObjectType","ObjectID","Name","Operation","Status"',
      `"Process","${id(4)}","Fails but works","Archive","Failed"`,
      `"Process","${id(5)}","Elsewhere","Archive","Failed"`,
      `"Process","9","Pinned","Archive","Failed"`,
      `"Process","${id(7)}","Archived input","Archive","Failed"`,
      `"Process","${UNKNOWN}","Gone","Archive","Failed"`,
      `"Group","","Payables","DeleteGroup","Kept"`,
      `"Process","${id(5)}","Elsewhere, again","Archive","Failed"`,
    ].join('\r\n') +
    '\r\n',
);

const fail = (what) => {
  console.error(`FAIL: ${what}`);
  process.exitCode = 1;
};
const expect = (ok, what) => (ok ? console.log(`ok: ${what}`) : fail(what));

const b = await connect();
await b.signIn();
await b.go('/archive', `!!document.querySelector('input[aria-label="Select Finance"]')`, 'tree');
// Open Finance to reach Payables, then check it.
await b.js(`[...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Expand Finance')?.click(); true`);
await b.until(`!!document.querySelector('input[aria-label="Select Payables"]')`, 'Payables in the tree');
await b.js(`$check('Select Payables')`);

await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids-file input[type=file]')`, 'the CSV upload');
await b.upload('#ids-file input[type=file]', csv);
await b.until(`document.body.innerText.includes('earlier-results.csv:')`, 'file read');
const note = await b.js(`[...document.querySelectorAll('[role=status]')].map((n) => n.textContent).join(' ')`);
console.log('--- FILE NOTE ---\n' + note);
expect(note.includes('7 row(s) read, 5 id(s) found, 1 duplicate(s) dropped, 1 row(s) with no id (line 7). This replaced what was in the box.'), 'the note counts rows, ids, the duplicate and the row with no id by line');
expect((await b.js(`document.querySelector('#ids').value`)).split('\n').length === 5, 'the box holds the five ids');
expect(await b.js(`!!document.querySelector('a[download="process-ids-template.csv"]')`), 'a template link');

await b.js(`$btn('Preview what would be archived')`);
await b.until(`document.body.innerText.includes('Would be archived')`, 'plan');
await b.js(`document.querySelectorAll('details').forEach((d) => (d.open = true)); true`);
const plan = await b.js(`document.querySelector('table.plan').innerText`);
console.log('--- PLAN ---\n' + plan);
const leftOut = await b.js(`[...document.querySelectorAll('details.panel')].map((d) => d.innerText).join('\\n')`);
console.log('--- LEFT OUT ---\n' + leftOut);
expect(/Disabled owner\s+Finance \/ Payables\s+From the tree/.test(plan), 'Disabled owner from the tree');
expect(/Fails but works\s+Finance \/ Payables\s+From the tree/.test(plan), 'Fails but works once, from the tree');
expect(/Elsewhere\s+Other\s+From earlier-results\.csv/.test(plan), 'Elsewhere from the file, under its path');
expect(/Pinned\s+Other\s+From earlier-results\.csv/.test(plan), 'Pinned from the file by its numeric id');
expect((plan.match(/Fails but works/g) ?? []).length === 1, 'each process once');
expect(leftOut.includes('Archived input: Already archived'), 'the archived one is left out');
expect(leftOut.includes(`${UNKNOWN}`) && leftOut.includes('not found'), 'the unknown id is left out');

await b.js(`$set('#change','Retired from a list'); true`);
await b.js(`$btn('Archive 4')`);
await b.js(`$btn('Yes, archive')`);
await b.until(`document.body.innerText.includes('Download the results')`, 'results');
const results = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + results);
const rows = results.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
expect(/"Select","Skipped","Already archived"/.test(rows[0] ?? '') && /"Resolve","Skipped"/.test(rows[1] ?? ''), 'the Skipped rows are at the top');
for (const n of [3, 4, 5, 9]) expect(rows.some((r) => r.includes(id(n)) && r.includes('"Archive"')), `an Archive row for ${id(n)}`);

const cleanup = await b.js(`[...document.querySelectorAll('.panel')].map((p) => p.innerText).find((t) => t.includes('Delete the groups this left empty')) ?? ''`);
console.log('--- CLEANUP OFFER ---\n' + cleanup);
expect(cleanup.includes('covered 1 group') && cleanup.includes('Processes picked by id cover no group'), 'cleanup offers only the checked group and says why');

console.log('--- ArchiveProcess calls ---\n' + (await b.sent()).filter((l) => l.includes('ArchiveProcess')).map((l) => l.slice(0, 140)).join('\n'));
b.close();
