'use client';

/**
 * Move documents (W9): active documents to another group, chosen by group, from the
 * document list, or by id or CSV. One destination a run.
 *
 * Only the primary group changes. Attached documents move too: what holds a document
 * points at the document, not at its group.
 */

import { Button } from '@exp-textura/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { loadDocumentIndex } from '@/lib/documents/list.ts';
import {
  buildDocumentMovePlan,
  destinationLabel,
  DOCUMENT_MOVE_STATUSES,
  moveInFlightRows,
  movePreviewRows,
  pendingChosen,
  readForMove,
  runDocumentMove,
  settleDocumentMove,
  type DocumentMovePlan,
  type DocumentMovePlanInput,
  type MoveDestination,
} from '@/lib/documents/move.ts';
import { inFlightOf, type DocumentRunRecord } from '@/lib/documents/runRecord.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { CANCELLED, createControls, errorMessage } from '@/lib/exec/runner.ts';
import { groupPathOf } from '@/lib/select/browse.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import { browserDocumentGateway, browserGateway, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { Notice, Progress } from '../../_ui/kit.tsx';
import { Checkbox } from '../../components/Checkbox.tsx';
import { DestinationPicker } from '../../components/DestinationPicker.tsx';
import { ResultsSummary } from '../../components/ResultsSummary.tsx';
import { SessionGate } from '../../components/SessionGate.tsx';
import { useBrowseTree } from '../../components/TreeBrowser.tsx';
import { AssociatedDecision, InterruptedRun, isSignedOut, LeftOut, useDocumentChoice, useRunRecord } from '../choose.tsx';

type Stage =
  | { kind: 'select' }
  | { kind: 'decide' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; input: DocumentMovePlanInput }
  | { kind: 'running'; progress: string }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null };

export default function MoveDocumentsPage() {
  return (
    <SessionGate title="Move documents">
      {(session, onSignedOut) => <MoveDocumentsFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function MoveDocumentsFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserGateway(), []);
  const docs = useMemo(() => browserDocumentGateway(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (isSignedOut(error)) onSignedOut();
    },
    [onSignedOut],
  );
  const browse = useBrowseTree(gateway, handleError);
  const destinations = useBrowseTree(gateway, handleError);

  const [destinationKey, setDestinationKey] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'select' });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [includePending, setIncludePending] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const fail = (cause: unknown) => {
    handleError(cause);
    setError(errorMessage(cause));
  };

  const runs = useRunRecord('move', session.tenant);
  const choice = useDocumentChoice({
    docs,
    browse,
    sources: ['tree', 'list', 'ids'],
    treeNote:
      'A checked group takes in the active documents whose primary group is that group or a group under it. They all land directly in the one destination, so subgroups are not recreated.',
    onError: fail,
  });

  const node = destinationKey === null ? undefined : destinations.tree.nodes.get(destinationKey);
  const destination: MoveDestination | null = node
    ? { id: node.id, uniqueId: node.uniqueId, path: [...groupPathOf(destinations.tree, node), node.title] }
    : null;

  async function buildPlan() {
    if (destination === null) return;
    setError(null);
    setConfirming(false);
    try {
      const progress = (text: string) => setStage({ kind: 'planning', progress: text });
      const collected = await choice.collect(progress);
      if (collected === null) {
        setStage({ kind: 'decide' });
        return;
      }
      if ('empty' in collected) {
        setError(collected.empty);
        setStage({ kind: 'select' });
        return;
      }
      const reads = await readForMove(collected.chosen, docs.properties, destination, {
        isFatal: isSignedOut,
        errorText: errorMessage,
        onProgress: (done, total) => progress(`Reading each document… ${done} of ${total}`),
      });
      setIncludePending(false);
      setStage({ kind: 'plan', input: { chosen: collected.chosen, resolveSkipped: collected.resolveSkipped, paths: collected.paths, reads, destination } });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'select' });
    }
  }

  async function apply(plan: DocumentMovePlan, input: DocumentMovePlanInput) {
    setError(null);
    setConfirming(false);
    setStage({ kind: 'running', progress: 'Moving the first documents…' });
    abort.current = new AbortController();
    const controls = createControls({ signal: abort.current.signal });
    // Kept until the run is settled, so a run whose session dies can be finished.
    const record = runs.start(plan.skipped, { move: { destination: plan.destination } });
    try {
      const draft = await runDocumentMove(docs, plan.targets, plan.destination, controls, {
        onBatch: (e) => record.save({ rows: [...plan.skipped, ...e.rows], inFlight: e.sending ? inFlightOf('UpdateLocation', e.sending) : null }),
        errorText: errorMessage,
        statusOf: (e) => (e instanceof PmRequestError ? e.status : null),
        onProgress: (done, total, label) => setStage({ kind: 'running', progress: `Moved ${done} of ${total}. Last: ${label}` }),
      });
      setStage({ kind: 'running', progress: 'Reading the document lists to confirm every outcome…' });
      let rows = draft;
      let warning = controls.stoppedReason();
      try {
        rows = settleDocumentMove(draft, await loadDocumentIndex(docs.list), plan.destination);
      } catch (cause) {
        // Not handleError: a dead session here must not lose the rows for what was moved.
        warning = `${warning ? `${warning} ` : ''}The final read failed (${errorMessage(cause)}), so these statuses are what the calls reported, not confirmed.`;
      }
      if (warning === null || warning === CANCELLED) record.clear();
      else record.save({ rows: [...plan.skipped, ...rows], inFlight: null });
      setStage({ kind: 'done', rows: [...plan.skipped, ...rows], warning });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'plan', input });
    } finally {
      abort.current = null;
    }
  }

  /** An interrupted run's rows, settled against the lists read now. */
  async function finishInterrupted(record: DocumentRunRecord) {
    const moved = record.move?.destination;
    if (moved === undefined) {
      runs.discard();
      return;
    }
    setError(null);
    setStage({ kind: 'running', progress: 'Reading the document lists to confirm what the interrupted run did…' });
    try {
      const after = await loadDocumentIndex(docs.list);
      const rows = settleDocumentMove([...record.rows, ...moveInFlightRows(record, after, moved)], after, moved);
      runs.discard();
      setStage({ kind: 'done', rows, warning: 'These are the results of an interrupted run. Build a new plan for anything it did not reach.' });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'select' });
    }
  }

  function startOver() {
    runs.reload();
    choice.reset();
    destinations.refresh();
    setDestinationKey(null);
    setStage({ kind: 'select' });
  }

  const input = stage.kind === 'plan' ? stage.input : null;
  const plan = input === null ? null : buildDocumentMovePlan({ ...input, includePending });
  const pending = input === null ? 0 : pendingChosen(input.chosen);
  const n = plan?.targets.length ?? 0;
  const noun = `document${n === 1 ? '' : 's'}`;

  return (
    <>
      {error !== null && (
        <Notice tone="critical" title="Problem">
          {error}
        </Notice>
      )}

      {stage.kind === 'select' && runs.interrupted !== null && (
        <InterruptedRun
          record={runs.interrupted}
          what="A move run"
          finish="Show its results"
          onFinish={() => void finishInterrupted(runs.interrupted!)}
          onDiscard={runs.discard}
        />
      )}

      {stage.kind === 'select' && runs.interrupted === null && (
        <>
          <div className="panel">
            <h2>1. Choose the documents to move</h2>
            <p>
              By group, from the document list, or by id or CSV. They add up, each document once. Only the primary group
              changes: the name, reference, review frequency, associated groups and attachments stay as they are.
            </p>
            {choice.tabs}
          </div>
          {choice.body}

          <div className="panel">
            <h2>2. Choose where they go</h2>
            <p>One group for the whole run.</p>
            <DestinationPicker state={destinations} chosen={destinationKey} onChoose={setDestinationKey} allowTopLevel={false} />
          </div>

          <div className="row">
            <Button disabled={choice.count === 0 || choice.busy || destination === null} onClick={() => void buildPlan()}>
              Preview what would move
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'decide' && (
        <AssociatedDecision
          decision={choice.decision}
          previewLabel="Preview what would move"
          onPreview={() => void buildPlan()}
          onBack={() => setStage({ kind: 'select' })}
        />
      )}

      {stage.kind === 'planning' && <Progress>{stage.progress}</Progress>}

      {plan !== null && input !== null && (
        <>
          <div className="panel">
            <h2>3. Check the plan. Nothing has been changed.</h2>
            <p>
              {n} {noun} would move to {destinationLabel(plan.destination)}. {plan.skipped.length > 0 && `${plan.skipped.length} left out (listed below).`}
            </p>
            <p className="small">
              Each move is the same save Process Manager makes when a document is moved by hand, so whatever that save does to
              review dates, and to owners that come from the group, happens here too.
            </p>
            <div className="row">
              <Button buttonType="secondary" onClick={() => downloadCsv(datedFilename('document-move-preview'), resultsToCsv(movePreviewRows(plan)))}>
                Download the preview
              </Button>
              <Button buttonType="secondary" onClick={() => setStage({ kind: 'select' })}>
                Change the selection
              </Button>
            </div>
          </div>

          {n > 0 && (
            <div className="panel">
              <h2>Would move</h2>
              <table className="plan">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>From</th>
                    <th>Type</th>
                    <th>Chosen</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.targets.map((t) => (
                    <tr key={t.uniqueId}>
                      <td>{t.name}</td>
                      <td>{t.path.join(' / ')}</td>
                      <td>{t.type}</td>
                      <td>{t.chosen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <LeftOut rows={plan.skipped} open={n === 0} />

          {pending > 0 && (
            <div className="panel">
              <label className="inline">
                <Checkbox
                  state={includePending ? 'checked' : 'unchecked'}
                  label="Also move the pending documents"
                  onChange={() => {
                    setConfirming(false);
                    setIncludePending(!includePending);
                  }}
                />{' '}
                Also move the {pending} pending document{pending === 1 ? '' : 's'}
              </label>
              <p className="small">
                Pending here means Process Manager has an upload awaiting approval. A document in this state can be moved by
                hand, but what happens to its pending upload has not been checked, so these are left out unless you tick this.
              </p>
            </div>
          )}

          <div className="panel">
            <h2>4. Move</h2>
            {confirming ? (
              <div className="row">
                <Button onClick={() => void apply(plan, input)}>
                  Yes, move {n} {noun} now
                </Button>
                <Button buttonType="secondary" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="row">
                <Button disabled={n === 0} onClick={() => setConfirming(true)}>
                  Move {n} {noun}
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Moving documents</h2>
          <Progress>{stage.progress}</Progress>
          <Button buttonType="secondary" onClick={() => abort.current?.abort()}>
            Stop after the current documents
          </Button>
        </div>
      )}

      {stage.kind === 'done' && (
        <ResultsSummary
          rows={stage.rows}
          vocabulary={DOCUMENT_MOVE_STATUSES}
          warning={stage.warning}
          siteUrl={session.siteUrl}
          filenameStem="document-move-results"
          actions={
            <Button buttonType="secondary" onClick={startOver}>
              Move other documents
            </Button>
          }
        />
      )}
    </>
  );
}
