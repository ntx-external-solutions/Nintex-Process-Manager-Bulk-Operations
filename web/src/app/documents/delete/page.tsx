'use client';

/**
 * Delete documents (W8b): choose by group, from either document list, or by id, preview,
 * archive the active ones, confirm, delete, put back what was archived and not deleted,
 * download the results, and optionally delete the checked groups the run emptied.
 *
 * Process Manager refuses to delete an active document, so the run archives active
 * targets first, exactly as Archive documents does. It stops there for a typed DELETE
 * naming every document to be deleted. A document attached to anything is never archived
 * or deleted (W8 decision 1); the tenant guards a delete against listed attachments but
 * not against a reference only a draft holds, so the preview scans every active process.
 */

import { Button, Input } from '@exp-textura/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { DocumentTarget } from '@/lib/documents/archive.ts';
import {
  afterArchivePhase,
  buildDocumentDeletePlan,
  recoverDelete,
  DELETE_MID_RUN_NOTE,
  deletePreviewRows,
  DOCUMENT_DELETE_STATUSES,
  leftArchived,
  NOT_CONFIRMED,
  putBack,
  runArchivePhase,
  runDeletePhase,
  settleDocumentDelete,
  type AfterArchive,
  type DocumentDeletePlan,
} from '@/lib/documents/delete.ts';
import { loadDocumentIndex } from '@/lib/documents/list.ts';
import { inFlightOf, type DocumentRunRecord, type Recorder } from '@/lib/documents/runRecord.ts';
import { nameList } from '@/lib/documents/holders.ts';
import { groupsTheRunDeletedFrom } from '@/lib/delete/selection.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { CANCELLED, createControls, errorMessage, type Controls } from '@/lib/exec/runner.ts';
import type { CoveredGroup } from '@/lib/select/resolve.ts';
import { loadProcessIndex, type ProcessIndex } from '@/lib/tenant/state.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import { browserDocumentGateway, browserGateway, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { Notice, Progress, valueOf } from '../../_ui/kit.tsx';
import { CleanupPanel } from '../../components/CleanupPanel.tsx';
import { ResultsSummary } from '../../components/ResultsSummary.tsx';
import { SessionGate } from '../../components/SessionGate.tsx';
import { useBrowseTree } from '../../components/TreeBrowser.tsx';
import { InterruptedRun, isSignedOut, LeftOut, readWhatHolds, UnreadProcesses, useDocumentChoice, useRunRecord } from '../choose.tsx';

/** What the done screen needs to offer the group cleanup, or why it can't. */
type CleanupOffer =
  | { kind: 'none' }
  | { kind: 'offer'; groups: CoveredGroup[]; after: ProcessIndex }
  | { kind: 'withheld'; groups: CoveredGroup[]; reason: string };

/** What a run carries from the plan to the end. */
interface Run {
  plan: DocumentDeletePlan;
  index: ProcessIndex;
  groups: CoveredGroup[];
  /** Rows an interrupted run made before this page picked it up; empty for a new run. */
  priorRows: ResultRow[];
  /** Every target, for the cleanup offer: a resumed run's plan holds none. */
  allTargets: DocumentTarget[];
}

/** Rows made before the current phase: what an interrupted run recorded, then the plan's. */
const before = (run: Run) => [...run.priorRows, ...run.plan.skipped];

const EMPTY_PLAN: DocumentDeletePlan = { toArchive: [], alreadyArchived: [], skipped: [], unreadProcesses: [], processesRead: 0 };

type Stage =
  | { kind: 'select' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; run: Run }
  | { kind: 'running'; title: string; progress: string }
  | { kind: 'confirm'; run: Run; between: AfterArchive; note: string | null }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null; cleanup: CleanupOffer };

export default function DeleteDocumentsPage() {
  return (
    <SessionGate title="Delete documents">
      {(session, onSignedOut) => <DeleteDocumentsFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

const statusOf = (e: unknown) => (e instanceof PmRequestError ? e.status : null);

function DeleteDocumentsFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
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
  const abort = useRef<AbortController | null>(null);
  // The run's record (lib/documents/runRecord.ts), from the first write to the settled end.
  const record = useRef<Recorder | null>(null);
  const runs = useRunRecord('delete', session.tenant);

  const fail = (cause: unknown) => {
    handleError(cause);
    setError(errorMessage(cause));
  };

  const choice = useDocumentChoice({
    docs,
    browse,
    sources: ['tree', 'list', 'archived', 'ids'],
    treeLists: ['All', 'Archived'],
    onError: fail,
    treeNote: (
      <>
        Checking a group takes in the documents, active and archived, whose primary group is that group or one under it.
        Documents that are only associated with a checked group are listed separately, for you to tick or not.
      </>
    ),
  });

  async function buildPlan() {
    setError(null);
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
      // Archived documents are scanned for too: deleting one a draft points at breaks that process (spike).
      const { properties, index, scan } = await readWhatHolds(docs, collected.chosen, progress, (c) => !c.entry.isPending);
      const plan = buildDocumentDeletePlan({ chosen: collected.chosen, resolveSkipped: collected.resolveSkipped, paths: collected.paths, properties, scan, index });
      setStage({ kind: 'plan', run: { plan, index, groups: collected.groups, priorRows: [], allTargets: [...plan.toArchive, ...plan.alreadyArchived] } });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'select' });
    }
  }

  function freshControls(): Controls {
    abort.current = new AbortController();
    return createControls({ signal: abort.current.signal });
  }

  /** `earlier`: rows made before this phase, which the record keeps ahead of the phase's own. */
  const runOptions = (run: Run, title: string, verb: string, operation: string, earlier: ResultRow[]) => ({
    index: run.index,
    errorText: errorMessage,
    statusOf,
    onProgress: (done: number, total: number, label: string) => setStage({ kind: 'running', title, progress: `${verb} ${done} of ${total}. Last: ${label}` }),
    onBatch: (e: { sending: readonly DocumentTarget[] | null; rows: readonly ResultRow[] }) =>
      record.current?.save({ rows: [...earlier, ...e.rows], inFlight: e.sending ? inFlightOf(operation, e.sending) : null }),
  });

  /** Phase 1, then the confirmation. With nothing active to archive, straight to the confirmation. */
  async function archiveFirst(run: Run) {
    setError(null);
    // Before the first write: a run whose session dies from here on can be finished.
    record.current = runs.start(before(run), {
      delete: { toArchive: run.plan.toArchive, alreadyArchived: run.plan.alreadyArchived, groups: run.groups, confirmed: false },
    });
    if (run.plan.toArchive.length === 0) {
      setStage({ kind: 'confirm', run, between: afterArchivePhase(run.plan, [], null), note: null });
      return;
    }
    const title = 'Phase 1: archiving the active documents';
    setStage({ kind: 'running', title, progress: 'Re-checking the first batch…' });
    const controls = freshControls();
    try {
      const archiveRows = await runArchivePhase(docs, run.plan, controls, runOptions(run, title, 'Archived', 'Archive', before(run)));
      let after = null;
      let note: string | null = null;
      try {
        setStage({ kind: 'running', title, progress: 'Reading the document lists to confirm what was archived…' });
        after = await loadDocumentIndex(docs.list);
      } catch (cause) {
        if (isSignedOut(cause)) controls.stop(errorMessage(cause));
        else note = `The read after archiving failed (${errorMessage(cause)}), so the archive statuses are what the calls reported. Each document is read again straight before it is deleted.`;
      }
      const between = afterArchivePhase(run.plan, archiveRows, after);
      record.current?.save({ rows: [...before(run), ...between.archiveRows], inFlight: null });
      if (controls.stopped()) {
        // Stopped, or the session ended: no delete. Put back what this phase archived.
        await finish(run, between, [], controls.stoppedReason() === CANCELLED ? 'the run was stopped before the delete' : null, controls.stoppedReason());
        return;
      }
      setStage({ kind: 'confirm', run, between, note });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'plan', run });
    } finally {
      abort.current = null;
    }
  }

  /** Phase 2, the delete, after the typed confirmation. */
  async function deleteNow(run: Run, between: AfterArchive) {
    setError(null);
    const title = 'Phase 2: deleting';
    setStage({ kind: 'running', title, progress: 'Re-checking the first batch…' });
    const controls = freshControls();
    const current = record.current?.current().delete;
    if (current) record.current?.save({ delete: { ...current, confirmed: true } });
    try {
      const deleteRows = await runDeletePhase(docs, between.toDelete, controls, runOptions(run, title, 'Deleted', 'Delete', [...before(run), ...between.archiveRows]));
      const fatal = controls.stopped() && controls.stoppedReason() !== CANCELLED;
      await finish(run, between, deleteRows, fatal ? null : 'it was not deleted', controls.stoppedReason());
    } catch (cause) {
      fail(cause);
      await finish(run, between, [], null, errorMessage(cause));
    } finally {
      abort.current = null;
    }
  }

  /**
   * Put back what this run archived and did not delete, read both lists, settle, and
   * offer the cleanup. `why` null means the session is gone and nothing can be put back.
   */
  async function finish(run: Run, between: AfterArchive, deleteRows: ResultRow[], why: string | null, stopped: string | null) {
    const title = 'Putting back what was archived and not deleted';
    let restoreRows: ResultRow[] = [];
    if (why !== null) {
      setStage({ kind: 'running', title, progress: 'Restoring…' });
      // Its own controls: an operator's stop of the delete still puts things back.
      restoreRows = await putBack(docs, between.archivedByRun, deleteRows, createControls(), {
        why,
        ...runOptions(run, title, 'Restored', 'Restore', [...before(run), ...between.archiveRows, ...deleteRows]),
      });
    }
    let rows = [...before(run), ...between.archiveRows, ...deleteRows, ...restoreRows];
    const warnings: string[] = stopped ? [stopped] : [];
    let settled = false;
    try {
      setStage({ kind: 'running', title: 'Confirming', progress: 'Reading the document lists to confirm every outcome…' });
      rows = settleDocumentDelete(rows, await loadDocumentIndex(docs.list));
      settled = true;
    } catch (cause) {
      // Not handleError: a dead session here must not lose the rows for what was deleted.
      warnings.push(`The final read failed (${errorMessage(cause)}), so these statuses are what the calls reported, not confirmed.`);
    }
    const stranded = leftArchived(between.archivedByRun, rows);
    if (stranded.length > 0) {
      warnings.push(
        `${stranded.length} document${stranded.length === 1 ? '' : 's'} this run archived ${stranded.length === 1 ? 'is' : 'are'} still archived: ` +
          `${nameList(stranded.map((t) => t.name))}. Sign in again and open Delete documents to finish the run: it offers to delete ${stranded.length === 1 ? 'it' : 'them'} or put ${stranded.length === 1 ? 'it' : 'them'} back.`,
      );
    }
    // The record goes once the run has settled with nothing left to finish; otherwise it
    // stays, and signing in again offers to finish the run.
    const finished = settled && stranded.length === 0 && (stopped === null || stopped === CANCELLED);
    if (finished) record.current?.clear();
    else record.current?.save({ rows, inFlight: null });
    record.current = null;
    const cleanup = await cleanupOffer(run, run.allTargets, rows, settled && stopped === null);
    setStage({ kind: 'done', rows, warning: warnings.length > 0 ? warnings.join(' ') : null, cleanup });
  }

  /** Checked groups a deleted document had as its primary group, read against a fresh process listing. */
  async function cleanupOffer(run: Run, toDelete: readonly DocumentTarget[], rows: readonly ResultRow[], completed: boolean): Promise<CleanupOffer> {
    const deleted = rows.filter((r) => r.operation === 'Delete' && r.status === 'Success').map((r) => r.objectId);
    const groups = groupsTheRunDeletedFrom({ groups: run.groups, targets: toDelete.map((t) => ({ uniqueId: t.uniqueId, groupUniqueId: t.groupUniqueId })) }, deleted);
    if (groups.length === 0) return { kind: 'none' };
    if (!completed) return { kind: 'withheld', groups, reason: 'the run did not complete, or its final read failed' };
    try {
      return { kind: 'offer', groups, after: await loadProcessIndex(gateway.processesList) };
    } catch (cause) {
      return { kind: 'withheld', groups, reason: `the process lists could not be read again (${errorMessage(cause)})` };
    }
  }

  /** Pick up an interrupted run from its record: settle what it did, then confirm the rest or put it back. */
  async function finishInterrupted(interrupted: DocumentRunRecord) {
    setError(null);
    const title = 'Finishing the interrupted run';
    try {
      setStage({ kind: 'running', title, progress: 'Reading the document lists to see what the interrupted run did…' });
      const after = await loadDocumentIndex(docs.list);
      const recovered = recoverDelete(interrupted, after);
      if (recovered === null) {
        setError('The record of the interrupted run is incomplete, so it cannot be finished here. Its rows are discarded; build a new plan.');
        runs.discard();
        setStage({ kind: 'select' });
        return;
      }
      setStage({ kind: 'running', title, progress: 'Reading the process lists…' });
      const index = await loadProcessIndex(gateway.processesList);
      const run: Run = { plan: EMPTY_PLAN, index, groups: interrupted.delete?.groups ?? [], priorRows: recovered.priorRows, allTargets: recovered.allTargets };
      record.current = runs.resume({ ...interrupted, rows: recovered.priorRows, inFlight: null });
      runs.dismiss();
      if (recovered.between.toDelete.length === 0) {
        await finish(run, recovered.between, [], 'it was not deleted', null);
        return;
      }
      setStage({
        kind: 'confirm',
        run,
        between: recovered.between,
        note: `This finishes a run that was interrupted. ${recovered.priorRows.length} rows it recorded are kept, corrected by the lists read now; the documents below are the ones its delete never reached.`,
      });
    } catch (cause) {
      fail(cause);
      setStage({ kind: 'select' });
    }
  }

  function startOver() {
    runs.reload();
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

      {stage.kind === 'select' && runs.interrupted !== null && (
        <InterruptedRun
          record={runs.interrupted}
          what="A delete run"
          finish="Finish it"
          onFinish={() => void finishInterrupted(runs.interrupted!)}
          onDiscard={runs.discard}
        />
      )}

      {stage.kind === 'select' && runs.interrupted === null && (
        <>
          <div className="panel">
            <h2>1. Choose the documents to delete</h2>
            <p>
              By group, from the active or archived document list, or by id. They add up, each document once. Active
              documents are archived first, then deleted. A document attached to a process (active or archived) or a
              training unit, or referenced in a process&rsquo;s unpublished draft, is never archived or deleted; the preview
              names what holds it.
            </p>
            {choice.tabs}
          </div>
          {choice.body}

          <div className="row">
            <Button disabled={choice.count === 0 || choice.busy} onClick={() => void buildPlan()}>
              Preview what would be deleted
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'planning' && <Progress>{stage.progress}</Progress>}

      {stage.kind === 'plan' && (
        <PlanView
          plan={stage.run.plan}
          onBack={() => setStage({ kind: 'select' })}
          onReplan={() => void buildPlan()}
          onStart={() => void archiveFirst(stage.run)}
        />
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>{stage.title}</h2>
          <Progress>{stage.progress}</Progress>
          <Button buttonType="secondary" onClick={() => abort.current?.abort()}>
            Stop after the current batch
          </Button>
        </div>
      )}

      {stage.kind === 'confirm' && (
        <ConfirmView
          plan={stage.run.plan}
          between={stage.between}
          note={stage.note}
          onDelete={() => void deleteNow(stage.run, stage.between)}
          onDecline={() => void finish(stage.run, stage.between, [], NOT_CONFIRMED, null)}
        />
      )}

      {stage.kind === 'done' && (
        <>
          <ResultsSummary
            rows={stage.rows}
            vocabulary={DOCUMENT_DELETE_STATUSES}
            warning={stage.warning}
            siteUrl={session.siteUrl}
            filenameStem="document-delete-results"
            actions={
              <Button buttonType="secondary" onClick={startOver}>
                Delete other documents
              </Button>
            }
          />
          {stage.cleanup.kind === 'offer' && (
            <CleanupPanel
              tenant={session.tenant}
              groups={stage.cleanup.groups}
              index={stage.cleanup.after}
              onError={handleError}
              onRows={(extra) => setStage({ ...stage, rows: [...stage.rows, ...extra] })}
              heading="4. Delete the groups this emptied (optional)"
              offer={
                <>
                  The run deleted documents from {stage.cleanup.groups.length} checked group{stage.cleanup.groups.length === 1 ? '' : 's'}.
                  This checks which of them now hold no active process, no document (active or archived, including one only
                  associated with the group), and no subgroup that is kept. Only groups you checked in the tree are offered.
                  Nothing is deleted until you confirm.
                </>
              }
            />
          )}
          {stage.cleanup.kind === 'withheld' && (
            <div className="panel">
              <h2>4. Delete the groups this emptied</h2>
              <p>
                Not offered for the {stage.cleanup.groups.length} checked group{stage.cleanup.groups.length === 1 ? '' : 's'} the
                run deleted from, because {stage.cleanup.reason}. Build the plan again to get a confirmed result first.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

function TargetTable({ targets }: { targets: readonly DocumentTarget[] }) {
  return (
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
        {targets.map((t) => (
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
  );
}

const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;

function PlanView(props: { plan: DocumentDeletePlan; onBack: () => void; onReplan: () => void; onStart: () => void }) {
  const { plan } = props;
  const [confirming, setConfirming] = useState(false);
  const incomplete = plan.unreadProcesses.length > 0;
  const total = plan.toArchive.length + plan.alreadyArchived.length;

  return (
    <>
      <div className="panel">
        <h2>2. Check the plan. Nothing has been changed.</h2>
        <p>
          {docs(total)} would be permanently deleted: {plan.toArchive.length} active, archived first; {plan.alreadyArchived.length}{' '}
          already archived. {plan.skipped.length > 0 && `${plan.skipped.length} left out (listed below).`}{' '}
          {plan.processesRead > 0 && `${plan.processesRead} active processes were read for references, drafts included.`}
        </p>
        <p className="small">{DELETE_MID_RUN_NOTE}</p>
        <div className="row">
          <Button buttonType="secondary" onClick={() => downloadCsv(datedFilename('document-delete-preview'), resultsToCsv(deletePreviewRows(plan)))}>
            Download the preview
          </Button>
          <Button buttonType="secondary" onClick={props.onBack}>
            Change the selection
          </Button>
        </div>
      </div>

      <UnreadProcesses unread={plan.unreadProcesses} verb="archived or deleted" onReplan={props.onReplan} />

      {plan.toArchive.length > 0 && (
        <div className="panel">
          <h2>Phase 1: archived, then deleted ({plan.toArchive.length})</h2>
          <TargetTable targets={plan.toArchive} />
        </div>
      )}
      {plan.alreadyArchived.length > 0 && (
        <div className="panel">
          <h2>Phase 2: already archived, deleted ({plan.alreadyArchived.length})</h2>
          <TargetTable targets={plan.alreadyArchived} />
        </div>
      )}

      <LeftOut rows={plan.skipped} open={total === 0} />

      <div className="panel">
        <h2>3. Start</h2>
        <p>
          {plan.toArchive.length > 0
            ? `The ${docs(plan.toArchive.length)} still active ${plan.toArchive.length === 1 ? 'is' : 'are'} archived first. Then the run stops and asks you to confirm the delete, naming every document. If you don't, everything this run archived is put back.`
            : 'Nothing needs archiving first. The next screen asks you to confirm the delete, naming every document.'}
        </p>
        {confirming ? (
          <div className="row">
            <Button onClick={props.onStart}>{plan.toArchive.length > 0 ? `Yes, archive ${docs(plan.toArchive.length)}` : 'Yes, go on'}</Button>
            <Button buttonType="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="row">
            <Button disabled={total === 0 || incomplete} onClick={() => setConfirming(true)}>
              {plan.toArchive.length > 0 ? `Archive ${docs(plan.toArchive.length)}, then confirm the delete` : 'Go to the delete confirmation'}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/** The final confirmation: every document to be deleted, every one left out, and a typed DELETE. */
function ConfirmView(props: { plan: DocumentDeletePlan; between: AfterArchive; note: string | null; onDelete: () => void; onDecline: () => void }) {
  const { between } = props;
  const [typed, setTyped] = useState('');
  const n = between.toDelete.length;
  const notArchived = between.archiveRows.filter((r) => r.status !== 'Success');
  const leftOut = [...props.plan.skipped, ...notArchived];
  const back = between.archivedByRun.length;

  return (
    <>
      {between.archiveRows.length > 0 && (
        <div className="panel">
          <h2>Phase 1 done</h2>
          <p>
            {docs(back)} archived. {notArchived.length > 0 && `${docs(notArchived.length)} not archived, so not deleted (listed below).`}
          </p>
        </div>
      )}

      {props.note !== null && (
        <div className="panel">
          <p className="small">{props.note}</p>
        </div>
      )}

      <LeftOut rows={leftOut} open={n === 0} />

      <div className="panel warning">
        <h2>3. Permanently delete {docs(n)}</h2>
        {n > 0 ? (
          <>
            <p>These are deleted for good. Process Manager has no way to bring a deleted document back.</p>
            <TargetTable targets={between.toDelete} />
            <label htmlFor="typed">Type DELETE to delete them</label>
            <Input id="typed" value={typed} onChange={(e) => setTyped(valueOf(e))} />
          </>
        ) : (
          <p>Nothing is left to delete.</p>
        )}
        <div className="row">
          {n > 0 && (
            <Button disabled={typed !== 'DELETE'} onClick={props.onDelete}>
              Delete {docs(n)} permanently
            </Button>
          )}
          <Button buttonType="secondary" onClick={props.onDecline}>
            {back > 0 ? `Don't delete; put back the ${docs(back)} this run archived` : n > 0 ? "Don't delete" : 'Finish'}
          </Button>
        </div>
      </div>
    </>
  );
}
