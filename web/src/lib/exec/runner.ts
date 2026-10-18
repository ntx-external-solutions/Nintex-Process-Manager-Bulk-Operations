/**
 * The executor's shared machinery. Everything above this reads; operations built on
 * this are where writes happen.
 *
 * Lifted from process-group-manager's runner, keeping the rules and leaving behind the
 * group, champion and shortcut steps that only PGM performs. The rules, in order of how
 * much they matter:
 *
 *  1. **Nothing outside the plan is ever touched.** A run walks the plan the operator
 *     approved on the preview screen and stops. There is no search, no discovery and
 *     no fallback in here.
 *  2. **A step is attempted at most once.** Identity comes from the journal, so a
 *     resume continues rather than repeating. A write whose outcome is unknown is
 *     reconciled against the tenant, never blindly retried.
 *  3. **A fatal error stops the run.** A dead token would otherwise turn into hundreds
 *     of failures, each one an audit-log entry someone has to read.
 */

export const DEFAULT_CONCURRENCY = 4;

/** The run-wide switches every operation's loop consults between steps. */
export interface Controls {
  /** True once the run has been stopped, by the operator or by a fatal error. */
  cancelled(): boolean;
  stop(reason: string): void;
  /** Returns a reason the run cannot continue, or null to carry on. */
  isFatal(error: unknown): string | null;
  stopped(): boolean;
  stoppedReason(): string | null;
}

export interface ControlOptions {
  signal?: AbortSignal | undefined;
  /**
   * Whether an error should stop the whole run. Defaults to stopping when the session
   * has gone, since nothing after that can work.
   */
  isFatal?: ((error: unknown) => string | null) | undefined;
}

export function defaultIsFatal(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'signedOut' in error) {
    if ((error as { signedOut?: boolean }).signedOut === true) {
      return 'Your session ended. Sign in again and resume. Nothing after this point was attempted.';
    }
  }
  return null;
}

export const CANCELLED =
  'Cancelled. Anything already written stays written; nothing further was attempted.';

export function createControls(options: ControlOptions = {}): Controls {
  const isFatal = options.isFatal ?? defaultIsFatal;
  const state = { stopped: false, reason: null as string | null };

  const stop = (reason: string): void => {
    if (state.stopped) return;
    state.stopped = true;
    state.reason = reason;
  };

  return {
    cancelled: () => {
      if (state.stopped) return true;
      if (options.signal?.aborted === true) {
        stop(CANCELLED);
        return true;
      }
      return false;
    },
    stop,
    isFatal,
    stopped: () => state.stopped,
    stoppedReason: () => state.reason,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BatchProgress {
  done: number;
  total: number;
  label: string;
}

/**
 * Run `work` over `items`, `concurrency` at a time, checking for a stop between batches.
 *
 * A batch already in flight is allowed to finish: abandoning a request after it was sent
 * does not unsend it, and the journal entry for it would then say `begin` for a write
 * that probably landed. Items after a stop are not attempted and are returned in
 * `notAttempted`, so the caller can give each one a results row.
 */
export async function forEachBatched<T, R>(
  items: readonly T[],
  controls: Controls,
  work: (item: T) => Promise<R>,
  options: {
    concurrency?: number | undefined;
    label?: ((item: T) => string) | undefined;
    onProgress?: ((progress: BatchProgress) => void) | undefined;
  } = {},
): Promise<{ results: R[]; notAttempted: T[] }> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const results: R[] = [];
  let done = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    if (controls.cancelled()) return { results, notAttempted: items.slice(i) };

    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(work))));
    done += batch.length;

    const last = batch[batch.length - 1];
    options.onProgress?.({
      done,
      total: items.length,
      label: last !== undefined && options.label ? options.label(last) : '',
    });
  }

  return { results, notAttempted: [] };
}
