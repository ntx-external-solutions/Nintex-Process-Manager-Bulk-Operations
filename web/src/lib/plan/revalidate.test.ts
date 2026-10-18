import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChildTreeItemsResponse, TreeItem, TreeItemType } from '../pm/types.ts';
import type { PlanGateway } from './load.ts';
import { revalidatePlacements, type Placement } from './revalidate.ts';

let nextId = 700;
function item(uniqueId: string, itemType: TreeItemType = 'process'): TreeItem {
  return {
    id: nextId++,
    uniqueId,
    title: uniqueId,
    itemType,
    itemOrder: 0,
    hasChild: false,
    totalSubgroups: null,
    totalStakeholderUsers: null,
    totalPermissionRoles: null,
    totalPermissionUsers: null,
    variationSetId: null,
  };
}

/** A gateway over fixed levels, recording which were read. */
function gateway(levels: Record<string, TreeItem[] | 'fail'>) {
  const fetched: string[] = [];
  const impl: PlanGateway = {
    async groupsTree(parentUniqueId): Promise<ChildTreeItemsResponse> {
      const key = parentUniqueId ?? '__root__';
      fetched.push(key);
      const level = levels[key];
      if (level === 'fail') throw new Error('HTTP 500');
      return { treeItems: level ?? [], parentUniqueId };
    },
  };
  return { impl, fetched };
}

function at(uniqueId: string, parentUniqueId: string | null): Placement {
  return { uniqueId, parentUniqueId, display: uniqueId, parentDisplay: parentUniqueId ?? 'the top level' };
}

test('a plan that still matches the tenant produces nothing', async () => {
  const g = gateway({ 'g-1': [item('p-1'), item('p-2')] });
  assert.deepEqual(await revalidatePlacements(g.impl, [at('p-1', 'g-1'), at('p-2', 'g-1')]), []);
});

test('an item that has gone from its level is reported', async () => {
  const g = gateway({ 'g-1': [item('p-1')] });
  const findings = await revalidatePlacements(g.impl, [at('p-1', 'g-1'), at('p-2', 'g-1')]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.uniqueId, 'p-2');
  assert.match(findings[0]?.message ?? '', /not in g-1 any more/);
});

test('each level is read once however many items share it', async () => {
  const g = gateway({ 'g-1': [item('a'), item('b'), item('c')], 'g-2': [item('d')] });
  await revalidatePlacements(g.impl, [at('a', 'g-1'), at('b', 'g-1'), at('c', 'g-1'), at('d', 'g-2')]);
  assert.deepEqual(g.fetched.sort(), ['g-1', 'g-2']);
});

test('the top level is read with a null parent', async () => {
  const g = gateway({ __root__: [item('top', 'group')] });
  assert.deepEqual(await revalidatePlacements(g.impl, [at('top', null)]), []);
  assert.deepEqual(g.fetched, ['__root__']);
});

test('a level that cannot be read is not treated as evidence of a conflict', async () => {
  const g = gateway({ 'g-1': 'fail' });
  assert.deepEqual(await revalidatePlacements(g.impl, [at('p-1', 'g-1')]), []);
});
