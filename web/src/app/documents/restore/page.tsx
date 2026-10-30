'use client';

/**
 * Restore documents (W8c): archived documents back to their primary group, chosen from
 * the archived list or by id. A results file of Archive or Delete documents feeds back
 * in as the documents its run left archived, so an operator can undo a delete run that
 * stopped between its archive and its delete.
 *
 * Attachments don't matter here; restoring is always safe. A document not archived, or
 * whose group is gone, is left out.
 */

import { Button } from '@exp-textura/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { loadDocumentIndex } from '@/lib/documents/list.ts';
import {
  buildDocumentRestorePlan,
  checkGroupsExist,
  DOCUMENT_RESTORE_STATUSES,
  restorePreviewRows,
  runDocumentRestore,
  settleDocumentRestore,
  type DocumentRestorePlan,
} from '@/lib/documents/restore.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { createControls, errorMessage } from '@/lib/exec/runner.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import { browserDocumentGateway, browserGateway, groupBreadcrumb, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { Notice, Progress } from '../../_ui/kit.tsx';
import { ResultsSummary } from '../../components/ResultsSummary.tsx';
import { SessionGate } from '../../components/SessionGate.tsx';
import { useBrowseTree } from '../../components/TreeBrowser.tsx';
import { isSignedOut, LeftOut, readProperties, useDocumentChoice } from '../choose.tsx';

type Stage =
  | { kind: 'select' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: DocumentRestorePlan }
  | { kind: 'running'; progress: string }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null };

export default function RestoreDocumentsPage() {
  return (
    <SessionGate title="Restore documents">
      {(session, onSignedOut) => <RestoreDocumentsFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function RestoreDocumentsFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserGateway(), []);
  const docs = useMemo(() => browserDocumentGateway(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (isSignedOut(error)) onSignedOut();
    },
    [onSignedOut],
  );
  // The hook takes a tree; this page offers no tree tab, so it is never shown or read.
  const browse = useBrowseTree(gateway, handleError);

  const [stage, setStage] = useState<Stage>({ kind: 'select' });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const fail = (cause: unknown) => {
    handleError(cause);
    setError(errorMessage(cause));
  };

  const choice = useDocumentChoice({ docs, browse, sources: ['archived', 'ids'], idKind: 'restore', onError: fail });

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
      const properties = await readProperties(docs, collected.chosen, progress);
      const archivedGroups = collected.chosen
        .filter((c) => c.entry.isArchived)
        .map((c) => c.entry.primaryGroupUniqueId)
        .filter((g): g is string => g !== null);
      const groups = await checkGroupsExist(archivedGroups, groupBreadcrumb, {
        isFatal: isSignedOut,
        errorText: errorMessage,
        onProgress: (done, total) => progress(`Checking each group still exists… ${done} of ${total}`),
      });
      const plan = buildDocumentRestorePlan({ chosen: collected.chosen, resolveSkipped: collected.resolveSkipped, paths: collected.paths, properties, groups });
      setStage({ kind: 'plan', plan });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'select' });
    }
  }

  async function apply(plan: DocumentRestorePlan) {
    setError(null);
    setConfirming(false);
    setStage({ kind: 'running', progress: 'Restoring the first batch…' });
    abort.current = new AbortController();
    const controls = createControls({ signal: abort.current.signal });
    try {
      const draft = await runDocumentRestore(docs, plan.targets, controls, {
        errorText: errorMessage,
        statusOf: (e) => (e instanceof PmRequestError ? e.status : null),
        onProgress: (done, total, label) => setStage({ kind: 'running', progress: `Restored ${done} of ${total}. Last: ${label}` }),
      });
      setStage({ kind: 'running', progress: 'Reading the document lists to confirm every outcome…' });
      let rows = draft;
      let warning = controls.stoppedReason();
      try {
        rows = settleDocumentRestore(draft, await loadDocumentIndex(docs.list));
      } catch (cause) {
        // Not handleError: a dead session here must not lose the rows for what was restored.
        warning = `${warning ? `${warning} ` : ''}The final read failed (${errorMessage(cause)}), so these statuses are what the calls reported, not confirmed.`;
      }
      setStage({ kind: 'done', rows: [...plan.skipped, ...rows], warning });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'plan', plan });
    } finally {
      abort.current = null;
    }
  }

  function startOver() {
    choice.reset();
    setStage({ kind: 'select' });
  }

  const plan = stage.kind === 'plan' ? stage.plan : null;
  const n = plan?.targets.length ?? 0;
  const noun = `document${n === 1 ? '' : 's'}`;

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
            <h2>1. Choose the documents to restore</h2>
            <p>
              From the archived list, or by id. Both add up, each document once. A restored document goes back to its
              primary group with its associations. To undo an Archive or Delete documents run, upload its results file under
              &ldquo;By id or CSV&rdquo;.
            </p>
            {choice.tabs}
          </div>
          {choice.body}

          <div className="row">
            <Button disabled={choice.count === 0 || choice.busy} onClick={() => void buildPlan()}>
              Preview what would be restored
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'planning' && <Progress>{stage.progress}</Progress>}

      {plan !== null && (
        <>
          <div className="panel">
            <h2>2. Check the plan. Nothing has been changed.</h2>
            <p>
              {n} {noun} would be restored. {plan.skipped.length > 0 && `${plan.skipped.length} left out (listed below).`}
            </p>
            <div className="row">
              <Button buttonType="secondary" onClick={() => downloadCsv(datedFilename('document-restore-preview'), resultsToCsv(restorePreviewRows(plan)))}>
                Download the preview
              </Button>
              <Button buttonType="secondary" onClick={() => setStage({ kind: 'select' })}>
                Change the selection
              </Button>
            </div>
          </div>

          {n > 0 && (
            <div className="panel">
              <h2>Would be restored</h2>
              <table className="plan">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Back to</th>
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
            <h2>3. Restore</h2>
            {confirming ? (
              <div className="row">
                <Button onClick={() => void apply(plan)}>
                  Yes, restore {n} {noun} now
                </Button>
                <Button buttonType="secondary" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="row">
                <Button disabled={n === 0} onClick={() => setConfirming(true)}>
                  Restore {n} {noun}
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Restoring documents</h2>
          <Progress>{stage.progress}</Progress>
          <Button buttonType="secondary" onClick={() => abort.current?.abort()}>
            Stop after the current batch
          </Button>
        </div>
      )}

      {stage.kind === 'done' && (
        <ResultsSummary
          rows={stage.rows}
          vocabulary={DOCUMENT_RESTORE_STATUSES}
          warning={stage.warning}
          siteUrl={session.siteUrl}
          filenameStem="document-restore-results"
          actions={
            <Button buttonType="secondary" onClick={startOver}>
              Restore other documents
            </Button>
          }
        />
      )}
    </>
  );
}
