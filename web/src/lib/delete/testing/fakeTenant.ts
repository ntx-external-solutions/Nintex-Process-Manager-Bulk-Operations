/**
 * A tenant in memory, behind the `DeleteGateway`, for the ported scenario suites.
 *
 * Test-Executor.ps1 and Test-BulkDelete.ps1 mock `Invoke-NpmApi` at URL level and
 * redefine the mock in nearly every scenario. Here there is one tenant with mutable
 * state, a log of every call, and three hooks for what a scenario changes:
 *
 *  - `fail` answers a call with an HTTP failure before it touches anything (a refused
 *    restore, a 500 dependency check), and `noEffect` answers one with success and
 *    changes nothing (a tenant that accepts a restore and moves nothing);
 *  - `after` runs once a call that changes something has succeeded, for what the
 *    tenant does on its own (a variation dragging its master, a delete stranding a
 *    process);
 *  - `onProcessMutation` listeners run before any call that changes a process, which is
 *    how a test sees what had been saved at the moment of the first one.
 *
 * Defaults follow the tenant as measured, where the PowerShell mocks agree on it: an
 * archived process is not on the active read (404), a live process is in its group's
 * listing and an archived one is not, RestoreProcess answers 500 for a group that is
 * gone, and an empty dependency answer is null. Where the mocks disagree (what
 * RestoreProcess does to a process that is already active) it is an option.
 *
 * Failures are thrown as the browser gateway throws them (`PmRequestError`), so
 * `failureOf` reads the status and the tenant's message exactly as it will in the app.
 *
 * Node only: tests import this, the app never does.
 */

import type { ArchiveState } from '../../archive/outcome.ts';
import { LIST_PAGE_SIZE, type ProcessListItem, type ProcessListPage } from '../../pm/processes.ts';
import type { ProcessUpdateEnvelope } from '../../pm/types.ts';
import { ARCHIVED_LIST_TYPE } from '../../tenant/state.ts';
import { PmRequestError } from '../../ui/gateway.ts';
import { ARCHIVED_BATCH_SIZE, type ActiveRead, type DeleteGateway, type GroupProcess, type GroupRef, type RestoreCallOptions } from '../gateway.ts';
import type { ProcessModel } from '../model.ts';

export interface FakeProcessSeed {
  uniqueId: string;
  name: string;
  /** The listing's `id`. */
  numericId?: number | null;
  archived?: boolean;
  groupId?: number | null;
  /** Defaults to the model's `GroupUniqueId`, then the group's, then empty. */
  groupUniqueId?: string;
  /** Absent: the listing row omits `groupExists`, which is not the same as reporting it true. */
  groupExists?: boolean;
  /** A full model, such as a fixture. Without one, a minimal model is built from the fields here. */
  model?: ProcessModel;
  /** False: in neither listing, as some real processes are, though a read may still serve it. */
  listed?: boolean;
  /** False: the batch read does not serve it either. */
  batchReadable?: boolean;
  /** The parsed `CheckProcessDependencies` answer. Absent is null: the tenant's "no dependencies". */
  dependencies?: unknown;
  /** The group listing's name for it, which for a variation is its master's. */
  groupListingName?: string;
}

export interface FakeProcess {
  uniqueId: string;
  numericId: number | null;
  name: string;
  archived: boolean;
  groupId: number | null;
  groupUniqueId: string;
  groupExists: boolean | undefined;
  model: ProcessModel | null;
  listed: boolean;
  batchReadable: boolean;
  dependencies: unknown;
  groupListingName: string | null;
  revisionEditId: number;
}

export type FakeOp =
  | 'listProcesses'
  | 'checkDependencies'
  | 'readArchivedModels'
  | 'readModel'
  | 'saveModel'
  | 'publishNow'
  | 'publishRevisionEdit'
  | 'archive'
  | 'archiveState'
  | 'restore'
  | 'deleteProcess'
  | 'listGroups'
  | 'createGroup'
  | 'deleteGroup'
  | 'groupProcesses';

/** Every call that changes a process. Creating or deleting the holding group does not. */
export const PROCESS_MUTATIONS: ReadonlySet<FakeOp> = new Set<FakeOp>([
  'saveModel',
  'publishNow',
  'publishRevisionEdit',
  'archive',
  'restore',
  'deleteProcess',
]);

export interface FakeCall {
  op: FakeOp;
  uniqueId?: string;
  uniqueIds?: string[];
  groupId?: number;
  groupUniqueId?: string | null;
  page?: number;
  listType?: number;
  /** Restore only: false for a call sent once, with no retry ladder. */
  retry?: boolean;
  envelope?: ProcessUpdateEnvelope;
  comment?: string;
  name?: string;
  revisionEditId?: number;
  /** The HTTP status it was answered with, when it failed. */
  failedWith?: number;
}

export interface FakeFailure {
  status: number;
  /** The tenant's own words, as `failureOf` reads them. */
  message?: string;
}

/** What RestoreProcess does with a process that is already active. */
export type RestoreActiveBehaviour = 'relocate' | 'refuse' | 'ignore';

export interface FakeTenantOptions {
  processes?: readonly FakeProcessSeed[];
  groups?: readonly GroupRef[];
  /** Deleted groups: RestoreProcess into one answers 500, every time. */
  missingGroupIds?: readonly number[];
  /**
   * Default `relocate`, which is what most of the PowerShell mocks do. The measured
   * tenant refuses with a 500; one mock silently does nothing.
   */
  restoreActive?: RestoreActiveBehaviour;
  /** The group `createGroup` makes; without it, the next free id. */
  holdingGroup?: GroupRef;
  /**
   * The active read (and its archive-state read) also serves archived processes, as most
   * of the PowerShell mocks do. The tenant answers 404, which is the default.
   */
  activeReadServesArchived?: boolean;
  fail?: (call: FakeCall, tenant: FakeTenant) => FakeFailure | null | undefined;
  /** True: the call is answered with success and its usual effect does not happen. */
  noEffect?: (call: FakeCall, tenant: FakeTenant) => boolean;
  after?: (call: FakeCall, tenant: FakeTenant) => void;
}

const key = (uniqueId: string): string => uniqueId.toLowerCase();

export class FakeTenant implements DeleteGateway {
  readonly calls: FakeCall[] = [];
  /** Deleted process ids, in order. */
  readonly deleted: string[] = [];
  /** Deleted group UniqueIds, in order. */
  readonly deletedGroups: string[] = [];
  /** Clear it and every listing row omits `groupExists`: a tenant that never answers the question. */
  reportGroupExists = true;
  restoreActive: RestoreActiveBehaviour;
  activeReadServesArchived: boolean;
  fail: FakeTenantOptions['fail'];
  noEffect: FakeTenantOptions['noEffect'];
  after: FakeTenantOptions['after'];
  readonly missingGroupIds: Set<number>;

  readonly #processes = new Map<string, FakeProcess>();
  readonly #groups = new Map<number, GroupRef>();
  readonly #holdingGroup: GroupRef | undefined;
  readonly #mutationListeners: Array<(call: FakeCall) => void> = [];

  constructor(options: FakeTenantOptions = {}) {
    for (const group of options.groups ?? []) this.#groups.set(group.id, { ...group });
    for (const seed of options.processes ?? []) this.add(seed);
    this.missingGroupIds = new Set(options.missingGroupIds ?? []);
    this.restoreActive = options.restoreActive ?? 'relocate';
    this.activeReadServesArchived = options.activeReadServesArchived ?? false;
    this.#holdingGroup = options.holdingGroup;
    this.fail = options.fail;
    this.noEffect = options.noEffect;
    this.after = options.after;
  }

  // ------------------------------------------------------------ state, for scenarios

  add(seed: FakeProcessSeed): FakeProcess {
    const modelGroupUniqueId = seed.model ? seed.model['GroupUniqueId'] : undefined;
    const groupId = seed.groupId ?? (typeof seed.model?.['GroupId'] === 'number' ? seed.model['GroupId'] : null);
    const revision = seed.model?.['ProcessRevisionEditId'];
    const process: FakeProcess = {
      uniqueId: seed.uniqueId,
      numericId: seed.numericId ?? (typeof seed.model?.['Id'] === 'number' ? seed.model['Id'] : null),
      name: seed.name,
      archived: seed.archived ?? false,
      groupId,
      groupUniqueId:
        seed.groupUniqueId ??
        (typeof modelGroupUniqueId === 'string' ? modelGroupUniqueId : this.#groupUniqueId(groupId)),
      groupExists: seed.groupExists,
      model: seed.model ? structuredClone(seed.model) : null,
      listed: seed.listed ?? true,
      batchReadable: seed.batchReadable ?? true,
      dependencies: seed.dependencies ?? null,
      groupListingName: seed.groupListingName ?? null,
      revisionEditId: typeof revision === 'number' ? revision : 1,
    };
    this.#processes.set(key(seed.uniqueId), process);
    return process;
  }

  process(uniqueId: string): FakeProcess | undefined {
    return this.#processes.get(key(uniqueId));
  }

  exists(uniqueId: string): boolean {
    return this.#processes.has(key(uniqueId));
  }

  isArchived(uniqueId: string): boolean | undefined {
    return this.process(uniqueId)?.archived;
  }

  groupOf(uniqueId: string): number | null | undefined {
    return this.process(uniqueId)?.groupId;
  }

  setArchived(uniqueId: string, archived: boolean): void {
    const process = this.#required(uniqueId);
    process.archived = archived;
  }

  moveTo(uniqueId: string, groupId: number | null): void {
    this.#place(this.#required(uniqueId), groupId);
  }

  remove(uniqueId: string): void {
    this.#processes.delete(key(uniqueId));
  }

  /** The model as a read would return it now. */
  modelOf(uniqueId: string): ProcessModel | undefined {
    const process = this.process(uniqueId);
    return process ? this.#view(process) : undefined;
  }

  group(id: number): GroupRef | undefined {
    return this.#groups.get(id);
  }

  addGroup(group: GroupRef): void {
    this.#groups.set(group.id, { ...group });
  }

  /** Calls of one kind, optionally for one process. */
  callsTo(op: FakeOp, uniqueId?: string): FakeCall[] {
    return this.calls.filter(
      (call) => call.op === op && (uniqueId === undefined || (call.uniqueId !== undefined && key(call.uniqueId) === key(uniqueId))),
    );
  }

  onProcessMutation(listener: (call: FakeCall) => void): void {
    this.#mutationListeners.push(listener);
  }

  // ------------------------------------------------------------ the gateway

  async listProcesses(page: number, listType: number): Promise<ProcessListPage> {
    this.#begin({ op: 'listProcesses', page, listType });
    const archived = listType === ARCHIVED_LIST_TYPE;
    const rows = [...this.#processes.values()].filter((p) => p.listed && p.archived === archived);
    const items = rows.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE).map((p) => this.#row(p));
    return { items, totalItemCount: rows.length };
  }

  async checkDependencies(processUniqueId: string): Promise<unknown> {
    this.#begin({ op: 'checkDependencies', uniqueId: processUniqueId });
    const process = this.process(processUniqueId);
    return process ? structuredClone(process.dependencies) : null;
  }

  async readArchivedModels(processUniqueIds: readonly string[]): Promise<ProcessModel[]> {
    this.#begin({ op: 'readArchivedModels', uniqueIds: [...processUniqueIds] }, () =>
      processUniqueIds.length > ARCHIVED_BATCH_SIZE ? { status: 414, message: 'Request-URI Too Long' } : null,
    );
    const out: ProcessModel[] = [];
    for (const id of processUniqueIds) {
      const process = this.process(id);
      if (process && process.batchReadable) out.push(this.#view(process));
    }
    return out;
  }

  async readModel(processUniqueId: string): Promise<ActiveRead> {
    const process = this.process(processUniqueId);
    // 404 is for a deleted process. An archived one answers 200 with only
    // `{success, isArchived}` and no model, as the tenant was measured to (S1, S2).
    this.#begin({ op: 'readModel', uniqueId: processUniqueId }, () => (process ? null : notFound()));
    if (!this.#onActiveSide(process!)) return { kind: 'archived' };
    return { kind: 'model', model: this.#view(process!) };
  }

  async saveModel(processUniqueId: string, envelope: ProcessUpdateEnvelope): Promise<void> {
    const process = this.process(processUniqueId);
    const call: FakeCall = { op: 'saveModel', uniqueId: processUniqueId, envelope: structuredClone(envelope) };
    if (this.#begin(call, () => (process && this.#onActiveSide(process) ? null : notFound()))) return;
    // An object instead of a string is answered 200 and the edit dropped, as the tenant does.
    if (typeof envelope.ProcessJson === 'string') {
      process!.model = JSON.parse(envelope.ProcessJson) as ProcessModel;
      process!.revisionEditId += 1;
    }
    this.#end(call);
  }

  async publishNow(processUniqueId: string, processRevisionEditId: number, publishMessage: string): Promise<unknown> {
    return this.#publish('publishNow', processUniqueId, processRevisionEditId, publishMessage);
  }

  async publishRevisionEdit(processUniqueId: string, processRevisionEditId: number, publishMessage: string): Promise<unknown> {
    return this.#publish('publishRevisionEdit', processUniqueId, processRevisionEditId, publishMessage);
  }

  async archive(processUniqueId: string, comment: string): Promise<unknown> {
    const process = this.process(processUniqueId);
    const call: FakeCall = { op: 'archive', uniqueId: processUniqueId, comment };
    if (this.#begin(call, () => (process ? null : notFound()))) return {};
    process!.archived = true;
    this.#end(call);
    return {};
  }

  async archiveState(processUniqueId: string): Promise<ArchiveState> {
    this.#begin({ op: 'archiveState', uniqueId: processUniqueId });
    const process = this.process(processUniqueId);
    if (!process) return { found: false, isArchived: null, revisionEditId: null };
    // What the live getArchiveState reads off the archived envelope: archived, no revision.
    if (!this.#onActiveSide(process)) return { found: true, isArchived: true, revisionEditId: null };
    return { found: true, isArchived: process.archived, revisionEditId: process.revisionEditId };
  }

  async restore(processUniqueId: string, processGroupId: number, options?: RestoreCallOptions): Promise<unknown> {
    const process = this.process(processUniqueId);
    const call: FakeCall = { op: 'restore', uniqueId: processUniqueId, groupId: processGroupId, retry: options?.retry ?? true };
    const skip = this.#begin(call, () => {
      if (!process) return notFound();
      if (this.missingGroupIds.has(processGroupId)) return serverError();
      if (!process.archived && this.restoreActive === 'refuse') return serverError();
      return null;
    });
    if (skip) return {};
    if (process!.archived || this.restoreActive === 'relocate') {
      process!.archived = false;
      this.#place(process!, processGroupId);
    }
    this.#end(call);
    return {};
  }

  async deleteProcess(processUniqueId: string, processGroupUniqueId: string | null): Promise<unknown> {
    const call: FakeCall = { op: 'deleteProcess', uniqueId: processUniqueId, groupUniqueId: processGroupUniqueId };
    if (this.#begin(call, () => (this.exists(processUniqueId) ? null : notFound()))) return {};
    this.remove(processUniqueId);
    this.deleted.push(processUniqueId);
    this.#end(call);
    return {};
  }

  async listGroups(): Promise<GroupRef[]> {
    this.#begin({ op: 'listGroups' });
    return [...this.#groups.values()].map((group) => ({ ...group }));
  }

  async createGroup(name: string, parentGroupUniqueId: string | null): Promise<GroupRef> {
    const call: FakeCall = { op: 'createGroup', name, groupUniqueId: parentGroupUniqueId };
    this.#begin(call);
    const id = this.#holdingGroup?.id ?? Math.max(0, ...this.#groups.keys()) + 1;
    const group: GroupRef = { id, uniqueId: this.#holdingGroup?.uniqueId ?? `group-${id}`, name };
    this.#groups.set(id, group);
    this.#end(call);
    return { ...group };
  }

  async deleteGroup(groupUniqueId: string): Promise<unknown> {
    const group = [...this.#groups.values()].find((g) => g.uniqueId === groupUniqueId);
    const call: FakeCall = { op: 'deleteGroup', groupUniqueId };
    if (this.#begin(call, () => (group ? null : notFound()))) return {};
    this.#groups.delete(group!.id);
    this.deletedGroups.push(groupUniqueId);
    this.#end(call);
    return {};
  }

  async groupProcesses(group: GroupRef): Promise<GroupProcess[]> {
    this.#begin({ op: 'groupProcesses', groupId: group.id, groupUniqueId: group.uniqueId });
    return [...this.#processes.values()]
      .filter((p) => !p.archived && p.groupId === group.id)
      .map((p) => ({ processUniqueId: p.uniqueId, processName: p.groupListingName ?? p.name }));
  }

  // ------------------------------------------------------------ plumbing

  /**
   * Logs the call, tells the mutation listeners, then throws any failure. True when the
   * call is to succeed without its effect.
   */
  #begin(call: FakeCall, builtIn?: () => FakeFailure | null): boolean {
    this.calls.push(call);
    if (PROCESS_MUTATIONS.has(call.op)) for (const listener of this.#mutationListeners) listener(call);
    const failure = this.fail?.(call, this) ?? builtIn?.() ?? null;
    if (failure) {
      call.failedWith = failure.status;
      throw new PmRequestError(failure.message ?? `Request failed (HTTP ${failure.status}).`, {
        status: failure.status,
        tenantMessage: failure.message ?? null,
      });
    }
    return this.noEffect?.(call, this) ?? false;
  }

  #end(call: FakeCall): void {
    this.after?.(call, this);
  }

  async #publish(
    op: 'publishNow' | 'publishRevisionEdit',
    processUniqueId: string,
    processRevisionEditId: number,
    publishMessage: string,
  ): Promise<unknown> {
    const call: FakeCall = { op, uniqueId: processUniqueId, revisionEditId: processRevisionEditId, comment: publishMessage };
    this.#begin(call, () => (this.exists(processUniqueId) ? null : notFound()));
    this.#end(call);
    return { actionUrl: '' };
  }

  #onActiveSide(process: FakeProcess): boolean {
    return !process.archived || this.activeReadServesArchived;
  }

  #required(uniqueId: string): FakeProcess {
    const process = this.process(uniqueId);
    if (!process) throw new Error(`The fake tenant has no process ${uniqueId}.`);
    return process;
  }

  /** Into a group. Staying put keeps the UniqueId the model came with, which the tenant knows and this fake may not. */
  #place(process: FakeProcess, groupId: number | null): void {
    if (process.groupId === groupId) return;
    process.groupId = groupId;
    process.groupUniqueId = this.#groupUniqueId(groupId);
  }

  #groupUniqueId(groupId: number | null): string {
    return groupId === null ? '' : (this.#groups.get(groupId)?.uniqueId ?? '');
  }

  /** A read's copy of the model, with the fields the tenant keeps current laid over it. */
  #view(process: FakeProcess): ProcessModel {
    const base: ProcessModel = process.model
      ? structuredClone(process.model)
      : { UniqueId: process.uniqueId, Id: process.numericId, Name: process.name, Version: '0.1' };
    base['GroupId'] = process.groupId;
    base['GroupUniqueId'] = process.groupUniqueId;
    base['StateId'] = process.archived ? 2 : 1;
    base['ProcessRevisionEditId'] = process.revisionEditId;
    return base;
  }

  /**
   * A listing row. DIFFERS from `ProcessListItem`: the row also carries `id`, the field
   * `Get-NpmProcessIndex` reads the numeric id from, beside the typed `processId`.
   */
  #row(process: FakeProcess): ProcessListItem {
    const row: Record<string, unknown> = {
      id: process.numericId,
      processId: process.numericId ?? 0,
      processName: process.name,
      processUniqueId: process.uniqueId,
      processState: process.archived ? 'Archived' : 'Active',
      groupId: process.groupId,
      groupUniqueId: process.groupUniqueId,
      groupName: process.groupId === null ? '' : (this.#groups.get(process.groupId)?.name ?? ''),
      processOwner: '',
      processExpert: '',
    };
    if (this.reportGroupExists && process.groupExists !== undefined) row['groupExists'] = process.groupExists;
    return row as unknown as ProcessListItem;
  }
}

function notFound(): FakeFailure {
  return { status: 404, message: 'Not found' };
}

function serverError(): FakeFailure {
  return { status: 500, message: 'Internal Server Error' };
}
