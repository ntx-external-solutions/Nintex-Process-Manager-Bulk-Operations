/**
 * What `CheckProcessDependencies` claims, and whether the located sites account for it.
 *
 * Its rows are per occurrence and summed across both directions, so they are never
 * deduplicated, and nothing in a row says which side of the pair holds the reference.
 * It also drops Process Input and Output rows naming an archived process, while the
 * references stay in that process's JSON (API_ARCHITECTURE.md).
 */

import { nodeArray, nodeString } from './model.ts';
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
  const claims: DependencyClaim[] = [];
  if (response === null || response === undefined) return claims;

  for (const entry of Array.isArray(response) ? response : [response]) {
    if (entry === null || entry === undefined) continue;
    const type = nodeString(entry, 'Type');
    const category: ClaimCategory = CLAIM_TYPE_MAP[type] ?? 'Unknown';
    // Deliberately not deduplicated: three rows naming one id are three references.
    for (const dep of nodeArray(entry, 'Dependencies')) {
      if (dep === null || dep === undefined) continue;
      claims.push({
        queriedUniqueId,
        relatedUniqueId: nodeString(dep, 'UniqueId'),
        relatedName: nodeString(dep, 'Name'),
        type,
        category,
      });
    }
  }
  return claims;
}

/** PowerShell's `-eq` on strings, which the script compares ids with: case-insensitive. */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
  const seen = new Map<string, string>();
  for (const id of targetUniqueIds) if (id) seen.set(id.toLowerCase(), id);
  for (const claim of claims) {
    if (claim.category === 'Group') continue;
    if (claim.relatedUniqueId) seen.set(claim.relatedUniqueId.toLowerCase(), claim.relatedUniqueId);
  }
  return [...seen.values()];
}

/** Sites inverted to one work item per holder. Report-only sites are left out. Port of `Group-ReferenceSiteByHolder`. */
export function groupSitesByHolder(sites: ReadonlyArray<ReferenceSite | null>): HolderWorkItem[] {
  const byHolder = new Map<string, HolderWorkItem>();
  for (const site of sites) {
    if (!site || site.action === 'Report' || !site.holderUniqueId) continue;
    // Keyed case-insensitively, as the script's hashtable is.
    const key = site.holderUniqueId.toLowerCase();
    let item = byHolder.get(key);
    if (!item) {
      item = { holderUniqueId: site.holderUniqueId, sites: [], targetsAffected: [] };
      byHolder.set(key, item);
    }
    item.sites.push(site);
    if (!item.targetsAffected.some((t) => sameId(t, site.targetUniqueId))) item.targetsAffected.push(site.targetUniqueId);
  }
  return [...byHolder.values()];
}

/**
 * Claimed against located, per category, for one queried/related pair. Link is the
 * union of both directions; Input and Output are scoped to the queried process's own
 * sites (measured, not assumed). Port of `Test-DependencyReconciliation`.
 */
export function reconcileDependencies(input: ReconciliationInput): Reconciliation[] {
  const { queriedUniqueId: q, relatedUniqueId: r } = input;
  const pairClaims = input.claims.filter((c) => sameId(c.queriedUniqueId, q) && sameId(c.relatedUniqueId, r));
  const pairSites = input.sites.filter(
    (s) => (sameId(s.holderUniqueId, q) && sameId(s.targetUniqueId, r)) || (sameId(s.holderUniqueId, r) && sameId(s.targetUniqueId, q)),
  );

  return (['Link', 'Input', 'Output'] as const).map((category): Reconciliation => {
    const claimed = pairClaims.filter((c) => c.category === category).length;
    // Link is the union of both directions; Input and Output are the queried side's own.
    const categorySites = pairSites.filter((s) => s.category === category && (category === 'Link' || sameId(s.holderUniqueId, q)));
    const located = categorySites.length;
    const suppressed = input.relatedIsArchived === true && category !== 'Link';
    const expected = suppressed ? 0 : located;

    let status: ReconciliationStatus = 'Match';
    let note = '';
    if (input.bothSidesDeleted === true) {
      status = 'NotApplicable';
      note = 'Both processes are delete targets; references between them disappear with them';
    } else if (claimed !== expected) {
      status = 'Mismatch';
      const childCount = categorySites.filter((s) => s.isChild && sameId(s.holderUniqueId, q)).length;
      // The asymmetry runs both ways, and the delta is the holder's child-procedure count
      // in both (API_ARCHITECTURE.md). Neither direction is evidence of drift on its own.
      const delta = Math.abs(claimed - expected);
      if (category === 'Link' && childCount > 0 && delta === childCount) {
        status = 'MatchWithKnownAsymmetry';
        note = `Differs by ${childCount} child-procedure site(s); see API_ARCHITECTURE.md child-reference asymmetry`;
      } else {
        note = `Claimed ${claimed}, located ${expected}. Investigate before removing.`;
      }
    } else if (suppressed && located > 0) {
      note = `${located} reference(s) exist but are suppressed because the related process is archived`;
    }

    return { queriedUniqueId: q, relatedUniqueId: r, category, claimed, located, expected, suppressed, status, note };
  });
}
