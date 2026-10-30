'use client';

/**
 * Repair document references (W8d): find processes pointing at documents that no longer
 * exist, and remove those references so the process can be published and archived again.
 *
 * The scan is read only and comes first. A deleted document a process still points at
 * leaves it unable to publish or archive ("Could not find Form: <name>", documents
 * spike). Nothing on this page archives, deletes or restores anything: it edits the
 * processes the operator ticks, one at a time, and reads each back.
 */

import { Button, Input } from '@exp-textura/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { loadDocumentIndex } from '@/lib/documents/list.ts';
import {
  describeReference,
  existingDocuments,
  interruptedRepairRow,
  REPAIR_DESCRIPTION,
  REPAIR_OPERATION,
  REPAIR_STATUSES,
  repairProcess,
  scanForDeadReferences,
  stateText,
  type BrokenProcess,
  type RepairScan,
} from '@/lib/documents/repair.ts';
import type { ResultRow } from '@/lib/exec/report.ts';
import { CANCELLED, errorMessage } from '@/lib/exec/runner.ts';
import { isOpenDraft } from '@/lib/pm/writePath.ts';
import { loadGroupPaths } from '@/lib/select/archived.ts';
import { loadProcessIndex } from '@/lib/tenant/state.ts';
import { browserDeleteGateway, browserDocumentGateway, browserGateway, groupBreadcrumb, type SessionInfo } from '@/lib/ui/gateway.ts';
import { Notice, Progress, valueOf } from '../../_ui/kit.tsx';
import { Checkbox } from '../../components/Checkbox.tsx';
import { ResultsSummary } from '../../components/ResultsSummary.tsx';
import { SessionGate } from '../../components/SessionGate.tsx';
import type { DocumentRunRecord } from '@/lib/documents/runRecord.ts';
import { InterruptedRun, isSignedOut, useRunRecord } from '../choose.tsx';

type Stage =
  | { kind: 'start' }
  | { kind: 'scanning'; progress: string }
  | { kind: 'found'; scan: RepairScan; paths: ReadonlyMap<string, string[]> }
  | { kind: 'running'; progress: string }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null };

export default function RepairDocumentReferencesPage() {
  return (
    <SessionGate title="Repair document references">
      {(session, onSignedOut) => <RepairFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

const draftOf = (p: BrokenProcess) => isOpenDraft({ revisionStateId: p.revisionStateId, publishedVersionExists: Number(p.version.split('.')[0]) >= 1 });

function RepairFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserGateway(), []);
  const docs = useMemo(() => browserDocumentGateway(), []);
  const writes = useMemo(() => browserDeleteGateway(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (isSignedOut(error)) onSignedOut();
    },
    [onSignedOut],
  );

  const [stage, setStage] = useState<Stage>({ kind: 'start' });
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [publishDrafts, setPublishDrafts] = useState<ReadonlySet<string>>(new Set());
  const [description, setDescription] = useState(REPAIR_DESCRIPTION);
  const [confirming, setConfirming] = useState(false);
  const stop = useRef(false);
  const runs = useRunRecord('repair', session.tenant);

  async function scan() {
    setError(null);
    setTicked(new Set());
    setPublishDrafts(new Set());
    setConfirming(false);
    const progress = (text: string) => setStage({ kind: 'scanning', progress: text });
    try {
      progress('Reading the document lists…');
      const existing = existingDocuments(await loadDocumentIndex(docs.list, (n) => progress(`Reading the document lists… ${n} read`)));
      progress('Reading the process lists…');
      const index = await loadProcessIndex(gateway.processesList, { onProgress: (n) => progress(`Reading the process lists… ${n} processes`) });
      const all = [...index.values()].map((p) => ({ uniqueId: p.uniqueId, name: p.name, groupUniqueId: p.groupUniqueId, groupId: p.groupId, archived: p.isArchived }));
      const found = await scanForDeadReferences({
        active: all.filter((p) => !p.archived),
        archived: all.filter((p) => p.archived),
        readModel: writes.readModel,
        readArchivedModels: writes.readArchivedModels,
        existing,
        isFatal: isSignedOut,
        errorText: errorMessage,
        onProgress: (done, total) => progress(`Reading every process, drafts included… ${done} of ${total}`),
      });
      const groups = [...found.active, ...found.archived].map((p) => p.groupUniqueId).filter((g): g is string => g !== null);
      const paths = await loadGroupPaths(groups, groupBreadcrumb, { isFatal: (e) => (isSignedOut(e) ? 'signed out' : null) });
      setStage({ kind: 'found', scan: found, paths });
    } catch (cause) {
      handleError(cause);
      setError(errorMessage(cause));
      setStage({ kind: 'start' });
    }
  }

  async function repair(found: RepairScan) {
    setError(null);
    setConfirming(false);
    stop.current = false;
    const chosen = found.active.filter((p) => ticked.has(p.uniqueId));
    const rows: ResultRow[] = [];
    let warning: string | null = null;
    // Each process's row as it is made, and the one being repaired, so a run whose session
    // dies can be finished.
    const record = runs.start([]);
    for (const [i, p] of chosen.entries()) {
      if (stop.current) {
        warning = CANCELLED;
        break;
      }
      setStage({ kind: 'running', progress: `Repairing ${i + 1} of ${chosen.length}: ${p.name}` });
      record.save({ rows, inFlight: { operation: REPAIR_OPERATION, items: [{ uniqueId: p.uniqueId, name: p.name, groupId: p.groupId }] } });
      try {
        rows.push(
          await repairProcess(
            { ...writes, list: docs.list },
            { uniqueId: p.uniqueId, name: p.name, groupId: p.groupId, dead: p.dead, publishDraft: publishDrafts.has(p.uniqueId) },
            { changeDescription: description.trim() || REPAIR_DESCRIPTION, isFatal: (e) => (isSignedOut(e) ? 'signed out' : null), errorText: errorMessage },
          ),
        );
      } catch (cause) {
        // A dead session: keep the rows for what was already repaired.
        warning = `The run stopped at ${p.name}: ${errorMessage(cause)}. Sign in again and scan again for the rest.`;
        break;
      }
    }
    if (warning === null || warning === CANCELLED) record.clear();
    // The process being repaired when the session died stays in flight, for the read-back.
    else record.save({ rows });
    setStage({ kind: 'done', rows, warning });
  }

  /** An interrupted run's rows, and a row for the process it was repairing, from a read-back. */
  async function finishInterrupted(interrupted: DocumentRunRecord) {
    setError(null);
    setStage({ kind: 'running', progress: 'Reading back the process the interrupted run was repairing…' });
    const done = new Set(interrupted.rows.map((r) => r.objectId.toLowerCase()));
    const flying = (interrupted.inFlight?.items ?? []).filter((item) => !done.has(item.uniqueId.toLowerCase()));
    const rows = [...interrupted.rows];
    for (const item of flying) rows.push(await interruptedRepairRow({ readModel: writes.readModel, list: docs.list }, item, errorMessage));
    runs.discard();
    setStage({ kind: 'done', rows, warning: 'These are the results of an interrupted run. Scan again for anything it did not reach.' });
  }

  return (
    <>
      {error !== null && (
        <Notice tone="critical" title="Problem">
          {error}
        </Notice>
      )}

      {stage.kind === 'start' && runs.interrupted !== null && (
        <InterruptedRun
          record={runs.interrupted}
          what="A repair run"
          finish="Show its results"
          onFinish={() => void finishInterrupted(runs.interrupted!)}
          onDiscard={runs.discard}
        />
      )}

      {stage.kind === 'start' && runs.interrupted === null && (
        <div className="panel">
          <h2>1. Find processes pointing at deleted documents</h2>
          <p>
            A process that still points at a deleted document cannot be published or archived. The scan reads both document
            lists and every process, active and archived, drafts included. It changes nothing. A reference to an archived
            document is not broken and is not listed.
          </p>
          <Button onClick={() => void scan()}>Scan for dead references</Button>
        </div>
      )}

      {stage.kind === 'scanning' && <Progress>{stage.progress}</Progress>}

      {stage.kind === 'found' && (
        <FoundView
          scan={stage.scan}
          paths={stage.paths}
          ticked={ticked}
          setTicked={setTicked}
          publishDrafts={publishDrafts}
          setPublishDrafts={setPublishDrafts}
          description={description}
          setDescription={setDescription}
          confirming={confirming}
          setConfirming={setConfirming}
          onRescan={() => void scan()}
          onRepair={() => void repair(stage.scan)}
        />
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Repairing</h2>
          <Progress>{stage.progress}</Progress>
          <Button buttonType="secondary" onClick={() => (stop.current = true)}>
            Stop after this process
          </Button>
        </div>
      )}

      {stage.kind === 'done' && (
        <ResultsSummary
          rows={stage.rows}
          vocabulary={REPAIR_STATUSES}
          warning={stage.warning}
          siteUrl={session.siteUrl}
          filenameStem="repair-document-references-results"
          actions={
            <Button buttonType="secondary" onClick={() => void scan()}>
              Scan again
            </Button>
          }
        />
      )}
    </>
  );
}

function DeadList({ process }: { process: BrokenProcess }) {
  return (
    <ul>
      {process.dead.map((r) => (
        <li key={r.path}>{describeReference(r)}</li>
      ))}
    </ul>
  );
}

function FoundView(props: {
  scan: RepairScan;
  paths: ReadonlyMap<string, string[]>;
  ticked: ReadonlySet<string>;
  setTicked: (next: ReadonlySet<string>) => void;
  publishDrafts: ReadonlySet<string>;
  setPublishDrafts: (next: ReadonlySet<string>) => void;
  description: string;
  setDescription: (value: string) => void;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onRescan: () => void;
  onRepair: () => void;
}) {
  const { scan, ticked } = props;
  const pathOf = (p: BrokenProcess) => (p.groupUniqueId ? props.paths.get(p.groupUniqueId)?.join(' / ') : undefined) ?? '';
  const flip = (set: ReadonlySet<string>, id: string, apply: (next: ReadonlySet<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };
  const allTicked = scan.active.length > 0 && scan.active.every((p) => ticked.has(p.uniqueId));
  const n = scan.active.filter((p) => ticked.has(p.uniqueId)).length;
  const drafts = scan.active.filter((p) => ticked.has(p.uniqueId) && draftOf(p) && props.publishDrafts.has(p.uniqueId)).length;
  const unreadActive = scan.unread.filter((u) => !u.archived);
  const unreadArchived = scan.unread.filter((u) => u.archived);

  return (
    <>
      <div className="panel">
        <h2>2. What the scan found. Nothing has been changed.</h2>
        <p>
          {scan.read} processes read. {scan.active.length} active process{scan.active.length === 1 ? '' : 'es'} and{' '}
          {scan.archived.length} archived process{scan.archived.length === 1 ? '' : 'es'} point at a document that no
          longer exists.
        </p>
        <Button buttonType="secondary" onClick={props.onRescan}>
          Scan again
        </Button>
      </div>

      {unreadActive.length + unreadArchived.length > 0 && (
        <div className="panel warning">
          <h2>Some processes could not be read ({unreadActive.length + unreadArchived.length})</h2>
          <p>They may point at deleted documents too. Scan again to retry.</p>
          <ul className="checklist">
            {[...unreadActive, ...unreadArchived].map((u) => (
              <li key={u.uniqueId}>
                {u.name}
                {u.archived && ' (archived)'}: {u.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {scan.active.length > 0 && (
        <div className="panel">
          <h2>Active processes to repair ({scan.active.length})</h2>
          <p className="small">
            Ticked processes are re-read with both document lists straight before saving, and only references whose
            document is still missing are removed. A published process is saved and published. A process with an open
            draft is saved into the draft and not published, unless you tick &ldquo;Publish the draft&rdquo;.
          </p>
          <label className="inline">
            <Checkbox
              state={allTicked ? 'checked' : 'unchecked'}
              label="Tick every active process"
              onChange={() => props.setTicked(allTicked ? new Set() : new Set(scan.active.map((p) => p.uniqueId)))}
            />{' '}
            Every active process
          </label>
          <ul className="checklist">
            {scan.active.map((p) => (
              <li key={p.uniqueId}>
                <label className="inline">
                  <Checkbox
                    state={ticked.has(p.uniqueId) ? 'checked' : 'unchecked'}
                    label={`Repair ${p.name}`}
                    onChange={() => flip(ticked, p.uniqueId, props.setTicked)}
                  />{' '}
                  <strong>{p.name}</strong>
                </label>{' '}
                <span className="small">
                  {pathOf(p)} · {stateText(p.version, p.revisionStateId)}
                </span>
                <DeadList process={p} />
                {draftOf(p) && (
                  <label className="inline small">
                    <Checkbox
                      state={props.publishDrafts.has(p.uniqueId) ? 'checked' : 'unchecked'}
                      label={`Publish the draft of ${p.name}`}
                      onChange={() => flip(props.publishDrafts, p.uniqueId, props.setPublishDrafts)}
                    />{' '}
                    Publish the draft with the repair
                  </label>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {scan.archived.length > 0 && (
        <details className="panel">
          <summary>Archived processes, reported only ({scan.archived.length})</summary>
          <p className="small">
            Repairing an archived process means restoring it, editing it, publishing it and archiving it again, which this
            page does not do. They are listed so you know where they are.
          </p>
          <ul className="checklist">
            {scan.archived.map((p) => (
              <li key={p.uniqueId}>
                <strong>{p.name}</strong> <span className="small">{pathOf(p) || 'group unknown'} · archived, version {p.version}</span>
                <DeadList process={p} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {scan.active.length > 0 && (
        <div className="panel">
          <h2>3. Repair</h2>
          {drafts > 0 && (
            <Notice tone="warning" title="Drafts will be published">
              {drafts} ticked process{drafts === 1 ? ' has' : 'es have'} an open draft you chose to publish. Publishing it puts
              someone else&rsquo;s unfinished changes live, with no way back from here.
            </Notice>
          )}
          <label htmlFor="change">Change description, sent with every save and publish</label>
          <Input id="change" value={props.description} onChange={(e) => props.setDescription(valueOf(e))} />
          {props.confirming ? (
            <div className="row">
              <Button onClick={props.onRepair}>
                Yes, repair {n} process{n === 1 ? '' : 'es'} now
              </Button>
              <Button buttonType="secondary" onClick={() => props.setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="row">
              <Button disabled={n === 0} onClick={() => props.setConfirming(true)}>
                Repair {n} process{n === 1 ? '' : 'es'}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
