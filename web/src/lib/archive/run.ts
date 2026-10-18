/**
 * Applying an archive plan, then settling every outcome from a fresh read.
 *
 * Ported from the archive and verify phases of the script's
 * `Invoke-BulkArchiveProcesses`. What the calls returned is a first draft. The final
 * status of every process comes from re-reading the tenant at the end, because an
 * archive can report failure and take effect anyway, and report success and not
 * (API_ARCHITECTURE.md).
 */

import type { Journal } from '../exec/journal.ts';
import { step } from '../exec/journal.ts';
import { resultRow, type ResultRow } from '../exec/report.ts';
import { forEachBatched, type Controls } from '../exec/runner.ts';
import { compareTenantState, indexEntry, type Collateral, type ProcessIndex } from '../tenant/state.ts';
import { archiveOne, statusFor, type ArchiveGateway } from './outcome.ts';
import { describeGroup, variationMessage, type ArchivePlan, type ArchiveTarget } from './plan.ts';

export interface RunArchiveOptions {
  changeDescription: string;
  approvalOverride: boolean;
  /** The variation warnings were reviewed and accepted on screen. */
  variationsAccepted: boolean;
  /**
   * Fresh index taken immediately before the first write. The baseline for collateral,
   * and a last chance to notice a target someone archived since the plan was built.
   */
  baseline: ProcessIndex;
  concurrency?: number | undefined;
  onProgress?: ((done: number, total: number, label: string) => void) | undefined;
}

const ATTEMPTED_ALREADY = 'Already attempted earlier in this run, so not sent again';

/**
 * Archive every target, one proxy operation per call.
 *
 * Refusals are data, not exceptions: the batch carries on. A fatal error (the session
 * ended) stops the run, and every target not attempted gets a Skipped row saying so.
 */
export async function runArchive(
  gateway: ArchiveGateway,
  journal: Journal,
  plan: ArchivePlan,
  controls: Controls,
  options: RunArchiveOptions,
): Promise<ResultRow[]> {
  if (plan.variations.length > 0 && !options.variationsAccepted) {
    throw new Error('The variation warnings have to be reviewed and accepted before archiving.');
  }

  const rows: ResultRow[] = [...plan.skipped];

  for (const match of plan.variations) {
    rows.push(
      resultRow({
        objectId: match.relativeUniqueId,
        name: match.relativeName,
        operation: 'VariationWarning',
        status: 'Accepted',
        message: `${variationMessage(match)}; risk accepted before the run started`,
        groupId: match.relativeGroupId,
      }),
    );
  }

  const targets: ArchiveTarget[] = [];
  for (const target of plan.targets) {
    if (indexEntry(options.baseline, target.uniqueId)?.isArchived) {
      rows.push(
        resultRow({
          objectId: target.uniqueId,
          name: target.name,
          operation: 'Archive',
          status: 'Skipped',
          message: 'Already archived by the time the run started; not sent',
          groupId: target.groupId,
        }),
      );
      continue;
    }
    targets.push(target);
  }

  const { results, notAttempted } = await forEachBatched(
    targets,
    controls,
    async (target): Promise<ResultRow> => {
      const archiveStep = step.archive(target.uniqueId);
      if (journal.isSettled(archiveStep) || journal.phaseOf(archiveStep) === 'begin') {
        return resultRow({
          objectId: target.uniqueId,
          name: target.name,
          operation: 'Archive',
          status: 'Skipped',
          message: ATTEMPTED_ALREADY,
          groupId: target.groupId,
        });
      }

      journal.append({ step: archiveStep, kind: 'process.archive', phase: 'begin' });
      try {
        const result = await archiveOne(gateway, target.uniqueId, options.changeDescription, {
          approvalOverride: options.approvalOverride,
          isFatal: controls.isFatal,
        });
        journal.append({
          step: archiveStep,
          kind: 'process.archive',
          phase: result.success ? 'commit' : 'fail',
          data: { outcome: result.outcome, statusCode: result.statusCode },
        });
        return resultRow({
          objectId: target.uniqueId,
          name: target.name,
          operation: 'Archive',
          status: statusFor(result.outcome),
          message: result.success ? `${result.message} from ${describeGroup(target)}` : result.message,
          groupId: target.groupId,
          statusCode: result.statusCode,
        });
      } catch (error) {
        // Only a fatal error reaches here; archiveOne turns everything else into an
        // outcome. The step stays `begin`: the archive may or may not have been sent.
        controls.stop(controls.isFatal(error) ?? (error instanceof Error ? error.message : String(error)));
        return resultRow({
          objectId: target.uniqueId,
          name: target.name,
          operation: 'Archive',
          status: 'Failed',
          message: `Stopped while archiving: ${controls.stoppedReason() ?? 'unknown error'}. The final read decides whether it took effect.`,
          groupId: target.groupId,
        });
      }
    },
    {
      concurrency: options.concurrency,
      label: (t) => t.name,
      onProgress: (p) => options.onProgress?.(p.done, p.total, p.label),
    },
  );

  rows.push(...results);
  for (const target of notAttempted) {
    rows.push(
      resultRow({
        objectId: target.uniqueId,
        name: target.name,
        operation: 'Archive',
        status: 'Skipped',
        message: `Not attempted: ${controls.stoppedReason() ?? 'the run stopped'}`,
        groupId: target.groupId,
      }),
    );
  }

  return rows;
}

const SENT: ReadonlySet<string> = new Set(['Success', 'Overridden', 'Pending', 'Blocked', 'Failed']);

/**
 * Settle every archive row against a fresh read of the tenant.
 *
 * The script re-checked only rows the calls called successful. This checks every row
 * whose call was sent, because the API notes record archives that reported failure and
 * were found archived afterwards:
 *
 *  - archived now: Success, whatever the call said, with the call's words kept;
 *  - still active after a call that said yes: Failed;
 *  - in neither listing after a call that said yes: Unverified, because the listings
 *    are incomplete and calling it Failed sends an operator after a process that is very
 *    likely archived;
 *  - otherwise the call's status stands, so a 200 that is still pending stays Pending.
 */
export function settleFromFinalRead(rows: readonly ResultRow[], after: ProcessIndex): ResultRow[] {
  return rows.map((row) => {
    if (row.operation !== 'Archive' || !SENT.has(row.status)) return row;

    const now = indexEntry(after, row.objectId);
    const saidYes = row.status === 'Success' || row.status === 'Overridden';

    if (now?.isArchived) {
      if (saidYes) return row;
      return {
        ...row,
        status: 'Success',
        message: `Archived, confirmed by the final read, although the run reported: ${row.message}`,
      };
    }

    if (!saidYes) return row;

    if (now === null) {
      return {
        ...row,
        status: 'Unverified',
        message:
          'Archive was accepted but neither listing returns the process, so its state could not be confirmed from a re-read',
      };
    }

    return { ...row, status: 'Failed', message: 'Archive reported success but the process is still active' };
  });
}

const CHANGE_WORDS: Readonly<Record<Collateral['change'], string>> = {
  Archived: 'was archived',
  Unarchived: 'was restored from the archive',
  Moved: 'moved to another group',
  ArchivedAndMoved: 'was archived and moved',
  Disappeared: 'no longer appears in either listing',
  NotInBaseline: 'was touched by the run but was in neither listing beforehand, so whether it changed is unknown',
};

/**
 * Anything that changed without being asked to, as results rows.
 *
 * The script also puts back what it can (`Restore-CollateralState`). That needs a
 * restore operation this app does not have yet, so for now these are reported for
 * manual attention, each with what changed and where it was before.
 */
export function collateralRows(
  baseline: ProcessIndex,
  after: ProcessIndex,
  targetIds: readonly string[],
): ResultRow[] {
  return compareTenantState(baseline, after, targetIds, targetIds).map((c) =>
    resultRow({
      objectId: c.uniqueId,
      name: c.name,
      operation: 'Collateral',
      status: 'Unreversed',
      message:
        `Not a target, but ${CHANGE_WORDS[c.change]} during this run` +
        (c.originalGroupId !== null ? ` (it was in group ${c.originalGroupId})` : '') +
        '. This app does not reverse collateral yet; check it in Process Manager.',
      groupId: c.currentGroupId ?? c.originalGroupId,
    }),
  );
}

/** The companion file for a tenant administrator: every refused process and why. */
export function manualReviewCsvRows(rows: readonly ResultRow[], siteUrl: string): string[][] {
  const out = [['ObjectID', 'Name', 'GroupId', 'StatusCode', 'Reason', 'Link']];
  for (const row of rows) {
    if (row.status !== 'Blocked') continue;
    out.push([row.objectId, row.name, row.groupId, row.statusCode, row.message, itemLink(siteUrl, row)]);
  }
  return out;
}

/** Where the process opens in Process Manager, or '' when the site is not known. */
export function processLink(siteUrl: string, processUniqueId: string): string {
  return siteUrl === '' ? '' : `${siteUrl.replace(/\/+$/, '')}/Process/${processUniqueId}`;
}

/**
 * Where the group opens in Process Manager, or '' when the site is not known. The format
 * is the product's group page and the breadcrumb items' own `url` (F1).
 */
export function groupLink(siteUrl: string, groupUniqueId: string): string {
  return siteUrl === '' ? '' : `${siteUrl.replace(/\/+$/, '')}/Process/Group/${groupUniqueId}`;
}

/**
 * Where a results row's item opens. Documents get no link: their URL format has not been
 * recorded, and a guessed link that opens the wrong page is worse than none.
 */
export function itemLink(siteUrl: string, row: ResultRow): string {
  if (row.objectType === 'Process') return processLink(siteUrl, row.objectId);
  if (row.objectType === 'ProcessGroup') return groupLink(siteUrl, row.objectId);
  return '';
}
