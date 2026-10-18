/**
 * What `CheckProcessDependencies` claims, and whether the located sites account for it.
 *
 * Its rows are per occurrence and summed across both directions, so they are never
 * deduplicated, and nothing in a row says which side of the pair holds the reference.
 * It also drops Process Input and Output rows naming an archived process, while the
 * references stay in that process's JSON (API_ARCHITECTURE.md).
 */

import { notPorted } from './phases.ts';
import type { ReferenceSite } from './references.ts';

export type ClaimCategory = 'Link' | 'Input' | 'Output' | 'Group' | 'Unknown';

/** `$script:ClaimTypeMap`: the response's `Type`, to the site category it reconciles against. */
export const CLAIM_TYPE_MAP: Readonly<Record<string, Exclude<ClaimCategory, 'Unknown'>>> = {
  'Linked Process': 'Link',
  'Process Input': 'Input',
  'Process Output': 'Output',
  'Linked Process Group': 'Group',
};

/** One occurrence in the response. Says the pair is connected, not which side holds it. */
export interface DependencyClaim {
  queriedUniqueId: string;
  relatedUniqueId: string;
  /** As the API sent it, untrimmed: it is the only name some processes ever get. */
  relatedName: string;
  /** The response's `Type`, verbatim. */
  type: string;
  category: ClaimCategory;
}

/** One holder, and every removal it needs, for one fetch, one save and one publish. */
export interface HolderWorkItem {
  holderUniqueId: string;
  sites: ReferenceSite[];
  /** Distinct targets among `sites`, in first-seen order. */
  targetsAffected: string[];
}

export type ReconciledCategory = 'Link' | 'Input' | 'Output';

export type ReconciliationStatus = 'Match' | 'Mismatch' | 'MatchWithKnownAsymmetry' | 'NotApplicable';

export interface Reconciliation {
  queriedUniqueId: string;
  relatedUniqueId: string;
  category: ReconciledCategory;
  claimed: number;
  located: number;
  /** `located`, or 0 when the related process is archived and the claim is suppressed. */
  expected: number;
  suppressed: boolean;
  status: ReconciliationStatus;
  note: string;
}

export interface ReconciliationInput {
  queriedUniqueId: string;
  relatedUniqueId: string;
  claims: readonly DependencyClaim[];
  sites: readonly ReferenceSite[];
  /** The API suppresses Input and Output claims naming an archived process. */
  relatedIsArchived?: boolean;
  /** Both ends are delete targets, so references between them go with them. */
  bothSidesDeleted?: boolean;
}

/**
 * One claim per occurrence, duplicates kept. Takes the parsed response as `unknown`: a
 * null response is no claims, and a bare entry is read as a one-entry list. Port of
 * `ConvertFrom-DependencyResponse`.
 */
export function parseDependencyResponse(response: unknown, queriedUniqueId: string): DependencyClaim[] {
  return notPorted('discovery');
}

/**
 * The processes to fetch and walk: the targets and both sides of every claim, once each
 * (case-insensitively), leaving out group claims, which name groups. Port of
 * `Get-DependencyCandidate`.
 */
export function dependencyCandidates(
  claims: readonly DependencyClaim[],
  targetUniqueIds: readonly string[],
): string[] {
  return notPorted('discovery');
}

/** Sites inverted to one work item per holder. Report-only sites are left out. Port of `Group-ReferenceSiteByHolder`. */
export function groupSitesByHolder(sites: ReadonlyArray<ReferenceSite | null>): HolderWorkItem[] {
  return notPorted('discovery');
}

/**
 * Claimed against located, per category, for one queried/related pair. Link is the
 * union of both directions; Input and Output are scoped to the queried process's own
 * sites (measured, not assumed). Port of `Test-DependencyReconciliation`.
 */
export function reconcileDependencies(input: ReconciliationInput): Reconciliation[] {
  return notPorted('discovery');
}
