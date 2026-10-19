'use client';

/**
 * The last, optional step of Bulk Archive and Bulk Delete: delete the groups the run left
 * empty.
 *
 * Offered only once the run has finished and been re-read. It is its own step with its
 * own confirmation, because it cannot be undone: a deleted group's archived processes can
 * never be restored to it (spike S1). After a Delete, a group still holding an archived
 * process is kept rather than offered (W6), so nothing the run chose to keep is stranded.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';

import { gatherFacts } from '@/lib/cleanup/facts.ts';
import { describeGroupPath, planCleanup, type CleanupDecision, type CleanupPlanOptions } from '@/lib/cleanup/plan.ts';
import { runCleanup, settleCleanup } from '@/lib/cleanup/run.ts';
import { Journal, sessionJournalStore } from '@/lib/exec/journal.ts';
import type { ResultRow } from '@/lib/exec/report.ts';
import { createControls, defaultIsFatal, errorMessage } from '@/lib/exec/runner.ts';
import type { TreeItem } from '@/lib/pm/types.ts';
import type { CoveredGroup } from '@/lib/select/resolve.ts';
import type { ProcessIndex } from '@/lib/tenant/state.ts';
import { browserCleanupGateway } from '@/lib/ui/gateway.ts';

type Step =
  | { kind: 'offer' }
  | { kind: 'checking'; progress: string }
  | { kind: 'review'; decisions: CleanupDecision[] }
  | { kind: 'running'; progress: string }
  | { kind: 'done'; deleted: number; kept: number };

export function CleanupPanel({
  tenant,
  groups,
  index,
  onRows,
  onError,
  heading,
  offer,
  archivedProcesses,
}: {
  tenant: string;
  groups: readonly CoveredGroup[];
  /** The run's final read. */
  index: ProcessIndex;
  onRows: (rows: ResultRow[]) => void;
  onError: (error: unknown) => void;
  heading: string;
  /** What the step checks, shown before anything is read. */
  offer: ReactNode;
  archivedProcesses?: CleanupPlanOptions['archivedProcesses'];
}) {
  const gateway = useMemo(() => browserCleanupGateway(), []);
  const [step, setStep] = useState<Step>({ kind: 'offer' });
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  if (groups.length === 0) return null;

  async function check() {
    setError(null);
    setUnderstood(false);
    setStep({ kind: 'checking', progress: 'Reading each group…' });
    try {
      const facts = await gatherFacts(gateway, groups, index, {
        isFatal: defaultIsFatal,
        onProgress: (done, total) => setStep({ kind: 'checking', progress: `Reading each group… ${done} of ${total}` }),
      });
      setStep({ kind: 'review', decisions: planCleanup(groups, facts, { archivedProcesses }) });
    } catch (cause) {
      onError(cause);
      setError(errorMessage(cause));
      setStep({ kind: 'offer' });
    }
  }

  async function apply(decisions: CleanupDecision[]) {
    setError(null);
    setStep({ kind: 'running', progress: 'Deleting…' });
    abort.current = new AbortController();
    const journal = Journal.start(crypto.randomUUID(), tenant, Date.now(), sessionJournalStore());
    const controls = createControls({ signal: abort.current.signal });

    const draft = await runCleanup(gateway, journal, decisions, controls, (done, total, label) =>
      setStep({ kind: 'running', progress: `Deleting ${done} of ${total}: ${label}` }),
    );

    // Settle from a fresh read of each deleted group's parent level.
    const parents = new Set(decisions.filter((d) => d.action === 'delete').map((d) => d.group.parentUniqueId ?? ''));
    const levels = new Map<string, readonly TreeItem[] | null>();
    for (const parent of parents) {
      try {
        levels.set(parent, await gateway.childItems(parent === '' ? null : parent));
      } catch {
        levels.set(parent, null);
      }
    }
    const rows = settleCleanup(draft, decisions, levels);
    journal.discard();
    abort.current = null;

    onRows(rows);
    setStep({
      kind: 'done',
      deleted: rows.filter((r) => r.operation === 'DeleteGroup' && r.status === 'Success').length,
      kept: rows.filter((r) => r.operation === 'DeleteGroup' && r.status !== 'Success').length,
    });
  }

  return (
    <div className="panel">
      <h2>{heading}</h2>

      {error !== null && <p className="error-text">{error}</p>}

      {step.kind === 'offer' && (
        <>
          <p>{offer}</p>
          <button type="button" className="secondary" onClick={() => void check()}>
            Check which groups are empty
          </button>
        </>
      )}

      {step.kind === 'checking' && <p className="pending">{step.progress}</p>}

      {step.kind === 'review' && (
        <ReviewDecisions
          decisions={step.decisions}
          understood={understood}
          setUnderstood={setUnderstood}
          onApply={() => void apply(step.decisions)}
          onCancel={() => setStep({ kind: 'offer' })}
        />
      )}

      {step.kind === 'running' && (
        <>
          <p className="pending">{step.progress}</p>
          <button type="button" className="secondary" onClick={() => abort.current?.abort()}>
            Stop after this group
          </button>
        </>
      )}

      {step.kind === 'done' && (
        <p>
          {step.deleted} group{step.deleted === 1 ? '' : 's'} deleted, {step.kept} kept. Each has a row
          in the results file, as does every archived process that lost its group.
        </p>
      )}
    </div>
  );
}

function ReviewDecisions({
  decisions,
  understood,
  setUnderstood,
  onApply,
  onCancel,
}: {
  decisions: CleanupDecision[];
  understood: boolean;
  setUnderstood: (value: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const deletes = decisions.filter((d): d is Extract<CleanupDecision, { action: 'delete' }> => d.action === 'delete');
  const keeps = decisions.filter((d): d is Extract<CleanupDecision, { action: 'keep' }> => d.action === 'keep');
  const orphans = deletes.reduce((sum, d) => sum + d.orphans.length, 0);

  return (
    <>
      {deletes.length === 0 ? (
        <p>None of the groups can be deleted. The reasons are below.</p>
      ) : (
        <div className="panel warning">
          <h2>
            {deletes.length} group{deletes.length === 1 ? '' : 's'} would be deleted, deepest first
          </h2>
          <p>
            Process Manager deletes a group that holds archived processes without asking. Those
            processes stay archived, but can never be restored to the group again.
          </p>
          <ul className="checklist">
            {deletes.map((d) => (
              <li key={d.group.uniqueId}>
                <strong>{describeGroupPath(d.group)}</strong>
                {d.orphans.length === 0 ? (
                  ' (no archived processes)'
                ) : (
                  <>
                    {`: ${d.orphans.length} archived process${d.orphans.length === 1 ? '' : 'es'} will lose this group:`}
                    <ul>
                      {d.orphans.map((o) => (
                        <li key={o.uniqueId}>{o.name}</li>
                      ))}
                    </ul>
                  </>
                )}
              </li>
            ))}
          </ul>
          <label className="inline">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />{' '}
            {orphans === 0
              ? 'I want to delete these groups'
              : `I understand ${orphans} archived process${orphans === 1 ? '' : 'es'} can never be restored to these groups`}
          </label>
          <div className="row">
            <button type="button" disabled={!understood} onClick={onApply}>
              Delete {deletes.length} group{deletes.length === 1 ? '' : 's'}
            </button>
            <button type="button" className="secondary" onClick={onCancel}>
              Not now
            </button>
          </div>
        </div>
      )}

      {keeps.length > 0 && (
        <details className="panel">
          <summary>Kept ({keeps.length})</summary>
          <ul className="checklist">
            {keeps.map((d) => (
              <li key={d.group.uniqueId}>
                {describeGroupPath(d.group)}: {d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
