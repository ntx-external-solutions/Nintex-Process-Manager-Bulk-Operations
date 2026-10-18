/**
 * The append-only record of what a run actually did.
 *
 * This exists because the thing driving every run is a browser tab that can be closed
 * mid-run, and because several of the writes here are two calls with no transaction
 * between them: an archive followed by the publish that clears its approval, a restore
 * followed by the reference edit it was made for. Without a journal an interrupted run
 * leaves a tenant in a state nobody can describe.
 *
 * Every step is idempotent by identity: replaying a journal tells the runner exactly
 * which steps are already done, so a resume never writes the same change twice.
 *
 * Lifted from process-group-manager. The journal is kept small on purpose and lives in
 * sessionStorage; the delete planner's ledger, which can hold hundreds of process
 * models, goes to IndexedDB instead (handoff/SPEC-WEB.md).
 */

/**
 * The writes this app makes. Each arrives with the task that needs it, and none is
 * reachable until its proxy operation exists.
 */
export type ActionKind =
  | 'process.archive'
  | 'process.publish'
  | 'process.restore'
  | 'process.update'
  | 'process.delete'
  | 'node.move'
  | 'group.delete';

export type Phase =
  /** Sent, outcome unknown. A begin with no terminal phase is the recovery case. */
  | 'begin'
  | 'commit'
  | 'fail'
  /** Deliberately not attempted. Terminal, and not an error. */
  | 'skip';

export interface JournalEntry {
  /** Stable identity for the step, independent of ordering. */
  step: string;
  kind: ActionKind;
  phase: Phase;
  /** Small, structured, and never credentials. */
  data?: Record<string, string | number | boolean | null>;
}

/** Where the journal is mirrored. Injected so tests need no DOM. */
export interface JournalStore {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export interface RunRecord {
  runId: string;
  /** Guards against replaying one tenant's run against another. */
  tenant: string;
  startedAt: number;
  entries: JournalEntry[];
}

const TERMINAL: ReadonlySet<Phase> = new Set<Phase>(['commit', 'fail', 'skip']);

export class Journal {
  readonly runId: string;
  readonly tenant: string;
  readonly startedAt: number;

  #entries: JournalEntry[];
  #store: JournalStore | null;

  constructor(record: RunRecord, store: JournalStore | null) {
    this.runId = record.runId;
    this.tenant = record.tenant;
    this.startedAt = record.startedAt;
    this.#entries = [...record.entries];
    this.#store = store;
  }

  static start(runId: string, tenant: string, startedAt: number, store: JournalStore | null): Journal {
    const journal = new Journal({ runId, tenant, startedAt, entries: [] }, store);
    journal.#persist();
    return journal;
  }

  append(entry: JournalEntry): void {
    this.#entries.push(entry);
    this.#persist();
  }

  entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  /** The most recent phase recorded for a step, or null if it was never attempted. */
  phaseOf(step: string): Phase | null {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i] as JournalEntry;
      if (entry.step === step) return entry.phase;
    }
    return null;
  }

  /** Data from the step's last committed entry, which is how a resume recovers ids. */
  commitData(step: string): Record<string, string | number | boolean | null> | null {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i] as JournalEntry;
      if (entry.step === step && entry.phase === 'commit') return entry.data ?? {};
    }
    return null;
  }

  /**
   * Data from the step's most recent entry, whatever phase it reached.
   *
   * How a resume recovers what a `begin` recorded, such as the revision id an archive
   * was sent against.
   */
  latestData(step: string): Record<string, string | number | boolean | null> | null {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i] as JournalEntry;
      if (entry.step === step) return entry.data ?? {};
    }
    return null;
  }

  /** True when the step reached a terminal phase and must not be attempted again. */
  isSettled(step: string): boolean {
    const phase = this.phaseOf(step);
    return phase !== null && TERMINAL.has(phase);
  }

  isCommitted(step: string): boolean {
    return this.phaseOf(step) === 'commit';
  }

  /**
   * Steps that were started and never finished.
   *
   * The tab died between sending a write and hearing back, so we cannot know whether
   * it landed. These are never retried automatically: they are reconciled against a
   * fresh read first, because a repeated publish burns another major version and an
   * archive can report failure and still take effect (API_ARCHITECTURE.md).
   */
  inDoubt(): JournalEntry[] {
    const latest = new Map<string, JournalEntry>();
    for (const entry of this.#entries) latest.set(entry.step, entry);
    return [...latest.values()].filter((entry) => entry.phase === 'begin');
  }

  discard(): void {
    this.#store?.clear();
  }

  #persist(): void {
    if (!this.#store) return;
    const record: RunRecord = {
      runId: this.runId,
      tenant: this.tenant,
      startedAt: this.startedAt,
      entries: this.#entries,
    };
    try {
      this.#store.write(JSON.stringify(record));
    } catch {
      // A full or unavailable store must not abort a run in progress. Losing the
      // ability to resume is bad; stopping halfway through writing is worse.
    }
  }
}

/**
 * Read a previous run back, or null if there is nothing usable.
 *
 * Anything unparseable, or belonging to a different tenant, is treated as absent —
 * replaying one tenant's steps against another would be the worst bug this tool could
 * have.
 */
export function loadJournal(store: JournalStore, tenant: string): Journal | null {
  let raw: string | null;
  try {
    raw = store.read();
  } catch {
    return null;
  }
  if (!raw) return null;

  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof record !== 'object' || record === null) return null;
  const candidate = record as Partial<RunRecord>;
  if (
    typeof candidate.runId !== 'string' ||
    typeof candidate.tenant !== 'string' ||
    typeof candidate.startedAt !== 'number' ||
    !Array.isArray(candidate.entries)
  ) {
    return null;
  }
  if (candidate.tenant !== tenant) return null;

  return new Journal(candidate as RunRecord, store);
}

/** sessionStorage, scoped to the tab and gone when it closes. */
export const SESSION_KEY = 'npmbo.run';

export function sessionJournalStore(): JournalStore | null {
  if (typeof sessionStorage === 'undefined') return null;
  return {
    read: () => sessionStorage.getItem(SESSION_KEY),
    write: (value) => sessionStorage.setItem(SESSION_KEY, value),
    clear: () => sessionStorage.removeItem(SESSION_KEY),
  };
}

// ------------------------------------------------------------ step names

/**
 * Keyed by the object's own id. Paths are not identities here: a move changes the path,
 * and an archived process whose group was deleted has no path at all.
 */
export const step = {
  archive: (processUniqueId: string): string => `archive:${processUniqueId}`,
  publish: (processUniqueId: string): string => `publish:${processUniqueId}`,
  restore: (processUniqueId: string): string => `restore:${processUniqueId}`,
  update: (processUniqueId: string): string => `update:${processUniqueId}`,
  deleteProcess: (processUniqueId: string): string => `delete:${processUniqueId}`,
  move: (uniqueId: string): string => `move:${uniqueId}`,
  deleteGroup: (groupUniqueId: string): string => `group.delete:${groupUniqueId}`,
};
