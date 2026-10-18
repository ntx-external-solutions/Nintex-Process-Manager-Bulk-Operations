/**
 * Where the run keeps its plan while it works.
 *
 * The script writes `Delete_Plan_*.json` before the first mutation and after every
 * step that changes the ledger, so a run that dies can be finished from the file
 * (Test-BulkDelete.ps1, B4). Here the working copy lives in IndexedDB and the operator
 * can download it; "on disk before the first restore" becomes "saved here before the
 * first call that changes a process".
 */

import type { DependencyPlan } from './ledger.ts';

export interface PlanStore {
  /** Replaces the stored plan. Resolves once it is durable. */
  save(plan: DependencyPlan): Promise<void>;
  /** The plan last saved, or null when there is none. */
  load(): Promise<DependencyPlan | null>;
}
