'use client';

/**
 * Bulk Move: choose what to move, choose where, preview the cost of every move, apply.
 *
 * A move is cheap for a group and expensive for a published process, which is
 * republished as a new major version, open draft included (spike S2). The preview says
 * which is which before anything is sent, drafts that would go live are left unticked,
 * and the confirmation counts the republishes.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { Journal, sessionJournalStore } from '@/lib/exec/journal.ts';
import { resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { createControls, defaultIsFatal, errorMessage } from '@/lib/exec/runner.ts';
import { buildMovePlan, describeCost, movePreviewRows, type MoveItem, type MovePlan } from '@/lib/move/plan.ts';
import { itemsToMove, MOVE_STATUSES, runMoves, settleMoves } from '@/lib/move/run.ts';
import { describeDestination, destinationOf, resolveMoveSelection } from '@/lib/move/select.ts';
import { revalidatePlacements, type StaleFinding } from '@/lib/plan/revalidate.ts';
import type { TreeItem } from '@/lib/pm/types.ts';
import { readUntilResolved } from '@/lib/select/resolve.ts';
import { hasSelection } from '@/lib/select/selection.ts';
import { loadProcessIndex, type ProcessIndex } from '@/lib/tenant/state.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';
import { browserGateway, browserMoveGateway, PmRequestError, type SessionInfo } from '@/lib/ui/gateway.ts';
import { DestinationPicker, TOP_LEVEL } from '../components/DestinationPicker.tsx';
import { ResultsSummary } from '../components/ResultsSummary.tsx';
import { SessionGate } from '../components/SessionGate.tsx';
import { TreeBrowser, useBrowseTree } from '../components/TreeBrowser.tsx';

type Stage =
  | { kind: 'select' }
  | { kind: 'planning'; progress: string }
  | { kind: 'plan'; plan: MovePlan }
  | { kind: 'running'; progress: string }
  | { kind: 'done'; rows: ResultRow[]; warning: string | null };

export default function MovePage() {
  return (
    <SessionGate title="Bulk Move">
      {(session, onSignedOut) => <MoveFlow session={session} onSignedOut={onSignedOut} />}
    </SessionGate>
  );
}

function MoveFlow({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const gateway = useMemo(() => browserGateway(), []);
  const moveGateway = useMemo(() => browserMoveGateway(), []);
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof PmRequestError && error.signedOut) onSignedOut();
    },
    [onSignedOut],
  );
  const browse = useBrowseTree(gateway, handleError);
  const destinations = useBrowseTree(gateway, handleError);

  const [stage, setStage] = useState<Stage>({ kind: 'select' });
  const [destinationKey, setDestinationKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [stale, setStale] = useState<StaleFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const destination =
    destinationKey === null ? null : destinationOf(destinations.tree, destinationKey === TOP_LEVEL ? null : destinationKey);

  async function buildPlan() {
    if (!destination) return;
    setError(null);
    setStale([]);
    setChosen(new Set());
    setConfirming(false);
    setStage({ kind: 'planning', progress: 'Reading the selected groups…' });
    try {
      const { tree, resolution } = await readUntilResolved(gateway, browse.tree, (t) => resolveMoveSelection(t, browse.selection));
      browse.setTree(tree);
      const plan = await buildMovePlan(tree, resolution, destination, {
        ...moveGateway,
        isFatal: defaultIsFatal,
        onProgress: (label) => setStage({ kind: 'planning', progress: label }),
      });
      setStage({ kind: 'plan', plan });
    } catch (cause) {
      handleError(cause);
      setError(errorMessage(cause));
      setStage({ kind: 'select' });
    }
  }

  async function apply(plan: MovePlan) {
    setError(null);
    setConfirming(false);
    const items = itemsToMove(plan, chosen);
    setStage({ kind: 'running', progress: 'Checking the plan against the tenant…' });
    try {
      const findings = await revalidatePlacements(gateway, [
        ...items.map((item) => ({
          uniqueId: item.uniqueId,
          parentUniqueId: item.fromParentUniqueId,
          display: item.title,
          parentDisplay: item.fromDisplay,
        })),
        // The destination has to still be where it was, too.
        ...(plan.destination.uniqueId === null
          ? []
          : [
              {
                uniqueId: plan.destination.uniqueId,
                parentUniqueId: plan.destination.ancestry.at(-2) ?? null,
                display: plan.destination.title,
                parentDisplay: plan.destination.path.slice(0, -1).join(' / ') || 'the top level',
              },
            ]),
      ]);
      if (findings.length > 0) {
        setStale(findings);
        setStage({ kind: 'plan', plan });
        return;
      }

      const journal = Journal.start(crypto.randomUUID(), session.tenant, Date.now(), sessionJournalStore());
      abort.current = new AbortController();
      const controls = createControls({ signal: abort.current.signal });
      const draft = await runMoves(moveGateway, journal, plan, chosen, controls, {
        onProgress: (done, total, label) => setStage({ kind: 'running', progress: `Moved ${done} of ${total}. Last: ${label}` }),
      });

      setStage({ kind: 'running', progress: 'Reading the tree to confirm every move…' });
      const levels = new Map<string, readonly TreeItem[] | null>();
      const keys = new Set([plan.destination.uniqueId ?? '', ...items.map((i) => i.fromParentUniqueId ?? '')]);
      for (const key of keys) {
        try {
          levels.set(key, (await gateway.groupsTree(key === '' ? null : key)).treeItems ?? []);
        } catch {
          levels.set(key, null);
        }
      }
      let after: ProcessIndex | null = null;
      if (items.some((i) => i.siblings.length > 0)) {
        try {
          after = await loadProcessIndex(gateway.processesList);
        } catch {
          after = null;
        }
      }

      journal.discard();
      browse.refresh();
      destinations.refresh();
      setStage({ kind: 'done', rows: settleMoves(draft, plan, levels, after), warning: controls.stoppedReason() });
    } catch (cause) {
      handleError(cause);
      setError(errorMessage(cause));
      setStage({ kind: 'plan', plan });
    } finally {
      abort.current = null;
    }
  }

  return (
    <main>
      <h1>Bulk Move</h1>
      <p className="lede">
        Signed in as {session.username} on <code>{session.tenant}</code>. <a href="/">Back</a>
      </p>

      {error !== null && (
        <div className="panel error">
          <h2>Problem</h2>
          <p>{error}</p>
        </div>
      )}

      {stage.kind === 'select' && (
        <>
          <div className="panel">
            <h2>1. Choose what to move</h2>
            <p>
              A checked group moves as a whole, which changes no process. A process moved on its own may
              be republished; the preview says which. Shortcuts cannot be moved from here.
            </p>
          </div>
          <TreeBrowser state={browse} />

          <div className="panel">
            <h2>2. Choose where it goes</h2>
          </div>
          <DestinationPicker state={destinations} chosen={destinationKey} onChoose={setDestinationKey} allowTopLevel />

          <div className="row">
            <button type="button" disabled={!hasSelection(browse.selection) || !destination} onClick={() => void buildPlan()}>
              Preview the move
            </button>
          </div>
        </>
      )}

      {stage.kind === 'planning' && <p className="pending">{stage.progress}</p>}

      {stage.kind === 'plan' && (
        <PlanView
          plan={stage.plan}
          chosen={chosen}
          setChosen={setChosen}
          stale={stale}
          confirming={confirming}
          setConfirming={setConfirming}
          onBack={() => setStage({ kind: 'select' })}
          onReplan={() => void buildPlan()}
          onApply={() => void apply(stage.plan)}
        />
      )}

      {stage.kind === 'running' && (
        <div className="panel">
          <h2>Moving</h2>
          <p className="pending">{stage.progress}</p>
          <button type="button" className="secondary" onClick={() => abort.current?.abort()}>
            Stop after the current batch
          </button>
        </div>
      )}

      {stage.kind === 'done' && (
        <ResultsSummary
          rows={stage.rows}
          vocabulary={MOVE_STATUSES}
          warning={stage.warning}
          siteUrl={session.siteUrl}
          filenameStem="move-results"
          actions={
            <button type="button" className="secondary" onClick={() => setStage({ kind: 'select' })}>
              Move something else
            </button>
          }
        />
      )}
    </main>
  );
}

function viewers(item: MoveItem): string {
  const fmt = (v: MoveItem['viewersBefore']) => (v === null ? '?' : `${v.users} users, ${v.roles} roles`);
  return `${fmt(item.viewersBefore)} → ${fmt(item.viewersAfter)}`;
}

function MoveTable({ items, choose }: { items: MoveItem[]; choose?: { chosen: ReadonlySet<string>; toggle: (id: string) => void } }) {
  return (
    <table className="plan">
      <thead>
        <tr>
          {choose && <th>Move</th>}
          <th>Item</th>
          <th>From</th>
          <th>What happens</th>
          <th>Who can see it</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.uniqueId}>
            {choose && (
              <td>
                <input
                  type="checkbox"
                  aria-label={`Move ${item.title}`}
                  checked={choose.chosen.has(item.uniqueId)}
                  onChange={() => choose.toggle(item.uniqueId)}
                />
              </td>
            )}
            <td>
              {item.title}
              {item.kind === 'group' && <span className="tag">group</span>}
              {item.siblings.length > 0 && (
                <div className="small">
                  Moves with its variation set: {item.siblings.map((s) => s.name).join(', ')}
                </div>
              )}
            </td>
            <td>{item.fromDisplay}</td>
            <td>
              {describeCost(item)}
              {item.tenantMessage && <div className="small">The tenant said: {item.tenantMessage}</div>}
            </td>
            <td className="small">{viewers(item)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlanView(props: {
  plan: MovePlan;
  chosen: ReadonlySet<string>;
  setChosen: (next: ReadonlySet<string>) => void;
  stale: StaleFinding[];
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onBack: () => void;
  onReplan: () => void;
  onApply: () => void;
}) {
  const { plan, chosen } = props;
  const items = itemsToMove(plan, chosen);
  const republished = items.filter((i) => i.cost === 'republish' || i.cost === 'draft').length;
  const siblings = items.reduce((n, i) => n + i.siblings.length, 0);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.setChosen(next);
  };

  return (
    <>
      <div className="panel">
        <h2>3. Check the plan. Nothing has been moved.</h2>
        <p>
          {items.length} item{items.length === 1 ? '' : 's'} would move to {describeDestination(plan.destination)}
          {siblings > 0 && `, taking ${siblings} variation sibling${siblings === 1 ? '' : 's'} with them`}.
          {republished > 0 && ` ${republished} would be republished as a new major version.`}
        </p>
        <div className="row">
          <button type="button" className="secondary" onClick={() => downloadCsv(datedFilename('move-preview'), resultsToCsv(movePreviewRows(plan, chosen)))}>
            Download the preview
          </button>
          <button type="button" className="secondary" onClick={props.onBack}>
            Change the selection
          </button>
        </div>
      </div>

      {props.stale.length > 0 && (
        <div className="panel error">
          <h2>The tenant has changed since this plan was built</h2>
          <ul className="checklist">
            {props.stale.map((f) => (
              <li key={f.uniqueId}>{f.message}</li>
            ))}
          </ul>
          <button type="button" onClick={props.onReplan}>
            Build the plan again
          </button>
        </div>
      )}

      {plan.viewersUnavailable !== null && (
        <p className="small">Viewer counts could not be read ({plan.viewersUnavailable}). The move is unaffected.</p>
      )}

      {plan.moves.length > 0 && (
        <div className="panel">
          <h2>Would move</h2>
          <MoveTable items={plan.moves} />
        </div>
      )}

      {plan.needsChoice.length > 0 && (
        <div className="panel warning">
          <h2>Tick to move: these would publish more than the move</h2>
          <p>
            Moving these publishes an open draft along with the move, or the cost could not be checked.
            The draft&rsquo;s changes would go live and cannot be taken back from here. None is moved
            unless you tick it.
          </p>
          <MoveTable items={plan.needsChoice} choose={{ chosen, toggle }} />
        </div>
      )}

      {plan.skipped.length + plan.excluded.length > 0 && (
        <details className="panel">
          <summary>Not moving ({plan.skipped.length + plan.excluded.length})</summary>
          <ul className="checklist">
            {plan.skipped.map((row) => (
              <li key={`s|${row.objectId}`}>
                {row.name}: {row.message}
              </li>
            ))}
            {plan.excluded.map((item) => (
              <li key={`e|${item.uniqueId}|${item.path.join('/')}`}>
                {item.title}: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="panel">
        <h2>4. Move</h2>
        {props.confirming ? (
          <div className="row">
            <button type="button" onClick={props.onApply}>
              Yes, move {items.length} item{items.length === 1 ? '' : 's'}
              {republished > 0 && ` (${republished} republished)`}
            </button>
            <button type="button" className="secondary" onClick={() => props.setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" disabled={items.length === 0 || props.stale.length > 0} onClick={() => props.setConfirming(true)}>
            Move {items.length} item{items.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </>
  );
}
