/**
 * The order targets can be deleted in, and which of them have to be edited first (F8).
 *
 * The planner used to drop references held by a target, on the basis that both ends were
 * being deleted. That is true at the end of the run, but the tenant refuses each delete
 * while any process linking to it still exists: 12 of 25 refusals in a customer run on
 * 4 Nov were a target linked from a target deleted later, or from one refused itself. So
 * those references are kept here, as ordering rather than as work. Pure: no network.
 *
 * Measured on the demo tenant, 4 Nov: the dependency check reports a link on the
 * linked-to side only, so a `Linked Process` claim on Q naming R means R links to Q.
 * Removing a link counts only once published, as R13 found for holders.
 */

import { groupSitesByHolder, type DependencyClaim, type HolderWorkItem } from './claims.ts';
import { nodeArray, nodeValue, type ProcessModel } from './model.ts';
import type { ReferenceSite } from './references.ts';

/** The holder has to go first: the tenant refuses the target's delete while it exists. */
export interface LinkEdge {
  holderUniqueId: string;
  targetUniqueId: string;
}

export interface LinkOrder {
  /** Every target, holders before what they link to; ties keep the order given. */
  order: string[];
  /** The links the order works from, leaving out those inside a cycle, which are removed. */
  edges: LinkEdge[];
  /** Each group of targets linking to each other in a loop, members in the order given. */
  cycles: string[][];
  /** One per cycle member with a located link to another member: only those links. */
  cycleWork: HolderWorkItem[];
}

const pairKey = (holder: string, target: string) => `${holder}|${target}`;

/**
 * `kept` are targets the plan already knows will not be deleted, lowercased. They stay in
 * the order, so their rows come out, but take no part in a cycle: editing one would change
 * a process that survives, to free a target that can simply stay as well.
 */
export function planLinkOrder(
  targetUniqueIds: readonly string[],
  sites: readonly ReferenceSite[],
  claims: readonly DependencyClaim[],
  kept: ReadonlySet<string> = new Set(),
): LinkOrder {
  const spelled = new Map(targetUniqueIds.map((id) => [id.toLowerCase(), id]));
  const position = new Map(targetUniqueIds.map((id, i) => [id.toLowerCase(), i]));

  const located = new Map<string, ReferenceSite[]>();
  for (const site of sites) {
    const holder = site.holderUniqueId.toLowerCase();
    const target = site.targetUniqueId.toLowerCase();
    if (holder === target || site.action === 'Report' || !spelled.has(holder) || !spelled.has(target)) continue;
    const key = pairKey(holder, target);
    located.set(key, [...(located.get(key) ?? []), site]);
  }

  // The claims name the holder directly, so they cover a link the walk missed. A claim the
  // walk explains the other way round is left out: the API labels some Input references
  // as links (Cowork's live check after W5 phase 3), which read as a holder here would
  // make a cycle out of one reference, and an edit to break it.
  const pairs = new Map<string, readonly [string, string]>();
  for (const [key, [site]] of located) pairs.set(key, [site!.holderUniqueId.toLowerCase(), site!.targetUniqueId.toLowerCase()]);
  for (const claim of claims) {
    if (claim.category !== 'Link') continue;
    const holder = claim.relatedUniqueId.toLowerCase();
    const target = claim.queriedUniqueId.toLowerCase();
    if (holder === target || !spelled.has(holder) || !spelled.has(target)) continue;
    if (located.has(pairKey(target, holder)) && !located.has(pairKey(holder, target))) continue;
    pairs.set(pairKey(holder, target), [holder, target]);
  }

  const linksFrom = new Map<string, string[]>();
  for (const [holder, target] of pairs.values()) {
    if (kept.has(holder) || kept.has(target)) continue;
    linksFrom.set(holder, [...(linksFrom.get(holder) ?? []), target]);
  }
  const loops = stronglyConnected([...position.keys()].filter((id) => !kept.has(id)), linksFrom);

  const loopOf = new Map<string, number>();
  loops.forEach((members, i) => members.forEach((m) => loopOf.set(m, i)));
  const insideLoop = ([holder, target]: readonly [string, string]) => loopOf.has(holder) && loopOf.get(holder) === loopOf.get(target);

  // Only located links can be removed. A claim-only link inside a loop stays an edge, and
  // the retry after the delete pass is what catches anything that still stands.
  const removed = [...pairs.entries()].filter(([key, pair]) => insideLoop(pair) && located.has(key));
  const removedKeys = new Set(removed.map(([key]) => key));
  const standing = [...pairs.entries()].filter(([key]) => !removedKeys.has(key)).map(([, pair]) => pair);

  return {
    order: topologicalOrder(targetUniqueIds, standing, position),
    edges: standing.map(([holder, target]) => ({ holderUniqueId: spelled.get(holder)!, targetUniqueId: spelled.get(target)! })),
    cycles: loops
      .map((members) => members.map((m) => spelled.get(m)!))
      .sort((a, b) => position.get(a[0]!.toLowerCase())! - position.get(b[0]!.toLowerCase())!),
    cycleWork: groupSitesByHolder(removed.flatMap(([key]) => located.get(key) ?? [])),
  };
}

/** Kahn's algorithm, always taking the earliest ready target, so an unlinked one keeps its place among the rest. */
function topologicalOrder(
  targetUniqueIds: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>,
  position: ReadonlyMap<string, number>,
): string[] {
  const after = targetUniqueIds.map((): number[] => []);
  const waitingOn = targetUniqueIds.map(() => 0);
  for (const [holder, target] of edges) {
    after[position.get(holder)!]!.push(position.get(target)!);
    waitingOn[position.get(target)!]!++;
  }

  const placed = targetUniqueIds.map(() => false);
  const ready = waitingOn.flatMap((n, i) => (n === 0 ? [i] : []));
  const order: string[] = [];
  while (order.length < targetUniqueIds.length) {
    // Nothing ready means a loop of claim-only links, which nothing here can break.
    const next = ready.shift() ?? placed.indexOf(false);
    if (placed[next]) continue;
    placed[next] = true;
    order.push(targetUniqueIds[next]!);
    for (const later of after[next]!) {
      if (--waitingOn[later]! !== 0 || placed[later]) continue;
      const at = ready.findIndex((i) => i > later);
      ready.splice(at === -1 ? ready.length : at, 0, later);
    }
  }
  return order;
}

/** Tarjan's algorithm: the groups of more than one node that can all reach each other, members in the order given. */
function stronglyConnected(nodes: readonly string[], linksFrom: ReadonlyMap<string, readonly string[]>): string[][] {
  const rank = new Map(nodes.map((n, i) => [n, i]));
  const visitOrder = new Map<string, number>();
  const lowest = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];

  // An explicit stack: a chain of thousands of targets should not depend on the call stack.
  for (const root of nodes) {
    if (visitOrder.has(root)) continue;
    const walk: Array<{ node: string; next: number }> = [];
    const enter = (node: string) => {
      visitOrder.set(node, visitOrder.size);
      lowest.set(node, visitOrder.get(node)!);
      stack.push(node);
      onStack.add(node);
      walk.push({ node, next: 0 });
    };
    enter(root);
    while (walk.length > 0) {
      const frame = walk[walk.length - 1]!;
      const links = linksFrom.get(frame.node) ?? [];
      if (frame.next < links.length) {
        const to = links[frame.next++]!;
        if (!visitOrder.has(to)) enter(to);
        else if (onStack.has(to)) lowest.set(frame.node, Math.min(lowest.get(frame.node)!, visitOrder.get(to)!));
        continue;
      }
      walk.pop();
      const parent = walk[walk.length - 1];
      if (parent) lowest.set(parent.node, Math.min(lowest.get(parent.node)!, lowest.get(frame.node)!));
      if (lowest.get(frame.node) !== visitOrder.get(frame.node)) continue;
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== frame.node);
      if (group.length > 1) groups.push(group.sort((a, b) => rank.get(a)! - rank.get(b)!));
    }
  }
  return groups;
}

/** A target whose dependency check named a process group (`Linked Process Group`). */
export interface GroupBlock {
  targetUniqueId: string;
  /** As the dependency check named them. */
  groups: string[];
  /**
   * Whether the target's own model carries a group link. True: listed as blocking the
   * delete, and not removed, because a `ProcessGroupLink` added through the process PUT
   * was silently dropped on the demo tenant, so a removal may not stick either. False: the
   * link is held somewhere other than a process, and the target is held back. Null: the
   * model could not be read, so it is listed and the delete goes ahead to find out.
   */
  linkInModel: boolean | null;
}

/** Whether a model carries a process group link of its own. */
export function hasProcessGroupLink(model: ProcessModel): boolean {
  const procedures = nodeValue(model, 'ProcessProcedures');
  return ['ProcessGroupLink', 'OrphanProcessGroupLink'].some((bucket) => nodeArray(procedures, bucket).length > 0);
}

/** The targets the claims tie to a process group, in target order. */
export function groupBlocksOf(
  targetUniqueIds: readonly string[],
  claims: readonly DependencyClaim[],
  modelOf: (uniqueId: string) => ProcessModel | null | undefined,
): GroupBlock[] {
  const blocks: GroupBlock[] = [];
  for (const target of targetUniqueIds) {
    const named = claims.filter((c) => c.category === 'Group' && c.queriedUniqueId.toLowerCase() === target.toLowerCase());
    if (named.length === 0) continue;
    const model = modelOf(target);
    blocks.push({
      targetUniqueId: target,
      groups: [...new Set(named.map((c) => c.relatedName.trim() || c.relatedUniqueId))],
      linkInModel: model ? hasProcessGroupLink(model) : null,
    });
  }
  return blocks;
}
