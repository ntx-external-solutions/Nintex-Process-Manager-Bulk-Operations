import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Journal, step } from '../exec/journal.ts';
import { createControls } from '../exec/runner.ts';
import type { VariationSet } from '../pm/processes.ts';
import type { TreeItem, ValidateActionResponse } from '../pm/types.ts';
import { addBrowseLevel, emptyBrowseTree, type BrowseTree } from '../select/browse.ts';
import { TREE_LEVELS } from '../select/fixtures.ts';
import { EMPTY_SELECTION, toggle, type Selection } from '../select/selection.ts';
import type { IndexEntry } from '../tenant/state.ts';
import { buildMovePlan, classifyValidation, isDraftOverPublished, movePreviewRows, type MovePlan, type MovePlanReads } from './plan.ts';
import { describeOutcome, itemsToMove, runMoves, settleMoves, type MoveGateway } from './run.ts';
import { destinationOf, resolveMoveSelection } from './select.ts';

const FULL = [null, 'g-fin', 'g-ap', 'g-empty', 'g-hr'] as const;

function tree(): BrowseTree {
  let t = emptyBrowseTree();
  for (const p of FULL) t = addBrowseLevel(t, p, TREE_LEVELS[p ?? ''] ?? []);
  return t;
}

function click(t: BrowseTree, ...keys: string[]): Selection {
  let s = EMPTY_SELECTION;
  for (const key of keys) s = toggle(t, s, t.nodes.get(key)!);
  return s;
}

function complete(t: BrowseTree, s: Selection) {
  const r = resolveMoveSelection(t, s);
  assert.equal(r.status, 'complete');
  if (r.status !== 'complete') throw new Error('incomplete');
  return r;
}

// ---------------------------------------------------------------- selection

test('a fully checked group moves as one node, not process by process', () => {
  const t = tree();
  const r = complete(t, click(t, 'g-fin'));
  assert.deepEqual(r.groups.map((g) => g.node.uniqueId), ['g-fin']);
  assert.deepEqual(r.processes, []);
});

test('a group with an exception inside moves its included children one by one', () => {
  const t = tree();
  const r = complete(t, click(t, 'g-fin', 'g-fin>p-close'));
  // Accounts Payable has no exceptions, so it still moves whole.
  assert.deepEqual(r.groups.map((g) => g.node.uniqueId), ['g-ap']);
  assert.deepEqual(r.processes.map((p) => p.node.uniqueId), ['p-exp', 'p-exp-c']);
  // The shortcut under Finance is listed as excluded, with the reason.
  assert.match(r.excluded.find((e) => e.uniqueId === 'p-onb')?.reason ?? '', /Shortcut/);
});

test('a mark left on something no longer in the tree does not stop its group moving whole', () => {
  // Marks can only be placed on loaded nodes, but a refresh can drop the node later.
  const t = tree();
  const s: Selection = new Map([['g-ap', 'include'], ['g-ap>gone', 'exclude']]);
  assert.deepEqual(complete(t, s).groups.map((g) => g.node.uniqueId), ['g-ap']);
});

test('the destination checks: into itself, already there, and a process at the top level', async () => {
  const t = tree();
  const r = complete(t, click(t, 'g-fin', 'g-hr>p-off'));
  const reads = fakeReads();

  const intoOwnSubtree = await buildMovePlan(t, r, destinationOf(t, 'g-ap')!, reads.reads);
  assert.equal(intoOwnSubtree.skipped.find((row) => row.objectId === 'g-fin')?.status, 'Blocked');
  assert.match(intoOwnSubtree.skipped.find((row) => row.objectId === 'g-fin')?.message ?? '', /own subgroups/);

  const alreadyThere = await buildMovePlan(t, complete(t, click(t, 'g-hr>p-off')), destinationOf(t, 'g-hr')!, reads.reads);
  assert.equal(alreadyThere.skipped[0]?.status, 'Skipped');
  assert.match(alreadyThere.skipped[0]?.message ?? '', /Already in People/);

  const topLevel = await buildMovePlan(t, r, destinationOf(t, null)!, reads.reads);
  assert.equal(topLevel.skipped.find((row) => row.objectId === 'p-off')?.status, 'Blocked');
  assert.match(topLevel.skipped.find((row) => row.objectId === 'p-off')?.message ?? '', /top level/);
  // Finance is already at the top level.
  assert.equal(topLevel.skipped.find((row) => row.objectId === 'g-fin')?.status, 'Skipped');
});

test('a document group cannot be a destination', () => {
  assert.equal(destinationOf(tree(), 'g-docs'), null);
});

// ---------------------------------------------------------------- pre-flight

function validation(over: Partial<ValidateActionResponse>): ValidateActionResponse {
  return {
    isValid: true,
    isCancelled: false,
    isPrompt: false,
    title: null,
    message: null,
    continueLabel: null,
    cancelLabel: null,
    additionalInfos: null,
    errorCode: null,
    ...over,
  };
}

test('the pre-flight decides the cost of each process move', () => {
  assert.equal(classifyValidation(validation({})).cost, 'clean');
  assert.deepEqual(
    classifyValidation(validation({ isPrompt: true, title: 'Publish New Version?', message: 'for this change to take effect a new version will be created and published' })),
    { cost: 'republish', message: 'Publish New Version?: for this change to take effect a new version will be created and published' },
  );
  assert.equal(
    classifyValidation(validation({ isPrompt: true, title: 'Publish New Version?', message: "'X' which has outstanding changes, for this change to take effect all other outstanding changes will also be published" })).cost,
    'draft',
  );
  assert.equal(classifyValidation(validation({ isValid: false, message: 'No permission' })).cost, 'refused');
  assert.equal(classifyValidation(validation({ isCancelled: true })).cost, 'refused');
  assert.equal(classifyValidation(null).cost, 'unknown');
});

type Revision = { version: string; revisionStateId: 1 | 2 | 3 };

function fakeReads(
  options: {
    validations?: Record<string, ValidateActionResponse | Error>;
    revisions?: Record<string, Revision | Error>;
    sets?: Record<string, VariationSet>;
    viewers?: Error;
  } = {},
) {
  const calls: string[] = [];
  const reads: MovePlanReads = {
    async validateMove(id, dest) {
      calls.push(`validate ${id} ${dest}`);
      const v = options.validations?.[id];
      if (v instanceof Error) throw v;
      return v ?? validation({});
    },
    async revision(id) {
      calls.push(`revision ${id}`);
      const r = options.revisions?.[id];
      if (r instanceof Error) throw r;
      return r ?? { version: '2.0', revisionStateId: 2 };
    },
    async variationSet(id) {
      calls.push(`set ${id}`);
      return options.sets?.[id] ?? null;
    },
    async viewers(ids) {
      calls.push(`viewers ${[...ids].sort((a, b) => a - b).join(',')}`);
      if (options.viewers) throw options.viewers;
      return ids.map((groupId) => ({ groupId, totalUsers: groupId, totalRoles: 1 }));
    },
  };
  return { reads, calls };
}

const PROMPT = validation({ isPrompt: true, title: 'Publish New Version?', message: 'a new version will be created and published' });
const DRAFT = validation({ isPrompt: true, title: 'Publish New Version?', message: 'has outstanding changes, all other outstanding changes will also be published' });

async function planFor(selectKeys: string[], dest: string, options: Parameters<typeof fakeReads>[0] = {}) {
  const t = tree();
  const f = fakeReads(options);
  const plan = await buildMovePlan(t, complete(t, click(t, ...selectKeys)), destinationOf(t, dest)!, f.reads);
  return { plan, calls: f.calls, t };
}

test('drafts that would go live are set aside, unchosen, with the tenant message', async () => {
  const { plan } = await planFor(['g-fin>p-close', 'g-fin>p-exp', 'g-ap>p-pay'], 'g-hr', {
    validations: { 'p-close': PROMPT, 'p-exp': DRAFT },
  });
  // Tree order: Accounts Payable's process comes before Finance's own.
  assert.deepEqual(plan.moves.map((m) => [m.uniqueId, m.cost]), [['p-pay', 'clean'], ['p-close', 'republish']]);
  assert.deepEqual(plan.needsChoice.map((m) => [m.uniqueId, m.cost]), [['p-exp', 'draft']]);
  assert.match(plan.needsChoice[0]?.tenantMessage ?? '', /outstanding changes/);
  const preview = movePreviewRows(plan, new Set());
  assert.equal(preview.find((r) => r.objectId === 'p-exp')?.status, 'Skipped');
  assert.equal(movePreviewRows(plan, new Set(['p-exp'])).find((r) => r.objectId === 'p-exp')?.status, 'Preview');
});

test('the revision state is a draft signal of its own', () => {
  assert.equal(isDraftOverPublished({ version: '1.1', revisionStateId: 1 }), true);
  assert.equal(isDraftOverPublished({ version: '3.2', revisionStateId: 1 }), true);
  // Never published: 0.x in progress.
  assert.equal(isDraftOverPublished({ version: '0.4', revisionStateId: 1 }), false);
  // Published with no draft open.
  assert.equal(isDraftOverPublished({ version: '2.0', revisionStateId: 2 }), false);
  assert.equal(isDraftOverPublished({ version: '', revisionStateId: 1 }), false);
});

test('a draft the pre-flight words differently is still set aside by its revision', async () => {
  const { plan, calls } = await planFor(['g-fin>p-close', 'g-fin>p-exp', 'g-ap>p-pay'], 'g-hr', {
    validations: { 'p-close': PROMPT, 'p-exp': DRAFT },
    revisions: { 'p-close': { version: '1.1', revisionStateId: 1 } },
  });
  assert.deepEqual(plan.needsChoice.map((m) => [m.uniqueId, m.cost]).sort(), [['p-close', 'draft'], ['p-exp', 'draft']]);
  assert.deepEqual(plan.moves.map((m) => m.uniqueId), ['p-pay']);
  // Only the prompted move the wording did not catch is read: not the clean one, not the worded draft.
  assert.deepEqual(calls.filter((c) => c.startsWith('revision')), ['revision p-close']);
});

test('a republish whose revision cannot be read needs a choice', async () => {
  const { plan } = await planFor(['g-fin>p-close'], 'g-hr', {
    validations: { 'p-close': PROMPT },
    revisions: { 'p-close': new Error('HTTP 500') },
  });
  assert.deepEqual(plan.needsChoice.map((m) => [m.uniqueId, m.cost]), [['p-close', 'unknown']]);
  assert.match(plan.needsChoice[0]?.tenantMessage ?? '', /open draft could not be read/);
});

test('a pre-flight the tenant refuses is Blocked; one that cannot be read needs a choice', async () => {
  const { plan } = await planFor(['g-fin>p-close', 'g-fin>p-exp'], 'g-hr', {
    validations: { 'p-close': validation({ isValid: false, message: 'You cannot move this process' }), 'p-exp': new Error('HTTP 500') },
  });
  assert.equal(plan.skipped.find((r) => r.objectId === 'p-close')?.status, 'Blocked');
  assert.match(plan.skipped.find((r) => r.objectId === 'p-close')?.message ?? '', /You cannot move this process/);
  assert.deepEqual(plan.needsChoice.map((m) => [m.uniqueId, m.cost]), [['p-exp', 'unknown']]);
});

test('a variation names every sibling that will move with it', async () => {
  const { plan, calls } = await planFor(['g-fin>p-exp-c'], 'g-hr', {
    sets: {
      'p-exp-c': {
        id: 5,
        name: 'Expense claims',
        group: null,
        self: { uniqueId: 'p-exp-c', variationName: 'Contractors', isArchived: false },
        others: [{ uniqueId: 'p-exp-s', variationName: 'Staff', isArchived: false }],
      },
    },
  });
  assert.ok(calls.includes('set p-exp-c'));
  assert.deepEqual(plan.moves[0]?.siblings.map((s) => [s.uniqueId, s.name]), [['p-exp-s', 'Expense claims :: Staff']]);
});

test('groups are never pre-flighted, and viewer counts cover both ends in one call', async () => {
  const { plan, calls, t } = await planFor(['g-empty', 'g-hr>p-off'], 'g-fin');
  assert.deepEqual(calls.filter((c) => c.startsWith('validate')), ['validate p-off g-fin']);
  const id = (key: string) => t.nodes.get(key)!.id;
  const ids = [id('g-empty'), id('g-hr'), id('g-fin')].sort((a, b) => a - b);
  assert.deepEqual(calls.filter((c) => c.startsWith('viewers')), [`viewers ${ids.join(',')}`]);
  // A group's audience before is its own; a process's is its group's.
  const group = plan.moves.find((m) => m.uniqueId === 'g-empty');
  assert.deepEqual(group?.viewersBefore, { users: id('g-empty'), roles: 1 });
  assert.deepEqual(group?.viewersAfter, { users: id('g-fin'), roles: 1 });
  assert.deepEqual(plan.moves.find((m) => m.uniqueId === 'p-off')?.viewersBefore, { users: id('g-hr'), roles: 1 });
});

test('viewer counts that cannot be read are reported, not a reason to stop', async () => {
  const { plan } = await planFor(['g-ap'], 'g-hr', { viewers: new Error('HTTP 500') });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.viewersUnavailable, 'HTTP 500');
});

// ---------------------------------------------------------------- running

function gateway(behaviour: Record<string, () => Promise<{ success: boolean; errors: unknown[] | null }>> = {}) {
  const calls: string[] = [];
  const g: MoveGateway = {
    async move(item) {
      calls.push(`${item.nodeType} ${item.uniqueId} ${item.oldParentUniqueId ?? 'top'}->${item.newParentUniqueId ?? 'top'}`);
      return behaviour[item.uniqueId] ? behaviour[item.uniqueId]!() : { success: true, errors: [] };
    },
  };
  return { g, calls };
}

const journal = () => Journal.start('run', 'tenant', 1, null);

async function planned(): Promise<MovePlan> {
  return (await planFor(['g-ap', 'g-fin>p-close', 'g-fin>p-exp'], 'g-hr', { validations: { 'p-close': PROMPT, 'p-exp': DRAFT } })).plan;
}

test('one call per node, with the item type passed straight through', async () => {
  const plan = await planned();
  const h = gateway();
  const rows = await runMoves(h.g, journal(), plan, new Set(), createControls(), { concurrency: 1 });
  assert.deepEqual(h.calls, ['group g-ap g-fin->g-hr', 'process p-close g-fin->g-hr']);
  assert.match(rows.find((r) => r.objectId === 'p-close')?.message ?? '', /A new major version will be published/);
  assert.match(rows.find((r) => r.objectId === 'g-ap')?.message ?? '', /No process revision changes/);
  // The unchosen draft still gets a row.
  assert.equal(rows.find((r) => r.objectId === 'p-exp')?.status, 'Skipped');
});

test('a ticked draft is moved', async () => {
  const plan = await planned();
  assert.deepEqual(itemsToMove(plan, new Set(['p-exp'])).map((i) => i.uniqueId), ['g-ap', 'p-close', 'p-exp']);
  const h = gateway();
  await runMoves(h.g, journal(), plan, new Set(['p-exp']), createControls());
  assert.ok(h.calls.some((c) => c.includes('p-exp')));
});

test('success false, a refusal and a dead session are each reported, and journaled', async () => {
  const plan = await planned();
  const refusal = Object.assign(new Error('403'), { status: 403, tenantMessage: 'Not allowed' });
  const dead = Object.assign(new Error('Not signed in.'), { signedOut: true });
  const j = journal();
  const rows = await runMoves(
    gateway({
      'g-ap': async () => ({ success: false, errors: ['Destination is locked'] }),
      'p-close': async () => Promise.reject(refusal),
    }).g,
    j,
    plan,
    new Set(),
    createControls(),
  );
  assert.equal(rows.find((r) => r.objectId === 'g-ap')?.status, 'Failed');
  assert.match(rows.find((r) => r.objectId === 'g-ap')?.message ?? '', /Destination is locked/);
  assert.equal(rows.find((r) => r.objectId === 'p-close')?.status, 'Blocked');
  assert.equal(j.phaseOf(step.move('g-ap')), 'fail');

  const stopped = await runMoves(gateway({ 'g-ap': async () => Promise.reject(dead) }).g, journal(), plan, new Set(), createControls(), { concurrency: 1 });
  assert.match(stopped.find((r) => r.objectId === 'p-close')?.message ?? '', /Not attempted: Your session ended/);
});

// ---------------------------------------------------------------- final read

test('a moved item\'s result says what became of its version', () => {
  const base = { uniqueId: 'p', title: 'P', nodeType: 'process', fromParentUniqueId: null, fromDisplay: 'X', tenantMessage: null, siblings: [], viewersBefore: null, viewersAfter: null };
  assert.equal(describeOutcome({ ...base, kind: 'process', cost: 'draft' }, { version: '2.0', revisionStateId: 3 }), 'Published as 2.0; the open draft went live.');
  assert.equal(describeOutcome({ ...base, kind: 'process', cost: 'republish' }, { version: '4.0', revisionStateId: 3 }), 'Published as 4.0.');
  assert.equal(describeOutcome({ ...base, kind: 'process', cost: 'clean' }, { version: '0.4', revisionStateId: 1 }), 'Now at 0.4, in progress and not published.');
  assert.equal(describeOutcome({ ...base, kind: 'process', cost: 'republish' }, { version: '2.1', revisionStateId: 2 }), 'Now at 2.1, awaiting approval.');
  assert.equal(describeOutcome({ ...base, kind: 'group', cost: 'group' }, null), 'No process revision changed.');
});

function item(uniqueId: string, itemType = 'process'): TreeItem {
  return { ...(TREE_LEVELS['g-fin']![1] as TreeItem), uniqueId, itemType: itemType as TreeItem['itemType'] };
}

test('the final read settles each move, and siblings get their own rows', async () => {
  const { plan } = await planFor(['g-fin>p-close', 'g-fin>p-exp-c', 'g-ap>p-pay'], 'g-hr', {
    sets: {
      'p-exp-c': {
        id: 5,
        name: 'Expense claims',
        group: null,
        self: null,
        others: [{ uniqueId: 'p-exp-s', variationName: 'Staff', isArchived: false }],
      },
    },
  });
  const failure = Object.assign(new Error('500'), { status: 500 });
  const draft = await runMoves(gateway({ 'p-pay': async () => Promise.reject(failure) }).g, journal(), plan, new Set(), createControls());

  const levels = new Map<string, TreeItem[]>([
    // p-close was accepted but is still in Finance; p-exp-c moved; p-pay failed but moved.
    ['g-hr', [item('p-exp-c'), item('p-pay')]],
    ['g-fin', [item('p-close')]],
    ['g-ap', []],
  ]);
  const after = new Map<string, IndexEntry>([
    ['p-exp-s', { uniqueId: 'p-exp-s', name: 'Expense claims :: Staff', isArchived: false, groupId: 9, groupUniqueId: 'g-hr', groupName: 'People', groupExists: true }],
  ]);
  const revisions = new Map<string, Revision | null>([
    ['p-exp-c', { version: '3.0', revisionStateId: 3 }],
    ['p-pay', null],
  ]);
  const settled = settleMoves(draft, plan, levels, after, revisions);
  const status = (id: string) => settled.find((r) => r.objectId === id)?.status;
  const message = (id: string) => settled.find((r) => r.objectId === id)?.message ?? '';
  assert.equal(status('p-close'), 'Failed');
  assert.equal(status('p-exp-c'), 'Success');
  // What happened, not the preview's "will be published".
  assert.equal(message('p-exp-c'), 'Moved from Finance to People. Published as 3.0.');
  assert.equal(status('p-pay'), 'Success');
  assert.match(message('p-pay'), /confirmed by the final read.*Its version could not be re-read\.$/);
  assert.equal(status('p-exp-s'), 'Success');
  assert.match(settled.find((r) => r.objectId === 'p-exp-s')?.message ?? '', /with its variation set/);
});
