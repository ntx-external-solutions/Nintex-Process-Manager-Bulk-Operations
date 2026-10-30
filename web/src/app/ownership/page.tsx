'use client';

/**
 * Bulk Update Ownership: upload the script's CSV, resolve every username through SCIM,
 * preview every row against the tenant, then apply.
 *
 * Two decisions the script made silently are made on screen here (SPEC-WEB.md): whether
 * a published process is republished or left with a draft, and stakeholders are not
 * notified (the script notified them once per row).
 */

import { Button, Input } from '@exp-textura/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { Journal, sessionJournalStore } from '@/lib/exec/journal.ts';
import { resultsToCsv, UNKNOWN_NAME, type ResultRow } from '@/lib/exec/report.ts';
import { createControls, defaultIsFatal, errorMessage } from '@/lib/exec/runner.ts';
import { parseOwnershipCsv, type OwnershipCsvRow } from '@/lib/ownership/csv.ts';
import {
  buildOwnershipPlan,
  describeChange,
  describeWrite,
  directoryOf,
  ownershipPreviewRows,
  publishCount,
  unresolvedUsernames,
  type Directory,
  type OwnershipPlan,
  type PublishChoice,
} from '@/lib/ownership/plan.ts';
import { OWNERSHIP_STATUSES, runOwnership, settleOwnership } from '@/lib/ownership/run.ts';
import type { OwnershipState } from '@/lib/pm/ownership.ts';
import { loadProcessIndex, type ProcessIndex } from '@/lib/tenant/state.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import { browserOwnershipGateway, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { ResultsSummary } from '../components/ResultsSummary.tsx';
import { SessionGate } from '../components/SessionGate.tsx';
import { Notice, Progress, valueOf } from '../_ui/kit.tsx';

interface Loaded {
  filename: string;
  rows: OwnershipCsvRow[];
  nonGuidIds: string[];
}

type Stage =
  | { kind: 'input' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: OwnershipPlan; unresolved: Array<{ value: string; reason: string }>; nonGuidIds: string[] }
  | { kind: 'running'; progress: string }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null };

const CHOICES: ReadonlyArray<{ value: PublishChoice; label: string; detail: string }> = [
  {
    value: 'save-only',
    label: 'Save only',
    detail:
      'Nothing is published. A published process gets a draft with the new owner, and readers see the old one until someone publishes it. This is what the PowerShell did.',
  },
  {
    value: 'match-state',
    label: 'Match current state',
    detail:
      'A published process is republished as a new major version, so the new owner is live. A process already in progress is only saved, because its draft may hold other people’s edits.',
  },
];

export default function OwnershipPage() {
  return (
    <SessionGate title="Bulk Update Ownership">
      {(session, onSignedOut) => <OwnershipFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function OwnershipFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserOwnershipGateway(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof PmRequestError && error.signedOut) onSignedOut();
    },
    [onSignedOut],
  );

  const [stage, setStage] = useState<Stage>({ kind: 'input' });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  // Held only in this component's state, sent once for the directory read, then dropped.
  const [scimKey, setScimKey] = useState('');
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [publish, setPublish] = useState<PublishChoice>('save-only');
  const [changeDescription, setChangeDescription] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function readFile(file: File | undefined) {
    setFileProblem(null);
    setLoaded(null);
    if (!file) return;
    const parsed = parseOwnershipCsv(await file.text());
    if (!parsed.ok) {
      setFileProblem(parsed.problem);
      return;
    }
    setLoaded({ filename: file.name, rows: parsed.rows, nonGuidIds: parsed.nonGuidIds });
  }

  async function buildPlan() {
    if (!loaded) return;
    setError(null);
    setConfirming(false);
    try {
      let users = directory;
      if (users === null) {
        setStage({ kind: 'planning', progress: 'Reading the user directory…' });
        users = directoryOf(await gateway.directory(scimKey));
        setDirectory(users);
        setScimKey('');
      }
      // Names for every row the plan will not write. Without them a skipped process reads
      // "(name unavailable)" even when it is in a list (F4). Not having them is not a reason
      // to stop: the rows fall back to that wording.
      setStage({ kind: 'planning', progress: 'Reading both process lists for names…' });
      let names: ProcessIndex | undefined;
      try {
        names = await loadProcessIndex(gateway.processesList);
      } catch (cause) {
        if (cause instanceof PmRequestError && cause.signedOut) throw cause;
      }
      const plan = await buildOwnershipPlan(
        loaded.rows,
        users,
        {
          ownership: gateway.ownership,
          isFatal: defaultIsFatal,
          onProgress: (done, total) => setStage({ kind: 'planning', progress: `Reading process ${done} of ${total}…` }),
        },
        { publish, names },
      );
      setStage({ kind: 'plan', plan, unresolved: unresolvedUsernames(loaded.rows, users), nonGuidIds: loaded.nonGuidIds });
    } catch (cause) {
      handleError(cause);
      setError(errorMessage(cause));
      setStage({ kind: 'input' });
    }
  }

  async function apply(planned: Extract<Stage, { kind: 'plan' }>) {
    const { plan } = planned;
    setError(null);
    setConfirming(false);
    setStage({ kind: 'running', progress: 'Saving…' });
    try {
      const journal = Journal.start(crypto.randomUUID(), session.tenant, Date.now(), sessionJournalStore());
      abort.current = new AbortController();
      const controls = createControls({ signal: abort.current.signal });
      const draft = await runOwnership(gateway, journal, plan, controls, {
        changeDescription,
        onProgress: (done, total, label) => setStage({ kind: 'running', progress: `Updated ${done} of ${total}. Last: ${label}` }),
      });

      setStage({ kind: 'running', progress: 'Re-reading every process to confirm…' });
      const after = new Map<string, OwnershipState | null>();
      for (const change of plan.changes) {
        try {
          const read = await gateway.ownership(change.uniqueId);
          after.set(change.uniqueId.toLowerCase(), read.kind === 'process' ? read.state : null);
        } catch {
          after.set(change.uniqueId.toLowerCase(), null);
        }
      }
      const rows = settleOwnership(draft, plan, journal, after);
      journal.discard();
      setStage({ kind: 'done', rows, warning: controls.stoppedReason() });
    } catch (cause) {
      handleError(cause);
      setError(errorMessage(cause));
      setStage(planned);
    } finally {
      abort.current = null;
    }
  }

  const canCheck = loaded !== null && (directory !== null || scimKey.trim() !== '');

  return (
    <>
      {error !== null && (
        <Notice tone="critical" title="Problem">
          {error}
        </Notice>
      )}

      {stage.kind === 'input' && (
        <>
          <div className="panel">
            <h2>1. Upload the CSV</h2>
            <p>
              The same file as <code>Update-ProcessOwnership.ps1</code>: a <code>ProcessID</code> column (the process
              GUID from its URL), and <code>NewOwner</code> and/or <code>NewExpert</code> with usernames. A blank cell
              leaves that role unchanged. <code>unassigned</code>, <code>none</code> or <code>n/a</code> sets it to
              &ldquo;Needs to be reassigned N/A&rdquo;.
            </p>
            <input type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} />
            {fileProblem !== null && <p className="error-text">{fileProblem}</p>}
            {loaded !== null && (
              <p className="small">
                {loaded.filename}: {loaded.rows.length} row{loaded.rows.length === 1 ? '' : 's'}.
              </p>
            )}
          </div>

          <div className="panel">
            <h2>2. Resolve the usernames</h2>
            {directory !== null ? (
              <p>The user directory is loaded for this session.</p>
            ) : (
              <>
                <label htmlFor="scim">SCIM API key</label>
                <Input id="scim" type="password" autoComplete="off" value={scimKey} onChange={(e) => setScimKey(valueOf(e))} />
                <p className="small">
                  Used once to read the user directory, and not stored anywhere. Find it in Process Manager under Admin.
                </p>
              </>
            )}
          </div>

          <div className="panel">
            <h2>3. Choose what happens to published processes</h2>
            <div className="choices">
              {CHOICES.map((choice) => (
                <label key={choice.value} className="checkbox">
                  <input type="radio" name="publish" checked={publish === choice.value} onChange={() => setPublish(choice.value)} />
                  <span>
                    {choice.label}
                    <span className="detail">{choice.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="small">Stakeholders are not notified of these changes.</p>
          </div>

          <div className="row">
            <Button disabled={!canCheck} onClick={() => void buildPlan()}>
              Preview the changes
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'planning' && <Progress>{stage.progress}</Progress>}

      {stage.kind === 'plan' && (
        <PlanView
          plan={stage.plan}
          unresolved={stage.unresolved}
          nonGuidIds={stage.nonGuidIds}
          changeDescription={changeDescription}
          setChangeDescription={setChangeDescription}
          confirming={confirming}
          setConfirming={setConfirming}
          onBack={() => setStage({ kind: 'input' })}
          onApply={() => void apply(stage)}
        />
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Updating</h2>
          <Progress>{stage.progress}</Progress>
          <Button buttonType="secondary" onClick={() => abort.current?.abort()}>
            Stop after the current batch
          </Button>
        </div>
      )}

      {stage.kind === 'done' && (
        <ResultsSummary
          rows={stage.rows}
          vocabulary={OWNERSHIP_STATUSES}
          warning={stage.warning}
          siteUrl={session.siteUrl}
          filenameStem="ownership-results"
          actions={
            <Button buttonType="secondary" onClick={() => setStage({ kind: 'input' })}>
              Update another file
            </Button>
          }
        />
      )}
    </>
  );
}

function PlanView(props: {
  plan: OwnershipPlan;
  unresolved: Array<{ value: string; reason: string }>;
  nonGuidIds: string[];
  changeDescription: string;
  setChangeDescription: (value: string) => void;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onBack: () => void;
  onApply: () => void;
}) {
  const { plan } = props;
  const count = plan.changes.length;
  const published = publishCount(plan);
  const ready = count > 0 && props.changeDescription.trim() !== '';
  const label = `${count} process${count === 1 ? '' : 'es'}`;

  return (
    <>
      <div className="panel">
        <h2>4. Check the plan. Nothing has been saved.</h2>
        <p>
          {label} would be updated
          {published > 0 ? `, ${published} of them republished as a new major version.` : ', none of them published.'}
        </p>
        <div className="row">
          <Button
            buttonType="secondary"
            onClick={() => downloadCsv(datedFilename('ownership-preview'), resultsToCsv(ownershipPreviewRows(plan)))}
          >
            Download the preview
          </Button>
          <Button buttonType="secondary" onClick={props.onBack}>
            Change the file or the choice
          </Button>
        </div>
      </div>

      {(props.unresolved.length > 0 || props.nonGuidIds.length > 0) && (
        <div className="panel warning">
          <h2>Rows that will be skipped</h2>
          {props.unresolved.length > 0 && (
            <>
              <p>These usernames could not be resolved, so every row naming one is skipped:</p>
              <ul className="checklist">
                {props.unresolved.map((u) => (
                  <li key={u.value}>
                    {u.value}: {u.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {props.nonGuidIds.length > 0 && (
            <p>
              {props.nonGuidIds.length} process id{props.nonGuidIds.length === 1 ? ' is' : 's are'} not a GUID (for example{' '}
              <code>{props.nonGuidIds[0]}</code>). Use the id in a process URL, not the short number.
            </p>
          )}
        </div>
      )}

      {count > 0 && (
        <div className="panel">
          <h2>Would update</h2>
          <table className="plan">
            <thead>
              <tr>
                <th>Process</th>
                <th>Change</th>
                <th>What happens</th>
              </tr>
            </thead>
            <tbody>
              {plan.changes.map((change) => (
                <tr key={change.uniqueId}>
                  <td>
                    {change.name}
                    <div className="small">
                      v{change.version}, {change.lines.length === 1 ? 'line' : 'lines'} {change.lines.join(', ')}
                    </div>
                  </td>
                  <td>{describeChange(change)}</td>
                  <td>{describeWrite(change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {plan.skipped.length > 0 && (
        <details className="panel">
          <summary>Not updating ({plan.skipped.length})</summary>
          <ul className="checklist">
            {plan.skipped.map((row, i) => (
              <li key={`${row.objectId}|${i}`}>
                {row.name === UNKNOWN_NAME ? row.objectId : row.name}: {row.status}. {row.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="panel">
        <h2>5. Update</h2>
        <label htmlFor="change">Change description (recorded on every process, and the publish message)</label>
        <Input
          id="change"
          value={props.changeDescription}
          onChange={(e) => props.setChangeDescription(valueOf(e))}
          placeholder="Why the owners are changing"
          required
        />
        {props.confirming ? (
          <div className="row">
            <Button onClick={props.onApply}>
              Yes, update {label}
              {published > 0 && ` (${published} republished)`}
            </Button>
            <Button buttonType="secondary" onClick={() => props.setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="row">
            <Button disabled={!ready} onClick={() => props.setConfirming(true)}>
              Update {label}
            </Button>
          </div>
        )}
        {count > 0 && props.changeDescription.trim() === '' && <p className="small">Enter a change description.</p>}
      </div>
    </>
  );
}
