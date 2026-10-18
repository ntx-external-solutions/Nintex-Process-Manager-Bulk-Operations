/**
 * What the run changed without being asked to, and what can be put back.
 *
 * A variation is its own record in its own group, and acting on one can act on its
 * master. Nothing in a model or a list entry says so, so the run has two handles: the
 * name heuristic and `variationSetData` before the first write (archive/plan.ts), and a
 * before/after diff of the whole tenant after each mutating phase (tenant/state.ts).
 * This module adds the delete engine's parts: the warning, the checkpoint and its gate,
 * the rows that record the gate's answer, the on-screen list and the reversal.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { NameVariationMatch } from '../archive/plan.ts';
import { compareTenantState, type Collateral, type ProcessIndex } from '../tenant/state.ts';
import { UNKNOWN_NAME } from './names.ts';

/**
 * A collateral row. `tenant/state.ts`'s `Collateral` now carries `originalGroupExists`,
 * as `Compare-TenantState` does, so a reversal knows the group it would restore into is
 * gone; the alias keeps the engine's name for it.
 */
export type CollateralChange = Collateral;

/** `Find-VariationMaster`'s row, with `BaseName` and `TargetGroupId` (archive/plan.ts). */
export type VariationMasterHit = NameVariationMatch;

export interface VariationWarningMaster extends VariationMasterHit {
  /** Active, so this run can archive it. Only these carry the risk. */
  atRisk: boolean;
}

export interface VariationWarningTarget {
  targetUniqueId: string;
  targetName: string;
  /** At-risk (active) first, then same group as the target, then by name. */
  masters: VariationWarningMaster[];
}

/** One row per target/master pair counts pairs; the warning counts targets and masters separately. */
export interface VariationWarning {
  targetCount: number;
  masterCount: number;
  targets: VariationWarningTarget[];
}

/**
 * The counting and ordering of `Show-VariationWarning`, without the printing. Null when
 * there is nothing to warn about.
 *
 * Reporting 13 "targets" for 3 targets is how a warning stops being read, so targets and
 * masters are counted, not rows.
 */
export function variationWarning(matches: readonly VariationMasterHit[]): VariationWarning | null {
  if (matches.length === 0) return null;
  const byTarget = new Map<string, VariationMasterHit[]>();
  for (const m of matches) {
    const key = m.targetUniqueId.toLowerCase();
    const list = byTarget.get(key) ?? [];
    list.push(m);
    byTarget.set(key, list);
  }
  const masterIds = new Set(matches.map((m) => m.relativeUniqueId.toLowerCase()));

  const targets: VariationWarningTarget[] = [];
  for (const group of byTarget.values()) {
    const first = group[0]!;
    // W5 in the script: the row that carries the risk goes first. Only an active master
    // can be archived by the run, and one in the target's own group is the likelier
    // relative. Name breaks the remaining ties so the order is stable.
    const masters = group
      .map((m) => ({ ...m, atRisk: m.relativeIsArchived !== true }))
      .sort(
        (a, b) =>
          Number(!a.atRisk) - Number(!b.atRisk) ||
          Number(a.relativeGroupId !== a.targetGroupId) - Number(b.relativeGroupId !== b.targetGroupId) ||
          a.relativeName.localeCompare(b.relativeName),
      );
    targets.push({ targetUniqueId: first.targetUniqueId, targetName: first.targetName, masters });
  }
  return { targetCount: targets.length, masterCount: masterIds.size, targets };
}

/** The text of `Show-VariationWarning`. Empty when there is nothing to warn about. */
export function variationWarningLines(warning: VariationWarning | null, separator = '::'): string[] {
  if (!warning) return [];
  const lines = [
    'VARIATION TARGETS DETECTED',
    `${warning.targetCount} target(s) are named like variations, with ${warning.masterCount} candidate master(s) not in the target set. Acting on a variation can act on its master too.`,
  ];
  for (const target of warning.targets) {
    lines.push(`  ${target.targetName}  (${target.targetUniqueId})`);
    for (const m of target.masters) {
      const state = m.atRisk ? 'active' : 'archived';
      const risk = m.atRisk ? '  <-- can be archived by this run' : '';
      lines.push(`      master: ${m.relativeName}  (${m.relativeUniqueId}) - ${state}, group ${m.relativeGroupId ?? 'unknown'}${risk}`);
    }
  }
  lines.push(
    `This is a name heuristic, matching on '${separator}', not an API guarantee. It can miss a variation whose master was renamed, and it can flag two unrelated processes that share a prefix. Nothing in the API exposes the real link.`,
  );
  return lines;
}

const was = (archived: boolean | null) => (archived ? 'archived' : 'active');

function changeLines(item: CollateralChange): string[] {
  switch (item.change) {
    case 'Disappeared':
      return [`DISAPPEARED from the tenant. It was ${was(item.wasArchived)} in group ${item.originalGroupId}.`];
    case 'Archived':
      return [`was ACTIVE, is now ARCHIVED (group ${item.originalGroupId})`];
    case 'Unarchived':
      return [`was ARCHIVED, is now ACTIVE (group ${item.originalGroupId})`];
    case 'Moved':
      return [`moved from group ${item.originalGroupId} to group ${item.currentGroupId}`];
    case 'ArchivedAndMoved':
      return [
        `now ${item.isArchivedNow ? 'ARCHIVED' : 'ACTIVE'} in group ${item.currentGroupId}; was ${was(item.wasArchived)} in group ${item.originalGroupId}`,
      ];
    case 'NotInBaseline':
      return [
        'NOT IN THE BEFORE-STATE. The run encountered it, but neither process list returned it beforehand, so what it looked like before is unknown.',
        ...(item.currentGroupId !== null ? [`It is now in group ${item.currentGroupId}.`] : []),
      ];
  }
}

/** A name, or the marker; never the id standing in for one. */
function displayName(item: Pick<CollateralChange, 'name' | 'uniqueId'>): string {
  const name = item.name.trim();
  return name && name.toLowerCase() !== item.uniqueId.toLowerCase() ? name : UNKNOWN_NAME;
}

/**
 * The collateral list as the operator reads it: one entry per process, its name or
 * `UNKNOWN_NAME` (never the id twice), its id, and what happened to it. Port of
 * `Show-CollateralDamage`'s text.
 */
export function collateralLines(collateral: readonly CollateralChange[], phase?: string): string[] {
  if (collateral.length === 0) return [];
  const lines = ['COLLATERAL CHANGES DETECTED'];
  if (phase) lines.push(`Phase: ${phase}`);
  lines.push(`${collateral.length} process(es) changed state without being targets of this run.`);
  for (const item of collateral) {
    lines.push(`  ${displayName(item)}  (${item.uniqueId})`);
    for (const line of changeLines(item)) lines.push(`      ${line}`);
  }
  lines.push(
    'The usual cause is a process VARIATION. Nintex Process Manager stores a variation as its own record in its own group, and acting on one can act on its master too. The coupling is not visible in the process model or the process lists, so it can only be caught by comparing tenant state before and after, which is what this check does.',
    'Another user editing the tenant during the run produces the same signal.',
  );
  return lines;
}

/**
 * Who let a collateral change through, for its `Accepted` row. The file distinguishes an
 * approval given in advance, on the preview, from one given at the gate with the list on
 * screen, as the script's distinguishes `-AcceptCollateral` from a typed YES.
 */
export const ACCEPTANCE_AUTHORITY = {
  inAdvance: 'accepted in advance on the preview',
  atGate: 'accepted at the on-screen confirmation',
} as const;

const groupOf = (item: CollateralChange) => item.currentGroupId;

/**
 * One `Collateral`/`Accepted` results row per change an operator authorised at the gate,
 * so the file records a decision rather than a fault. Port of `New-CollateralAcceptanceRow`.
 */
export function collateralAcceptanceRows(
  collateral: readonly CollateralChange[],
  phase?: string,
  authority: string = ACCEPTANCE_AUTHORITY.atGate,
): ResultRow[] {
  const where = phase ? ` ${phase}` : '';
  return collateral.map((item) =>
    resultRow({
      objectId: item.uniqueId,
      name: item.name,
      operation: 'Collateral',
      status: 'Accepted',
      message: `Changed without being a target (${item.change})${where}; ${authority}, so the run continued`,
      groupId: groupOf(item),
    }),
  );
}

/**
 * One `Collateral`/`Failed` row per change, for a checkpoint the run stopped at, or for
 * the post-delete checkpoint, which cannot stop anything. `outcome` finishes the message:
 * "run stopped before anything was deleted", "detected after deletion".
 */
export function collateralFailureRows(collateral: readonly CollateralChange[], outcome: string): ResultRow[] {
  return collateral.map((item) =>
    resultRow({
      objectId: item.uniqueId,
      name: item.name,
      operation: 'Collateral',
      status: 'Failed',
      message: `Changed without being a target (${item.change}); ${outcome}`,
      groupId: groupOf(item),
    }),
  );
}

/**
 * The collateral gate: true carries on, false stops. The script's `-OnCollateral`
 * scriptblock and its "Type 'YES'" prompt, as an on-screen confirmation. No gate means stop.
 */
export type CollateralGate = (collateral: readonly CollateralChange[], phase: string) => boolean | Promise<boolean>;

export interface CheckpointInput {
  /** The whole tenant before the run (`tenantStateSnapshot`). Null: no checkpoint runs, as in the script. */
  baseline: ProcessIndex | null;
  /** A fresh read of both listings, taken after the phase. */
  fresh: ProcessIndex;
  /** Everything the run changed on purpose: the targets, and every holder it restored. */
  expected: readonly string[];
  /** What the run met, whatever the listings said (the holding group's contents). */
  observed?: readonly string[] | undefined;
  /** Raised at an earlier checkpoint. An approved change is still changed, and is not asked about twice. */
  alreadyRaised?: readonly { uniqueId: string }[] | undefined;
}

/** What changed unasked since the baseline, less what an earlier checkpoint raised. */
export function newCollateral(input: CheckpointInput): CollateralChange[] {
  const raised = new Set((input.alreadyRaised ?? []).map((c) => c.uniqueId.toLowerCase()));
  return compareTenantState(input.baseline, input.fresh, input.expected, input.observed ?? []).filter(
    (c) => !raised.has(c.uniqueId.toLowerCase()),
  );
}

export interface GateOptions {
  gate?: CollateralGate | undefined;
  /** Approved in advance on the preview. Carries on without asking, and says so on each row. */
  acceptCollateral?: boolean | undefined;
}

export interface GateOutcome {
  proceed: boolean;
  /** `Accepted` rows when it carries on, `Failed` rows when it stops. */
  rows: ResultRow[];
  /** What the screen shows: the collateral list, then the decision. */
  lines: string[];
}

/**
 * One gated checkpoint, the decision half: the list, the question, and the rows that
 * record the answer. Stopping is the default and the only unattended answer;
 * `acceptCollateral` is the one way past without a person at the gate. Approval is
 * permission to carry on, not to leave the tenant changed: the caller still puts the
 * collateral back at the end of the run.
 */
export async function decideCollateral(
  collateral: readonly CollateralChange[],
  phase: string,
  options: GateOptions,
): Promise<GateOutcome> {
  if (collateral.length === 0) {
    return { proceed: true, rows: [], lines: ['No collateral changes. Only the processes this run meant to change moved.'] };
  }
  const lines = collateralLines(collateral, phase);
  if (options.acceptCollateral) {
    return {
      proceed: true,
      rows: collateralAcceptanceRows(collateral, phase, ACCEPTANCE_AUTHORITY.inAdvance),
      lines: [...lines, 'Approved in advance on the preview, so the run continues. These are still put back at the end.'],
    };
  }
  const accepted = options.gate ? (await options.gate(collateral, phase)) === true : false;
  if (accepted) {
    return {
      proceed: true,
      rows: collateralAcceptanceRows(collateral, phase, ACCEPTANCE_AUTHORITY.atGate),
      lines: [...lines, 'Accepted, so the run continues. These are still put back at the end.'],
    };
  }
  return {
    proceed: false,
    rows: collateralFailureRows(collateral, `${phase ? `${phase}; ` : ''}run stopped before anything was deleted`),
    lines: [...lines, 'Stopping. Nothing has been deleted.'],
  };
}

/** The two calls a reversal can make. Each reports rather than throws, except a dead session. */
export interface CollateralGateway {
  restore(
    uniqueId: string,
    groupId: number | null,
    destinationGroupExists: boolean,
  ): Promise<{ ok: boolean; statusCode: number | null }>;
  archive(uniqueId: string, comment: string): Promise<{ ok: boolean; message: string; statusCode: number | null }>;
}

export const COLLATERAL_REVERSAL_COMMENT = 'Reversing collateral change from bulk operation';

/**
 * Puts back what it can prove: an archived master is restored into its own group (if it
 * still exists), an un-archived one is re-archived. A move, a disappearance and a
 * process with no before-state are reported, never guessed at. One `ReverseCollateral`
 * row per change. Port of `Restore-CollateralState`.
 *
 * A pure move is not reversed because the only move this app trusts (ReorderTreeNodes)
 * republishes a published process (S2): a new major version of a process nobody asked to
 * touch. `-ApprovalsEnabled` is the gateway's, through `collateralGateway` (executor.ts).
 */
export async function restoreCollateral(
  gateway: CollateralGateway,
  collateral: readonly CollateralChange[],
): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];
  for (const item of collateral) {
    const row = (status: string, message: string, groupId: number | null, statusCode?: number | null) =>
      resultRow({ objectId: item.uniqueId, name: item.name, operation: 'ReverseCollateral', status, message, groupId, statusCode });

    if (item.change === 'NotInBaseline') {
      rows.push(row('Skipped', 'No before-state was captured for this process; check it manually', item.currentGroupId));
      continue;
    }
    if (item.change === 'Disappeared') {
      rows.push(row('Failed', 'Process disappeared during the run and cannot be restored automatically', null));
      continue;
    }

    // Active before, archived now: un-archive it back into its own group.
    if (item.wasArchived === false && item.isArchivedNow === true) {
      if (!item.originalGroupExists) {
        // Restoring it into some other group would be a second unasked-for change on top
        // of the first, and RestoreProcess answers 500 for a group that is gone.
        rows.push(
          row(
            'Failed',
            `Cannot be restored: its group ${item.originalGroupId} no longer exists. It is archived; restore it manually into a group that does.`,
            item.currentGroupId,
          ),
        );
        continue;
      }
      const restored = await gateway.restore(item.uniqueId, item.originalGroupId, true);
      rows.push(
        restored.ok
          ? row('Success', `Restored to group ${item.originalGroupId}`, item.originalGroupId)
          : row(
              'Failed',
              `Restore FAILED; still archived. Restore it manually to group ${item.originalGroupId}`,
              item.currentGroupId,
              restored.statusCode,
            ),
      );
      continue;
    }

    // Archived before, active now: put it back in the archive.
    if (item.wasArchived === true && item.isArchivedNow === false) {
      const archived = await gateway.archive(item.uniqueId, COLLATERAL_REVERSAL_COMMENT);
      rows.push(
        archived.ok
          ? row('Success', 'Re-archived', item.currentGroupId)
          : row('Failed', `Re-archive FAILED; this process is still ACTIVE. ${archived.message}`.trimEnd(), item.currentGroupId, archived.statusCode),
      );
      continue;
    }

    // Same archive state, different group.
    rows.push(
      row(
        'Skipped',
        `Moved from group ${item.originalGroupId} to ${item.currentGroupId}. Move it back manually; moving it here would publish a new version of a process this run was not asked to touch.`,
        item.currentGroupId,
      ),
    );
  }
  return rows;
}
