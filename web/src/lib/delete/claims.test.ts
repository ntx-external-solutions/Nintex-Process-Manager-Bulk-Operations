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
  reconciliationGate,
  type DependencyClaim,
} from './claims.ts';
import type { ProcessModel } from './model.ts';
import type { ReferenceSite } from './references.ts';
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

test('located sites with no claims fall short of nothing, so they are not a mismatch', () => {
  // DIFFERS from the script, which flagged this as a mismatch. Since W5 phase 4 the pair is
  // judged on its totals, and only a located total below the claimed one is a mismatch
  // (Cowork's live check after W5 phase 3): every site found is removed, so finding more
  // than the API claims misses nothing.
  const rec = reconcileDependencies({
    queriedUniqueId: TARGET_ID,
    relatedUniqueId: HOLDER_ID,
    claims: [],
    sites: pairSites(),
    relatedIsArchived: false,
  });
  const link = rec.find((r) => r.category === 'Link');
  assert.equal(link?.status, 'MatchAcrossCategories', 'located with nothing claimed is not a mismatch');
  assert.equal(reconciliationGate(rec).blocking.length, 0, 'and nothing gates');
});

// ---------------------------------------------------------------- links the API counts twice
// Measured on the W5 phase 2 dry run (API_ARCHITECTURE.md, "Why links reconcile as
// 'claimed 2, located 1'"): the dependency check lists every linked process twice, while
// each holder's model references the target once. 21 of the run's 24 mismatches were
// that shape. Cowork's review: classify it and report it apart, without changing the rule.

const Q = 'f0f00000-0000-0000-0000-00000000000a';
const R = 'f0f00000-0000-0000-0000-00000000000b';

function linkRec(claimed: number, located: number, category: 'Link' | 'Input' = 'Link') {
  const type = category === 'Link' ? 'Linked Process' : 'Process Input';
  const response = [{ Type: type, Dependencies: Array.from({ length: claimed }, () => ({ Name: 'Related', UniqueId: R })) }];
  const sites: ReferenceSite[] = Array.from({ length: located }, (_, i) => ({
    holderUniqueId: category === 'Link' ? R : Q,
    targetUniqueId: category === 'Link' ? Q : R,
    path: `ProcessProcedures.ProcessLink[${i}].LinkedProcessUniqueId`,
    bucket: category === 'Link' ? 'ProcessLink' : 'Input',
    category,
    action: 'Remove',
    matchedField: 'LinkedProcessUniqueId',
    elementId: i,
    isChild: false,
  })) as ReferenceSite[];
  const rec = reconcileDependencies({ queriedUniqueId: Q, relatedUniqueId: R, claims: parseDependencyResponse(response, Q), sites, relatedIsArchived: false });
  return rec.find((r) => r.category === category)!;
}

test('a link claimed exactly twice per located site is a mismatch the API double-counted', () => {
  const one = linkRec(2, 1);
  assert.equal(one.status, 'Mismatch', 'it is still a mismatch: the rule is unchanged');
  assert.equal(one.doubleCounted, true, 'and classified as the double-counted shape');
  assert.match(one.note, /lists each linked process twice/, 'with the cause in the note');
  assert.equal(linkRec(4, 2).doubleCounted, true, 'two references claimed four times is the same shape');
});

test('any other count is a mismatch of its own', () => {
  assert.equal(linkRec(1, 0).doubleCounted, false, 'claimed 1, located 0 is not doubling');
  assert.equal(linkRec(1, 0).status, 'Mismatch');
  assert.equal(linkRec(3, 1).doubleCounted, false, 'claimed 3, located 1 is not doubling');
  assert.equal(linkRec(0, 0).doubleCounted, false, 'claimed 0, located 0 matches');
  assert.equal(linkRec(0, 0).status, 'Match');
  assert.equal(linkRec(1, 1).doubleCounted, false, 'a match is not classified');
  assert.equal(linkRec(2, 1, 'Input').doubleCounted, false, 'the measurement is for links, so an Input is not classified');
});

// ---------------------------------------------------------------- the pair as a whole (W5 phase 4)
// Cowork read both raw models of all 24 mismatched pairs on R11's set: in every one the
// models hold exactly the sites the plan removes. Two were Input references the API labels
// "Linked Process", one a variation's Decision[0] claimed three times, 21 doubled links.

function site(holder: string, target: string, category: 'Link' | 'Input', i = 0): ReferenceSite {
  return {
    holderUniqueId: holder,
    targetUniqueId: target,
    path: category === 'Link' ? `ProcessProcedures.ProcessLink[${i}]` : `Inputs.Input[${i}]`,
    bucket: category === 'Link' ? 'ProcessLink' : 'Input',
    category,
    action: 'Remove',
    matchedField: category === 'Link' ? 'LinkedProcessUniqueId' : 'FromProcessUniqueId',
    elementId: i,
    isChild: false,
  };
}

function pairRec(response: unknown, sites: ReferenceSite[]) {
  return reconcileDependencies({ queriedUniqueId: Q, relatedUniqueId: R, claims: parseDependencyResponse(response, Q), sites, relatedIsArchived: false });
}

const claimed = (type: string, n: number) => ({ Type: type, Dependencies: Array.from({ length: n }, () => ({ Name: 'Related', UniqueId: R })) });

test('an Input the API calls a link reconciles across categories, and keeps both numbers', () => {
  // Claimed 1 Link and 0 Input; located 0 Link and 1 Input, held by the queried process.
  const rec = pairRec([claimed('Linked Process', 1)], [site(Q, R, 'Input')]);
  const link = rec.find((r) => r.category === 'Link');
  assert.equal(link?.status, 'MatchAcrossCategories', 'the pair totals agree, so it is not a mismatch');
  assert.equal(link?.claimed, 1, 'the per-category claim is kept');
  assert.equal(link?.located, 0, 'and the per-category located count');
  assert.match(link?.note ?? '', /claimed Link 1, Input 0, Output 0; located Link 0, Input 1, Output 0/, 'the note carries every category');
  assert.equal(rec.find((r) => r.category === 'Input')?.status, 'MatchAcrossCategories', 'so is the Input row it was counted under');
  assert.deepEqual(reconciliationGate(rec), { blocking: [], overClaims: [], doubleCounted: [] }, 'nothing gates');
});

test('a pair that finds some but fewer than claimed is an over-claim, acknowledged rather than blocking', () => {
  const rec = pairRec([claimed('Linked Process', 3)], [site(R, Q, 'Link')]);
  const link = rec.find((r) => r.category === 'Link');
  assert.equal(link?.status, 'Mismatch', 'still a mismatch');
  assert.equal(link?.overClaim, true, 'flagged as an over-claim');
  assert.equal(link?.doubleCounted, false, 'three times is not the doubled shape');
  const gate = reconciliationGate(rec);
  assert.equal(gate.overClaims.length, 1, 'asked to be acknowledged');
  assert.equal(gate.blocking.length, 0, 'not a stop');
});

test('a pair with nothing located still blocks', () => {
  const rec = pairRec([claimed('Linked Process', 1)], []);
  const gate = reconciliationGate(rec);
  assert.equal(gate.blocking.length, 1, 'nothing found for a claim blocks');
  assert.equal(gate.blocking[0]?.overClaim, undefined, 'and is not an over-claim');
});

test('the shortfall is the pair\'s, not the category\'s', () => {
  // Claimed 2 Link; located 0 Link and 1 Input. The Link row found nothing, but the pair
  // found one site, so it is an over-claim, not a block.
  const rec = pairRec([claimed('Linked Process', 2)], [site(Q, R, 'Input')]);
  const gate = reconciliationGate(rec);
  assert.deepEqual(gate.overClaims.map((r) => r.category), ['Link', 'Input'], 'both rows of the pair take its verdict');
  assert.equal(gate.blocking.length, 0);
});

test('doubled links are reported and never gate, and a plan from before the flags blocks as it did', () => {
  const rec = pairRec([claimed('Linked Process', 2)], [site(R, Q, 'Link')]);
  const gate = reconciliationGate(rec);
  assert.equal(gate.doubleCounted.length, 1, 'listed as doubled');
  assert.equal(gate.blocking.length + gate.overClaims.length, 0, 'and asked about nowhere');

  const old = rec.map(({ doubleCounted: _, overClaim: __, ...r }) => r as (typeof rec)[number]);
  assert.equal(reconciliationGate(old).blocking.length, 1, 'a mismatch without the flags is read as blocking');
});

test('both sides deleted is never judged as a pair', () => {
  const rec = reconcileDependencies({
    queriedUniqueId: Q,
    relatedUniqueId: R,
    claims: parseDependencyResponse([claimed('Linked Process', 3)], Q),
    sites: [],
    relatedIsArchived: false,
    bothSidesDeleted: true,
  });
  assert.ok(rec.every((r) => r.status === 'NotApplicable'));
});
