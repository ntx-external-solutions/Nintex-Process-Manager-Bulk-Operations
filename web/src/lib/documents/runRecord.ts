/**
 * A document page's run record (W8 follow-up): what a run has done so far, kept in the
 * browser while it runs, so a run whose session dies or whose tab closes can be finished.
 *
 * Each page writes its record before its first write and after every batch, with the
 * batch that is out at the moment (`inFlight`). Signed in again, the page reads the record
 * back and settles every row against a fresh read of the tenant: a batch that was out
 * when the run died is decided by what the lists say now, never by sending it again.
 * Delete documents also keeps its targets, so the run can go on to its confirmation and
 * put back what it archived (delete.ts, `recoverDelete`).
 *
 * localStorage rather than the process archive's sessionStorage journal: a record has to
 * survive the tab closing, which is how most operators will meet a dead session.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { CoveredGroup } from '../select/resolve.ts';
import type { DocumentTarget } from './archive.ts';
import type { DocumentIndex } from './list.ts';

export type DocumentPage = 'archive' | 'delete' | 'restore' | 'repair';

/** What a call that was out when the run died was sent about. */
export interface InFlight {
  operation: string;
  items: Array<{ uniqueId: string; name: string; groupId: number | null }>;
}

export interface DocumentRunRecord {
  page: DocumentPage;
  /** Guards against finishing one tenant's run against another. */
  tenant: string;
  runId: string;
  startedAt: number;
  /** Every row so far, in the order the results file gives them. */
  rows: ResultRow[];
  inFlight: InFlight | null;
  /** Delete documents only: what finishing the run needs. */
  delete?: {
    toArchive: DocumentTarget[];
    alreadyArchived: DocumentTarget[];
    groups: CoveredGroup[];
    /** The operator typed DELETE before the run died. */
    confirmed: boolean;
  };
}

export interface RecordStore {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export const RECORD_KEY = (page: DocumentPage) => `npmbo.documents.${page}`;

/** localStorage, one record per page. Null where there is none (a test, a locked-down browser). */
export function localRecordStore(page: DocumentPage): RecordStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
  } catch {
    return null;
  }
  const key = RECORD_KEY(page);
  return {
    read: () => localStorage.getItem(key),
    write: (value) => localStorage.setItem(key, value),
    clear: () => localStorage.removeItem(key),
  };
}

export interface Recorder {
  current(): DocumentRunRecord;
  save(patch: Partial<Omit<DocumentRunRecord, 'page' | 'tenant' | 'runId' | 'startedAt'>>): void;
  clear(): void;
}

/**
 * Start (or carry on) a record. A store that is full or unavailable must not stop a run
 * that is writing to the tenant, so failures to save are swallowed: losing the ability to
 * recover is bad, stopping half way through is worse (the process journal's rule).
 */
export function recorder(store: RecordStore | null, record: DocumentRunRecord): Recorder {
  let now = record;
  const write = () => {
    try {
      store?.write(JSON.stringify(now));
    } catch {
      // See above.
    }
  };
  write();
  return {
    current: () => now,
    save: (patch) => {
      now = { ...now, ...patch };
      write();
    },
    clear: () => {
      try {
        store?.clear();
      } catch {
        // Nothing to do: the record is only a convenience once the run has finished.
      }
    },
  };
}

/** The record left by an earlier run on this page and tenant, or null. Anything malformed is ignored. */
export function loadRecord(store: RecordStore | null, tenant: string, page: DocumentPage): DocumentRunRecord | null {
  let raw: string | null = null;
  try {
    raw = store?.read() ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<DocumentRunRecord>;
    if (record.page !== page || record.tenant !== tenant || typeof record.runId !== 'string' || typeof record.startedAt !== 'number' || !Array.isArray(record.rows)) {
      return null;
    }
    return { ...record, inFlight: record.inFlight ?? null } as DocumentRunRecord;
  } catch {
    return null;
  }
}

export const inFlightOf = (operation: string, targets: readonly DocumentTarget[]): InFlight => ({
  operation,
  items: targets.map((t) => ({ uniqueId: t.uniqueId, name: t.name, groupId: t.groupId })),
});

const INTERRUPTED = 'The run was interrupted while this call was out';

/**
 * Rows for the documents of a call that was out when the run died, from the lists read
 * now. A document that already has a row for that operation keeps it.
 */
export function inFlightRows(record: DocumentRunRecord, after: DocumentIndex): ResultRow[] {
  const flight = record.inFlight;
  if (flight === null) return [];
  const has = new Set(record.rows.filter((r) => r.operation === flight.operation).map((r) => r.objectId.toLowerCase()));
  return flight.items
    .filter((item) => !has.has(item.uniqueId.toLowerCase()))
    .map((item) => {
      const now = after.get(item.uniqueId.toLowerCase());
      const row = (status: string, message: string) =>
        resultRow({ objectType: 'Document', objectId: item.uniqueId, name: item.name, operation: flight.operation, status, message, groupId: item.groupId });
      const state = now === undefined ? 'gone' : now.isArchived ? 'archived' : 'active';
      const took: Record<string, string> = { Archive: 'archived', Delete: 'gone', Restore: 'active' };
      if (state === took[flight.operation]) return row('Success', `${pastOf(flight.operation)}. ${INTERRUPTED}; the read afterwards confirms it.`);
      if (state === 'gone') return row('Unverified', `${INTERRUPTED}, and neither document list returns it now, so its state could not be confirmed.`);
      // "Not attempted" so a resumed delete offers it again: the call did not take.
      return row('Skipped', `Not attempted, or not taken: ${INTERRUPTED.toLowerCase()}, and the read afterwards shows it ${state}.`);
    });
}

function pastOf(operation: string): string {
  return operation === 'Archive' ? 'Archived' : operation === 'Delete' ? 'Deleted' : operation === 'Restore' ? 'Restored' : operation;
}
