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
  type PropertiesRead,
} from '@/lib/documents/archive.ts';
import { toDocumentProperties } from '@/lib/documents/holders.ts';
import { documentPath, loadDocumentIndex, loadDocumentList, type DocumentEntry } from '@/lib/documents/list.ts';
import { scanProcessesForDocuments } from '@/lib/documents/references.ts';
import {
  CHOSEN_FROM_LIST,
  CHOSEN_FROM_TREE,
  combineChosen,
  resolveDocumentIds,
  splitByPrimaryGroup,
  type ChosenDocument,
} from '@/lib/documents/select.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { createControls, errorMessage } from '@/lib/exec/runner.ts';
import { loadGroupPaths } from '@/lib/select/archived.ts';
import { chosenLabel, EMPTY_ID_INPUT, typedIds, type IdInput } from '@/lib/select/ids.ts';
import { loadForSelection } from '@/lib/select/resolve.ts';
import { hasSelection, type Selection } from '@/lib/select/selection.ts';
import { loadProcessIndex, type ProcessIndex } from '@/lib/tenant/state.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import { browserDocumentGateway, browserGateway, groupBreadcrumb, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { Notice, Progress } from '../../_ui/kit.tsx';
import { Checkbox } from '../../components/Checkbox.tsx';
import { DocumentList } from '../../components/DocumentList.tsx';
import { ProcessIdInput } from '../../components/ProcessIdInput.tsx';
import { ResultsSummary } from '../../components/ResultsSummary.tsx';
import { SessionGate } from '../../components/SessionGate.tsx';
import { TreeBrowser, useBrowseTree } from '../../components/TreeBrowser.tsx';

type Source = 'tree' | 'list' | 'ids';

type Stage =
  | { kind: 'select' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: DocumentArchivePlan; index: ProcessIndex }
  | { kind: 'running'; plan: DocumentArchivePlan; progress: string }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null };

/** What the checked groups hold, read for the selection it was read for. */
interface TreeDocuments {
  selection: Selection;
  inSubtree: DocumentEntry[];
  associatedOnly: DocumentEntry[];
  /** Associated-only documents the operator ticked, lowercased ids. */
  ticked: ReadonlySet<string>;
}

export default function ArchiveDocumentsPage() {
  return (
    <SessionGate title="Archive documents">
      {(session, onSignedOut) => <ArchiveDocumentsFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

const isSignedOut = (e: unknown) => e instanceof PmRequestError && e.signedOut;

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
  const [source, setSource] = useState<Source>('tree');
  const [error, setError] = useState<string | null>(null);
  const [treeDocs, setTreeDocs] = useState<TreeDocuments | null>(null);
  const [treeReading, setTreeReading] = useState<string | null>(null);
  const [list, setList] = useState<DocumentEntry[] | null>(null);
  const [listReading, setListReading] = useState<string | null>(null);
  const [listTicked, setListTicked] = useState<ReadonlySet<string>>(new Set());
  const [idInput, setIdInput] = useState<IdInput>(EMPTY_ID_INPUT);
  const [paths, setPaths] = useState<ReadonlyMap<string, string[]>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const fail = (cause: unknown) => {
    handleError(cause);
    setError(errorMessage(cause));
  };

  const ids = typedIds(idInput.text);
  const treeChosen = hasSelection(browse.selection);
  // A read of the checked groups is for the selection it was made for, and no other.
  const treeDocsCurrent = treeDocs !== null && treeDocs.selection === browse.selection ? treeDocs : null;

  /** Breadcrumbs for the primary groups not yet known, merged into the page's paths. */
  async function addPaths(entries: readonly DocumentEntry[], progress: (text: string) => void): Promise<Map<string, string[]>> {
    const missing = [...new Set(entries.map((e) => e.primaryGroupUniqueId).filter((g): g is string => g !== null && !paths.has(g)))];
    const read = await loadGroupPaths(missing, groupBreadcrumb, {
      isFatal: (e) => (isSignedOut(e) ? 'signed out' : null),
      onProgress: (done, total) => progress(`Reading group paths… ${done} of ${total}`),
    });
    setPaths((current) => new Map([...current, ...read]));
    return new Map([...paths, ...read]);
  }

  /** The checked groups' documents, split by where their primary group is. */
  async function readTreeDocuments(): Promise<TreeDocuments> {
    setTreeReading('Reading the checked groups…');
    try {
      const loaded = await loadForSelection(gateway, browse.tree, browse.selection, {
        onProgress: (n) => setTreeReading(`Reading the checked groups… ${n} read`),
      });
      browse.setTree(loaded.tree);
      const covered = new Set(loaded.resolution.groups.map((g) => g.uniqueId.toLowerCase()));
      // The tenant's group filter takes in the subgroups (spike), so only the topmost checked groups are listed.
      const tops = loaded.resolution.groups.filter((g) => g.parentUniqueId === null || !covered.has(g.parentUniqueId.toLowerCase()));
      const listed = new Map<string, DocumentEntry>();
      for (const [i, group] of tops.entries()) {
        setTreeReading(`Listing documents in ${group.title} (${i + 1} of ${tops.length})…`);
        for (const entry of await loadDocumentList(docs.list, 'All', group.uniqueId)) listed.set(entry.uniqueId.toLowerCase(), entry);
      }
      const split = splitByPrimaryGroup([...listed.values()], covered);
      await addPaths(split.associatedOnly, setTreeReading);
      const read = { selection: browse.selection, ...split, ticked: new Set<string>() };
      setTreeDocs(read);
      return read;
    } finally {
      setTreeReading(null);
    }
  }

  /** The list tab reads the active list when first opened, and again after a failed read. */
  async function openList() {
    setSource('list');
    if (list !== null || listReading !== null) return;
    setListReading('Reading the document list…');
    try {
      const entries = await loadDocumentList(docs.list, 'All', null, (n) => setListReading(`Reading the document list… ${n} read`));
      await addPaths(entries, setListReading);
      setList(entries);
    } catch (cause) {
      fail(cause);
    } finally {
      setListReading(null);
    }
  }

  async function buildPlan() {
    setError(null);
    setConfirming(false);
    try {
      let fromTree = treeDocsCurrent;
      if (treeChosen && fromTree === null) {
        fromTree = await readTreeDocuments();
        if (fromTree.associatedOnly.length > 0) {
          // The operator decides about these before anything is planned.
          setSource('tree');
          return;
        }
      }

      setStage({ kind: 'planning', progress: 'Reading the document lists…' });
      const docIndex = await loadDocumentIndex(docs.list, (n) => setStage({ kind: 'planning', progress: `Reading the document lists… ${n} read` }));
      const fresh = (e: DocumentEntry) => docIndex.get(e.uniqueId.toLowerCase()) ?? e;

      const tree: ChosenDocument[] = fromTree
        ? [...fromTree.inSubtree, ...fromTree.associatedOnly.filter((e) => fromTree.ticked.has(e.uniqueId.toLowerCase()))].map((e) => ({
            entry: fresh(e),
            chosen: CHOSEN_FROM_TREE,
          }))
        : [];
      const fromList: ChosenDocument[] = (list ?? [])
        .filter((e) => listTicked.has(e.uniqueId.toLowerCase()))
        .map((e) => ({ entry: fresh(e), chosen: CHOSEN_FROM_LIST }));
      const byId = ids.length > 0 ? resolveDocumentIds(ids, docIndex, (v) => chosenLabel(idInput, v)) : null;
      if (byId && byId.chosen.length === 0 && tree.length === 0 && fromList.length === 0) {
        setError(`None of the ids matched a document: ${byId.unknown.join(', ')}`);
        setStage({ kind: 'select' });
        return;
      }
      const chosen = combineChosen(tree, fromList, byId?.chosen ?? []);
      if (chosen.length === 0) {
        setError('The checked groups hold no active documents.');
        setStage({ kind: 'select' });
        return;
      }
      const merged = await addPaths(
        chosen.map((c) => c.entry),
        (progress) => setStage({ kind: 'planning', progress }),
      );

      // Every chosen document, archived and pending ones too: the read gives each row its group's id.
      const toRead = chosen;
      const properties = new Map<string, PropertiesRead>();
      for (let i = 0; i < toRead.length; i += 4) {
        setStage({ kind: 'planning', progress: `Reading what holds each document… ${i} of ${toRead.length}` });
        await Promise.all(
          toRead.slice(i, i + 4).map(async (c) => {
            try {
              properties.set(c.entry.uniqueId.toLowerCase(), toDocumentProperties(await docs.properties(c.entry.documentId), c.entry.primaryGroupName));
            } catch (cause) {
              if (isSignedOut(cause)) throw cause;
              properties.set(c.entry.uniqueId.toLowerCase(), { error: errorMessage(cause) });
            }
          }),
        );
      }

      setStage({ kind: 'planning', progress: 'Reading the process lists…' });
      const index = await loadProcessIndex(gateway.processesList, {
        onProgress: (n) => setStage({ kind: 'planning', progress: `Reading the process lists… ${n} processes` }),
      });
      const active = [...index.values()].filter((p) => !p.isArchived).map((p) => ({ uniqueId: p.uniqueId, name: p.name }));
      const scan =
        chosen.every((c) => c.entry.isArchived || c.entry.isPending)
          ? { holders: [], unread: [], read: 0 }
          : await scanProcessesForDocuments(active, docs.readModel, {
              isFatal: isSignedOut,
              errorText: errorMessage,
              onProgress: (done, total) =>
                setStage({ kind: 'planning', progress: `Checking every active process for references, drafts included… ${done} of ${total}` }),
            });

      const plan = buildDocumentArchivePlan({ chosen, resolveSkipped: byId?.skipped ?? [], paths: merged, properties, scan, index });
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
    browse.refresh();
    setTreeDocs(null);
    setList(null);
    setListTicked(new Set());
    setIdInput(EMPTY_ID_INPUT);
    setSource('tree');
    setStage({ kind: 'select' });
  }

  const chosenCount = (treeChosen ? 1 : 0) + listTicked.size + ids.length;

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
            <div className="row" role="tablist">
              {(
                [
                  ['tree', `From the tree${treeChosen ? ' (some checked)' : ''}`],
                  ['list', `From the document list${listTicked.size > 0 ? ` (${listTicked.size})` : ''}`],
                  ['ids', `By id or CSV${ids.length > 0 ? ` (${ids.length})` : ''}`],
                ] as const
              ).map(([key, label]) => (
                <Button key={key} role="tab" aria-selected={source === key} buttonType={source === key ? 'primary' : 'secondary'} onClick={() => (key === 'list' ? void openList() : setSource(key))}>
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {source === 'tree' && (
            <>
              <div className="panel">
                <p>
                  Checking a group takes in the documents whose primary group is that group or one under it. Documents
                  that are only associated with a checked group are listed separately, for you to tick or not.
                </p>
              </div>
              <TreeBrowser state={browse} groupsOnly />
              {treeReading !== null && <Progress>{treeReading}</Progress>}
              {treeDocsCurrent !== null && (
                <TreeDocumentsPanel
                  read={treeDocsCurrent}
                  paths={paths}
                  onTick={(ticked) => setTreeDocs({ ...treeDocsCurrent, ticked })}
                />
              )}
            </>
          )}

          {source === 'list' && (
            <>
              {listReading !== null && <Progress>{listReading}</Progress>}
              {list !== null && <DocumentList entries={list} paths={paths} selected={listTicked} onChange={setListTicked} />}
            </>
          )}

          {source === 'ids' && <ProcessIdInput kind="document" value={idInput} onChange={setIdInput} />}

          <div className="row">
            <Button disabled={chosenCount === 0 || treeReading !== null} onClick={() => void buildPlan()}>
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

function TreeDocumentsPanel({
  read,
  paths,
  onTick,
}: {
  read: TreeDocuments;
  paths: ReadonlyMap<string, string[]>;
  onTick: (ticked: ReadonlySet<string>) => void;
}) {
  return (
    <div className="panel">
      <p>
        The checked groups hold {read.inSubtree.length} active document{read.inSubtree.length === 1 ? '' : 's'} as their
        primary group. These are included.
      </p>
      {read.associatedOnly.length > 0 && (
        <>
          <h3>Only associated with a checked group ({read.associatedOnly.length})</h3>
          <p className="small">
            Their primary group is elsewhere. They are not included unless you tick them, and archiving one archives it
            everywhere, not just in this group.
          </p>
          <ul className="checklist">
            {read.associatedOnly.map((e) => {
              const key = e.uniqueId.toLowerCase();
              return (
                <li key={e.uniqueId}>
                  <label className="inline">
                    <Checkbox
                      state={read.ticked.has(key) ? 'checked' : 'unchecked'}
                      label={`Include document ${e.name}`}
                      onChange={() => {
                        const next = new Set(read.ticked);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        onTick(next);
                      }}
                    />{' '}
                    {e.name} <span className="small">(primary group: {documentPath(e, paths).join(' / ') || 'unknown'})</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
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

      {incomplete && (
        <div className="panel error">
          <h2>Some processes could not be read</h2>
          <p>
            A reference in one of these processes&rsquo; drafts cannot be ruled out, so nothing is archived until every
            active process has been read.
          </p>
          <ul className="checklist">
            {plan.unreadProcesses.map((p) => (
              <li key={p.uniqueId}>
                {p.name}: {p.error}
              </li>
            ))}
          </ul>
          <Button onClick={props.onReplan}>Build the plan again</Button>
        </div>
      )}

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

      {plan.skipped.length > 0 && (
        <details className="panel" open={n === 0}>
          <summary>Left out ({plan.skipped.length})</summary>
          <ul className="checklist">
            {plan.skipped.map((row) => (
              <li key={`${row.operation}|${row.objectId}`}>
                {/* An id that matched nothing has no name; the id is what the operator can look for. */}
                {row.operation === 'Resolve' ? row.objectId : row.name}: {row.message}
              </li>
            ))}
          </ul>
        </details>
      )}

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
