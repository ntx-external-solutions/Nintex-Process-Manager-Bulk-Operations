// Ported from Tests/Test-Dependencies.ps1: "Locator against real payloads", "Locator
// against all buckets", "Remover", "Remover: orphan semantics and collateral damage",
// "Null and shape tolerance" and "Input/Output finder matches the full walk".
//
// The real pair is a holder and a target captured from the demo tenant: the holder
// holds three references to the target, the target two back to the holder. The
// all-buckets model is synthetic and covers every bucket the real pair does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProcessModel } from './model.ts';
import {
  findInputOutputReferenceSites,
  findProcessReferenceSites,
  removeProcessReferences,
  type ReferenceSite,
} from './references.ts';
import { readFixture } from './testing/fixtures.ts';
import { count, dig, list } from './testing/json.ts';

type Fixture = ProcessModel & { UniqueId: string; Name: string; GroupUniqueId: string };

const holder = () => readFixture<Fixture>('ActionCustomerRequest.json');
const target = () => readFixture<Fixture>('DependencyTest.json');
const allBuckets = () => readFixture<Fixture>('AllBuckets.json');
const HOLDER_ID = holder().UniqueId;
const TARGET_ID = target().UniqueId;

const where = (sites: readonly ReferenceSite[], pick: (s: ReferenceSite) => boolean) => sites.filter(pick);

// ---------------------------------------------------------------- locator, real payloads

test('the locator finds every reference the holder makes to the target', () => {
  const model = holder();
  const sites = findProcessReferenceSites(model, [TARGET_ID]);

  assert.equal(sites.length, 3, 'the holder holds exactly 3 references to the target');
  assert.equal(where(sites, (s) => s.bucket === 'ProcessLink').length, 1, 'finds the top-level ProcessLink');
  assert.equal(where(sites, (s) => s.bucket === 'Note').length, 1, 'finds the Note nested in ChildProcessProcedures');
  assert.equal(where(sites, (s) => s.category === 'Input').length, 1, 'finds the Input');

  const note = where(sites, (s) => s.bucket === 'Note')[0];
  const notePath = ['ProcessProcedures', 'Activity', 1, 'ChildProcessProcedures', 'Note', 0] as const;
  assert.equal(note?.elementId, dig(model, ...notePath, 'Id'), 'captures the Note element id');
  assert.equal(note?.isChild, true, 'marks the Note as a child site');
  assert.equal(note?.path, 'ProcessProcedures.Activity[1].ChildProcessProcedures.Note[0]', 'records the full path to the nested Note');
  assert.equal(
    where(sites, (s) => (s.bucket as string) === 'LinkedStakeholder').length,
    0,
    'never reports LinkedStakeholders as a site',
  );
});

test('the target holds references back, and the two sides sum to what the API reports', () => {
  const sites = findProcessReferenceSites(holder(), [TARGET_ID]);
  const backSites = findProcessReferenceSites(target(), [HOLDER_ID]);
  assert.equal(backSites.length, 2, 'the target holds exactly 2 references to the holder');

  // The arithmetic from API_ARCHITECTURE.md: the union of both sides is what the API
  // reports, and it only reconciles when both are walked.
  assert.equal(
    where(sites, (s) => s.category === 'Link').length + where(backSites, (s) => s.category === 'Link').length,
    3,
    'link sites across both sides sum to the 3 the API reports for a query on the target',
  );
});

// ---------------------------------------------------------------- locator, all buckets

test('the locator finds a target in every bucket', () => {
  const a = findProcessReferenceSites(allBuckets(), ['TARGET-A']);
  assert.equal(where(a, (s) => s.bucket === 'Activity').length, 1, 'finds an Activity-level link');
  assert.equal(where(a, (s) => s.bucket === 'Decision').length, 1, 'finds a Decision link');
  assert.equal(where(a, (s) => s.bucket === 'ProcessLink').length, 1, 'finds a ProcessLink');
  assert.equal(where(a, (s) => s.bucket === 'OrphanProcessLink').length, 1, 'finds an OrphanProcessLink');
  assert.equal(where(a, (s) => s.bucket === 'OrphanEmbeddedProcessLink').length, 1, 'finds an OrphanEmbeddedProcessLink');
  assert.equal(where(a, (s) => s.bucket === 'Note').length, 1, 'finds a child Note');
  assert.equal(where(a, (s) => s.category === 'Input').length, 1, 'finds an Input');
  assert.equal(a.length, 7, 'finds all 7 TARGET-A sites');

  const b = findProcessReferenceSites(allBuckets(), ['TARGET-B']);
  assert.equal(where(b, (s) => s.bucket === 'EmbeddedProcessLink').length, 1, 'finds an EmbeddedProcessLink');
  assert.equal(where(b, (s) => s.category === 'Output').length, 1, 'finds an Output');
  assert.equal(where(b, (s) => s.bucket === 'WebLink').length, 1, 'finds a WebLink nested two levels deep');
  assert.equal(b.length, 4, 'finds all 4 TARGET-B sites');
});

test('group links are found only by group id, and only reported', () => {
  const g = findProcessReferenceSites(allBuckets(), [], ['GROUP-1']);
  assert.equal(g.length, 1, 'finds the ProcessGroupLink when a group id is supplied');
  assert.equal(g[0]?.action, 'Report', 'group links are report-only');
});

test('a multi-target search returns the union', () => {
  const both = findProcessReferenceSites(allBuckets(), ['TARGET-A', 'TARGET-B']);
  assert.equal(both.length, 11, 'multi-target search returns the union of both site sets');
});

// ---------------------------------------------------------------- remover

test('the remover clears every reference on a copy, and leaves the rest', () => {
  const model = holder();
  const notePath = ['ProcessProcedures', 'Activity', 1, 'ChildProcessProcedures', 'Note', 0] as const;
  const originalText = dig(model, ...notePath, 'Text');

  const result = removeProcessReferences(model, [TARGET_ID]);
  assert.equal(result.referencesRemoved, 3, 'removes all 3 of the holder\'s references');
  assert.equal(findProcessReferenceSites(result.cleaned, [TARGET_ID]).length, 0, 'no references survive the removal');
  assert.equal(findProcessReferenceSites(model, [TARGET_ID]).length, 3, 'the caller-supplied object is not mutated');

  const clean = result.cleaned;
  assert.equal(count(dig(clean, 'ProcessProcedures', 'ProcessLink')), 0, 'the matching ProcessLink element is dropped');
  assert.equal(count(dig(clean, 'Inputs', 'Input')), 0, 'the matching Input element is dropped');
  assert.equal(count(dig(clean, 'LinkedStakeholders', 'LinkedStakeholder')), 2, 'LinkedStakeholders is left intact');
  assert.equal(count(dig(clean, 'ProcessProcedures', 'Activity')), 2, 'activities are preserved');

  const note = dig(clean, ...notePath);
  assert.equal(dig(note, 'LinkedProcessUniqueId'), null, 'the child Note link is cleared');
  assert.equal(dig(note, 'LinkedProcessId'), null, 'the child Note LinkedProcessId is cleared');
  assert.ok(typeof originalText === 'string' && originalText !== '');
  assert.equal(dig(note, 'Text'), originalText, 'the child Note keeps its text rather than being deleted');
});

// ---------------------------------------------------------------- orphan semantics

test('orphaning keeps the element and its breadcrumb, and touches nothing unrelated', () => {
  const result = removeProcessReferences(allBuckets(), ['TARGET-A']);
  const ac = result.cleaned;
  assert.equal(result.referencesRemoved, 7, 'removes all 7 TARGET-A references');

  const decisions = list(dig(ac, 'ProcessProcedures', 'Decision'));
  assert.equal(decisions.length, 2, 'decisions are orphaned, never deleted');
  assert.equal(dig(decisions[0], 'DecisionLinkType'), 7, 'a live decision link (4) becomes orphaned (7)');
  assert.equal(dig(decisions[0], 'LinkedProcessDisplayName'), 'Target A', 'orphaned decision keeps LinkedProcessDisplayName');
  assert.equal(dig(decisions[0], 'LinkedProcessUniqueId'), null, 'orphaned decision clears LinkedProcessUniqueId');
  assert.equal(dig(decisions[1], 'DecisionLinkType'), 4, 'an unrelated decision keeps DecisionLinkType 4');
  assert.equal(dig(decisions[1], 'LinkedProcessUniqueId'), 'SOMETHING-ELSE', 'an unrelated decision is untouched');

  const activity = dig(ac, 'ProcessProcedures', 'Activity', 0);
  assert.equal(dig(activity, 'EmbeddedLinkedProcessId'), null, 'orphaning clears EmbeddedLinkedProcessId');
  assert.equal(dig(activity, 'LinkedProcessGroupUniqueId'), null, 'orphaning clears the group fields of the same link');
  assert.equal(dig(activity, 'LinkedProcessDisplayName'), 'Target A', 'orphaning keeps the display name breadcrumb');

  const links = list(dig(ac, 'ProcessProcedures', 'ProcessLink')).map((l) => dig(l, 'LinkedProcessUniqueId'));
  assert.equal(links.length, 2, 'only the matching ProcessLink is dropped');
  assert.ok(links.includes('SOMETHING-ELSE'), 'the unrelated ProcessLink survives');
  assert.ok(links.includes('TARGET-B'), 'the other target ProcessLink survives a single-target removal');

  assert.equal(count(dig(ac, 'Inputs', 'Input')), 1, 'only the matching Input is dropped');
  assert.equal(count(dig(ac, 'ProcessProcedures', 'ProcessGroupLink')), 1, 'group links are never removed');
  assert.equal(count(dig(ac, 'Outputs', 'Output')), 1, 'unrelated Outputs survive');

  const unrelatedTask = dig(ac, 'ProcessProcedures', 'Activity', 0, 'ChildProcessProcedures', 'Task', 0);
  assert.equal(dig(unrelatedTask, 'LinkedProcessUniqueId'), 'SOMETHING-ELSE', 'an unrelated child link is untouched');

  const deep = dig(ac, 'ProcessProcedures', 'Activity', 0, 'ChildProcessProcedures', 'Note', 0, 'ChildProcessProcedures', 'WebLink', 0);
  assert.equal(dig(deep, 'LinkedProcessUniqueId'), 'TARGET-B', 'a two-deep child pointing elsewhere is untouched');
});

test('a multi-target removal clears every site in one pass', () => {
  const result = removeProcessReferences(allBuckets(), ['TARGET-A', 'TARGET-B']);
  assert.equal(result.referencesRemoved, 11, 'a multi-target removal clears every site in one pass');
  assert.equal(
    findProcessReferenceSites(result.cleaned, ['TARGET-A', 'TARGET-B']).length,
    0,
    'nothing survives a multi-target removal',
  );
  assert.equal(count(dig(result.cleaned, 'ProcessProcedures', 'ProcessLink')), 1, 'the unrelated ProcessLink still survives');
});

// ---------------------------------------------------------------- null and shape tolerance

test('an empty or null model yields no sites', () => {
  assert.equal(findProcessReferenceSites({}, [TARGET_ID]).length, 0, 'an empty object yields no sites');
  assert.equal(findProcessReferenceSites(null, [TARGET_ID]).length, 0, 'a null process yields no sites');
});

test('the real holder fixture carries a null Outputs', () => {
  // A naive walk indexes into it and throws.
  const model = holder();
  assert.ok('Outputs' in model);
  assert.equal(model['Outputs'], null, 'the real fixture really does carry a null Outputs');
});

test('a bare-object bucket is walked, and ids match whatever their case', () => {
  const single = JSON.parse('{"UniqueId":"H","ProcessProcedures":{"ProcessLink":{"Id":1,"LinkedProcessUniqueId":"TARGET-A"}}}') as ProcessModel;
  assert.equal(
    findProcessReferenceSites(single, ['TARGET-A']).length,
    1,
    'a bucket collapsed to a bare object is still walked',
  );

  const mixedCase: ProcessModel = { UniqueId: 'H', Inputs: { Input: [{ Id: 1, FromProcessUniqueId: TARGET_ID.toUpperCase() }] } };
  assert.equal(findProcessReferenceSites(mixedCase, [TARGET_ID]).length, 1, 'GUID matching is case-insensitive');
});

// ---------------------------------------------------------------- the narrow Input/Output finder

test('the Input/Output finder agrees with the full walk', () => {
  // The blind-spot sweep uses the narrow finder instead of walking every activity tree
  // and discarding the result. The two must agree on Input and Output sites.
  const model = holder();
  const viaFull = findProcessReferenceSites(model, [TARGET_ID]).filter(
    (s) => s.category === 'Input' || s.category === 'Output',
  );
  const viaNarrow = findInputOutputReferenceSites(model, [TARGET_ID]);

  assert.equal(viaNarrow.length, viaFull.length, 'the narrow finder finds the same number of Input/Output sites');
  assert.deepEqual(
    viaNarrow.map((s) => s.path),
    viaFull.map((s) => s.path),
    'the narrow finder reports the same paths as the full walk',
  );
  assert.equal(
    viaNarrow.filter((s) => s.category === 'Link').length,
    0,
    'the narrow finder never returns Link sites',
  );
  assert.equal(findInputOutputReferenceSites(null, [TARGET_ID]).length, 0, 'a null process yields no sites rather than throwing');
});
