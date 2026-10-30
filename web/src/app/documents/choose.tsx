'use client';

/**
 * Choosing documents, shared by the document pages (W8): from the tree's groups, from the
 * active document list, from the archived list, and by id or CSV. Each page names the
 * ways in it offers. They add up, each document once, as on the process pages.
 *
 * Also the plan's shared reads: each chosen document's properties, the process index, and
 * the scan of every active process's model for references, drafts included.
 */

import { Button } from '@exp-textura/react';
import { useState, type ReactNode } from 'react';

import type { PropertiesRead } from '@/lib/documents/archive.ts';
import { toDocumentProperties } from '@/lib/documents/holders.ts';
import { documentPath, loadDocumentIndex, loadDocumentList, type DocumentEntry } from '@/lib/documents/list.ts';
import { scanProcessesForDocuments, type ReferenceScan } from '@/lib/documents/references.ts';
import {
  CHOSEN_FROM_ARCHIVED,
  CHOSEN_FROM_LIST,
  CHOSEN_FROM_TREE,
  combineChosen,
  resolveDocumentIds,
  splitByPrimaryGroup,
  type ChosenDocument,
} from '@/lib/documents/select.ts';
import type { ResultRow } from '@/lib/exec/report.ts';
import { errorMessage } from '@/lib/exec/runner.ts';
import type { DocumentListType } from '@/lib/pm/documents.ts';
import { loadGroupPaths } from '@/lib/select/archived.ts';
import { chosenLabel, EMPTY_ID_INPUT, typedIds, type IdInput } from '@/lib/select/ids.ts';
import { loadForSelection, type CoveredGroup } from '@/lib/select/resolve.ts';
import { hasSelection, type Selection } from '@/lib/select/selection.ts';
import { loadProcessIndex, type ProcessIndex } from '@/lib/tenant/state.ts';
import { browserDocumentGateway, browserGateway, groupBreadcrumb, PmRequestError } from '@/lib/ui/gateway.ts';
import { Progress } from '../_ui/kit.tsx';
import { ArchivedDocumentList } from '../components/ArchivedDocumentList.tsx';
import { Checkbox } from '../components/Checkbox.tsx';
import { DocumentList } from '../components/DocumentList.tsx';
import { ProcessIdInput } from '../components/ProcessIdInput.tsx';
import { TreeBrowser, type BrowseState } from '../components/TreeBrowser.tsx';

export type DocumentSource = 'tree' | 'list' | 'archived' | 'ids';

export const isSignedOut = (e: unknown) => e instanceof PmRequestError && e.signedOut;

/** What the checked groups hold, read for the selection it was read for. */
interface TreeDocuments {
  selection: Selection;
  /** Every checked group and the groups under it, for the delete page's cleanup offer. */
  groups: CoveredGroup[];
  inSubtree: DocumentEntry[];
  associatedOnly: DocumentEntry[];
  /** Associated-only documents the operator ticked, lowercased ids. */
  ticked: ReadonlySet<string>;
}

export interface Collected {
  chosen: ChosenDocument[];
  resolveSkipped: ResultRow[];
  paths: Map<string, string[]>;
  /** The checked groups, when the tree was used; empty otherwise. */
  groups: CoveredGroup[];
}

type Docs = ReturnType<typeof browserDocumentGateway>;

export function useDocumentChoice(options: {
  docs: Docs;
  browse: BrowseState;
  sources: readonly DocumentSource[];
  /** The lists a checked group is read from: active only to archive, both to delete. */
  treeLists?: readonly DocumentListType[];
  /** Shown by the tree tab, above the tree. */
  treeNote?: ReactNode;
  onError: (cause: unknown) => void;
}) {
  const { docs, browse, sources } = options;
  const treeLists = options.treeLists ?? ['All'];
  const [source, setSource] = useState<DocumentSource>(sources[0]!);
  const [treeDocs, setTreeDocs] = useState<TreeDocuments | null>(null);
  const [treeReading, setTreeReading] = useState<string | null>(null);
  const [lists, setLists] = useState<Partial<Record<DocumentListType, DocumentEntry[]>>>({});
  const [listReading, setListReading] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Record<DocumentListType, ReadonlySet<string>>>({ All: new Set(), Archived: new Set() });
  const [idInput, setIdInput] = useState<IdInput>(EMPTY_ID_INPUT);
  const [paths, setPaths] = useState<ReadonlyMap<string, string[]>>(new Map());

  const ids = typedIds(idInput.text);
  const treeChosen = sources.includes('tree') && hasSelection(browse.selection);
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
      const loaded = await loadForSelection(browserGateway(), browse.tree, browse.selection, {
        onProgress: (n) => setTreeReading(`Reading the checked groups… ${n} read`),
      });
      browse.setTree(loaded.tree);
      const covered = new Set(loaded.resolution.groups.map((g) => g.uniqueId.toLowerCase()));
      // The tenant's group filter takes in the subgroups (spike), so only the topmost checked groups are listed.
      const tops = loaded.resolution.groups.filter((g) => g.parentUniqueId === null || !covered.has(g.parentUniqueId.toLowerCase()));
      const listed = new Map<string, DocumentEntry>();
      for (const [i, group] of tops.entries()) {
        setTreeReading(`Listing documents in ${group.title} (${i + 1} of ${tops.length})…`);
        for (const listType of treeLists) {
          for (const entry of await loadDocumentList(docs.list, listType, group.uniqueId)) listed.set(entry.uniqueId.toLowerCase(), entry);
        }
      }
      const split = splitByPrimaryGroup([...listed.values()], covered);
      await addPaths(split.associatedOnly, setTreeReading);
      const read = { selection: browse.selection, groups: loaded.resolution.groups, ...split, ticked: new Set<string>() };
      setTreeDocs(read);
      return read;
    } finally {
      setTreeReading(null);
    }
  }

  /** A list tab reads its list when first opened, and again after a failed read. */
  async function openList(tab: 'list' | 'archived') {
    setSource(tab);
    const listType: DocumentListType = tab === 'list' ? 'All' : 'Archived';
    if (lists[listType] !== undefined || listReading !== null) return;
    const what = tab === 'list' ? 'the document list' : 'the archived document list';
    setListReading(`Reading ${what}…`);
    try {
      const entries = await loadDocumentList(docs.list, listType, null, (n) => setListReading(`Reading ${what}… ${n} read`));
      await addPaths(entries, setListReading);
      setLists((current) => ({ ...current, [listType]: entries }));
    } catch (cause) {
      options.onError(cause);
    } finally {
      setListReading(null);
    }
  }

  /**
   * Everything chosen, read fresh against both lists. Null when the operator has
   * associated-only documents to decide about first, or when nothing was chosen (the
   * reason is in `empty`).
   */
  async function collect(progress: (text: string) => void): Promise<Collected | { empty: string } | null> {
    let fromTree = treeDocsCurrent;
    if (treeChosen && fromTree === null) {
      fromTree = await readTreeDocuments();
      if (fromTree.associatedOnly.length > 0) {
        // The operator decides about these before anything is planned.
        setSource('tree');
        return null;
      }
    }

    progress('Reading the document lists…');
    const docIndex = await loadDocumentIndex(docs.list, (n) => progress(`Reading the document lists… ${n} read`));
    const fresh = (e: DocumentEntry) => docIndex.get(e.uniqueId.toLowerCase()) ?? e;

    const tree: ChosenDocument[] = fromTree
      ? [...fromTree.inSubtree, ...fromTree.associatedOnly.filter((e) => fromTree.ticked.has(e.uniqueId.toLowerCase()))].map((e) => ({
          entry: fresh(e),
          chosen: CHOSEN_FROM_TREE,
        }))
      : [];
    const fromList = (listType: DocumentListType, chosen: string): ChosenDocument[] =>
      (lists[listType] ?? []).filter((e) => ticked[listType].has(e.uniqueId.toLowerCase())).map((e) => ({ entry: fresh(e), chosen }));
    const picked = [...fromList('All', CHOSEN_FROM_LIST), ...fromList('Archived', CHOSEN_FROM_ARCHIVED)];
    const byId = ids.length > 0 ? resolveDocumentIds(ids, docIndex, (v) => chosenLabel(idInput, v)) : null;
    if (byId && byId.chosen.length === 0 && tree.length === 0 && picked.length === 0) {
      return { empty: `None of the ids matched a document: ${byId.unknown.join(', ')}` };
    }
    const chosen = combineChosen(tree, picked, byId?.chosen ?? []);
    if (chosen.length === 0) {
      return { empty: treeLists.includes('Archived') ? 'The checked groups hold no documents.' : 'The checked groups hold no active documents.' };
    }
    const merged = await addPaths(
      chosen.map((c) => c.entry),
      progress,
    );
    return { chosen, resolveSkipped: byId?.skipped ?? [], paths: merged, groups: fromTree?.groups ?? [] };
  }

  function reset() {
    browse.refresh();
    setTreeDocs(null);
    setLists({});
    setTicked({ All: new Set(), Archived: new Set() });
    setIdInput(EMPTY_ID_INPUT);
    setSource(sources[0]!);
  }

  const count = (treeChosen ? 1 : 0) + ticked.All.size + ticked.Archived.size + ids.length;

  const labels: Record<DocumentSource, string> = {
    tree: `From the tree${treeChosen ? ' (some checked)' : ''}`,
    list: `From the document list${ticked.All.size > 0 ? ` (${ticked.All.size})` : ''}`,
    archived: `From the archived list${ticked.Archived.size > 0 ? ` (${ticked.Archived.size})` : ''}`,
    ids: `By id or CSV${ids.length > 0 ? ` (${ids.length})` : ''}`,
  };

  const tabs = (
    <div className="row" role="tablist">
      {sources.map((key) => (
        <Button
          key={key}
          role="tab"
          aria-selected={source === key}
          buttonType={source === key ? 'primary' : 'secondary'}
          onClick={() => (key === 'list' || key === 'archived' ? void openList(key) : setSource(key))}
        >
          {labels[key]}
        </Button>
      ))}
    </div>
  );

  const body = (
    <>
      {source === 'tree' && (
        <>
          <div className="panel">
            <p>{options.treeNote}</p>
          </div>
          <TreeBrowser state={browse} groupsOnly />
          {treeReading !== null && <Progress>{treeReading}</Progress>}
          {treeDocsCurrent !== null && (
            <TreeDocumentsPanel
              read={treeDocsCurrent}
              paths={paths}
              withArchived={treeLists.includes('Archived')}
              onTick={(next) => setTreeDocs({ ...treeDocsCurrent, ticked: next })}
            />
          )}
        </>
      )}

      {(source === 'list' || source === 'archived') && listReading !== null && <Progress>{listReading}</Progress>}
      {source === 'list' && lists.All !== undefined && (
        <DocumentList entries={lists.All} paths={paths} selected={ticked.All} onChange={(next) => setTicked((t) => ({ ...t, All: next }))} />
      )}
      {source === 'archived' && lists.Archived !== undefined && (
        <ArchivedDocumentList
          entries={lists.Archived}
          paths={paths}
          selected={ticked.Archived}
          onChange={(next) => setTicked((t) => ({ ...t, Archived: next }))}
        />
      )}

      {source === 'ids' && <ProcessIdInput kind="document" value={idInput} onChange={setIdInput} />}
    </>
  );

  return { tabs, body, collect, reset, count, busy: treeReading !== null };
}

function TreeDocumentsPanel({
  read,
  paths,
  withArchived,
  onTick,
}: {
  read: TreeDocuments;
  paths: ReadonlyMap<string, string[]>;
  withArchived: boolean;
  onTick: (ticked: ReadonlySet<string>) => void;
}) {
  const n = read.inSubtree.length;
  const archived = read.inSubtree.filter((e) => e.isArchived).length;
  return (
    <div className="panel">
      <p>
        {withArchived
          ? `The checked groups hold ${n} document${n === 1 ? '' : 's'} as their primary group (${archived} archived). These are included.`
          : `The checked groups hold ${n} active document${n === 1 ? '' : 's'} as their primary group. These are included.`}
      </p>
      {read.associatedOnly.length > 0 && (
        <>
          <h3>Only associated with a checked group ({read.associatedOnly.length})</h3>
          <p className="small">
            Their primary group is elsewhere. They are not included unless you tick them, and acting on one acts on it
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
                    {e.name}
                    {e.isArchived && ' (archived)'}{' '}
                    <span className="small">(primary group: {documentPath(e, paths).join(' / ') || 'unknown'})</span>
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

/**
 * Each chosen document's properties, a few at a time, and, when any of them could be
 * acted on, the process index and the scan of every active process's model for
 * references, drafts included (W8 decision 1).
 */
export async function readWhatHolds(
  docs: Docs,
  chosen: readonly ChosenDocument[],
  progress: (text: string) => void,
  scanFor: (c: ChosenDocument) => boolean,
): Promise<{ properties: Map<string, PropertiesRead>; index: ProcessIndex; scan: ReferenceScan }> {
  const properties = new Map<string, PropertiesRead>();
  for (let i = 0; i < chosen.length; i += 4) {
    progress(`Reading what holds each document… ${i} of ${chosen.length}`);
    await Promise.all(
      chosen.slice(i, i + 4).map(async (c) => {
        try {
          properties.set(c.entry.uniqueId.toLowerCase(), toDocumentProperties(await docs.properties(c.entry.documentId), c.entry.primaryGroupName));
        } catch (cause) {
          if (isSignedOut(cause)) throw cause;
          properties.set(c.entry.uniqueId.toLowerCase(), { error: errorMessage(cause) });
        }
      }),
    );
  }

  progress('Reading the process lists…');
  const index = await loadProcessIndex(browserGateway().processesList, {
    onProgress: (n) => progress(`Reading the process lists… ${n} processes`),
  });
  const active = [...index.values()].filter((p) => !p.isArchived).map((p) => ({ uniqueId: p.uniqueId, name: p.name }));
  const scan = !chosen.some(scanFor)
    ? { holders: [], unread: [], read: 0 }
    : await scanProcessesForDocuments(active, docs.readModel, {
        isFatal: isSignedOut,
        errorText: errorMessage,
        onProgress: (done, total) => progress(`Checking every active process for references, drafts included… ${done} of ${total}`),
      });
  return { properties, index, scan };
}

/** The plan's list of left-out rows, shared by the document pages. */
export function LeftOut({ rows, open }: { rows: readonly ResultRow[]; open: boolean }) {
  if (rows.length === 0) return null;
  return (
    <details className="panel" open={open}>
      <summary>Left out ({rows.length})</summary>
      <ul className="checklist">
        {rows.map((row) => (
          <li key={`${row.operation}|${row.objectId}`}>
            {/* An id that matched nothing has no name; the id is what the operator can look for. */}
            {row.operation === 'Resolve' ? row.objectId : row.name}: {row.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The panel a plan shows when some process models could not be read. */
export function UnreadProcesses({ unread, verb, onReplan }: { unread: ReferenceScan['unread']; verb: string; onReplan: () => void }) {
  if (unread.length === 0) return null;
  return (
    <div className="panel error">
      <h2>Some processes could not be read</h2>
      <p>
        A reference in one of these processes&rsquo; drafts cannot be ruled out, so nothing is {verb} until every active
        process has been read.
      </p>
      <ul className="checklist">
        {unread.map((p) => (
          <li key={p.uniqueId}>
            {p.name}: {p.error}
          </li>
        ))}
      </ul>
      <Button onClick={onReplan}>Build the plan again</Button>
    </div>
  );
}
