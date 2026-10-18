/**
 * What a Bulk Move will do, and what each move will cost, before anything is written.
 *
 * Spike S2 measured the costs, and the preview has to show them:
 *
 *  - a group moves with no process revision changed;
 *  - a never-published process gets a minor version bump;
 *  - a process with a published version is republished as a new major version, which
 *    the server's pre-flight announces as "Publish New Version?";
 *  - a process with an open draft gets the draft published with it ("has outstanding
 *    changes ... will also be published"). Those go in their own section, not selected
 *    unless the operator ticks each one. The wording is one signal; the revision is the
 *    other (`isDraftOverPublished`), so a tenant that words it differently still lands
 *    the process there;
 *  - a variation moves its whole set. Siblings are not in the tree, so they are named
 *    from `variationSetData`.
 *
 * The pre-flight is the server's (`ValidateProcessAction`, action 11). The move endpoint
 * does not enforce it, so this is the only place it is honoured.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { GroupViewerCount } from '../pm/groups.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type { VariationMember, VariationSet } from '../pm/processes.ts';
import type { ValidateActionResponse } from '../pm/types.ts';
import type { BrowseTree } from '../select/browse.ts';
import type { ExcludedItem } from '../select/resolve.ts';
import {
  describeDestination,
  destinationProblem,
  type Destination,
  type MoveCandidate,
  type MoveResolution,
} from './select.ts';

/**
 * - `group`: a whole group; no revision changes.
 * - `clean`: the pre-flight raised nothing; a never-published process, minor bump.
 * - `republish`: the pre-flight prompts; a new major version will be published.
 * - `draft`: the pre-flight says an open draft will be published too.
 * - `unknown`: the pre-flight could not be read, so the cost is not known.
 */
export type MoveCost = 'group' | 'clean' | 'republish' | 'draft' | 'unknown';

export interface ViewerCount {
  users: number;
  roles: number;
}

export interface MoveItem {
  uniqueId: string;
  title: string;
  nodeType: string;
  kind: 'group' | 'process';
  fromParentUniqueId: string | null;
  /** "Finance / Payables", or "the top level". */
  fromDisplay: string;
  cost: MoveCost;
  /** The server's own words from the pre-flight, when it said anything. */
  tenantMessage: string | null;
  /** Variations that will move with this one. Not in the tree. */
  siblings: Array<VariationMember & { name: string }>;
  /** Audience before (the group itself, or the process's group) and after (the destination). */
  viewersBefore: ViewerCount | null;
  viewersAfter: ViewerCount | null;
}

export interface MovePlan {
  destination: Destination;
  /** Groups and processes that move unless the operator unticks them. */
  moves: MoveItem[];
  /** Processes whose open draft would be published, or whose cost is unknown. Unticked. */
  needsChoice: MoveItem[];
  /** Rows for what will not move, so nothing is lost from the results. */
  skipped: ResultRow[];
  excluded: ExcludedItem[];
  /** Set when viewer counts could not be read. Advisory only. */
  viewersUnavailable: string | null;
}

export function classifyValidation(validation: ValidateActionResponse | null): {
  cost: MoveCost | 'refused';
  message: string | null;
} {
  if (validation === null) return { cost: 'unknown', message: null };
  const words = [validation.title, validation.message].filter((w): w is string => !!w && w.trim() !== '');
  const message = words.length > 0 ? words.join(': ') : null;
  if (validation.isCancelled || (!validation.isValid && !validation.isPrompt)) {
    return { cost: 'refused', message };
  }
  if (validation.isPrompt) {
    return { cost: /outstanding changes/i.test(validation.message ?? '') ? 'draft' : 'republish', message };
  }
  return { cost: 'clean', message };
}

/**
 * True when the process has an open draft over a published version: revision state 1
 * (in progress) at a major version of 1 or more. Measured for F1: never-published
 * processes were 0.x in state 1, and the draft over a published version was 1.1 in
 * state 1.
 */
export function isDraftOverPublished(revision: Pick<ProcessSummary, 'version' | 'revisionStateId'>): boolean {
  const major = Number.parseInt(String(revision.version ?? '').split('.')[0] ?? '', 10);
  return revision.revisionStateId === 1 && Number.isInteger(major) && major >= 1;
}

export interface MovePlanReads {
  validateMove(processUniqueId: string, destinationGroupUniqueId: string): Promise<ValidateActionResponse>;
  /** The model's version and revision state, for the structured draft check. */
  revision(processUniqueId: string): Promise<Pick<ProcessSummary, 'version' | 'revisionStateId'>>;
  variationSet(processUniqueId: string): Promise<VariationSet | null>;
  viewers(groupIds: number[]): Promise<GroupViewerCount[]>;
  isFatal?: (error: unknown) => string | null;
  onProgress?: (label: string) => void;
}

function describeFrom(path: readonly string[]): string {
  return path.length === 0 ? 'the top level' : path.join(' / ');
}

function skipRow(candidate: MoveCandidate, status: string, message: string): ResultRow {
  return resultRow({
    objectType: candidate.node.kind === 'group' ? 'ProcessGroup' : 'Process',
    objectId: candidate.node.uniqueId,
    name: candidate.node.title,
    operation: 'UpdateLocation',
    status,
    message,
    groupId: candidate.node.kind === 'group' ? candidate.node.id : null,
  });
}

export async function buildMovePlan(
  tree: BrowseTree,
  resolution: Extract<MoveResolution, { status: 'complete' }>,
  destination: Destination,
  reads: MovePlanReads,
): Promise<MovePlan> {
  const rethrowIfFatal = (error: unknown): void => {
    if (reads.isFatal?.(error)) throw error;
  };

  const moves: MoveItem[] = [];
  const needsChoice: MoveItem[] = [];
  const skipped: ResultRow[] = [];

  const base = (candidate: MoveCandidate, kind: 'group' | 'process'): MoveItem => ({
    uniqueId: candidate.node.uniqueId,
    title: candidate.node.title,
    nodeType: candidate.node.itemType,
    kind,
    fromParentUniqueId: candidate.node.parentUniqueId,
    fromDisplay: describeFrom(candidate.path),
    cost: kind === 'group' ? 'group' : 'clean',
    tenantMessage: null,
    siblings: [],
    viewersBefore: null,
    viewersAfter: null,
  });

  for (const candidate of resolution.groups) {
    const problem = destinationProblem(candidate, destination);
    if (problem) {
      skipped.push(skipRow(candidate, problem.kind === 'skip' ? 'Skipped' : 'Blocked', problem.reason));
      continue;
    }
    moves.push(base(candidate, 'group'));
  }

  for (const [i, candidate] of resolution.processes.entries()) {
    const problem = destinationProblem(candidate, destination);
    if (problem) {
      skipped.push(skipRow(candidate, problem.kind === 'skip' ? 'Skipped' : 'Blocked', problem.reason));
      continue;
    }
    reads.onProgress?.(`Checking ${i + 1} of ${resolution.processes.length}: ${candidate.node.title}`);

    let validation: ValidateActionResponse | null = null;
    try {
      validation = await reads.validateMove(candidate.node.uniqueId, destination.uniqueId as string);
    } catch (error) {
      rethrowIfFatal(error);
    }
    const { cost, message } = classifyValidation(validation);
    if (cost === 'refused') {
      skipped.push(skipRow(candidate, 'Blocked', `The tenant refused the move in its pre-flight: ${message ?? 'no reason given'}`));
      continue;
    }

    const item: MoveItem = { ...base(candidate, 'process'), cost, tenantMessage: message };

    // Only a prompted move can publish anything, and a draft the wording already caught
    // needs no second opinion. So the model is read for republishes alone.
    if (cost === 'republish') {
      try {
        if (isDraftOverPublished(await reads.revision(candidate.node.uniqueId))) item.cost = 'draft';
      } catch (error) {
        rethrowIfFatal(error);
        // Not knowing whether a draft goes live is the case the section exists for.
        item.cost = 'unknown';
        item.tenantMessage = `${item.tenantMessage ? `${item.tenantMessage}. ` : ''}Whether it has an open draft could not be read.`;
      }
    }

    if (candidate.node.variationSetId !== null) {
      try {
        const set = await reads.variationSet(candidate.node.uniqueId);
        item.siblings = (set?.others ?? []).map((sibling) => ({
          ...sibling,
          name: [set?.name ?? candidate.node.title, sibling.variationName].filter((p) => p !== '').join(' :: '),
        }));
      } catch (error) {
        rethrowIfFatal(error);
        // Not knowing the siblings is not a reason to refuse, but it is a reason to ask.
        item.cost = item.cost === 'clean' || item.cost === 'republish' ? 'unknown' : item.cost;
        item.tenantMessage = `${item.tenantMessage ? `${item.tenantMessage}. ` : ''}Its variation set could not be read, so siblings that would move with it are not listed.`;
      }
    }

    (item.cost === 'draft' || item.cost === 'unknown' ? needsChoice : moves).push(item);
  }

  // Viewer counts: one call for both ends of every move. Advisory, never a gate.
  let viewersUnavailable: string | null = null;
  const sourceIdOf = (item: MoveItem): number | null => {
    const node = item.kind === 'group' ? tree.nodes.get(item.uniqueId) : item.fromParentUniqueId ? tree.nodes.get(item.fromParentUniqueId) : undefined;
    return node?.id ?? null;
  };
  const all = [...moves, ...needsChoice];
  const ids = new Set<number>();
  for (const item of all) {
    const id = sourceIdOf(item);
    if (id !== null) ids.add(id);
  }
  if (destination.id !== null) ids.add(destination.id);
  if (ids.size > 0) {
    try {
      const counts = new Map((await reads.viewers([...ids])).map((c) => [c.groupId, { users: c.totalUsers, roles: c.totalRoles }]));
      for (const item of all) {
        const source = sourceIdOf(item);
        item.viewersBefore = source === null ? null : (counts.get(source) ?? null);
        item.viewersAfter = destination.id === null ? null : (counts.get(destination.id) ?? null);
      }
    } catch (error) {
      rethrowIfFatal(error);
      viewersUnavailable = error instanceof Error ? error.message : String(error);
    }
  }

  return { destination, moves, needsChoice, skipped, excluded: [...resolution.excluded], viewersUnavailable };
}

/** What a move will do to the process's revision, in words for the preview and results. */
export function describeCost(item: MoveItem): string {
  switch (item.cost) {
    case 'group':
      return 'No process revision changes.';
    case 'clean':
      return 'Never published, so it gets a minor version bump.';
    case 'republish':
      return 'A new major version will be published.';
    case 'draft':
      return 'Its open draft will be published along with the move.';
    case 'unknown':
      return 'The cost could not be checked in advance.';
  }
}

/** The dry run's results file. */
export function movePreviewRows(plan: MovePlan, chosen: ReadonlySet<string>): ResultRow[] {
  const toDisplay = describeDestination(plan.destination);
  const row = (item: MoveItem, status: string, message: string): ResultRow =>
    resultRow({
      objectType: item.kind === 'group' ? 'ProcessGroup' : 'Process',
      objectId: item.uniqueId,
      name: item.title,
      operation: 'UpdateLocation',
      status,
      message,
      groupId: plan.destination.id,
    });
  return [
    ...plan.moves.map((item) => row(item, 'Preview', `Would move from ${item.fromDisplay} to ${toDisplay}. ${describeCost(item)}`)),
    ...plan.needsChoice.map((item) =>
      chosen.has(item.uniqueId)
        ? row(item, 'Preview', `Would move from ${item.fromDisplay} to ${toDisplay}. ${describeCost(item)}`)
        : row(item, 'Skipped', `Not chosen. ${describeCost(item)}${item.tenantMessage ? ` The tenant said: ${item.tenantMessage}` : ''}`),
    ),
    ...plan.skipped,
  ];
}
