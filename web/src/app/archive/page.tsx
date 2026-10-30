'use client';

/**
 * Bulk Archive: choose in the tree or by id, preview, apply, download the results.
 *
 * The tree and the id box add up, each process once (W7). Ids are resolved against the
 * process lists this page reads anyway (lib/archive/ids.ts): an active process is a
 * target, an archived one or an id nothing matches is left out with a row saying why.
 *
 * The preview is the dry run and is where every run starts. Nothing is written until
 * the operator has entered a change description, reviewed any variation warnings, and
 * confirmed. Immediately before the first write the touched levels of the tree and both
 * process listings are read again, so the run acts on the tenant as it is, not as it was
 * when the preview was built.
 */

import { Button, Input } from '@exp-textura/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CHOSEN_FROM_TREE,
  combineSelections,
  groupsOfPicked,
  idTargetFindings,
  idTargetsNeedingSetReads,
  LARGE_ID_LIST,
  readGroupLevels,
  resolveArchiveIds,
  withGroupPaths,
  type ArchiveIdResolution,
} from '@/lib/archive/ids.ts';
import type { ArchivePlan } from '@/lib/archive/plan.ts';
import {
  buildArchivePlan,
  describeGroup,
  previewRows,
  targetsInVariationSets,
  VARIATION_ARCHIVE_LIST_NOTE,
  variationMessage,
} from '@/lib/archive/plan.ts';
import type { VariationSet } from '@/lib/pm/processes.ts';
import { ARCHIVE_STATUSES } from '@/lib/archive/outcome.ts';
import { collateralRows, manualReviewCsvRows, runArchive, settleFromFinalRead } from '@/lib/archive/run.ts';
import { toCsv } from '@/lib/csv/parse.ts';
import { Journal, loadJournal, sessionJournalStore, type JournalEntry } from '@/lib/exec/journal.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { createControls, errorMessage } from '@/lib/exec/runner.ts';
import { revalidatePlacements, type StaleFinding } from '@/lib/plan/revalidate.ts';
import { loadGroupPaths } from '@/lib/select/archived.ts';
import { chosenLabel, EMPTY_ID_INPUT, typedIds, type IdInput } from '@/lib/select/ids.ts';
import { loadForSelection, type Resolution } from '@/lib/select/resolve.ts';
import { hasSelection } from '@/lib/select/selection.ts';
import { loadProcessIndex } from '@/lib/tenant/state.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import {
  browserArchiveGateway,
  browserGateway,
  groupBreadcrumb,
  PmRequestError,
  type SessionInfo,
} from '@/lib/ui/gateway.ts';
import { CleanupPanel } from '../components/CleanupPanel.tsx';
import { ProcessIdInput } from '../components/ProcessIdInput.tsx';
import { ResultsSummary } from '../components/ResultsSummary.tsx';
import { SessionGate } from '../components/SessionGate.tsx';
import { TreeBrowser, useBrowseTree } from '../components/TreeBrowser.tsx';
import type { ProcessIndex } from '@/lib/tenant/state.ts';
import { Notice, valueOf } from '../_ui/kit.tsx';

type Stage =
  | { kind: 'select' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: ArchivePlan }
  | { kind: 'running'; plan: ArchivePlan; progress: string }
  | {
      kind: 'done';
      plan: ArchivePlan;
      rows: ResultRow[];
      warning: string | null;
      /** The final read, or null when it failed. Cleanup needs it. */
      after: ProcessIndex | null;
    };

export default function ArchivePage() {
  return (
    <SessionGate title="Bulk Archive">
      {(session, onSignedOut) => <ArchiveFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function ArchiveFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserGateway(), []);
  const archiveGateway = useMemo(() => browserArchiveGateway(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof PmRequestError && error.signedOut) onSignedOut();
    },
    [onSignedOut],
  );
  const browse = useBrowseTree(gateway, handleError);

  const [stage, setStage] = useState<Stage>({ kind: 'select' });
  const [source, setSource] = useState<'tree' | 'ids'>('tree');
  const [idInput, setIdInput] = useState<IdInput>(EMPTY_ID_INPUT);
  /** The id count the operator agreed to build a plan for, above LARGE_ID_LIST. */
  const [largeConfirmed, setLargeConfirmed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changeDescription, setChangeDescription] = useState('');
  const [approvalOverride, setApprovalOverride] = useState(true);
  const [variationsAccepted, setVariationsAccepted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stale, setStale] = useState<StaleFinding[]>([]);
  const [interrupted, setInterrupted] = useState<JournalEntry[]>([]);
  const abort = useRef<AbortController | null>(null);

  // A run interrupted by a closed or reloaded tab leaves its journal behind.
  useEffect(() => {
    const store = sessionJournalStore();
    const journal = store ? loadJournal(store, session.tenant) : null;
    if (journal) setInterrupted(journal.inDoubt());
  }, [session.tenant]);

  const fail = (cause: unknown) => {
    handleError(cause);
    setError(errorMessage(cause));
  };

  const ids = typedIds(idInput.text);
  const treeChosen = hasSelection(browse.selection);
  const askLarge = ids.length > LARGE_ID_LIST && largeConfirmed !== ids.length;

  async function buildPlan() {
    setError(null);
    setStale([]);
    setVariationsAccepted(false);
    setConfirming(false);
    if (askLarge) return;
    try {
      let resolution: Extract<Resolution, { status: 'complete' }> | null = null;
      if (treeChosen) {
        setStage({ kind: 'planning', progress: 'Reading the selected groups…' });
        const loaded = await loadForSelection(gateway, browse.tree, browse.selection, {
          onProgress: (n) => setStage({ kind: 'planning', progress: `Reading the selected groups… ${n} read` }),
        });
        browse.setTree(loaded.tree);
        resolution = loaded.resolution;
      }
      setStage({ kind: 'planning', progress: 'Reading the process lists…' });
      const index = await loadProcessIndex(gateway.processesList, {
        onProgress: (n) => setStage({ kind: 'planning', progress: `Reading the process lists… ${n} processes` }),
      });

      let picked: ArchiveIdResolution | null = null;
      let idSetReads: string[] = [];
      if (ids.length > 0) {
        picked = resolveArchiveIds(ids, index, (value) => chosenLabel(idInput, value));
        const resolvedAny = picked.processes.length > 0 || picked.skipped.some((r) => r.operation === 'Select');
        if (!resolvedAny && (resolution?.processes.length ?? 0) === 0) {
          setError(`None of the ids matched a process: ${picked.unknown.join(', ')}`);
          setStage({ kind: 'select' });
          return;
        }
        const isFatal = (e: unknown) => e instanceof PmRequestError && e.signedOut;
        const groups = groupsOfPicked(picked.processes);
        // The path each id target is shown under, one breadcrumb per group, as the archived view reads it.
        const paths = await loadGroupPaths(groups, groupBreadcrumb, {
          isFatal: (e) => (isFatal(e) ? 'signed out' : null),
          onProgress: (done, total) => setStage({ kind: 'planning', progress: `Reading group paths… ${done} of ${total}` }),
        });
        picked = { ...picked, processes: withGroupPaths(picked.processes, paths) };
        // One level per group says which id targets are variations (archive/ids.ts).
        const levels = await readGroupLevels(groups, async (g) => (await gateway.groupsTree(g)).treeItems ?? [], {
          isFatal,
          onProgress: (done, total) => setStage({ kind: 'planning', progress: `Reading each group's processes… ${done} of ${total}` }),
        });
        idSetReads = idTargetsNeedingSetReads(picked.processes, levels);
      }
      const combined = combineSelections(resolution, picked);

      // Siblings are not in the tree, so each variation's set is read from the process.
      const sets = new Map<string, VariationSet>();
      const unread = new Map<string, string>();
      const inSets = [...new Set([...targetsInVariationSets(resolution?.processes ?? []), ...idSetReads])];
      for (const [i, uniqueId] of inSets.entries()) {
        setStage({ kind: 'planning', progress: `Reading variation sets… ${i + 1} of ${inSets.length}` });
        try {
          const set = await gateway.variationSet(uniqueId);
          if (set) sets.set(uniqueId.toLowerCase(), set);
        } catch (cause) {
          handleError(cause);
          if (cause instanceof PmRequestError && cause.signedOut) throw cause;
          unread.set(uniqueId.toLowerCase(), errorMessage(cause));
        }
      }
      setStage({ kind: 'plan', plan: buildArchivePlan(combined, index, sets, unread) });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'select' });
    }
  }

  async function apply(plan: ArchivePlan) {
    setError(null);
    setConfirming(false);
    setStage({ kind: 'running', plan, progress: 'Checking the plan against the tenant…' });

    try {
      const findings = await revalidatePlacements(
        gateway,
        plan.targets
          // A target picked by id with no group in the listing has no level to look in;
          // the check against the fresh lists below still covers it.
          .filter((t) => t.groupUniqueId !== null || (t.chosen ?? CHOSEN_FROM_TREE) === CHOSEN_FROM_TREE)
          .map((t) => ({
            uniqueId: t.uniqueId,
            parentUniqueId: t.groupUniqueId,
            display: t.name,
            parentDisplay: describeGroup(t),
          })),
      );
      if (findings.length > 0) {
        setStale(findings);
        setStage({ kind: 'plan', plan });
        return;
      }

      setStage({ kind: 'running', plan, progress: 'Reading the process lists before the first change…' });
      const baseline = await loadProcessIndex(gateway.processesList);
      // Each id target still active and still in the group the plan showed (W7).
      const idFindings = idTargetFindings(plan.targets, baseline);
      if (idFindings.length > 0) {
        setStale(idFindings);
        setStage({ kind: 'plan', plan });
        return;
      }

      const journal = Journal.start(crypto.randomUUID(), session.tenant, Date.now(), sessionJournalStore());
      abort.current = new AbortController();
      const controls = createControls({ signal: abort.current.signal });

      const draft = await runArchive(archiveGateway, journal, plan, controls, {
        changeDescription: changeDescription.trim(),
        approvalOverride,
        variationsAccepted,
        baseline,
        onProgress: (done, total, label) =>
          setStage({ kind: 'running', plan, progress: `Archived ${done} of ${total}. Last: ${label}` }),
      });

      setStage({ kind: 'running', plan, progress: 'Reading the process lists to confirm every outcome…' });
      let rows = draft;
      let warning = controls.stoppedReason();
      let after: ProcessIndex | null = null;
      try {
        after = await loadProcessIndex(gateway.processesList);
        rows = [
          ...settleFromFinalRead(draft, after),
          ...collateralRows(
            baseline,
            after,
            plan.targets.map((t) => t.uniqueId),
          ),
        ];
      } catch (cause) {
        // Not handleError: a dead session here must not swap the page for the sign-in
        // prompt, or the rows for everything this run already changed would be lost.
        warning =
          `${warning ? `${warning} ` : ''}The final read failed (${errorMessage(cause)}), so these statuses ` +
          `are what the calls reported, not confirmed. An archive can report failure and still take effect.`;
      }

      journal.discard();
      setInterrupted([]);
      setStage({ kind: 'done', plan, rows, warning, after });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'plan', plan });
    } finally {
      abort.current = null;
    }
  }

  function startOver() {
    browse.refresh();
    setIdInput(EMPTY_ID_INPUT);
    setLargeConfirmed(null);
    setSource('tree');
    setChangeDescription('');
    setStage({ kind: 'select' });
  }

  return (
    <>
      {interrupted.length > 0 && (
        <div className="panel warning">
          <h2>An earlier run in this tab was interrupted</h2>
          <p>
            {interrupted.length} archive{interrupted.length === 1 ? ' was' : 's were'} sent with no answer
            recorded, so they may or may not have taken effect. Build the plan again: anything already
            archived is listed as skipped.
          </p>
          <Button
            buttonType="secondary"
            onClick={() => {
              const store = sessionJournalStore();
              if (store) loadJournal(store, session.tenant)?.discard();
              setInterrupted([]);
            }}
          >
            Dismiss
          </Button>
        </div>
      )}

      {error !== null && (
        <Notice tone="critical" title="Problem">
          {error}
        </Notice>
      )}

      {stage.kind === 'select' && (
        <>
          <div className="panel">
            <h2>1. Choose what to archive</h2>
            <p>
              Pick from the tree, or by id; the two add up, each process once. Checking a group means everything
              under it, including subgroups you have not opened. Document groups and shortcuts cannot be archived
              from here; a shortcut&rsquo;s id is its home process&rsquo;s, so by id it picks the home process.
            </p>
            <div className="row" role="tablist">
              {(
                [
                  ['tree', `From the tree${treeChosen ? ' (some checked)' : ''}`],
                  ['ids', `By id or CSV${ids.length > 0 ? ` (${ids.length})` : ''}`],
                ] as const
              ).map(([key, label]) => (
                <Button key={key} role="tab" aria-selected={source === key} buttonType={source === key ? 'primary' : 'secondary'} onClick={() => setSource(key)}>
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {source === 'tree' && <TreeBrowser state={browse} />}
          {source === 'ids' && <ProcessIdInput value={idInput} onChange={setIdInput} />}
          {askLarge && (
            <Notice tone="warning" title={`${ids.length} ids`}>
              That is more than {LARGE_ID_LIST}. Building the plan reads the group of each one, and the variation set of
              each that is a variation, which takes a while.{' '}
              <Button buttonType="secondary" onClick={() => setLargeConfirmed(ids.length)}>
                Build the plan for all {ids.length}
              </Button>
            </Notice>
          )}
          <div className="row">
            <Button disabled={(!treeChosen && ids.length === 0) || askLarge} onClick={() => void buildPlan()}>
              Preview what would be archived
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'planning' && <p className="pending">{stage.progress}</p>}

      {stage.kind === 'plan' && (
        <PlanView
          plan={stage.plan}
          stale={stale}
          changeDescription={changeDescription}
          setChangeDescription={setChangeDescription}
          approvalOverride={approvalOverride}
          setApprovalOverride={setApprovalOverride}
          variationsAccepted={variationsAccepted}
          setVariationsAccepted={setVariationsAccepted}
          confirming={confirming}
          setConfirming={setConfirming}
          onBack={() => setStage({ kind: 'select' })}
          onReplan={() => void buildPlan()}
          onApply={() => void apply(stage.plan)}
        />
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Archiving</h2>
          <p className="pending">{stage.progress}</p>
          <Button buttonType="secondary" onClick={() => abort.current?.abort()}>
            Stop after the current batch
          </Button>
        </div>
      )}

      {stage.kind === 'done' && (
        <>
          <ResultsView rows={stage.rows} warning={stage.warning} siteUrl={session.siteUrl} onStartOver={startOver} />
          {stage.after !== null && !stage.warning ? (
            <CleanupPanel
              tenant={session.tenant}
              groups={stage.plan.groups}
              index={stage.after}
              onError={handleError}
              onRows={(extra) => setStage({ ...stage, rows: [...stage.rows, ...extra] })}
              heading="4. Delete the groups this left empty (optional)"
              offer={
                <>
                  The selection covered {stage.plan.groups.length} group{stage.plan.groups.length === 1 ? '' : 's'}. This
                  checks which of them now hold nothing but archived processes, and lets you delete those. Nothing is
                  deleted until you confirm.
                  {pickedById(stage.plan) &&
                    ' Only groups checked in the tree are offered. Processes picked by id cover no group, so they never make a group a candidate, even if this run emptied it.'}
                </>
              }
            />
          ) : null}
          {stage.after !== null && !stage.warning && stage.plan.groups.length === 0 && pickedById(stage.plan) && (
            <div className="panel">
              <h2>4. Delete the groups this left empty</h2>
              <p>
                Not offered. Only groups checked in the tree are offered, and nothing was checked. Processes picked by id
                cover no group, so they never make a group a candidate, even if this run emptied it.
              </p>
            </div>
          )}
          {(stage.after === null || stage.warning) && stage.plan.groups.length > 0 && (
            <div className="panel">
              <h2>4. Delete the groups this left empty</h2>
              <p>
                Not offered, because the run did not finish cleanly or could not be re-read. Archive
                again to get a confirmed result first.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

function PlanView(props: {
  plan: ArchivePlan;
  stale: StaleFinding[];
  changeDescription: string;
  setChangeDescription: (value: string) => void;
  approvalOverride: boolean;
  setApprovalOverride: (value: boolean) => void;
  variationsAccepted: boolean;
  setVariationsAccepted: (value: boolean) => void;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onBack: () => void;
  onReplan: () => void;
  onApply: () => void;
}) {
  const { plan } = props;
  const needsAcceptance = plan.variations.length > 0;
  const ready =
    plan.targets.length > 0 &&
    props.changeDescription.trim() !== '' &&
    (!needsAcceptance || props.variationsAccepted) &&
    props.stale.length === 0;

  return (
    <>
      <div className="panel">
        <h2>2. Check the plan. Nothing has been changed.</h2>
        <p>
          {plan.targets.length} process{plan.targets.length === 1 ? '' : 'es'} would be archived.{' '}
          {plan.skipped.length > 0 && `${plan.skipped.length} left out (listed below).`}
        </p>
        <div className="row">
          <Button buttonType="secondary" onClick={() => downloadCsv(datedFilename('archive-preview'), resultsToCsv(previewRows(plan)))}>
            Download the preview
          </Button>
          <Button buttonType="secondary" onClick={props.onBack}>
            Change the selection
          </Button>
        </div>
      </div>

      {props.stale.length > 0 && (
        <div className="panel error">
          <h2>The tenant has changed since this plan was built</h2>
          <ul className="checklist">
            {props.stale.map((f) => (
              <li key={f.uniqueId}>{f.message}</li>
            ))}
          </ul>
          <Button onClick={props.onReplan}>
            Build the plan again
          </Button>
        </div>
      )}

      {plan.unreadVariationSets.length > 0 && (
        <div className="panel warning">
          <h2>Variation sets that could not be read</h2>
          <p>
            These targets are variations, and their sets could not be read, so any siblings that
            may be affected are not listed above. Check them in Process Manager before archiving.
          </p>
          <ul className="checklist">
            {plan.unreadVariationSets.map((u) => (
              <li key={u.uniqueId}>
                {u.name}: {u.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {needsAcceptance && (
        <div className="panel warning">
          <h2>Variations: these may be archived too</h2>
          <p>
            Process variations are coupled. Each process below is a variation of a target, or looks
            like one by its name, and is not itself a target. Archiving the target can affect it.
            Variation siblings are not shown in the tree, so this is the only place they appear.
          </p>
          <p>{VARIATION_ARCHIVE_LIST_NOTE}</p>
          <ul className="checklist">
            {plan.variations.map((m) => (
              <li key={`${m.targetUniqueId}|${m.relativeUniqueId}`}>
                <strong>{m.relativeName}</strong>
                {m.relativeGroupId !== null && ` (group ${m.relativeGroupId})`}: {variationMessage(m)}
              </li>
            ))}
          </ul>
          <label className="inline">
            <input
              type="checkbox"
              checked={props.variationsAccepted}
              onChange={(e) => props.setVariationsAccepted(e.target.checked)}
            />{' '}
            I have reviewed these and want to archive the targets anyway
          </label>
        </div>
      )}

      <div className="panel">
        <h2>Would be archived</h2>
        <table className="plan">
          <thead>
            <tr>
              <th>Process</th>
              <th>Group</th>
              <th>Chosen</th>
            </tr>
          </thead>
          <tbody>
            {plan.targets.map((t) => (
              <tr key={t.uniqueId}>
                <td>
                  {t.name}
                  {!t.inIndex && <span className="tag">not in either list</span>}
                </td>
                <td>{describeGroup(t)}</td>
                <td>{t.chosen ?? CHOSEN_FROM_TREE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {plan.skipped.length > 0 && (
        <details className="panel">
          <summary>Left out ({plan.skipped.length})</summary>
          <ul className="checklist">
            {plan.skipped.map((row) => (
              <li key={`${row.operation}|${row.objectId}`}>
                {/* An id that matched nothing has no name; the id is what the operator can look for (W7). */}
                {row.operation === 'Resolve' ? row.objectId : row.name}: {row.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="panel">
        <h2>3. Archive</h2>
        <label htmlFor="change">Change description (recorded on every process)</label>
        <Input
          id="change"
          value={props.changeDescription}
          onChange={(e) => props.setChangeDescription(valueOf(e))}
          placeholder="Why these processes are being archived"
          required
        />
        <label className="inline">
          <input
            type="checkbox"
            checked={props.approvalOverride}
            onChange={(e) => props.setApprovalOverride(e.target.checked)}
          />{' '}
          If the tenant holds an archive for approval, archive it now anyway (the &ldquo;Archive now&rdquo;
          option in Process Manager)
        </label>
        {props.confirming ? (
          <div className="row">
            <Button onClick={props.onApply}>
              Yes, archive {plan.targets.length} process{plan.targets.length === 1 ? '' : 'es'} now
            </Button>
            <Button buttonType="secondary" onClick={() => props.setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="row">
            <Button disabled={!ready} onClick={() => props.setConfirming(true)}>
              Archive {plan.targets.length} process{plan.targets.length === 1 ? '' : 'es'}
            </Button>
          </div>
        )}
        {!ready && plan.targets.length > 0 && (
          <p className="small">
            {props.changeDescription.trim() === '' && 'Enter a change description. '}
            {needsAcceptance && !props.variationsAccepted && 'Review the variation warnings. '}
          </p>
        )}
      </div>
    </>
  );
}

function ResultsView({
  rows,
  warning,
  siteUrl,
  onStartOver,
}: {
  rows: ResultRow[];
  warning: string | null;
  siteUrl: string;
  onStartOver: () => void;
}) {
  const blocked = rows.some((r) => r.status === 'Blocked' && r.operation === 'Archive');
  return (
    <ResultsSummary
      rows={rows}
      vocabulary={[...ARCHIVE_STATUSES, 'Orphaned']}
      warning={warning}
      siteUrl={siteUrl}
      filenameStem="archive-results"
      actions={
        <>
          {blocked && (
            <Button
              buttonType="secondary"
              onClick={() => downloadCsv(datedFilename('archive-manual-review'), toCsv(manualReviewCsvRows(rows, siteUrl)))}
            >
              Download the manual review list
            </Button>
          )}
          <Button buttonType="secondary" onClick={onStartOver}>
            Archive something else
          </Button>
        </>
      }
    />
  );
}

/** Whether any target was picked by id, so the cleanup step can say ids never offer a group. */
function pickedById(plan: ArchivePlan): boolean {
  return plan.targets.some((t) => (t.chosen ?? CHOSEN_FROM_TREE) !== CHOSEN_FROM_TREE);
}
