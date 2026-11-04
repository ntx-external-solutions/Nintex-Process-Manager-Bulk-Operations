// Link order (F8). Targets given backwards: Chain tail, Chain middle, Chain head; Loop one
// and Loop two, which link to each other; Hidden target, linked from Hidden holder by a
// link no read shows; and Group tied. Expect the preview and the final confirmation to name
// the two cycle targets edited first and the group; Chain head before Chain middle before
// Chain tail, all in one pass; a RemoveReferences row each for the loop; Hidden target
// refused on pass 1 and deleted on pass 2, with one Delete row; and Group tied held back,
// never archived. Restart the mock first.

import { connect } from './cdp.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const failures = [];
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const b = await connect();
await b.signIn();
await b.go('/delete', `document.body.innerText.includes('Choose what to delete')`, 'delete page');
await b.js(`$btn('By id or CSV')`);
await b.until(`!!document.querySelector('#ids')`, 'the ids box');
await b.js(`(() => { const el = document.querySelector('#ids'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '22\\n21\\n20\\n23\\n24\\n26\\n25\\n27'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await b.js(`$btn('Build the plan')`);
await b.until(`document.body.innerText.includes('Delete for real')`, 'dry run plan');

const preview = await b.js(`document.body.innerText`);
console.log('--- PREVIEW ---\n' + preview.slice(preview.indexOf('Links between targets'), preview.indexOf('Links between targets') + 900));
expect(/TARGETS EDITED FIRST, TO BREAK A LINK CYCLE \(2\)/.test(preview), 'the preview counts the targets edited first');
expect(/Loop one[\s\S]*link to Loop two removed/.test(preview), 'and names them');
expect(/HELD BACK, TIED TO A PROCESS GROUP \(1\)[\s\S]*Group tied[\s\S]*Reference Library \(Group\)/.test(preview), 'the preview names the group and what it holds back');

await b.js(`$set('#typed', 'DELETE'); true`);
await b.js(`$btn('Run the delete')`);
await b.until(`document.body.innerText.includes('Permanent deletion')`, 'the final confirmation');
const confirmation = await b.js(`document.body.innerText`);
expect(/About to permanently delete 7 process/.test(confirmation), 'seven to delete, Group tied kept');
expect(/Edited first, to break a link cycle, 2 target\(s\)/.test(confirmation), 'the confirmation counts the cycle edits');
expect(/Group tied[^\n]*held by a process group/.test(confirmation), 'and says why Group tied is kept');
await b.js(`$btn('Delete 7 process')`);
await b.until(`document.body.innerText.includes('Delete finished') || document.body.innerText.includes('did not finish')`, 'the end');

const csv = await b.resultsCsv();
console.log('--- RESULTS FILE ---\n' + csv);
const rowOf = (n, operation) => csv.split('\n').find((l) => l.includes(id(n)) && l.includes(`"${operation}"`)) ?? '';
expect(/"Delete","Success","Deleted"/.test(rowOf(20, 'Delete')), 'Chain head in pass 1');
expect(/"Delete","Success","Deleted"/.test(rowOf(21, 'Delete')), 'Chain middle in pass 1');
expect(/"Delete","Success","Deleted"/.test(rowOf(22, 'Delete')), 'Chain tail in pass 1');
expect(/Edited to break a link cycle between targets/.test(rowOf(23, 'RemoveReferences')), 'Loop one edited, and says why');
expect(/Edited to break a link cycle between targets/.test(rowOf(24, 'RemoveReferences')), 'Loop two edited, and says why');
expect(/"Delete","Success","Deleted on pass 2, after the processes linking to it were deleted"/.test(rowOf(26, 'Delete')), 'Hidden target on pass 2');
expect(/"Delete","Skipped","Not deleted: The tenant ties it to the process group Reference Library \(Group\)/.test(rowOf(27, 'Delete')), 'Group tied held back');
expect(csv.split('\n').filter((l) => l.includes(id(26)) && l.includes('"Delete"')).length === 1, 'one Delete row for Hidden target');

const sent = await b.sent();
const writes = sent.filter((l) => /^(PUT|POST) /.test(l) && !l.includes('oauth2'));
const deletes = writes.filter((l) => l.includes('DeleteProcess')).map((l) => Number(/"processUniqueId":"[^"]*?(\d{3})"/.exec(l)?.[1]));
console.log('--- deletes, in order ---\n' + deletes.join(' '));
const at = (n) => deletes.indexOf(n);
expect(at(20) < at(21) && at(21) < at(22), 'the chain went head first');
expect(!writes.some((l) => (l.includes('ArchiveProcess') || l.includes('RestoreProcess')) && l.includes(id(27))), 'Group tied never archived or restored');
expect(!writes.some((l) => l.startsWith('PUT') && (l.includes(id(20)) || l.includes(id(21)) || l.includes(id(22)))), 'the chain was not edited');
b.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
