/**
 * Every tenant call the Bulk Delete engine and its orchestrator make, one proxy operation
 * each.
 *
 * The script reaches the tenant through `Invoke-NpmApi` (NintexProcessDependencies.ps1)
 * and a handful of `Invoke-Api*` helpers in Nintex-BulkOperations.ps1. The engine runs in
 * the browser here, so each of those URLs becomes one method naming at most one process
 * or group, like `ArchiveGateway` (archive/outcome.ts) and `MoveGateway` (move/run.ts).
 * The two batch reads are the exception the proxy allows: they only read.
 *
 * A call that fails rejects. The script returned `Success`/`StatusCode`/`Error`; here the
 * HTTP status and the tenant's own message travel on what is thrown, as the browser
 * gateway's `PmRequestError` (ui/gateway.ts) carries them, and `failureOf`
 * (archive/outcome.ts) reads them back.
 *
 * `readModel` does not use a 404 to mean "archived". The tenant answers the active read
 * for an archived process with 200 and only `{"success": true, "isArchived": true}`; 404
 * is a deleted process (Cowork's review of phase 1, measured in S1 and S2). The script
 * fell back to returning that envelope as if it were the model.
 */

import type { ArchiveGateway } from '../archive/outcome.ts';
import type { ProcessListPage } from '../pm/processes.ts';
import type { ProcessUpdateEnvelope } from '../pm/types.ts';
import type { ActiveRead } from '../pm/dependencies.ts';
import type { ProcessModel } from './model.ts';

export { ARCHIVED_BATCH_SIZE, DEPENDENCY_SEARCH_BEHAVIOR, type ActiveRead } from '../pm/dependencies.ts';

/** The script's default `-TempGroupName`. */
export const HOLDING_GROUP_NAME = 'Bulk Delete Temporary Group';

/** A process group as `Get-ProcessGroups` and `New-ProcessGroup` return it. */
export interface GroupRef {
  id: number;
  uniqueId: string;
  name: string;
}

/** One row of a group's process listing (`Get-ProcessesFromGroup`). */
export interface GroupProcess {
  processUniqueId: string;
  /** The listing's name, which for a variation is its master's, suffix dropped. */
  processName: string;
}

export interface RestoreCallOptions {
  /**
   * False sends the call once. The relocation probe asks RestoreProcess something it
   * answers with HTTP 500 every time on the measured tenant, so a retry ladder there is
   * 14 seconds of backoff per process (`Move-NpmProcessToGroup`, `-MaxRetries 0`).
   */
  retry?: boolean;
}

export interface DeleteGateway extends ArchiveGateway {
  /** `GET /Bff/Process/api/v1/processes?Page&PageSize=200&ListType`: 0 active, 7 archived. */
  listProcesses(page: number, listType: number): Promise<ProcessListPage>;

  /**
   * `GET /Api/v1/Processes/{id}/CheckProcessDependencies?searchBehavior=31`, parsed. An
   * empty body (null) is a clean check, not a failed one: the tenant answers 200 with
   * nothing for a process with no dependencies.
   */
  checkDependencies(processUniqueId: string): Promise<unknown>;

  /**
   * `GET /mobile/api/v1/processes?processUniqueIds=...`, at most `ARCHIVED_BATCH_SIZE` ids,
   * each `data[].ProcessModel` unwrapped. Serves archived processes, and some processes
   * neither listing returns. An id it does not serve is simply absent from the result.
   */
  readArchivedModels(processUniqueIds: readonly string[]): Promise<ProcessModel[]>;

  /**
   * `GET /Api/v1/Processes/{id}`: the model for an active process, `{ kind: 'archived' }`
   * for an archived one (200 with no model). Rejects with 404 for a deleted process.
   */
  readModel(processUniqueId: string): Promise<ActiveRead>;

  /**
   * `PUT /Api/v1/Processes/{id}` with `buildUpdateEnvelope` (pm/processes.ts): ProcessJson as
   * a string, SuppressChangeNotification true for reference removal.
   */
  saveModel(processUniqueId: string, envelope: ProcessUpdateEnvelope): Promise<void>;

  /**
   * `POST /Process/Edit/PublishProcessRevisionEdit`, the publish `Save-NpmProcessModel`
   * uses when approvals are off. With approvals on it uses `publishNow`, inherited.
   */
  publishRevisionEdit(processUniqueId: string, processRevisionEditId: number, publishMessage: string): Promise<unknown>;

  /**
   * `POST /Process/Edit/RestoreProcess` into one group. HTTP 500 for a group that does not
   * exist, and on the measured tenant for a process that is already active.
   */
  restore(processUniqueId: string, processGroupId: number, options?: RestoreCallOptions): Promise<unknown>;

  /** `POST /Process/Edit/DeleteProcess`. The group is sent when the ledger knows it. */
  deleteProcess(processUniqueId: string, processGroupUniqueId: string | null): Promise<unknown>;

  /** Every process group, for numeric id to UniqueId (the listing gives only the number). */
  listGroups(): Promise<GroupRef[]>;

  /** `POST /Process/Edit/CreateGroup`, then the new group's numeric id. */
  createGroup(name: string, parentGroupUniqueId: string | null): Promise<GroupRef>;

  /** The proxy's `group.delete`. Deletes a group holding archived processes without asking (S1). */
  deleteGroup(groupUniqueId: string): Promise<unknown>;

  /** The live processes in one group, no subgroups. Archived processes are not listed. */
  groupProcesses(group: GroupRef): Promise<GroupProcess[]>;
}
