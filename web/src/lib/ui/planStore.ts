/**
 * The delete run's working plan, in IndexedDB.
 *
 * The script wrote `Delete_Plan_*.json` before its first change and after every step that
 * changed the ledger, so a run that died could be finished from the file (B4). Here the
 * plan is saved in the browser the same way, and is also offered as a download. One plan
 * at a time: a new run replaces the last one, which is why the page offers to finish an
 * unfinished plan before it starts another.
 *
 * A save that cannot be made rejects. The run calls it before its first change, so a
 * browser that will not keep the plan stops the run before anything is restored, rather
 * than restoring processes with no record of where they belong.
 */

import { parsePlan, serializePlan, type DependencyPlan } from '../delete/ledger.ts';
import type { PlanStore } from '../delete/planStore.ts';

const DB_NAME = 'bulk-operations';
const STORE = 'delete-plan';
const KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so the delete plan cannot be kept. Use another browser, or leave private browsing.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the plan store.'));
  });
}

async function transact<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = act(tx.objectStore(STORE));
      // Resolved on commit, not on the request: "durable" is what the run waits for.
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? new Error('The plan store refused the write.'));
      tx.onabort = () => reject(tx.error ?? new Error('The plan store write was aborted.'));
    });
  } finally {
    db.close();
  }
}

export function browserPlanStore(): PlanStore & { clear(): Promise<void> } {
  return {
    // Stored as the plan file's own text, so what is kept is exactly what downloads.
    save: async (plan: DependencyPlan) => {
      await transact('readwrite', (store) => store.put(serializePlan(plan), KEY));
    },
    load: async () => {
      const text = await transact<unknown>('readonly', (store) => store.get(KEY));
      return typeof text === 'string' ? parsePlan(text) : null;
    },
    clear: async () => {
      await transact('readwrite', (store) => store.delete(KEY));
    },
  };
}

/**
 * Whether a saved plan still has processes to put back: something the run un-archived and
 * neither deleted nor re-archived, or a holding group it may not have removed.
 */
export function planNeedsFinishing(plan: DependencyPlan | null): boolean {
  if (!plan || plan.status === 'Completed') return false;
  const outstanding = plan.ledger.some((e) => e.wasArchived && e.restoredByThisRun && !e.denormalized && !e.deleted);
  return outstanding || (Boolean(plan.holdingGroup) && plan.holdingGroupRemoved !== true);
}
