'use client';

/**
 * Archive documents (W8a): choose by group, from the document list, or by id, preview,
 * archive, download the results.
 *
 * A document attached to anything is never archived, although Process Manager would
 * archive one attached to a published process (documents spike). The preview reads each
 * chosen document's properties and the current model of every active process, because
 * a reference in an unpublished draft is reported nowhere else. Every batch re-reads its
 * documents' properties before the write.
 *
 * No folder cleanup here: an archived document still blocks deleting its groups, so
 * archiving documents never empties one.
 */

import { Button } from '@exp-textura/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  buildDocumentArchivePlan,
  DOCUMENT_ARCHIVE_STATUSES,
  documentPreviewRows,
  MID_RUN_NOTE,
  runDocumentArchive,
  settleDocumentArchive,
  type DocumentArchivePlan,
} from '@/lib/documents/archive.ts';
import { loadDocumentIndex } from '@/lib/documents/list.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { createControls, errorMessage } from '@/lib/exec/runner.ts';
import type { ProcessIndex } from '@/lib/tenant/state.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import { browserDocumentGateway, browserGateway, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { Notice, Progress } from '../../_ui/kit.tsx';
import { ResultsSummary } from '../../components/ResultsSummary.tsx';
import { SessionGate } from '../../components/SessionGate.tsx';
import { useBrowseTree } from '../../components/TreeBrowser.tsx';
import { isSignedOut, LeftOut, readWhatHolds, UnreadProcesses, useDocumentChoice } from '../choose.tsx';

type Stage =
  | { kind: 'select' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: DocumentArchivePlan; index: ProcessIndex }
  | { kind: 'running'; plan: DocumentArchivePlan; progress: string }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null };

export default function ArchiveDocumentsPage() {
  return (
    <SessionGate title="Archive documents">
      {(session, onSignedOut) => <ArchiveDocumentsFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function ArchiveDocumentsFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserGateway(), []);
  const docs = useMemo(() => browserDocumentGateway(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (isSignedOut(error)) onSignedOut();
    },
    [onSignedOut],
  );
  const browse = useBrowseTree(gateway, handleError);

  const [stage, setStage] = useState<Stage>({ kind: 'select' });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const fail = (cause: unknown) => {
    handleError(cause);
    setError(errorMessage(cause));
  };

  const choice = useDocumentChoice({
    docs,
    browse,
    sources: ['tree', 'list', 'ids'],
    onError: fail,
    treeNote: (
      <>
        Checking a group takes in the documents whose primary group is that group or one under it. Documents that are only
        associated with a checked group are listed separately, for you to tick or not.
      </>
    ),
  });

  async function buildPlan() {
    setError(null);
    setConfirming(false);
    try {
      const progress = (text: string) => setStage({ kind: 'planning', progress: text });
      const collected = await choice.collect(progress);
      if (collected === null) {
        setStage({ kind: 'select' });
        return;
      }
      if ('empty' in collected) {
        setError(collected.empty);
        setStage({ kind: 'select' });
        return;
      }
      // Every chosen document, archived and pending ones too: the read gives each row its group's id.
      const { properties, index, scan } = await readWhatHolds(docs, collected.chosen, progress, (c) => !c.entry.isArchived && !c.entry.isPending);
      const plan = buildDocumentArchivePlan({ chosen: collected.chosen, resolveSkipped: collected.resolveSkipped, paths: collected.paths, properties, scan, index });
      setStage({ kind: 'plan', plan, index });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'select' });
    }
  }

  async function apply(plan: DocumentArchivePlan, index: ProcessIndex) {
    setError(null);
    setConfirming(false);
    setStage({ kind: 'running', plan, progress: 'Re-checking the first batch…' });
    abort.current = new AbortController();
    const controls = createControls({ signal: abort.current.signal });
    try {
      const draft = await runDocumentArchive(docs, plan.targets, controls, {
        index,
        errorText: errorMessage,
        statusOf: (e) => (e instanceof PmRequestError ? e.status : null),
        onProgress: (done, total, label) => setStage({ kind: 'running', plan, progress: `Archived ${done} of ${total}. Last: ${label}` }),
      });
      setStage({ kind: 'running', plan, progress: 'Reading the document lists to confirm every outcome…' });
      let rows = draft;
      let warning = controls.stoppedReason();
      try {
        rows = settleDocumentArchive(draft, await loadDocumentIndex(docs.list));
      } catch (cause) {
        // Not handleError: a dead session here must not lose the rows for what was archived.
        warning =
          `${warning ? `${warning} ` : ''}The final read failed (${errorMessage(cause)}), so these statuses are what ` +
          `the calls reported, not confirmed.`;
      }
      setStage({ kind: 'done', rows: [...plan.skipped, ...rows], warning });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'plan', plan, index });
    } finally {
      abort.current = null;
    }
  }

  function startOver() {
    choice.reset();
    setStage({ kind: 'select' });
  }

  return (
    <>
      {error !== null && (
        <Notice tone="critical" title="Problem">
          {error}
        </Notice>
      )}

      {stage.kind === 'select' && (
        <>
          <div className="panel">
            <h2>1. Choose the documents to archive</h2>
            <p>
              By group, from the document list, or by id. The three add up, each document once. A document attached to a
              process (active or archived) or a training unit, or referenced in a process&rsquo;s unpublished draft, is
              never archived; the preview names what holds it.
            </p>
            {choice.tabs}
          </div>
          {choice.body}

          <div className="row">
            <Button disabled={choice.count === 0 || choice.busy} onClick={() => void buildPlan()}>
              Preview what would be archived
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'planning' && <Progress>{stage.progress}</Progress>}

      {stage.kind === 'plan' && (
        <PlanView
          plan={stage.plan}
          confirming={confirming}
          setConfirming={setConfirming}
          onBack={() => setStage({ kind: 'select' })}
          onReplan={() => void buildPlan()}
          onApply={() => void apply(stage.plan, stage.index)}
        />
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Archiving documents</h2>
          <Progress>{stage.progress}</Progress>
          <Button buttonType="secondary" onClick={() => abort.current?.abort()}>
            Stop after the current batch
          </Button>
        </div>
      )}

      {stage.kind === 'done' && (
        <ResultsSummary
          rows={stage.rows}
          vocabulary={DOCUMENT_ARCHIVE_STATUSES}
          warning={stage.warning}
          siteUrl={session.siteUrl}
          filenameStem="document-archive-results"
          actions={
            <Button buttonType="secondary" onClick={startOver}>
              Archive other documents
            </Button>
          }
        />
      )}
    </>
  );
}

function PlanView(props: {
  plan: DocumentArchivePlan;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onBack: () => void;
  onReplan: () => void;
  onApply: () => void;
}) {
  const { plan } = props;
  const incomplete = plan.unreadProcesses.length > 0;
  const n = plan.targets.length;
  const noun = `document${n === 1 ? '' : 's'}`;

  return (
    <>
      <div className="panel">
        <h2>2. Check the plan. Nothing has been changed.</h2>
        <p>
          {n} {noun} would be archived. {plan.skipped.length > 0 && `${plan.skipped.length} left out (listed below).`}{' '}
          {plan.processesRead > 0 && `${plan.processesRead} active processes were read for references, drafts included.`}
        </p>
        <p className="small">{MID_RUN_NOTE}</p>
        <div className="row">
          <Button buttonType="secondary" onClick={() => downloadCsv(datedFilename('document-archive-preview'), resultsToCsv(documentPreviewRows(plan)))}>
            Download the preview
          </Button>
          <Button buttonType="secondary" onClick={props.onBack}>
            Change the selection
          </Button>
        </div>
      </div>

      <UnreadProcesses unread={plan.unreadProcesses} verb="archived" onReplan={props.onReplan} />

      {n > 0 && (
        <div className="panel">
          <h2>Would be archived</h2>
          <table className="plan">
            <thead>
              <tr>
                <th>Document</th>
                <th>Group</th>
                <th>Type</th>
                <th>Location</th>
                <th>Chosen</th>
              </tr>
            </thead>
            <tbody>
              {plan.targets.map((t) => (
                <tr key={t.uniqueId}>
                  <td>{t.name}</td>
                  <td>{t.path.join(' / ')}</td>
                  <td>{t.type}</td>
                  <td>{t.location}</td>
                  <td>{t.chosen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LeftOut rows={plan.skipped} open={n === 0} />

      <div className="panel">
        <h2>3. Archive</h2>
        {props.confirming ? (
          <div className="row">
            <Button onClick={props.onApply}>
              Yes, archive {n} {noun} now
            </Button>
            <Button buttonType="secondary" onClick={() => props.setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="row">
            <Button disabled={n === 0 || incomplete} onClick={() => props.setConfirming(true)}>
              Archive {n} {noun}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
