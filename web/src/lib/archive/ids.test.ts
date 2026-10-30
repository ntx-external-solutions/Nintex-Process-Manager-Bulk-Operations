// W7: Bulk Archive by id or CSV. Ids resolve against the index Archive already reads,
// join the tree's targets each process once, get the same variation review, are checked
// again before the run, and never make a group a cleanup candidate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planCleanup } from '../cleanup/plan.ts';
import { UNKNOWN_NAME } from '../exec/report.ts';
import type { GroupFacts } from '../cleanup/plan.ts';
import type { VariationSet } from '../pm/processes.ts';
import type { TreeItem } from '../pm/types.ts';
import { afterFileRead, chosenLabel, EMPTY_ID_INPUT } from '../select/ids.ts';
import type { CoveredGroup, ResolvedProcess } from '../select/resolve.ts';
import type { IndexEntry, ProcessIndex } from '../tenant/state.ts';
import {
  ALREADY_ARCHIVED,
  CHOSEN_BY_ID,
  CHOSEN_FROM_TREE,
  combineSelections,
  groupsOfPicked,
  idTargetFindings,
  idTargetsNeedingSetReads,
  NOT_AN_ID,
  NOT_FOUND,
  readGroupLevels,
  resolveArchiveIds,
  withGroupPaths,
} from './ids.ts';
import { buildArchivePlan } from './plan.ts';

const g = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const p = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function entry(n: number, name: string, isArchived: boolean, group: number): IndexEntry {
  return { uniqueId: p(n), name, isArchived, groupId: group, groupUniqueId: g(group), groupName: `Group ${group}`, groupExists: true, numericId: 1000 + n };
}

const INDEX: ProcessIndex = new Map(
  [
    entry(1, 'Pay a supplier', false, 10),
    entry(2, 'Close the month', false, 10),
    entry(3, 'Old payroll', true, 10),
    entry(4, 'Onboard a starter', false, 20),
    entry(5, 'Invoice::Export', false, 20),
    entry(6, 'Invoice', false, 30),
  ].map((e) => [e.uniqueId.toLowerCase(), e]),
);

function treeProcess(n: number, group: number, path: string[], variationSetId: number | null = null): ResolvedProcess {
  return { uniqueId: p(n), id: n, title: INDEX.get(p(n))!.name, itemType: 'process', groupUniqueId: g(group), groupId: group, path, variationSetId };
}

function node(uniqueId: string, itemType: string, variationSetId: number | null = null): TreeItem {
  return { id: 1, uniqueId, title: 't', itemType, itemOrder: 0, hasChild: false, variationSetId } as TreeItem;
}

const groupOf = (n: number, depth = 1): CoveredGroup => ({ uniqueId: g(n), id: n, title: `Group ${n}`, parentUniqueId: null, path: [], depth });

test('an active process is a target; archived, unknown and non-ids are left out with their rows', () => {
  const unknownGuid = '99999999-9999-4999-8999-999999999999';
  const r = resolveArchiveIds([p(1).toUpperCase(), p(3), unknownGuid, '1004', '777', 'Pay a supplier', p(1)], INDEX);
  assert.deepEqual(
    r.processes.map((x) => [x.uniqueId, x.groupUniqueId, x.chosen]),
    [
      [p(1), g(10), CHOSEN_BY_ID],
      [p(4), g(20), CHOSEN_BY_ID],
    ],
    'a GUID in any case and a numeric id both resolve, each process once',
  );
  assert.deepEqual(
    r.skipped.map((row) => [row.operation, row.status, row.objectId, row.name, row.message]),
    [
      ['Select', 'Skipped', p(3), 'Old payroll', ALREADY_ARCHIVED],
      ['Resolve', 'Skipped', unknownGuid, UNKNOWN_NAME, NOT_FOUND],
      ['Resolve', 'Skipped', '777', UNKNOWN_NAME, NOT_FOUND],
      ['Resolve', 'Skipped', 'Pay a supplier', UNKNOWN_NAME, NOT_AN_ID],
    ],
    'a name is never matched, even one that is in the index',
  );
  assert.deepEqual(r.unknown, [unknownGuid, '777', 'Pay a supplier']);
});

test('a shortcut’s id is its home process’s, so by id it resolves to the home process in its own group', () => {
  // The tree lists the shortcut in group 30 with the home process's id; the tree excludes it.
  const shortcut = node(p(4), 'linked-process');
  const tree = {
    processes: [] as ResolvedProcess[],
    excluded: [{ uniqueId: shortcut.uniqueId, title: 'Onboard a starter', itemType: 'linked-process', path: ['Group 30'], reason: 'Shortcut' }],
    groups: [groupOf(30)],
  };
  const combined = combineSelections(tree, resolveArchiveIds([p(4)], INDEX));
  assert.deepEqual(combined.processes.map((x) => [x.uniqueId, x.groupUniqueId]), [[p(4), g(20)]]);
  const plan = buildArchivePlan(combined, INDEX);
  assert.deepEqual(plan.targets.map((t) => [t.name, t.groupId]), [['Onboard a starter', 20]]);
});

test('the tree and the ids add up, each process once, the tree’s placement first', () => {
  const tree = { processes: [treeProcess(1, 10, ['Finance']), treeProcess(2, 10, ['Finance'])], excluded: [], groups: [groupOf(10)] };
  const input = afterFileRead(EMPTY_ID_INPUT, 'ids.csv', `ProcessID\r\n${p(2)}\r\n${p(4)}\r\n`);
  const typed = `${input.text}\n1001`;
  const ids = resolveArchiveIds(typed.split('\n'), INDEX, (v) => chosenLabel(input, v));
  const plan = buildArchivePlan(combineSelections(tree, ids), INDEX);
  assert.deepEqual(
    plan.targets.map((t) => [t.name, t.chosen]),
    [
      ['Pay a supplier', CHOSEN_FROM_TREE],
      ['Close the month', CHOSEN_FROM_TREE],
      ['Onboard a starter', 'From ids.csv'],
    ],
  );
  assert.equal(chosenLabel(input, '1001'), CHOSEN_BY_ID, 'an id typed after the upload is "By id"');
});

test('an id target is shown under its group’s path, or the listing’s group name when the path is unknown', () => {
  const ids = resolveArchiveIds([p(1), p(4)], INDEX);
  assert.deepEqual(groupsOfPicked(ids.processes), [g(10), g(20)]);
  const placed = withGroupPaths(ids.processes, new Map([[g(10), ['Finance', 'Payables']]]));
  const plan = buildArchivePlan(combineSelections(null, { ...ids, processes: placed }), INDEX);
  assert.deepEqual(plan.targets.map((t) => t.path), [['Finance', 'Payables'], ['Group 20']]);
});

test('an id target in a variation set gets the same review as a tree target', () => {
  const ids = resolveArchiveIds([p(1), p(4), p(5)], INDEX);
  const levels = new Map<string, readonly TreeItem[] | null>([
    // p(1) is shown, not in a set; p(4) is shown with a set id; p(5)'s level could not be read.
    [g(10), [node(p(1), 'process'), node(p(2), 'process')]],
    [g(20), [node(p(4), 'process', 77)]],
  ]);
  assert.deepEqual(idTargetsNeedingSetReads(ids.processes, levels), [p(4), p(5)]);
  assert.deepEqual(
    idTargetsNeedingSetReads(ids.processes, new Map([[g(10), [node(p(2), 'process')]]])),
    [p(1), p(4), p(5)],
    'a target its level does not show is read: the tree shows one variation per set',
  );

  const set: VariationSet = { id: 77, name: 'Onboarding', group: { id: 20, uniqueId: g(20), name: 'Group 20' }, others: [{ uniqueId: p(2), variationName: 'Contractors', isArchived: false }] } as unknown as VariationSet;
  const plan = buildArchivePlan(combineSelections(null, ids), INDEX, new Map([[p(4).toLowerCase(), set]]));
  assert.deepEqual(
    plan.variations.map((v) => [v.signal, v.targetName, v.relativeName]),
    [
      ['set', 'Onboard a starter', 'Close the month'],
      ['name', 'Invoice::Export', 'Invoice'],
    ],
    'the set read and the name match both apply',
  );
});

test('the run’s fresh read catches an id target archived, moved or gone since the plan', () => {
  const tree = { processes: [treeProcess(2, 10, ['Finance'])], excluded: [], groups: [] };
  const plan = buildArchivePlan(combineSelections(tree, resolveArchiveIds([p(1), p(4), p(6)], INDEX)), INDEX);
  const baseline = new Map(INDEX);
  baseline.set(p(1).toLowerCase(), { ...INDEX.get(p(1))!, isArchived: true });
  baseline.set(p(4).toLowerCase(), { ...INDEX.get(p(4))!, groupId: 30, groupUniqueId: g(30) });
  baseline.delete(p(6).toLowerCase());
  baseline.set(p(2).toLowerCase(), { ...INDEX.get(p(2))!, isArchived: true });
  const findings = idTargetFindings(plan.targets, baseline);
  assert.deepEqual(findings.map((f) => f.uniqueId), [p(1), p(4), p(6)], 'tree targets are checked by their tree level instead');
  assert.match(findings[0]!.message, /"Pay a supplier" has been archived since this plan was built\. Plan again/);
  assert.match(findings[1]!.message, /is not in Group 20 any more/);
  assert.match(findings[2]!.message, /in neither process list any more/);
  assert.deepEqual(idTargetFindings(plan.targets, INDEX), [], 'nothing changed, nothing found');
});

test('a group emptied only by ids is never offered for cleanup', () => {
  const emptied: GroupFacts = { children: [], documents: { total: 0, names: [] }, archived: [] };
  const idsOnly = buildArchivePlan(combineSelections(null, resolveArchiveIds([p(1), p(2)], INDEX)), INDEX);
  assert.deepEqual(idsOnly.groups, []);
  assert.deepEqual(planCleanup(idsOnly.groups, new Map([[g(10), emptied]])), []);

  const tree = { processes: [treeProcess(6, 30, ['Group 30'])], excluded: [], groups: [groupOf(30)] };
  const mixed = buildArchivePlan(combineSelections(tree, resolveArchiveIds([p(4), p(5)], INDEX)), INDEX);
  assert.deepEqual(mixed.groups.map((x) => x.uniqueId), [g(30)], 'only the checked group, not group 20 the ids emptied');
  assert.deepEqual(
    planCleanup(mixed.groups, new Map([[g(30), emptied], [g(20), emptied]])).map((d) => d.group.uniqueId),
    [g(30)],
  );
});

test('the plan lists the id rows first, as Delete’s results do', () => {
  const tree = { processes: [treeProcess(3, 10, ['Finance'])], excluded: [], groups: [] };
  const plan = buildArchivePlan(combineSelections(tree, resolveArchiveIds(['nope'], INDEX)), INDEX);
  assert.deepEqual(plan.skipped.map((r) => [r.operation, r.message]), [
    ['Resolve', NOT_AN_ID],
    ['Archive', 'Already archived'],
  ]);
});

test('group levels are read a few at a time; a level that fails is null, a dead session stops the plan', async () => {
  const levels = await readGroupLevels([g(1), g(2), g(3)], async (id) => {
    if (id === g(2)) throw new Error('500');
    return [node(p(1), 'process')];
  }, { concurrency: 2 });
  assert.deepEqual([...levels.entries()].map(([k, v]) => [k, v === null]), [[g(1), false], [g(2), true], [g(3), false]]);
  await assert.rejects(
    readGroupLevels([g(1)], async () => { throw new Error('signed out'); }, { isFatal: () => true }),
    /signed out/,
  );
});
