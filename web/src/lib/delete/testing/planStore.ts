/**
 * A plan store in memory that keeps every save, and can say what had been saved at the
 * moment the run first changed a process.
 *
 * Test-BulkDelete.ps1 reads `Delete_Plan_*.json` from inside its RestoreProcess mock,
 * because that file, as it stood then, is what a crashed run would be recovered from.
 * `watch` does the same against the fake tenant's mutation listener.
 *
 * Node only: tests import this, the app never does.
 */

import type { DependencyPlan } from '../ledger.ts';
import type { PlanStore } from '../planStore.ts';
import type { FakeTenant } from './fakeTenant.ts';

export class FakePlanStore implements PlanStore {
  /** Copies, in order, so a later change to the plan object cannot rewrite history. */
  readonly saves: DependencyPlan[] = [];
  /** Undefined until the first process mutation; then the plan saved by that moment, or null if none was. */
  atFirstMutation: DependencyPlan | null | undefined = undefined;

  async save(plan: DependencyPlan): Promise<void> {
    this.saves.push(structuredClone(plan));
  }

  async load(): Promise<DependencyPlan | null> {
    return this.latest();
  }

  latest(): DependencyPlan | null {
    const last = this.saves.at(-1);
    return last ? structuredClone(last) : null;
  }

  watch(tenant: FakeTenant): this {
    tenant.onProcessMutation(() => {
      if (this.atFirstMutation === undefined) this.atFirstMutation = this.latest();
    });
    return this;
  }
}
