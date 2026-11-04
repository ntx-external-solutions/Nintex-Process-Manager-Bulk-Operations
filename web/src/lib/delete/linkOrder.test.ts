// F8: the order targets are deleted in and the cycles among them, from sites and claims
// alone. What the run does with them is in linkDelete.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DependencyClaim } from './claims.ts';
import { groupBlocksOf, hasProcessGroupLink, planLinkOrder } from './linkOrder.ts';
import type { ReferenceSite } from './references.ts';

const site = (holderUniqueId: string, targetUniqueId: string, overrides: Partial<ReferenceSite> = {}): ReferenceSite => ({
  holderUniqueId,
  targetUniqueId,
  path: 'ProcessProcedures.ProcessLink[0]',
  bucket: 'ProcessLink',
  category: 'Link',
  action: 'Remove',
  matchedField: 'LinkedProcessUniqueId',
  elementId: 1,
  isChild: false,
  ...overrides,
});

const claim = (queriedUniqueId: string, relatedUniqueId: string, overrides: Partial<DependencyClaim> = {}): DependencyClaim => ({
  queriedUniqueId,
  relatedUniqueId,
  relatedName: relatedUniqueId,
  type: 'Linked Process',
  category: 'Link',
  ...overrides,
});

test('holders come before what they link to, whatever order the targets were given in', () => {
  const links = planLinkOrder(['c', 'b', 'a'], [site('a', 'b'), site('b', 'c')], []);
  assert.deepEqual(links.order, ['a', 'b', 'c']);
  assert.deepEqual(links.cycles, []);
  assert.deepEqual(links.cycleWork, []);
});

test('unlinked targets keep their order, and a tie goes to the earlier target', () => {
  assert.deepEqual(planLinkOrder(['x', 'y', 'z'], [], []).order, ['x', 'y', 'z']);
  assert.deepEqual(planLinkOrder(['b', 'x', 'a', 'y'], [site('a', 'b')], []).order, ['x', 'a', 'b', 'y']);
});

test('a claim names the holder when the walk missed the site', () => {
  // Measured: the check lists a link on the linked-to side, so b's check naming a is a link from a.
  assert.deepEqual(planLinkOrder(['b', 'a'], [], [claim('b', 'a')]).order, ['a', 'b']);
});

test('only claims of a link give an order: Input and group claims say nothing about who blocks whom', () => {
  const links = planLinkOrder(['b', 'a'], [], [claim('b', 'a', { type: 'Process Input', category: 'Input' }), claim('b', 'a', { type: 'Linked Process Group', category: 'Group' })]);
  assert.deepEqual(links.order, ['b', 'a']);
  assert.deepEqual(links.edges, []);
});

test('a claim the walk explains the other way round makes no cycle', () => {
  // The API labels some Input references as links. a holds the Input from b; a's check
  // calls that a link. Read as a holder, it would make one reference into a loop.
  const input = site('a', 'b', { bucket: 'Input', category: 'Input', path: 'Inputs.Input[0]', matchedField: 'FromProcessUniqueId' });
  const links = planLinkOrder(['b', 'a'], [input], [claim('a', 'b')]);
  assert.deepEqual(links.cycles, []);
  assert.deepEqual(links.order, ['a', 'b']);
});

test('sites and claims are matched whatever the casing, and a process linking to itself is no edge', () => {
  const links = planLinkOrder(['BB', 'AA'], [site('aa', 'bb'), site('aa', 'aa')], [claim('bb', 'AA'), claim('aa', 'aa')]);
  assert.deepEqual(links.order, ['AA', 'BB']);
  assert.deepEqual(links.edges, [{ holderUniqueId: 'AA', targetUniqueId: 'BB' }]);
  assert.deepEqual(links.cycles, []);
});

test('a link to something that is not a target is no edge', () => {
  assert.deepEqual(planLinkOrder(['a'], [site('a', 'holder'), site('holder', 'a')], [claim('a', 'holder')]).edges, []);
});

test('a two-process cycle: each member removes its link to the other, and the order still has both', () => {
  const links = planLinkOrder(['a', 'b'], [site('a', 'b'), site('b', 'a')], []);
  assert.deepEqual(links.cycles, [['a', 'b']]);
  assert.deepEqual(links.cycleWork.map((w) => [w.holderUniqueId, w.targetsAffected]), [['a', ['b']], ['b', ['a']]]);
  assert.deepEqual(links.edges, []);
  assert.deepEqual(links.order, ['a', 'b']);
});

test('a three-process cycle, with a chain hanging off it that is not part of the loop', () => {
  // in -> a -> b -> c -> a, and c -> out. in and out are ordered, not edited.
  const links = planLinkOrder(['out', 'c', 'b', 'a', 'in'], [site('in', 'a'), site('a', 'b'), site('b', 'c'), site('c', 'a'), site('c', 'out')], []);
  assert.deepEqual(links.cycles, [['c', 'b', 'a']]);
  assert.deepEqual(links.cycleWork.flatMap((w) => w.targetsAffected.map((t) => `${w.holderUniqueId}>${t}`)).sort(), ['a>b', 'b>c', 'c>a']);
  const at = (id: string) => links.order.indexOf(id);
  assert.ok(at('in') < at('a'), 'the holder into the loop goes first');
  assert.ok(at('c') < at('out'), 'and what the loop links out to goes after it');
});

test('two separate cycles are two cycles', () => {
  const links = planLinkOrder(['a', 'b', 'c', 'd'], [site('a', 'b'), site('b', 'a'), site('c', 'd'), site('d', 'c')], []);
  assert.deepEqual(links.cycles, [['a', 'b'], ['c', 'd']]);
});

test('a cycle made only of claims is reported, and its members are still ordered: there is nothing to edit', () => {
  const links = planLinkOrder(['a', 'b'], [], [claim('a', 'b'), claim('b', 'a')]);
  assert.deepEqual(links.cycles, [['a', 'b']]);
  assert.deepEqual(links.cycleWork, []);
  assert.deepEqual(links.order, ['a', 'b']);
});

test('only located links inside a loop are removed: a claimed one stays an edge and still orders the pair', () => {
  // a -> b and c -> a are located; b -> c is only claimed. Editing a and c leaves b -> c.
  const links = planLinkOrder(['c', 'b', 'a'], [site('a', 'b'), site('c', 'a')], [claim('c', 'b')]);
  assert.deepEqual(links.cycleWork.map((w) => w.holderUniqueId).sort(), ['a', 'c']);
  assert.deepEqual(links.edges, [{ holderUniqueId: 'b', targetUniqueId: 'c' }]);
  assert.ok(links.order.indexOf('b') < links.order.indexOf('c'));
});

test('a kept target is no part of a cycle: nothing is edited for it, and its link still stands', () => {
  const links = planLinkOrder(['a', 'b'], [site('a', 'b'), site('b', 'a')], [], new Set(['a']));
  assert.deepEqual(links.cycles, []);
  assert.deepEqual(links.cycleWork, []);
  assert.equal(links.edges.length, 2, 'a kept target going on linking to b is what keeps b as well');
});

test('a chain of ten thousand targets neither overflows nor changes the answer', () => {
  const ids = Array.from({ length: 10_000 }, (_, i) => `t${i}`);
  const sites = ids.slice(1).map((id, i) => site(id, ids[i]!));
  const links = planLinkOrder(ids, sites, []);
  assert.deepEqual(links.order, [...ids].reverse());
  assert.deepEqual(links.cycles, []);
});

test('a process group link in a model is found in either bucket, and absent otherwise', () => {
  assert.equal(hasProcessGroupLink({ ProcessProcedures: { ProcessGroupLink: [{ Id: 1 }] } }), true);
  assert.equal(hasProcessGroupLink({ ProcessProcedures: { OrphanProcessGroupLink: [{ Id: 1 }] } }), true);
  assert.equal(hasProcessGroupLink({ ProcessProcedures: { ProcessGroupLink: [], ProcessLink: [{ Id: 1 }] } }), false);
  assert.equal(hasProcessGroupLink({ ProcessProcedures: null }), false);
});

test('group blocks name each group once, say where the link is, and say when nobody could tell', () => {
  const group = (queried: string, relatedName: string) => claim(queried, 'g1', { relatedName, type: 'Linked Process Group', category: 'Group' });
  const blocks = groupBlocksOf(
    ['a', 'b', 'c', 'd'],
    [group('a', 'Reference Library (Group) '), group('a', 'Reference Library (Group)'), group('b', 'Other'), group('c', ''), claim('d', 'a')],
    (id) => (id === 'a' ? { ProcessProcedures: { ProcessGroupLink: [{ Id: 1 }] } } : id === 'b' ? { ProcessProcedures: null } : null),
  );
  assert.deepEqual(blocks, [
    { targetUniqueId: 'a', groups: ['Reference Library (Group)'], linkInModel: true },
    { targetUniqueId: 'b', groups: ['Other'], linkInModel: false },
    { targetUniqueId: 'c', groups: ['g1'], linkInModel: null },
  ]);
});
