'use client';

/**
 * Bulk Delete: a dry run, then the run itself (W5 phase 7).
 *
 * The dry run builds the plan the way the script's preview does, reading and never
 * writing. The run then does everything the script's Mode 5 does, building its own plan
 * again with the archive restored, and asks each of the script's questions on screen: a
 * question nobody answers is a no, and every no puts back what the run un-archived. The
 * plan is kept in this browser as the run goes, so a run that dies (a session that ends
 * mid-way) can be finished from it after signing in again, or from a downloaded copy.
 *
 * The tree and archived-view entry points, delete by group and empty-group cleanup are
 * W6.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { errorMessage } from '@/lib/exec/runner.ts';
import { deleteResultsSummary, resumeUnwind, runBulkDelete, type DeleteDecisions } from '@/lib/delete/bulkDelete.ts';
import type { Reconciliation } from '@/lib/delete/claims.ts';
import { collateralLines, variationWarningLines } from '@/lib/delete/collateral.ts';
import type { DeleteEvent, DeleteStage } from '@/lib/delete/events.ts';
import { REFERENCE_REMOVAL_DESCRIPTION } from '@/lib/delete/executor.ts';
import { findOrphanedGroupProcesses, groupExistsCoverage, groupExistsCoverageLines } from '@/lib/delete/groups.ts';
import { orphanedTargetWarningLines } from '@/lib/delete/holdingGroup.ts';
import { parsePlan, serializePlan, type DependencyPlan, type DraftHolder } from '@/lib/delete/ledger.ts';
import type { DeleteIndex } from '@/lib/delete/model.ts';
import { buildDeletePlan, loadDeleteIndex, planSummaryLines } from '@/lib/delete/planner.ts';
import { resolveTargetIds, targetsFromCsv } from '@/lib/delete/targets.ts';
import { datedFilename, downloadCsv, downloadText } from '@/lib/ui/download.ts';
import { browserDeleteGateway, browserPlanningGateway, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { browserPlanStore, planNeedsFinishing } from '@/lib/ui/planStore.ts';
import { ResultsSummary } from '../components/ResultsSummary.tsx';
import { SessionGate } from '../components/SessionGate.tsx';

const RESULT_STATUSES = ['Success', 'Skipped', 'Failed', 'Accepted'] as const;

type Question =
  | { kind: 'yesno'; title: string; lines: string[]; yes: string; no: string; resolve: (answer: boolean) => void }
  | { kind: 'drafts'; holders: readonly DraftHolder[]; resolve: (ids: string[]) => void };

type Stage =
  | { kind: 'input' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: DependencyPlan; index: DeleteIndex; unknown: string[]; seconds: number }
  | { kind: 'running'; log: string[]; progress: string }
  | { kind: 'done'; rows: ResultRow[]; plan: DependencyPlan | null; log: string[]; title: string };

const STAGE_TEXT: Record<DeleteStage, string> = {
  gathering: 'Reading both process lists',
  snapshot: 'Recording where every target is before anything moves',
  'holding-group': 'Making the holding group and restoring archived targets into it',
  'checking-collateral': 'Checking the tenant for processes that changed without being targets',
  'building-plan': 'Building the plan, with the archive restored',
  'removing-references': 'Removing references from the processes that hold them',
  verifying: 'Reading each edited process back to check nothing is left',
  'archiving-targets': 'Archiving the targets before deleting them',
  'deleting-targets': 'Deleting the targets',
  'checking-collateral-after-delete': 'Checking the tenant again after the deletes',
  'returning-processes': 'Returning what the run restored to its own group, archived',
  'reversing-collateral': 'Putting back processes that changed without being targets',
  cleanup: 'Removing the holding group',
  rechecking: 'Re-checking what still needs attention against a fresh read',
};

export default function DeletePage() {
  return (
    <SessionGate title="Bulk Delete">
      {(session, onSignedOut) => <DeleteFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function DeleteFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const planning = useMemo(() => browserPlanningGateway(), []);
  const gateway = useMemo(() => browserDeleteGateway(), []);
  const store = useMemo(() => browserPlanStore(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof PmRequestError && error.signedOut) onSignedOut();
    },
    [onSignedOut],
  );

  const [stage, setStage] = useState<Stage>({ kind: 'input' });
  const [ids, setIds] = useState('');
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [thorough, setThorough] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [unfinished, setUnfinished] = useState<DependencyPlan | null>(null);

  // A plan an earlier run left unfinished, kept in this browser.
  useEffect(() => {
    store
      .load()
      .then((plan) => setUnfinished(planNeedsFinishing(plan) ? plan : null))
      .catch(() => setUnfinished(null));
  }, [store]);

  async function readFile(file: File | undefined) {
    setFileNote(null);
    if (!file) return;
    const read = targetsFromCsv(await file.text());
    if (read.idColumnMissing) {
      setFileNote(`Read ${read.rowCount} row(s) but found no id column. Columns in the file: ${read.headers.join(', ')}.`);
      return;
    }
    setIds(read.ids.join('\n'));
    setFileNote(`${file.name}: ${read.ids.length} id(s).`);
  }

  async function dryRun() {
    setError(null);
    const started = Date.now();
    const onEvent = (event: DeleteEvent) => {
      if (event.kind === 'progress') setStage({ kind: 'planning', progress: `${event.label}: ${event.done} of ${event.total}` });
    };
    try {
      setStage({ kind: 'planning', progress: 'Reading both process lists…' });
      const index = await loadDeleteIndex(planning, {
        onProgress: (loaded) => setStage({ kind: 'planning', progress: `Reading both process lists: ${loaded} so far` }),
      });
      const { uniqueIds, unknown } = resolveTargetIds(ids.split(/[\s,;]+/), index);
      if (uniqueIds.length === 0) {
        setError(unknown.length > 0 ? `None of the ids matched a process: ${unknown.join(', ')}` : 'Enter at least one process id.');
        setStage({ kind: 'input' });
        return;
      }
      const plan = await buildDeletePlan(planning, {
        siteUrl: session.siteUrl,
        targetUniqueIds: uniqueIds,
        index,
        allowRestore: false,
        holdingGroupId: null,
        scanActiveForInputOutput: thorough,
        onEvent,
      });
      setStage({ kind: 'plan', plan, index, unknown, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (cause) {
      handleError(cause);
      setError(errorMessage(cause));
      setStage({ kind: 'input' });
    }
  }

  /** Asks on screen and waits. Leaving the question unanswered leaves the run waiting, never answering yes. */
  const askYesNo = (title: string, lines: string[], yes: string, no = 'Stop and put things back') =>
    new Promise<boolean>((resolve) => setQuestion({ kind: 'yesno', title, lines, yes, no, resolve }));

  /** Runs one engine call with the live log, then shows its results. */
  async function withLog(title: string, work: (onEvent: (event: DeleteEvent) => void) => Promise<{ results: ResultRow[]; plan: DependencyPlan | null }>) {
    setError(null);
    const log: string[] = [];
    const push = (line: string) => {
      log.push(line);
      setStage({ kind: 'running', log: [...log], progress: '' });
    };
    const onEvent = (event: DeleteEvent) => {
      if (event.kind === 'stage') push(STAGE_TEXT[event.stage]);
      else if (event.kind === 'progress') setStage({ kind: 'running', log: [...log], progress: `${event.label}: ${event.done} of ${event.total}` });
      else if (event.kind === 'stopped') push(`STOPPED: ${event.reason}`);
      else if (event.kind === 'log') push(`  ${event.line}`);
      else if (event.kind === 'holderHeld') push(`  Held ${event.name} in the holding group: its group ${event.originalGroupId ?? 'unknown'} is gone`);
      else if (event.kind === 'orphanedTargets') log.push(...orphanedTargetWarningLines(event.orphans, event.totalTargets, event.holdingGroupName));
      else if (event.kind === 'groupExistsCoverage') log.push(...groupExistsCoverageLines(event.coverage));
      else if (event.kind === 'collateralDecision') push(`  Collateral ${event.phase}: ${event.accepted ? `accepted (${event.authority})` : 'not accepted'}`);
      else if (event.kind === 'noTargets') push(event.reason);
      else if (event.kind === 'csvNoIdColumn') push(`The file has no id column. Columns: ${event.headers.join(', ')}`);
    };
    setStage({ kind: 'running', log, progress: '' });
    try {
      const run = await work(onEvent);
      setUnfinished(planNeedsFinishing(run.plan) ? run.plan : null);
      setStage({ kind: 'done', rows: run.results, plan: run.plan, log, title });
    } catch (cause) {
      handleError(cause);
      const saved = await store.load().catch(() => null);
      setUnfinished(planNeedsFinishing(saved) ? saved : null);
      setError(
        `${errorMessage(cause)} The run stopped here. Its plan is saved in this browser: sign in again if asked, then use "Finish it" at the top of this page to put back what it un-archived.`,
      );
      setStage({ kind: 'done', rows: [], plan: saved, log, title: 'The run did not finish' });
    }
  }

  async function runDelete(plan: DependencyPlan, index: DeleteIndex, options: RunOptions) {
    const nameOf = (id: string) => index.get(id.toLowerCase())?.name || id;
    const pairLines = (rows: readonly Reconciliation[]) =>
      rows.map((r) => `${nameOf(r.queriedUniqueId)} -> ${nameOf(r.relatedUniqueId)}: ${r.category}, claimed ${r.claimed}, located ${r.located}. ${r.note}`);
    const decisions: DeleteDecisions = {
      collateral: (collateral, phase) => askYesNo('Processes changed that were not targets', collateralLines(collateral, phase), 'Accept and carry on (they are still put back at the end)'),
      variation: (warning) => askYesNo('A target looks like a variation', variationWarningLines(warning), 'Accept the risk to these masters'),
      failedTargets: (failed) =>
        askYesNo('Some targets could not be checked for dependencies', failed.map((f) => `${nameOf(f.uniqueId)}: HTTP ${f.status} ${f.error ?? ''}`), 'Carry on without them'),
      unresolved: (unresolved) =>
        askYesNo('Participants nothing could read', unresolved.map((u) => `${u.name} (${u.uniqueId}): ${u.reason}. A reference it holds will not be removed.`), 'Carry on anyway'),
      mismatches: (rows) => askYesNo('The dependency API claims references nothing holds', pairLines(rows), 'Carry on anyway'),
      overClaims: (rows) =>
        askYesNo('Claimed more than was found', ['Every reference found will be removed; the API claims more. Every such pair checked so far was the API over-claiming.', ...pairLines(rows)], 'Acknowledge and carry on'),
      verificationFailed: (failed) =>
        askYesNo(
          'References remain after the removal',
          failed.flatMap((f) => [
            `${nameOf(f.holderUniqueId)}${f.unreadReason ? `: could not be read back (${f.unreadReason})` : ''}`,
            ...f.remaining.map((site) => `    ${site.path}`),
          ]),
          'Delete anyway, leaving these references broken',
        ),
      publishDrafts: (holders) => new Promise<string[]>((resolve) => setQuestion({ kind: 'drafts', holders, resolve })),
      confirmDelete: (count) =>
        askYesNo('Permanent deletion', [`About to permanently delete ${count} process(es). This cannot be undone.`], `Delete ${count} process(es)`, 'Cancel and put things back'),
    };
    await withLog('Delete finished', (onEvent) =>
      runBulkDelete(gateway, {
        siteUrl: session.siteUrl,
        source: { kind: 'ids', ids: plan.targetUniqueIds },
        planStore: store,
        thoroughScan: thorough,
        approvalsEnabled: options.approvalsEnabled,
        acceptCollateral: options.acceptCollateral,
        allowUnheldTargets: options.allowUnheldTargets,
        changeDescription: options.changeDescription.trim() || REFERENCE_REMOVAL_DESCRIPTION,
        decisions,
        onEvent,
      }),
    );
  }

  async function finish(plan: DependencyPlan) {
    await withLog('The interrupted run is finished', (onEvent) => resumeUnwind(gateway, plan, { planStore: store, onEvent }));
  }

  async function uploadPlan(file: File | undefined) {
    if (!file) return;
    const plan = parsePlan(await file.text());
    if (!plan) {
      setError(`${file.name} is not a delete plan this app wrote.`);
      return;
    }
    setUnfinished(plan);
  }

  const answer = (value: boolean | string[]) => {
    const q = question;
    setQuestion(null);
    if (q?.kind === 'yesno') q.resolve(value === true);
    if (q?.kind === 'drafts') q.resolve(Array.isArray(value) ? value : []);
  };

  const busy = stage.kind === 'running' || stage.kind === 'planning';

  return (
    <main>
      <h1>Bulk Delete</h1>
      <p className="lede">
        Signed in as {session.username} on <code>{session.tenant}</code>. <a href="/">Back</a>
      </p>

      {unfinished !== null && !busy && (
        <div className="panel warning">
          <h2>An earlier run did not finish</h2>
          <p>
            Its plan, from {unfinished.createdUtc}, says it un-archived processes it has not put back, or left its holding
            group in place. Finishing returns each one to its own group, archived, and removes the holding group if it is empty.
          </p>
          <div className="row">
            <button type="button" onClick={() => void finish(unfinished)}>
              Finish it
            </button>
            <button type="button" className="secondary" onClick={() => downloadText(datedFilename('delete-plan', 'json'), serializePlan(unfinished), 'application/json')}>
              Download its plan
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <div className="panel error">
          <h2>Problem</h2>
          <p>{error}</p>
        </div>
      )}

      {question !== null && (
        // Keyed, so one question's ticks never carry over to the next.
        <QuestionPanel key={question.kind === 'yesno' ? `q|${question.title}|${question.lines.length}` : 'drafts'} question={question} onAnswer={answer} />
      )}

      {stage.kind === 'input' && (
        <div className="panel">
          <h2>1. Which processes</h2>
          <label htmlFor="ids">Process ids (GUIDs or numeric ids), one per line</label>
          <textarea id="ids" rows={8} value={ids} onChange={(e) => setIds(e.target.value)} />
          <label htmlFor="file">Or a CSV with a ProcessID or ObjectID column (a results file works)</label>
          <input id="file" type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} />
          {fileNote !== null && <p className="small">{fileNote}</p>}
          <label className="checkbox">
            <input type="checkbox" checked={thorough} onChange={(e) => setThorough(e.target.checked)} />
            <span>
              Also scan active processes for Input/Output references
              <span className="detail">Slow: one read per active process. The script&rsquo;s thorough scan.</span>
            </span>
          </label>
          <div className="row">
            <button type="button" disabled={ids.trim() === ''} onClick={() => void dryRun()}>
              Build the plan (dry run)
            </button>
          </div>
          <label htmlFor="plan-file">Or finish an interrupted run from a downloaded plan</label>
          <input id="plan-file" type="file" accept=".json,application/json" onChange={(e) => void uploadPlan(e.target.files?.[0])} />
        </div>
      )}

      {stage.kind === 'planning' && <p className="pending">{stage.progress}</p>}

      {stage.kind === 'plan' && (
        <>
          <div className="panel">
            <h2>2. The plan ({stage.plan.status})</h2>
            <p>
              {stage.plan.targetUniqueIds.length} target(s), {stage.plan.workItems.length} process(es) to edit,{' '}
              {stage.plan.sites.length} reference site(s), {stage.plan.claims.length} claim(s). Built in {stage.seconds}s.
              This dry run changed nothing. Archived processes were not restored, so a real run may find more.
            </p>
            {stage.unknown.length > 0 && <p className="small">Not found, so left out: {stage.unknown.join(', ')}</p>}
            <div className="row">
              <button
                type="button"
                className="secondary"
                onClick={() => downloadText(datedFilename('delete-plan', 'json'), serializePlan(stage.plan), 'application/json')}
              >
                Download the plan
              </button>
              <button type="button" className="secondary" onClick={() => setStage({ kind: 'input' })}>
                Plan something else
              </button>
            </div>
          </div>
          <div className="panel">
            <pre className="plan-text">{dryRunLines(stage.plan, stage.index).join('\n')}</pre>
          </div>
          <RunPanel
            targetCount={stage.plan.targetUniqueIds.length}
            disabled={unfinished !== null}
            onRun={(options) => void runDelete(stage.plan, stage.index, options)}
          />
        </>
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Running</h2>
          {stage.progress !== '' && <p className="pending">{stage.progress}</p>}
          <pre className="plan-text">{stage.log.join('\n')}</pre>
        </div>
      )}

      {stage.kind === 'done' && (
        <>
          {stage.rows.length > 0 && (
            <ResultsSummary
              rows={stage.rows}
              vocabulary={RESULT_STATUSES}
              warning={null}
              siteUrl={session.siteUrl}
              filenameStem="delete-results"
              actions={
                <>
                  {stage.plan !== null && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => downloadText(datedFilename('delete-plan', 'json'), serializePlan(stage.plan!), 'application/json')}
                    >
                      Download the plan
                    </button>
                  )}
                  <button type="button" className="secondary" onClick={() => setStage({ kind: 'input' })}>
                    Delete something else
                  </button>
                </>
              }
            />
          )}
          <div className="panel">
            <h2>{stage.title}</h2>
            <pre className="plan-text">{[...deleteResultsSummary(stage.rows).lines, '', ...stage.log].join('\n')}</pre>
            {stage.rows.length === 0 && (
              <div className="row">
                <button type="button" className="secondary" onClick={() => downloadCsv(datedFilename('delete-results'), resultsToCsv(stage.rows))}>
                  Download the results
                </button>
                <button type="button" className="secondary" onClick={() => setStage({ kind: 'input' })}>
                  Start again
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}

interface RunOptions {
  approvalsEnabled: boolean;
  acceptCollateral: boolean;
  allowUnheldTargets: boolean;
  changeDescription: string;
}

/** The run's switches, and the typed DELETE the script asked for before it started. */
function RunPanel({ targetCount, disabled, onRun }: { targetCount: number; disabled: boolean; onRun: (options: RunOptions) => void }) {
  const [approvalsEnabled, setApprovalsEnabled] = useState(true);
  const [acceptCollateral, setAcceptCollateral] = useState(false);
  const [allowUnheldTargets, setAllowUnheldTargets] = useState(false);
  const [changeDescription, setChangeDescription] = useState(REFERENCE_REMOVAL_DESCRIPTION);
  const [typed, setTyped] = useState('');
  return (
    <div className="panel warning">
      <h2>3. Delete for real</h2>
      <p>
        The run restores archived targets into a holding group, builds the plan again with the archive restored, removes
        every reference, checks the tenant before and after deleting, and puts back everything it un-archived. It asks
        before each step that needs a decision; a question nobody answers stops the run.
      </p>
      {disabled && <p className="small">Finish the earlier run first (top of the page).</p>}
      <label htmlFor="change">Change description, sent with every save, publish and archive</label>
      <input id="change" type="text" value={changeDescription} onChange={(e) => setChangeDescription(e.target.value)} />
      <label className="checkbox">
        <input type="checkbox" checked={approvalsEnabled} onChange={(e) => setApprovalsEnabled(e.target.checked)} />
        <span>
          Allowed to override a pending approval
          <span className="detail">Edit and publish over a revision awaiting approval, and override a pending archive.</span>
        </span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={acceptCollateral} onChange={(e) => setAcceptCollateral(e.target.checked)} />
        <span>
          Accept collateral changes in advance
          <span className="detail">Carry on past processes that change without being targets, and past the variation warning. They are still put back at the end.</span>
        </span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={allowUnheldTargets} onChange={(e) => setAllowUnheldTargets(e.target.checked)} />
        <span>
          Delete targets that cannot be restored, unchecked
          <span className="detail">Their Input and Output references are never seen, so a reference to them can be left broken.</span>
        </span>
      </label>
      <label htmlFor="typed">Type DELETE to start</label>
      <input id="typed" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <div className="row">
        <button
          type="button"
          disabled={disabled || typed !== 'DELETE'}
          onClick={() => onRun({ approvalsEnabled, acceptCollateral, allowUnheldTargets, changeDescription })}
        >
          Run the delete ({targetCount} target{targetCount === 1 ? '' : 's'})
        </button>
      </div>
    </div>
  );
}

function QuestionPanel({ question, onAnswer }: { question: Question; onAnswer: (value: boolean | string[]) => void }) {
  const [ticked, setTicked] = useState<string[]>([]);
  if (question.kind === 'drafts') {
    return (
      <div className="panel warning">
        <h2>Holders with an unpublished draft</h2>
        <p>
          Removing a reference publishes the holder, and with it the draft: someone else&rsquo;s unfinished changes, live,
          with no way back from here. Unticked, a holder is not edited and the targets it holds are kept. Tick a holder to
          publish its draft with the removal.
        </p>
        <ul className="checklist">
          {question.holders.map((h) => (
            <li key={h.holderUniqueId}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ticked.includes(h.holderUniqueId)}
                  onChange={(e) =>
                    setTicked((now) => (e.target.checked ? [...now, h.holderUniqueId] : now.filter((id) => id !== h.holderUniqueId)))
                  }
                />
                <span>
                  {h.name || h.holderUniqueId}
                  {h.version && ` (draft ${h.version})`}
                  <span className="detail">Keeps {h.targetsBlocked.length} target(s) unless ticked.</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="row">
          <button type="button" onClick={() => onAnswer(ticked)}>
            Carry on{ticked.length > 0 ? `, publishing ${ticked.length} draft(s)` : ', keeping their targets'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel warning">
      <h2>{question.title}</h2>
      <pre className="plan-text">{question.lines.join('\n')}</pre>
      <div className="row">
        <button type="button" onClick={() => onAnswer(true)}>
          {question.yes}
        </button>
        <button type="button" className="secondary" onClick={() => onAnswer(false)}>
          {question.no}
        </button>
      </div>
    </div>
  );
}

/** The warnings a real run raises before its first change, then the plan as the script's preview shows it. */
function dryRunLines(plan: DependencyPlan, index: DeleteIndex): string[] {
  const targets = plan.targetUniqueIds;
  const warnings = [
    // The run names its holding group by its start time (F5), which a preview doesn't have yet.
    ...orphanedTargetWarningLines(findOrphanedGroupProcesses(index, targets), targets.length, 'Bulk Delete holding group (temporary, <run start> UTC)'),
    ...groupExistsCoverageLines(groupExistsCoverage(index)),
  ];
  return warnings.length > 0 ? [...warnings, '', ...planSummaryLines(plan, index)] : planSummaryLines(plan, index);
}
