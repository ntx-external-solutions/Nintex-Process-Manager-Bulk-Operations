/**
 * The temporary group the run parks processes in so they can be read, and its removal.
 *
 * Archived targets go there to come out of the archive, and so does any holder whose own
 * group is gone (old T2). By cleanup every one of them should be deleted or archived
 * again, so a holding group that still lists a process means something did not finish.
 * Deleting it anyway is how processes get lost: live, in a group nobody will look in,
 * named only by a plan file. So it is left in place and every process in it is named.
 */

import type { ResultRow } from '../exec/report.ts';
import type { DeleteGateway, GroupRef } from './gateway.ts';
import type { OrphanedGroupProcess } from './groups.ts';
import { notPorted } from './phases.ts';

export interface HoldingGroupCleanupOptions {
  groupName: string;
  targetUniqueIds?: readonly string[] | undefined;
  /** Already raised by a checkpoint, so not raised again here (W2: 7 rows for 5 processes). */
  reportedUniqueIds?: readonly string[] | undefined;
  /** The baseline, whose name wins over the group listing's (which drops a variation's suffix). */
  nameLookup?: ReadonlyMap<string, { name: string }> | null | undefined;
}

/**
 * Deletes the holding group only if it lists nothing: one `Cleanup` row for the group,
 * and one `Collateral`/`Failed` row for each process stranded in it that is not a target
 * and was not already reported. A listing that cannot be read leaves the group in place.
 * Port of `Remove-HoldingGroup`.
 */
export function removeHoldingGroup(
  gateway: Pick<DeleteGateway, 'groupProcesses' | 'deleteGroup'>,
  group: GroupRef | null,
  options: HoldingGroupCleanupOptions,
): Promise<ResultRow[]> {
  return notPorted('unwind');
}

/**
 * The warning before the first mutation for targets whose group is gone: they can be
 * held and deleted, but not sent home if the run stops short. Counts targets, not rows,
 * and names each. Port of `Show-OrphanedGroupWarning`'s text.
 */
export function orphanedTargetWarningLines(
  orphans: readonly OrphanedGroupProcess[],
  totalTargets: number,
  holdingGroupName: string,
): string[] {
  return notPorted('hold');
}
