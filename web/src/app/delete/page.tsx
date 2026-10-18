'use client';

/**
 * Bulk Delete, dry run only (W5 phases 2 and 3).
 *
 * Builds the delete plan the way the script's preview does, reading and never writing:
 * dependency checks, process models, the Input/Output scan of the archive,
 * reconciliation. Archived participants are not restored, so the plan says it is
 * incomplete, as the script's does. It exists so the plan can be compared against the
 * script's on the live tenant before any phase that writes is built.
 */

import { useCallback, useMemo, useState } from 'react';

import type { DeleteEvent } from '@/lib/delete/events.ts';
import { HOLDING_GROUP_NAME } from '@/lib/delete/gateway.ts';
import { findOrphanedGroupProcesses, groupExistsCoverage, groupExistsCoverageLines } from '@/lib/delete/groups.ts';
import { orphanedTargetWarningLines } from '@/lib/delete/holdingGroup.ts';
import { serializePlan, type DependencyPlan } from '@/lib/delete/ledger.ts';
import type { DeleteIndex } from '@/lib/delete/model.ts';
import { buildDeletePlan, loadDeleteIndex, planSummaryLines } from '@/lib/delete/planner.ts';
import { resolveTargetIds, targetsFromCsv } from '@/lib/delete/targets.ts';
import { errorMessage } from '@/lib/exec/runner.ts';
import { datedFilename, downloadText } from '@/lib/ui/download.ts';
import { browserPlanningGateway, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { SessionGate } from '../components/SessionGate.tsx';

type Stage =
  | { kind: 'input' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: DependencyPlan; index: DeleteIndex; unknown: string[]; seconds: number };

export default function DeletePage() {
  return (
    <SessionGate title="Bulk Delete">
      {(session, onSignedOut) => <DryRunFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function DryRunFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserPlanningGateway(), []);
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

  async function run() {
    setError(null);
    const started = Date.now();
    const onEvent = (event: DeleteEvent) => {
      if (event.kind === 'progress') setStage({ kind: 'planning', progress: `${event.label}: ${event.done} of ${event.total}` });
    };
    try {
      setStage({ kind: 'planning', progress: 'Reading both process lists…' });
      const index = await loadDeleteIndex(gateway, {
        onProgress: (loaded) => setStage({ kind: 'planning', progress: `Reading both process lists: ${loaded} so far` }),
      });
      const { uniqueIds, unknown } = resolveTargetIds(ids.split(/[\s,;]+/), index);
      if (uniqueIds.length === 0) {
        setError(unknown.length > 0 ? `None of the ids matched a process: ${unknown.join(', ')}` : 'Enter at least one process id.');
        setStage({ kind: 'input' });
        return;
      }
      const plan = await buildDeletePlan(gateway, {
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

  return (
    <main>
      <h1>Bulk Delete</h1>
      <p className="lede">
        Signed in as {session.username} on <code>{session.tenant}</code>. <a href="/">Back</a>
      </p>

      <div className="panel warning">
        <h2>Dry run only</h2>
        <p>
          This builds the plan a delete would follow, and changes nothing on the tenant. Deleting is not
          available yet. Archived processes are not restored, so the plan says it is incomplete, as the
          PowerShell preview does.
        </p>
      </div>

      {error !== null && (
        <div className="panel error">
          <h2>Problem</h2>
          <p>{error}</p>
        </div>
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
            <button type="button" disabled={ids.trim() === ''} onClick={() => void run()}>
              Build the plan
            </button>
          </div>
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
            </p>
            {stage.unknown.length > 0 && <p className="small">Not found, so left out: {stage.unknown.join(', ')}</p>}
            <div className="row">
              <button
                type="button"
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
        </>
      )}
    </main>
  );
}

/** The warnings a real run raises before its first change, then the plan as the script's preview shows it. */
function dryRunLines(plan: DependencyPlan, index: DeleteIndex): string[] {
  const targets = plan.targetUniqueIds;
  const warnings = [
    ...orphanedTargetWarningLines(findOrphanedGroupProcesses(index, targets), targets.length, HOLDING_GROUP_NAME),
    ...groupExistsCoverageLines(groupExistsCoverage(index)),
  ];
  return warnings.length > 0 ? [...warnings, '', ...planSummaryLines(plan, index)] : planSummaryLines(plan, index);
}
