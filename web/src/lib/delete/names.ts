/**
 * A label for a process, from whichever source can name it.
 *
 * A validation run printed two collateral rows as a bare GUID twice over: absent from the
 * baseline, from the index and from every claim, so nothing could name them. That is a
 * real state, but printing the id where a name goes reads as a broken tool, so it is
 * said in words (`UNKNOWN_NAME`). `Format-NpmProcessName` is already ported as the naming
 * rule inside `resultRow` (exec/report.ts).
 */

import { notPorted } from './phases.ts';

export { UNKNOWN_NAME } from '../exec/report.ts';

/** Whether a label carries information: not empty, not the marker, not the id. Port of `Test-NpmNameIsReal`. */
export function isRealName(name: string, uniqueId?: string): boolean {
  return notPorted('checkpoints');
}

/**
 * One label where producers disagree: the longest real name, because the holding-group
 * listing truncates a variation to its master's name. The marker is excluded before the
 * contest, since it is longer than most real names. Port of `Select-NpmDisplayName`.
 */
export function selectDisplayName(rows: ReadonlyArray<{ name: string }>, uniqueId: string): string {
  return notPorted('checkpoints');
}

/**
 * The name a dependency claim gave this id, trimmed, or the id itself: the only name
 * available for a process no listing returned. Port of `Resolve-ClaimName`.
 */
export function resolveClaimName(
  claims: ReadonlyArray<{ relatedUniqueId: string; relatedName: string }>,
  uniqueId: string,
): string {
  return notPorted('discovery');
}
