/**
 * The temporary group the run parks processes in so they can be read, and its removal.
 *
 * Archived targets go there to come out of the archive, and so does any holder whose own
 * group is gone (old T2). By cleanup every one of them should be deleted or archived
 * again, so a holding group that still lists a process means something did not finish.
 * Deleting it anyway is how processes get lost: live, in a group nobody will look in,
 * named only by a plan file. So it is left in place and every process in it is named.
 */

import { failureOf } from '../archive/outcome.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import { defaultIsFatal } from '../exec/runner.ts';
import type { DeleteGateway, GroupProcess, GroupRef } from './gateway.ts';
import type { OrphanedGroupProcess } from './groups.ts';
import { resolveCollateralName } from './names.ts';

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
export async function removeHoldingGroup(
  gateway: Pick<DeleteGateway, 'groupProcesses' | 'deleteGroup'>,
  group: GroupRef | null,
  options: HoldingGroupCleanupOptions,
  isFatal: (error: unknown) => string | null = defaultIsFatal,
): Promise<ResultRow[]> {
  if (!group) return [];
  const groupRow = (status: string, message: string, statusCode?: number | null) =>
    resultRow({ objectType: 'ProcessGroup', objectId: group.uniqueId, name: options.groupName, operation: 'Cleanup', status, message, groupId: group.id, statusCode });

  let remaining: GroupProcess[];
  try {
    remaining = await gateway.groupProcesses(group);
  } catch (error) {
    if (isFatal(error)) throw error;
    // A group of unknown contents is not deleted.
    return [groupRow('Skipped', 'Could not verify the group is empty; delete it manually after checking')];
  }

  if (remaining.length > 0) {
    const rows = [groupRow('Skipped', `Still holds ${remaining.length} process(es): ${remaining.map((p) => p.processUniqueId).join(', ')}`)];
    // A process stranded here was moved in by this run and left behind, which makes it
    // collateral whatever the sweeps said. The checkpoints are the other producer of
    // collateral rows, so what they reported is not reported twice (W2: 7 rows for 5).
    const targets = new Set((options.targetUniqueIds ?? []).map((t) => t.toLowerCase()));
    const reported = new Set((options.reportedUniqueIds ?? []).map((t) => t.toLowerCase()));
    for (const proc of remaining) {
      const id = proc.processUniqueId;
      if (!id || targets.has(id.toLowerCase()) || reported.has(id.toLowerCase())) continue;
      rows.push(
        resultRow({
          objectId: id,
          // The listing shows a variation under its master's name; the baseline's wins.
          name: resolveCollateralName(options.nameLookup ?? null, id, proc.processName),
          operation: 'Collateral',
          status: 'Failed',
          message: `Left stranded in the holding group '${options.groupName}' and was not a target; move it back manually`,
          groupId: group.id,
        }),
      );
    }
    return rows;
  }

  try {
    await gateway.deleteGroup(group.uniqueId);
  } catch (error) {
    if (isFatal(error)) throw error;
    return [groupRow('Failed', 'Delete failed; remove it manually', failureOf(error).status)];
  }
  return [groupRow('Success', 'Empty holding group deleted')];
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
  if (orphans.length === 0) return [];
  const total = totalTargets > 0 ? totalTargets : orphans.length;
  const lines = [
    'TARGETS WHOSE GROUP NO LONGER EXISTS',
    `${orphans.length} of ${total} target(s) belong to a group that no longer exists.`,
    'They can be archived but cannot be returned to their original group.',
  ];
  for (const o of [...orphans].sort((x, y) => x.name.localeCompare(y.name))) {
    lines.push(`  ${o.name}  (${o.uniqueId})`);
    lines.push(`      ${o.isArchived ? 'archived' : 'active'}; group ${o.originalGroupId ?? 'unknown'} is gone`);
  }
  lines.push('If the run does not delete them, they are archived where they sit and the results file names the group they are actually in.');
  if (holdingGroupName) {
    lines.push(`That is inside '${holdingGroupName}', so the holding group is left in place rather than deleted. Move them somewhere real to clear it.`);
  }
  return lines;
}
