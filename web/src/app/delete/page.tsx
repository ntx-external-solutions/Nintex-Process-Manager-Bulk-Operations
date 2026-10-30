'use client';

/**
 * Bulk Delete: choose, build the plan (a dry run), run it, then optionally delete the
 * groups it emptied (W6).
 *
 * Three ways in, which add up: the tree (whole groups or processes), the archived view,
 * and a list of ids. A checked group means every process under it and every archived
 * process whose group is under it, which the tree never shows; active ones are archived
 * first, so the preview shows the two phases apart (lib/delete/selection.ts).
 *
 * The dry run builds the plan the way the script's preview does, reading and never
 * writing. The run then does everything the script's Mode 5 does, building its own plan
 * again with the archive restored, and asks each of the script's questions on screen: a
 * question nobody answers is a no, and every no puts back what the run un-archived. The
 * plan is kept in this browser as the run goes, so a run that dies (a session that ends
 * mid-way) can be finished from it after signing in again, or from a downloaded copy.
 *
 * A variation set is deleted whole or not at all: a target whose set is only partly
 * selected is left out unless the operator ticks the set in (R3). Before the run, the
 * levels the plan touches are read again (plan/revalidate.ts), as Archive and Move do.
 *
 * After a run that finished, the groups checked in the tree that it deleted something
 * from are offered for deletion, deepest first, through Archive's group cleanup as it is
 * (W2b): a document keeps a group (spike S1), and a group still holding archived
 * processes, targets the run held back for example, is offered with each one named.
 */

import { Button, Input } from '@exp-textura/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { targetsInVariationSets, variationMessage, type VariationMatch } from '@/lib/archive/plan.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { errorMessage } from '@/lib/exec/runner.ts';
import { deleteConfirmationLines, deleteResultsSummary, resumeUnwind, runBulkDelete, type DeleteDecisions } from '@/lib/delete/bulkDelete.ts';
import type { Reconciliation } from '@/lib/delete/claims.ts';
import { COLLATERAL_NOTES, collateralEntries, type CollateralChange, variationWarningLines } from '@/lib/delete/collateral.ts';
import type { DeleteEvent, DeleteStage } from '@/lib/delete/events.ts';
import { REFERENCE_REMOVAL_DESCRIPTION } from '@/lib/delete/executor.ts';
import { confirmArchivedOrphans, findOrphanedGroupProcesses, groupExistsCoverage, groupExistsCoverageLines, type ArchivedOrphanCheck, type ModelGroup } from '@/lib/delete/groups.ts';
import { orphanedTargetWarningLines } from '@/lib/delete/holdingGroup.ts';
import { parsePlan, serializePlan, type DependencyPlan, type DraftHolder } from '@/lib/delete/ledger.ts';
import type { DeleteIndex } from '@/lib/delete/model.ts';
import { buildDeletePlan, loadDeleteIndex, planSummaryLines } from '@/lib/delete/planner.ts';
import {
  applyVariationSets,
  deletePlacements,
  deleteVariations,
  groupsTheRunDeletedFrom,
  previewHolders,
  resolveDeleteSelection,
  selectionIds,
  selectionSummary,
  type DeleteSelection,
  type DeleteTarget,
  type VariationSetReview,
} from '@/lib/delete/selection.ts';
import type { VariationSet } from '@/lib/pm/processes.ts';
import { groupArchived, groupsNeedingPaths, loadArchived, loadGroupPaths, type ArchivedView as ArchivedViewData } from '@/lib/select/archived.ts';
import { EMPTY_ID_INPUT, typedIds as readTypedIds, type IdInput } from '@/lib/select/ids.ts';
import { loadForSelection, type CoveredGroup } from '@/lib/select/resolve.ts';
import { revalidatePlacements, type StaleFinding } from '@/lib/plan/revalidate.ts';
import { hasSelection } from '@/lib/select/selection.ts';
import { loadProcessIndex, type ProcessIndex } from '@/lib/tenant/state.ts';
import { datedFilename, downloadCsv, downloadText } from '@/lib/ui/download.ts';
import { browserDeleteGateway, browserGateway, browserPlanningGateway, groupBreadcrumb, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { browserPlanStore, planNeedsFinishing } from '@/lib/ui/planStore.ts';
import { ArchivedView } from '../components/ArchivedView.tsx';
import { CleanupPanel } from '../components/CleanupPanel.tsx';
import { ResultsSummary } from '../components/ResultsSummary.tsx';
import { SessionGate } from '../components/SessionGate.tsx';
import { ProcessIdInput } from '../components/ProcessIdInput.tsx';
import { TreeBrowser, useBrowseTree } from '../components/TreeBrowser.tsx';
import { Notice, valueOf } from '../_ui/kit.tsx';

const RESULT_STATUSES = ['Success', 'Skipped', 'Failed', 'Accepted', 'Warning', 'Blocked', 'Orphaned'] as const;

type Question =
  | { kind: 'yesno'; title: string; lines: string[]; yes: string; no: string; resolve: (answer: boolean) => void }
  | { kind: 'collateral'; phase: string; collateral: readonly CollateralChange[]; resolve: (answer: boolean) => void }
  | { kind: 'drafts'; holders: readonly DraftHolder[]; resolve: (ids: string[]) => void };

type Source = 'tree' | 'archived' | 'ids';

interface Preview {
  plan: DependencyPlan;
  index: DeleteIndex;
  selection: DeleteSelection;
  variations: VariationMatch[];
  unreadSets: Array<{ uniqueId: string; name: string; error: string }>;
  /** Every variation set a tree target is in, each sibling named. */
  sets: VariationSetReview[];
  /** Partial sets the operator ticked in whole. */
  include: ReadonlySet<number>;
  /** `GroupCheck` rows for the targets the archived view's model check placed. */
  groupChecks: ResultRow[];
  seconds: number;
}

/** What the done screen needs to offer the group cleanup, or why it can't. */
type CleanupOffer =
  | { kind: 'none' }
  | { kind: 'offer'; groups: CoveredGroup[]; after: ProcessIndex }
  | { kind: 'withheld'; groups: CoveredGroup[]; reason: string };

type Stage =
  | { kind: 'input' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; preview: Preview; stale: StaleFinding[] }
  | { kind: 'running'; log: string[]; progress: string }
  | { kind: 'done'; rows: ResultRow[]; plan: DependencyPlan | null; log: string[]; title: string; cleanup: CleanupOffer };

const STAGE_TEXT: Record<DeleteStage, string> = {
  gathering: 'Reading both process lists',
  snapshot: 'Recording where every target is before anything moves',
  'holding-group': 'Making the holding group and restoring archived targets into it',
  'checking-collateral': 'Checking the tenant for processes that changed without being targets',
  'building-plan': 'Building the plan, with the archive restored',
  'removing-references': 'Checking each holder for open drafts, then removing references from the processes that hold them',
  verifying: 'Reading each edited process back to check nothing is left',
  'archiving-targets': 'Archiving the active targets before deleting them',
  'deleting-targets': 'Deleting the targets',
  'checking-collateral-after-delete': 'Checking the tenant again after the deletes',
  'returning-processes': 'Returning what the run restored to its own group, archived',
  'reversing-collateral': 'Putting back processes that changed without being targets',
  cleanup: 'Removing the holding group',
  rechecking: 'Re-checking what still needs attention against a fresh read',
};

const SOURCE_TEXT: Record<DeleteTarget['source'], string> = {
  tree: 'Picked in the tree',
  group: 'Archived in a checked group',
  archived: 'Picked in the archived list',
  ids: 'By id',
  variation: 'Its variation set ticked in whole',
};

export default function DeletePage() {
  return (
    <SessionGate title="Bulk Delete">
      {(session, onSignedOut) => <DeleteFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function DeleteFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const reads = useMemo(() => browserGateway(), []);
  const planning = useMemo(() => browserPlanningGateway(), []);
  const gateway = useMemo(() => browserDeleteGateway(), []);
  const store = useMemo(() => browserPlanStore(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof PmRequestError && error.signedOut) onSignedOut();
    },
    [onSignedOut],
  );
  const browse = useBrowseTree(reads, handleError);

  const [stage, setStage] = useState<Stage>({ kind: 'input' });
  const [source, setSource] = useState<Source>('tree');
  const [archived, setArchived] = useState<ArchivedViewData | null>(null);
  const [archivedNote, setArchivedNote] = useState<string | null>(null);
  const [orphanCheck, setOrphanCheck] = useState<ArchivedOrphanCheck | null>(null);
  const [archivedPicked, setArchivedPicked] = useState<ReadonlySet<string>>(new Set());
  const [idInput, setIdInput] = useState<IdInput>(EMPTY_ID_INPUT);
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

  // The archived list is read the first time it is opened, not on every visit.
  const archivedRequested = useRef(false);
  async function openArchived() {
    setSource('archived');
    if (archivedRequested.current) return;
    archivedRequested.current = true;
    try {
      setArchivedNote('Reading the archived list…');
      const processes = await loadArchived(reads.processesList, {
        onPage: (loaded, total) => setArchivedNote(`Reading the archived list… ${loaded} of ${total}`),
      });
      const isFatal = (e: unknown) => (e instanceof PmRequestError && e.signedOut ? 'signed out' : null);
      // R13: groupExists: false can be wrong, so each one is checked against its model's
      // group and the tree before it is labelled orphaned (the F6 check).
      setArchivedNote('Checking the processes listed as having no group…');
      const check = await confirmArchivedOrphans(planning, processes, isFatal);
      setArchivedNote('Reading group paths…');
      const paths = await loadGroupPaths(groupsNeedingPaths(check.processes), groupBreadcrumb, { isFatal });
      setOrphanCheck(check);
      setArchived(groupArchived(check.processes, (id) => paths.get(id) ?? null));
      setArchivedNote(null);
    } catch (cause) {
      handleError(cause);
      archivedRequested.current = false;
      setArchivedNote(`Could not read the archived list: ${errorMessage(cause)}. Open it again to retry.`);
    }
  }

  const typedIds = readTypedIds(idInput.text);
  const treeChosen = hasSelection(browse.selection);
  const anything = treeChosen || archivedPicked.size > 0 || typedIds.length > 0;

  async function dryRun(include: ReadonlySet<number> = new Set()) {
    setError(null);
    const started = Date.now();
    const onEvent = (event: DeleteEvent) => {
      if (event.kind === 'progress') setStage({ kind: 'planning', progress: `${event.label}: ${event.done} of ${event.total}` });
    };
    try {
      let tree = null;
      if (treeChosen) {
        setStage({ kind: 'planning', progress: 'Reading the checked groups…' });
        const loaded = await loadForSelection(reads, browse.tree, browse.selection, {
          onProgress: (n) => setStage({ kind: 'planning', progress: `Reading the checked groups… ${n} read` }),
        });
        browse.setTree(loaded.tree);
        tree = loaded.resolution;
      }
      setStage({ kind: 'planning', progress: 'Reading both process lists…' });
      const index = await loadDeleteIndex(planning, {
        onProgress: (loaded) => setStage({ kind: 'planning', progress: `Reading both process lists: ${loaded} so far` }),
      });
      const paths = new Map<string, string>();
      for (const bucket of archived?.buckets ?? []) if (bucket.groupExists) paths.set(bucket.key.toLowerCase(), bucket.label);
      const corrections = new Map<string, ModelGroup>((orphanCheck?.corrections ?? []).map((c) => [c.uniqueId.toLowerCase(), c.group]));
      const chosen = resolveDeleteSelection({ tree, archived: archivedPicked, ids: typedIds, index, groupPath: (g) => paths.get(g.toLowerCase()) ?? null, corrections });
      if (chosen.targets.length === 0) {
        const unknown = chosen.skipped.filter((r) => r.operation === 'Resolve').map((r) => r.objectId);
        setError(unknown.length > 0 ? `None of the ids matched a process: ${unknown.join(', ')}` : 'Nothing selected resolves to a process to delete.');
        setStage({ kind: 'input' });
        return;
      }

      // Siblings are not in the tree, so each variation's set is read from the process.
      const sets = new Map<string, VariationSet>();
      const unreadSets: Preview['unreadSets'] = [];
      const inSets = targetsInVariationSets(tree?.processes ?? []);
      for (const [i, uniqueId] of inSets.entries()) {
        setStage({ kind: 'planning', progress: `Reading variation sets… ${i + 1} of ${inSets.length}` });
        try {
          const set = await reads.variationSet(uniqueId);
          if (set) sets.set(uniqueId.toLowerCase(), set);
        } catch (cause) {
          if (cause instanceof PmRequestError && cause.signedOut) throw cause;
          unreadSets.push({ uniqueId, name: index.get(uniqueId.toLowerCase())?.name ?? uniqueId, error: errorMessage(cause) });
        }
      }

      // A set is deleted whole or not at all (R3): a partial one is left out unless ticked.
      const { selection, reviews } = applyVariationSets(chosen, index, sets, include);
      if (selection.targets.length === 0) {
        setError('Every selected process is a variation whose set is not wholly selected, so nothing is left to delete. Select the whole set, or build the plan again and tick it in.');
        setStage({ kind: 'input' });
        return;
      }

      const plan = await buildDeletePlan(planning, {
        siteUrl: session.siteUrl,
        targetUniqueIds: selectionIds(selection),
        index,
        allowRestore: false,
        holdingGroupId: null,
        scanActiveForInputOutput: thorough,
        onEvent,
      });
      const placed = new Set(selection.targets.map((t) => t.uniqueId.toLowerCase()));
      setStage({
        kind: 'plan',
        stale: [],
        preview: {
          plan,
          index,
          selection,
          variations: deleteVariations(index, selection.targets, sets),
          unreadSets,
          sets: reviews,
          include,
          groupChecks: (orphanCheck?.rows ?? []).filter((r) => placed.has(r.objectId.toLowerCase())),
          seconds: Math.round((Date.now() - started) / 1000),
        },
      });
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
  async function withLog(
    title: string,
    work: (onEvent: (event: DeleteEvent) => void) => Promise<{ results: ResultRow[]; plan: DependencyPlan | null; cleanup?: CleanupOffer }>,
  ) {
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
      setStage({ kind: 'done', rows: run.results, plan: run.plan, log, title, cleanup: run.cleanup ?? { kind: 'none' } });
    } catch (cause) {
      handleError(cause);
      const saved = await store.load().catch(() => null);
      setUnfinished(planNeedsFinishing(saved) ? saved : null);
      setError(
        `${errorMessage(cause)} The run stopped here. Its plan is saved in this browser: sign in again if asked, then use "Finish it" at the top of this page to put back what it un-archived.`,
      );
      setStage({ kind: 'done', rows: [], plan: saved, log, title: 'The run did not finish', cleanup: { kind: 'none' } });
    }
  }

  async function runDelete(preview: Preview, options: RunOptions) {
    const { index, selection } = preview;
    // Read the levels the plan touches again before the first write, as Archive and Move
    // do: a plan built from a cached tree does not authorise writing from one.
    setStage({ kind: 'running', log: [], progress: 'Checking the plan against the tenant…' });
    try {
      const stale = await revalidatePlacements(reads, deletePlacements(selection));
      if (stale.length > 0) {
        setStage({ kind: 'plan', preview, stale });
        return;
      }
    } catch (cause) {
      handleError(cause);
      setError(errorMessage(cause));
      setStage({ kind: 'plan', preview, stale: [] });
      return;
    }
    const nameOf = (id: string) => index.get(id.toLowerCase())?.name || id;
    const pairLines = (rows: readonly Reconciliation[]) =>
      rows.map((r) => `${nameOf(r.queriedUniqueId)} -> ${nameOf(r.relatedUniqueId)}: ${r.category}, claimed ${r.claimed}, located ${r.located}. ${r.note}`);
    const decisions: DeleteDecisions = {
      collateral: (collateral, phase) => new Promise<boolean>((resolve) => setQuestion({ kind: 'collateral', phase, collateral, resolve })),
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
      // Names what goes, what stays and why, and which drafts go live (F6, after R13).
      confirmDelete: (c) =>
        askYesNo('Permanent deletion', deleteConfirmationLines(c), `Delete ${c.deleting.length} process(es)`, 'Cancel and put things back'),
    };
    await withLog('Delete finished', async (onEvent) => {
      const run = await runBulkDelete(gateway, {
        siteUrl: session.siteUrl,
        source: { kind: 'ids', ids: selectionIds(selection) },
        planStore: store,
        thoroughScan: thorough,
        approvalsEnabled: options.approvalsEnabled,
        // Never in advance from here: the gate is the on-screen table that names each
        // process before it is accepted (W6).
        acceptCollateral: false,
        allowUnheldTargets: options.allowUnheldTargets,
        changeDescription: options.changeDescription.trim() || REFERENCE_REMOVAL_DESCRIPTION,
        decisions,
        onEvent,
      });
      // What was selected and left out, then what the run did: every row in one file.
      return { results: [...preview.groupChecks, ...selection.skipped, ...run.results], plan: run.plan, cleanup: await cleanupOffer(selection, run.results, run.plan) };
    });
  }

  /**
   * The groups the finished run may offer, read against a fresh listing. Only a run that
   * completed: one that stopped has put things back, and its groups are as they were.
   */
  async function cleanupOffer(selection: DeleteSelection, rows: readonly ResultRow[], plan: DependencyPlan | null): Promise<CleanupOffer> {
    const deleted = rows.filter((r) => r.operation === 'Delete' && r.status === 'Success').map((r) => r.objectId);
    const groups = groupsTheRunDeletedFrom(selection, deleted, plan?.holdingGroup?.uniqueId ?? null);
    if (groups.length === 0) return { kind: 'none' };
    if (plan?.status !== 'Completed') return { kind: 'withheld', groups, reason: 'the run did not complete' };
    try {
      return { kind: 'offer', groups, after: await loadProcessIndex(reads.processesList) };
    } catch (cause) {
      // Not handleError: a dead session here must not swap the page for the sign-in
      // prompt, or the rows for everything this run already changed would be lost.
      return { kind: 'withheld', groups, reason: `the process lists could not be read again (${errorMessage(cause)})` };
    }
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

  function startOver() {
    browse.refresh();
    archivedRequested.current = false;
    setArchived(null);
    setArchivedNote(null);
    setOrphanCheck(null);
    setArchivedPicked(new Set());
    setIdInput(EMPTY_ID_INPUT);
    setSource('tree');
    setStage({ kind: 'input' });
  }

  const answer = (value: boolean | string[]) => {
    const q = question;
    setQuestion(null);
    if (q?.kind === 'yesno' || q?.kind === 'collateral') q.resolve(value === true);
    if (q?.kind === 'drafts') q.resolve(Array.isArray(value) ? value : []);
  };

  const busy = stage.kind === 'running' || stage.kind === 'planning';

  return (
    <>
      {unfinished !== null && !busy && (
        <div className="panel warning">
          <h2>An earlier run did not finish</h2>
          <p>
            Its plan, from {unfinished.createdUtc}, says it un-archived processes it has not put back, or left its holding
            group in place. Finishing returns each one to its own group, archived, and removes the holding group if it is empty.
          </p>
          <div className="row">
            <Button onClick={() => void finish(unfinished)}>
              Finish it
            </Button>
            <Button buttonType="secondary" onClick={() => downloadText(datedFilename('delete-plan', 'json'), serializePlan(unfinished), 'application/json')}>
              Download its plan
            </Button>
          </div>
        </div>
      )}

      {error !== null && (
        <Notice tone="critical" title="Problem">
          {error}
        </Notice>
      )}

      {question !== null && (
        // Keyed, so one question's ticks never carry over to the next.
        <QuestionPanel
          key={question.kind === 'yesno' ? `q|${question.title}|${question.lines.length}` : question.kind === 'collateral' ? `c|${question.phase}` : 'drafts'}
          question={question}
          onAnswer={answer}
        />
      )}

      {stage.kind === 'input' && (
        <>
          <div className="panel">
            <h2>1. Choose what to delete</h2>
            <p>
              Pick from the tree, from the archived list, or by id; the three add up. Checking a group means every process
              under it, including subgroups you have not opened, and every archived process whose group is under it. Active
              processes are archived first, then deleted. Nothing changes until you run the delete.
            </p>
            <div className="row" role="tablist">
              {(
                [
                  ['tree', `From the tree${treeChosen ? ' (some checked)' : ''}`],
                  ['archived', `From the archived list${archivedPicked.size > 0 ? ` (${archivedPicked.size})` : ''}`],
                  ['ids', `By id or CSV${typedIds.length > 0 ? ` (${typedIds.length})` : ''}`],
                ] as const
              ).map(([key, label]) => (
                <Button key={key} role="tab" aria-selected={source === key} buttonType={source === key ? 'primary' : 'secondary'} onClick={() => (key === 'archived' ? void openArchived() : setSource(key))}>
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {source === 'tree' && <TreeBrowser state={browse} />}

          {source === 'archived' && (
            <>
              {archivedNote !== null && <p className="pending">{archivedNote}</p>}
              {orphanCheck !== null && (orphanCheck.corrections.length > 0 || orphanCheck.unchecked > 0) && (
                <div className="panel warning">
                  {orphanCheck.corrections.length > 0 && (
                    <>
                      <p>
                        The listing says these processes have no group, but each one&rsquo;s model names a group that is in the
                        tree, so they are listed under that group instead:
                      </p>
                      <ul className="checklist">
                        {orphanCheck.corrections.map((c) => (
                          <li key={c.uniqueId}>
                            {c.name || c.uniqueId}: listed as group {c.listedGroupId ?? 'unknown'}, model names {c.group.name ? `'${c.group.name}'` : `group ${c.group.id ?? 'unknown'}`}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {orphanCheck.unchecked > 0 && (
                    <p className="small">
                      {orphanCheck.unchecked} process(es) listed as having no group could not be checked against the tree, so they
                      stay in that bucket as the listing says.
                    </p>
                  )}
                </div>
              )}
              {archived !== null && <ArchivedView view={archived} selected={archivedPicked} onChange={setArchivedPicked} />}
            </>
          )}

          {source === 'ids' && <ProcessIdInput value={idInput} onChange={setIdInput} />}

          <div className="panel">
            <label className="checkbox">
              <input type="checkbox" checked={thorough} onChange={(e) => setThorough(e.target.checked)} />
              <span>
                Also scan active processes for Input/Output references
                <span className="detail">Slow: one read per active process. The script&rsquo;s thorough scan.</span>
              </span>
            </label>
            <div className="row">
              <Button disabled={!anything} onClick={() => void dryRun(new Set())}>
                Build the plan (dry run)
              </Button>
            </div>
            <label htmlFor="plan-file">Or finish an interrupted run from a downloaded plan</label>
            <input id="plan-file" type="file" accept=".json,application/json" onChange={(e) => void uploadPlan(e.target.files?.[0])} />
          </div>
        </>
      )}

      {stage.kind === 'planning' && <p className="pending">{stage.progress}</p>}

      {stage.kind === 'plan' && (
        <PlanView
          preview={stage.preview}
          stale={stage.stale}
          finishFirst={unfinished !== null}
          onBack={() => setStage({ kind: 'input' })}
          onReplan={(include) => void dryRun(include)}
          onRun={(options) => void runDelete(stage.preview, options)}
        />
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
                    <Button
                      buttonType="secondary"
                      onClick={() => downloadText(datedFilename('delete-plan', 'json'), serializePlan(stage.plan!), 'application/json')}
                    >
                      Download the plan
                    </Button>
                  )}
                  <Button buttonType="secondary" onClick={startOver}>
                    Delete something else
                  </Button>
                </>
              }
            />
          )}
          <div className="panel">
            <h2>{stage.title}</h2>
            <pre className="plan-text">{[...deleteResultsSummary(stage.rows).lines, '', ...stage.log].join('\n')}</pre>
            {stage.rows.length === 0 && (
              <div className="row">
                <Button buttonType="secondary" onClick={() => downloadCsv(datedFilename('delete-results'), resultsToCsv(stage.rows))}>
                  Download the results
                </Button>
                <Button buttonType="secondary" onClick={startOver}>
                  Start again
                </Button>
              </div>
            )}
          </div>
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
                  The run deleted processes from {stage.cleanup.groups.length} checked group{stage.cleanup.groups.length === 1 ? '' : 's'}.
                  This checks which of them the run left with no active process, no document, and no subgroup that is kept. A
                  group still holding archived processes, targets the run held back for example, can still be deleted, and each
                  one it would leave with no group is named first. Only groups you checked in the tree are offered, and never the
                  holding group. Nothing is deleted until you confirm.
                </>
              }
            />
          )}
          {stage.cleanup.kind === 'withheld' && (
            <div className="panel">
              <h2>4. Delete the groups this emptied</h2>
              <p>
                Not offered for the {stage.cleanup.groups.length} checked group{stage.cleanup.groups.length === 1 ? '' : 's'} the run
                deleted from, because {stage.cleanup.reason}. Build the plan again to get a confirmed result first.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

function PlanView({
  preview,
  stale,
  finishFirst,
  onBack,
  onReplan,
  onRun,
}: {
  preview: Preview;
  stale: readonly StaleFinding[];
  finishFirst: boolean;
  onBack: () => void;
  onReplan: (include: ReadonlySet<number>) => void;
  onRun: (options: RunOptions) => void;
}) {
  const { plan, selection, variations, unreadSets, sets } = preview;
  const [variationsReviewed, setVariationsReviewed] = useState(false);
  const archiveFirst = selection.targets.filter((t) => t.phase === 'archive-then-delete');
  const deleteOnly = selection.targets.filter((t) => t.phase === 'delete');
  const needsReview = variations.length > 0 || unreadSets.length > 0;
  const holders = previewHolders(plan, preview.index);
  const toggleSet = (setId: number, on: boolean) => {
    const next = new Set(preview.include);
    if (on) next.add(setId);
    else next.delete(setId);
    onReplan(next);
  };

  return (
    <>
      <div className="panel">
        <h2>2. The plan ({plan.status}). Nothing has been changed.</h2>
        <p>{selectionSummary(selection)}</p>
        <p>
          {plan.workItems.length} process(es) to edit, {plan.sites.length} reference site(s), {plan.claims.length} claim(s). Built in{' '}
          {preview.seconds}s. Archived processes were not restored, so a real run may find more.
        </p>
        <div className="row">
          <Button buttonType="secondary" onClick={() => downloadText(datedFilename('delete-plan', 'json'), serializePlan(plan), 'application/json')}>
            Download the plan
          </Button>
          <Button buttonType="secondary" onClick={onBack}>
            Change the selection
          </Button>
        </div>
      </div>

      {stale.length > 0 && (
        <div className="panel error">
          <h2>The tenant has changed since this plan was built</h2>
          <ul className="checklist">
            {stale.map((f) => (
              <li key={f.uniqueId}>{f.message}</li>
            ))}
          </ul>
          <Button onClick={() => onReplan(preview.include)}>
            Build the plan again
          </Button>
        </div>
      )}

      {archiveFirst.length > 0 && <TargetTable title={`Phase 1: archived, then deleted in phase 2 (${archiveFirst.length})`} targets={archiveFirst} />}
      {deleteOnly.length > 0 && <TargetTable title={`Phase 2: deleted (${deleteOnly.length + archiveFirst.length}; ${deleteOnly.length} already archived)`} targets={deleteOnly} />}

      {sets.length > 0 && (
        <div className="panel warning">
          <h2>Variation sets</h2>
          <p>
            Deleting one variation can archive its master, so a set is deleted whole or not at all. A set that is only partly
            selected is left out, with the reason in the results file. Tick it to delete every variation in it; the plan is built
            again.
          </p>
          <ul className="checklist">
            {sets.map((v) => (
              <li key={v.setId}>
                {v.whole ? (
                  <strong>{v.name}: the whole set is selected</strong>
                ) : (
                  <label className="checkbox">
                    <input type="checkbox" checked={v.included} onChange={(e) => toggleSet(v.setId, e.target.checked)} />
                    <span>
                      <strong>{v.name}</strong>: {v.included ? 'deleted whole' : 'left out, because not every variation is selected'}
                      <span className="detail">Tick to delete the whole set.</span>
                    </span>
                  </label>
                )}
                <ul>
                  {v.members.map((m) => (
                    <li key={m.uniqueId}>
                      {m.name}
                      {m.isArchived ? ' (archived)' : ''}: {m.selected ? 'selected' : v.included ? 'added with the set' : 'not selected'}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(holders.edited.length > 0 || holders.skipped.length > 0) && (
        <div className="panel">
          <h2>Holders</h2>
          {holders.edited.length > 0 && (
            <>
              <p>Edited ({holders.edited.length}): each reference to a target is removed, then the holder is published.</p>
              <ul className="checklist">
                {holders.edited.map((h) => (
                  <li key={h.uniqueId}>
                    {h.name}: {h.sites} reference site(s)
                  </li>
                ))}
              </ul>
            </>
          )}
          {holders.skipped.length > 0 && (
            <>
              <p>
                Skipped ({holders.skipped.length}): each has an unpublished draft that removing a reference would publish. The run
                asks about each one, unticked; a holder left unticked is not edited.
              </p>
              <ul className="checklist">
                {holders.skipped.map((h) => (
                  <li key={h.holderUniqueId}>
                    {h.displayName}
                    {h.version ? ` (draft ${h.version})` : ''}
                  </li>
                ))}
              </ul>
              <p>Held back, unless their holder is ticked ({holders.heldBack.length}):</p>
              <ul className="checklist">
                {holders.heldBack.map((t) => (
                  <li key={t.uniqueId}>
                    {t.name}: held by {t.holderName}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {unreadSets.length > 0 && (
        <div className="panel warning">
          <h2>Variation sets that could not be read</h2>
          <p>These targets are variations, and their sets could not be read, so siblings that may be affected are not listed. Check them in Process Manager first.</p>
          <ul className="checklist">
            {unreadSets.map((u) => (
              <li key={u.uniqueId}>
                {u.name}: {u.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {variations.length > 0 && (
        <div className="panel warning">
          <h2>Variations: these may be affected too</h2>
          <p>
            Process variations are coupled: deleting one can act on its master. Each process below is a variation of a target, or
            looks like one by its name, and is not itself a target. Siblings are not shown in the tree, so this is the only place
            they appear. The run also checks the tenant before and after deleting, and puts back what it can.
          </p>
          <ul className="checklist">
            {variations.map((m) => (
              <li key={`${m.targetUniqueId}|${m.relativeUniqueId}`}>
                <strong>{m.relativeName}</strong>
                {m.relativeGroupId !== null && ` (group ${m.relativeGroupId})`}
                {m.relativeIsArchived && ' (archived)'}: {variationMessage(m)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {needsReview && (
        <div className="panel">
          <label className="inline">
            <input type="checkbox" checked={variationsReviewed} onChange={(e) => setVariationsReviewed(e.target.checked)} /> I have reviewed the
            variation warnings above
          </label>
        </div>
      )}

      {selection.skipped.length > 0 && (
        <details className="panel">
          <summary>Left out ({selection.skipped.length})</summary>
          <ul className="checklist">
            {selection.skipped.map((row) => (
              <li key={`${row.operation}|${row.objectId}`}>
                {row.name || row.objectId}: {row.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="panel">
        <pre className="plan-text">{dryRunLines(plan, preview.index).join('\n')}</pre>
      </div>

      <RunPanel
        targetCount={plan.targetUniqueIds.length}
        disabled={finishFirst || (needsReview && !variationsReviewed)}
        reason={finishFirst ? 'Finish the earlier run first (top of the page).' : needsReview && !variationsReviewed ? 'Review the variation warnings first.' : null}
        onRun={onRun}
      />
    </>
  );
}

function TargetTable({ title, targets }: { title: string; targets: readonly DeleteTarget[] }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <table className="plan">
        <thead>
          <tr>
            <th>Process</th>
            <th>Group</th>
            <th>Chosen</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.uniqueId}>
              <td>{t.name || t.uniqueId}</td>
              <td>{t.groupExists ? t.location || (t.groupId !== null ? `group ${t.groupId}` : 'not known') : 'Group no longer exists'}</td>
              <td>{SOURCE_TEXT[t.source]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RunOptions {
  approvalsEnabled: boolean;
  allowUnheldTargets: boolean;
  changeDescription: string;
}

/** The run's switches, and the typed DELETE the script asked for before it started. */
function RunPanel({ targetCount, disabled, reason, onRun }: { targetCount: number; disabled: boolean; reason: string | null; onRun: (options: RunOptions) => void }) {
  const [approvalsEnabled, setApprovalsEnabled] = useState(true);
  const [allowUnheldTargets, setAllowUnheldTargets] = useState(false);
  const [changeDescription, setChangeDescription] = useState(REFERENCE_REMOVAL_DESCRIPTION);
  const [typed, setTyped] = useState('');
  return (
    <div className="panel warning">
      <h2>3. Delete for real</h2>
      <p>
        The run restores archived targets into a holding group, builds the plan again with the archive restored, removes
        every reference, archives the active targets, checks the tenant before and after deleting, and puts back everything
        it un-archived. It asks before each step that needs a decision; a question nobody answers stops the run.
      </p>
      {reason !== null && <p className="small">{reason}</p>}
      <label htmlFor="change">Change description, sent with every save, publish and archive</label>
      <Input id="change" value={changeDescription} onChange={(e) => setChangeDescription(valueOf(e))} />
      <label className="checkbox">
        <input type="checkbox" checked={approvalsEnabled} onChange={(e) => setApprovalsEnabled(e.target.checked)} />
        <span>
          Allowed to override a pending approval
          <span className="detail">Edit and publish over a revision awaiting approval, and override a pending archive.</span>
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
      <Input id="typed" value={typed} onChange={(e) => setTyped(valueOf(e))} />
      <div className="row">
        <Button
          disabled={disabled || typed !== 'DELETE'}
          onClick={() => onRun({ approvalsEnabled, allowUnheldTargets, changeDescription })}
        >
          Run the delete ({targetCount} target{targetCount === 1 ? '' : 's'})
        </Button>
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
          <Button onClick={() => onAnswer(ticked)}>
            Carry on{ticked.length > 0 ? `, publishing ${ticked.length} draft(s)` : ', keeping their targets'}
          </Button>
        </div>
      </div>
    );
  }
  if (question.kind === 'collateral') {
    // The -AcceptCollateral gate, on screen: what changed, process by process (W6).
    return (
      <div className="panel warning">
        <h2>Processes changed that were not targets</h2>
        <p>
          {question.collateral.length} process(es) changed state {question.phase}, without being targets of this run. Accepting
          carries on; they are still put back at the end. Stopping puts back everything the run changed.
        </p>
        <table className="plan">
          <thead>
            <tr>
              <th>Process</th>
              <th>What changed</th>
            </tr>
          </thead>
          <tbody>
            {collateralEntries(question.collateral).map((c) => (
              <tr key={c.uniqueId}>
                <td>
                  {c.name}
                  <span className="small"> {c.uniqueId}</span>
                </td>
                <td>{c.changes.join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {COLLATERAL_NOTES.map((note) => (
          <p key={note} className="small">
            {note}
          </p>
        ))}
        <div className="row">
          <Button onClick={() => onAnswer(true)}>
            Accept and carry on (they are still put back at the end)
          </Button>
          <Button buttonType="secondary" onClick={() => onAnswer(false)}>
            Stop and put things back
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel warning">
      <h2>{question.title}</h2>
      <pre className="plan-text">{question.lines.join('\n')}</pre>
      <div className="row">
        <Button onClick={() => onAnswer(true)}>
          {question.yes}
        </Button>
        <Button buttonType="secondary" onClick={() => onAnswer(false)}>
          {question.no}
        </Button>
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
