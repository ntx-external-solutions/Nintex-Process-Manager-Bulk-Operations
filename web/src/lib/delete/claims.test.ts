// Ported from Tests/Test-Dependencies.ps1: "Claims parsing", "Inversion" and
// "Reconciliation".
//
// The response is rebuilt from the fixtures rather than pasted: it is the shape the
// API returned when the target was queried with both processes active, three Linked
// Process rows naming the holder (with the trailing space the API sent) and one Process
// Input row.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dependencyCandidates,
  groupSitesByHolder,
  parseDependencyResponse,
  reconcileDependencies,
  type DependencyClaim,
} from './claims.ts';
import type { ProcessModel } from './model.ts';
import { PHASE } from './phases.ts';
import { findProcessReferenceSites } from './references.ts';
import { readFixture } from './testing/fixtures.ts';

type Fixture = ProcessModel & { UniqueId: string; Name: string };

const holder = () => readFixture<Fixture>('ActionCustomerRequest.json');
const target = () => readFixture<Fixture>('DependencyTest.json');
const allBuckets = () => readFixture<Fixture>('AllBuckets.json');
const HOLDER_ID = holder().UniqueId;
const TARGET_ID = target().UniqueId;

function targetQueryResponse(): unknown {
  const named = { Name: `${holder().Name} `, UniqueId: HOLDER_ID };
  return [
    { Type: 'Linked Process', Dependencies: [{ ...named }, { ...named }, { ...named }] },
    { Type: 'Process Input', Dependencies: [{ ...named }] },
  ];
}

const targetClaims = (): DependencyClaim[] => parseDependencyResponse(targetQueryResponse(), TARGET_ID);

/** Both sides of the real pair walked: the holder's 3 sites and the target's 2. */
const pairSites = () => [
  ...findProcessReferenceSites(holder(), [TARGET_ID]),
  ...findProcessReferenceSites(target(), [HOLDER_ID]),
];

// ---------------------------------------------------------------- claims parsing

test('every occurrence in the response becomes a claim', () => {
  const claims = targetClaims();
  assert.equal(claims.length, 4, 'every occurrence becomes a claim, duplicates included');
  assert.equal(claims.filter((c) => c.category === 'Link').length, 3, 'the 3 duplicate Linked Process rows are all kept');
  assert.equal(claims.filter((c) => c.category === 'Input').length, 1, 'the Process Input row is categorised');
});

test('a one-entry response and a null response', () => {
  const single = JSON.parse('[{"Type":"Linked Process","Dependencies":[{"Name":"X","UniqueId":"TARGET-A"}]}]') as unknown;
  assert.equal(parseDependencyResponse(single, 'Q').length, 1, 'a single-entry response is not lost to array collapsing');
  assert.equal(parseDependencyResponse(null, 'Q').length, 0, 'a null response yields no claims');
});

test('both sides of a claim are fetched, and group claims are not', () => {
  assert.equal(dependencyCandidates(targetClaims(), [TARGET_ID]).length, 2, 'both sides of a claim become fetch candidates');

  const groupClaim = [{ Type: 'Linked Process Group', Dependencies: [{ Name: 'G', UniqueId: 'GROUP-1' }] }];
  const gc = parseDependencyResponse(groupClaim, 'Q');
  assert.equal(dependencyCandidates(gc, ['Q']).length, 1, 'group claims are not fetched as processes');
});

// ---------------------------------------------------------------- inversion

test('sites invert to one work item per holder', () => {
  const work = groupSitesByHolder(pairSites());
  assert.equal(work.length, 2, 'sites invert to one work item per holder');

  const holderWork = work.find((w) => w.holderUniqueId === HOLDER_ID);
  assert.equal(holderWork?.sites.length, 3, 'the holder\'s work item carries all 3 of its sites');
  assert.equal(holderWork?.targetsAffected.length, 1, 'the holder\'s work item names 1 affected target');
});

test('report-only group sites are not work', () => {
  const model = allBuckets();
  const withGroup = [
    ...findProcessReferenceSites(model, ['TARGET-A']),
    ...findProcessReferenceSites(model, [], ['GROUP-1']),
  ];
  const work = groupSitesByHolder(withGroup);
  assert.equal(
    work.find((w) => w.holderUniqueId === model.UniqueId)?.sites.length,
    7,
    'report-only group sites are excluded from work items',
  );
});

// ---------------------------------------------------------------- reconciliation

test('a query on the target reconciles against both sides', () => {
  const rec = reconcileDependencies({
    queriedUniqueId: TARGET_ID,
    relatedUniqueId: HOLDER_ID,
    claims: targetClaims(),
    sites: pairSites(),
    relatedIsArchived: false,
  });

  const link = rec.find((r) => r.category === 'Link');
  assert.equal(link?.claimed, 3, 'a query on the target claims 3 link references');
  assert.equal(link?.located, 3, 'walking both sides locates 3 link references');
  assert.equal(link?.status, 'Match', 'the union reconciles exactly');

  const input = rec.find((r) => r.category === 'Input');
  assert.equal(input?.claimed, 1, 'a query on the target claims 1 input reference');
  assert.equal(input?.status, 'Match', 'the input reconciles');
});

test('an archived related process suppresses the Input claim, not the reference', () => {
  // With the holder archived the API drops the Input row, but the reference still exists.
  const rec = reconcileDependencies({
    queriedUniqueId: TARGET_ID,
    relatedUniqueId: HOLDER_ID,
    claims: targetClaims().filter((c) => c.category !== 'Input'),
    sites: pairSites(),
    relatedIsArchived: true,
  });

  const input = rec.find((r) => r.category === 'Input');
  assert.equal(input?.claimed, 0, 'an archived related process suppresses the Input claim');
  assert.equal(input?.located, 1, 'the suppressed reference is still located in the JSON');
  assert.equal(input?.status, 'Match', 'suppression is expected, not a mismatch');
  assert.match(input?.note ?? '', /suppressed/, 'the suppression is called out in the note');
});

test('Input is scoped to the queried side, where Link is a union', () => {
  // Measured, not assumed: the pair holds one Input each way, but each query reports
  // exactly one, so Input is not the union that Link is. Reconciliation scopes
  // Input/Output to the queried process's own sites.
  const sites = pairSites();
  const inputSites = sites.filter((s) => s.category === 'Input');
  assert.equal(inputSites.length, 2, 'the pair really does hold one Input in each direction');
  assert.equal(inputSites.filter((s) => s.holderUniqueId === TARGET_ID).length, 1, 'the target holds one of them');
  assert.equal(inputSites.filter((s) => s.holderUniqueId === HOLDER_ID).length, 1, 'the holder holds the other');

  const fromHolder = [{ Type: 'Process Input', Dependencies: [{ Name: target().Name, UniqueId: TARGET_ID }] }];
  const rec = reconcileDependencies({
    queriedUniqueId: HOLDER_ID,
    relatedUniqueId: TARGET_ID,
    claims: parseDependencyResponse(fromHolder, HOLDER_ID),
    sites,
    relatedIsArchived: false,
  });
  const input = rec.find((r) => r.category === 'Input');
  assert.equal(input?.located, 1, 'querying the other side scopes to that side\'s own Input');
  assert.equal(input?.status, 'Match', 'Input reconciles from either side under the scoped rule');

  // Link stays a union: scoping it the same way would under-count and hide sites.
  assert.equal(sites.filter((s) => s.category === 'Link').length, 3, 'link sites are counted across both sides');
});

test('located sites with no claims is a mismatch', () => {
  const rec = reconcileDependencies({
    queriedUniqueId: TARGET_ID,
    relatedUniqueId: HOLDER_ID,
    claims: [],
    sites: pairSites(),
    relatedIsArchived: false,
  });
  assert.equal(
    rec.find((r) => r.category === 'Link')?.status,
    'Mismatch',
    'located sites with no claims is flagged as a mismatch',
  );
});
