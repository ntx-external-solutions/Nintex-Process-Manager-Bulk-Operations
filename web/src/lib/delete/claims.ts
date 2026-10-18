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

/**
 * `MatchAcrossCategories`: the category disagrees but the pair's totals do not fall short.
 * Measured on R11's set: the API labels some Input references "Linked Process" (Cowork's
 * live check after W5 phase 3).
 */
export type ReconciliationStatus = 'Match' | 'Mismatch' | 'MatchWithKnownAsymmetry' | 'MatchAcrossCategories' | 'NotApplicable';

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
  /**
   * A Link mismatch claimed exactly twice per located site. The dependency check lists
   * every linked process twice while the holder's model holds one reference (measured on
   * the W5 phase 2 dry run, API_ARCHITECTURE.md "Why links reconcile as 'claimed 2,
   * located 1'"). Still a `Mismatch`, reported apart, and no longer gating: Cowork checked
   * all 21 such pairs on R11's set against the holders' models after W5 phase 3.
   */
  doubleCounted: boolean;
  /**
   * A mismatch whose pair has at least one located site, but fewer than claimed. Every
   * such pair on R11's set was the API over-claiming, so the run asks for an
   * acknowledgement rather than stopping. Absent in a plan file from before it existed,
   * which `reconciliationGate` reads as blocking.
   */
  overClaim?: boolean;
  note: string;
}

/** Mismatches as the run treats them. Port of the script's single mismatch gate, split three ways. */
export interface ReconciliationGate {
  /** Nothing located for the pair: the run stops here unless the operator says otherwise. */
  blocking: Reconciliation[];
  /** Located, but fewer than claimed: carries on once acknowledged on screen. */
  overClaims: Reconciliation[];
  /** The API's doubled links: reported, never asked about. */
  doubleCounted: Reconciliation[];
}

export function reconciliationGate(rows: readonly Reconciliation[]): ReconciliationGate {
  const gate: ReconciliationGate = { blocking: [], overClaims: [], doubleCounted: [] };
  for (const row of rows) {
    if (row.status !== 'Mismatch') continue;
    if (row.doubleCounted === true) gate.doubleCounted.push(row);
    else if (row.overClaim === true) gate.overClaims.push(row);
    else gate.blocking.push(row);
  }
  return gate;
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
 *
 * DIFFERS: then the pair as a whole (Cowork's live check after W5 phase 3). A category
 * mismatch is only a mismatch when the pair's located total is below its claimed total,
 * because the API labels some references by the wrong category, and finding more than the
 * API claims removes everything found. A pair that falls short is an over-claim when
 * anything was located, and blocks when nothing was.
 *
 * The pair's located total is every planned site between the two, in either direction,
 * any category, child sites included. Summing the per-category counts missed an Input
 * held by the related process, because those counts are scoped to the queried side: on
 * Cowork's live check after phase 4, two pairs (a Link claimed on the target, an Input
 * held by the related process) still blocked for that reason.
 */
export function reconcileDependencies(input: ReconciliationInput): Reconciliation[] {
  const rows = reconcileByCategory(input);
  if (input.bothSidesDeleted === true || !rows.some((r) => r.status === 'Mismatch')) return rows;

  const pairClaimed = rows.reduce((n, r) => n + r.claimed, 0);
  const pairLocated = sitesBetween(input).length;
  const counts = (pick: (r: Reconciliation) => number) => rows.map((r) => `${r.category} ${pick(r)}`).join(', ');
  const across = `Across the pair: claimed ${counts((r) => r.claimed)}; located ${counts((r) => r.expected)}; ${pairLocated} site(s) between them in all.`;

  return rows.map((row) => {
    if (row.status !== 'Mismatch') return row;
    if (pairLocated >= pairClaimed) {
      return { ...row, status: 'MatchAcrossCategories', doubleCounted: false, note: `${across} The pair's totals do not fall short, so nothing claimed is missing.` };
    }
    if (row.doubleCounted) return { ...row, note: `${row.note} ${across}` };
    if (pairLocated >= 1) {
      return { ...row, overClaim: true, note: `${across} The API claims more than the models hold; acknowledge before removing.` };
    }
    return { ...row, note: `${row.note} ${across}` };
  });
}

/** Every site between the pair, whichever of the two holds it. */
function sitesBetween(input: ReconciliationInput): ReconciliationInput['sites'] {
  const { queriedUniqueId: q, relatedUniqueId: r } = input;
  return input.sites.filter(
    (s) => (sameId(s.holderUniqueId, q) && sameId(s.targetUniqueId, r)) || (sameId(s.holderUniqueId, r) && sameId(s.targetUniqueId, q)),
  );
}

function reconcileByCategory(input: ReconciliationInput): Reconciliation[] {
  const { queriedUniqueId: q, relatedUniqueId: r } = input;
  const pairClaims = input.claims.filter((c) => sameId(c.queriedUniqueId, q) && sameId(c.relatedUniqueId, r));
  const pairSites = sitesBetween(input);

  return (['Link', 'Input', 'Output'] as const).map((category): Reconciliation => {
    const claimed = pairClaims.filter((c) => c.category === category).length;
    // Link is the union of both directions; Input and Output are the queried side's own.
    const categorySites = pairSites.filter((s) => s.category === category && (category === 'Link' || sameId(s.holderUniqueId, q)));
    const located = categorySites.length;
    const suppressed = input.relatedIsArchived === true && category !== 'Link';
    const expected = suppressed ? 0 : located;

    let status: ReconciliationStatus = 'Match';
    let doubleCounted = false;
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
      } else if (category === 'Link' && located >= 1 && claimed === 2 * located) {
        doubleCounted = true;
        note = `Claimed ${claimed}, located ${located}: the dependency API lists each linked process twice (API_ARCHITECTURE.md).`;
      } else {
        note = `Claimed ${claimed}, located ${expected}. Investigate before removing.`;
      }
    } else if (suppressed && located > 0) {
      note = `${located} reference(s) exist but are suppressed because the related process is archived`;
    }

    return { queriedUniqueId: q, relatedUniqueId: r, category, claimed, located, expected, suppressed, status, doubleCounted, note };
  });
}
