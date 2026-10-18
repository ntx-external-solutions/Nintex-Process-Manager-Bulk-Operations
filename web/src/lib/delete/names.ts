/**
 * A label for a process, from whichever source can name it.
 *
 * A validation run printed two collateral rows as a bare GUID twice over: absent from the
 * baseline, from the index and from every claim, so nothing could name them. That is a
 * real state, but printing the id where a name goes reads as a broken tool, so it is
 * said in words (`UNKNOWN_NAME`). `Format-NpmProcessName` is already ported as the naming
 * rule inside `resultRow` (exec/report.ts).
 */

import { UNKNOWN_NAME } from '../exec/report.ts';

export { UNKNOWN_NAME };

/** Whether a label carries information: not empty, not the marker, not the id. Port of `Test-NpmNameIsReal`. */
export function isRealName(name: string, uniqueId?: string): boolean {
  if (!name) return false;
  if (name === UNKNOWN_NAME) return false;
  // Ids compare case-insensitively everywhere else in the engine, as PowerShell's -eq does.
  if (uniqueId && name.toLowerCase() === uniqueId.toLowerCase()) return false;
  return true;
}

/**
 * One label where producers disagree: the longest real name, because the holding-group
 * listing truncates a variation to its master's name. The marker is excluded before the
 * contest, since it is longer than most real names. Port of `Select-NpmDisplayName`.
 */
export function selectDisplayName(rows: ReadonlyArray<{ name: string }>, uniqueId: string): string {
  let best = '';
  for (const row of rows) {
    if (isRealName(row.name, uniqueId) && row.name.length > best.length) best = row.name;
  }
  return best || UNKNOWN_NAME;
}

/**
 * The name a dependency claim gave this id, trimmed, or the id itself: the only name
 * available for a process no listing returned. Port of `Resolve-ClaimName`.
 */
export function resolveClaimName(
  claims: ReadonlyArray<{ relatedUniqueId: string; relatedName: string }>,
  uniqueId: string,
): string {
  const lower = uniqueId.toLowerCase();
  const named = claims.find((c) => c.relatedUniqueId.toLowerCase() === lower && c.relatedName);
  return named ? named.relatedName.trim() : uniqueId;
}

/**
 * One name per process whoever reports it: the lookup (the run's baseline), then the
 * fallback when it is a real name, then the marker. The holding-group listing names a
 * variation by its master, so two producers could print one id under two names. Port of
 * `Resolve-CollateralName` (Nintex-BulkOperations.ps1).
 */
export function resolveCollateralName(
  nameLookup: ReadonlyMap<string, { name: string }> | null,
  uniqueId: string,
  fallback?: string,
): string {
  const looked = nameLookup?.get(uniqueId.toLowerCase())?.name;
  if (looked) return looked;
  if (fallback && isRealName(fallback, uniqueId)) return fallback;
  // Not in the baseline, not in the index, and named by no claim. Say so, rather than
  // printing the id where a name goes.
  return UNKNOWN_NAME;
}
