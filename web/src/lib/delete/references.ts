/**
 * Where one process references another, and what removes each reference.
 *
 * The dependency API is a candidate index, not a location index (API_ARCHITECTURE.md):
 * it never says which side of a pair holds the reference. This module is the ground
 * truth it cannot provide. Everything here is pure: no network, and the caller's model
 * is never mutated.
 */

import { nodeArray, nodeString, nodeValue, type ProcessModel, type ProcessNode } from './model.ts';
import { notPorted } from './phases.ts';

export type SiteCategory = 'Link' | 'Input' | 'Output' | 'Group';

/**
 * Remove drops the element (ProcessLink, Input, Output, ...). Orphan clears its link
 * fields and keeps it, because the element carries process content of its own. Report
 * is never mutated (group links).
 */
export type SiteAction = 'Remove' | 'Orphan' | 'Report';

/**
 * The reference location map (`$script:ProcedureBuckets`). A bucket missing from this
 * table is a reference that survives removal while the run reports success.
 */
export const PROCEDURE_BUCKETS = [
  { bucket: 'Activity', field: 'LinkedProcessUniqueId', action: 'Orphan' },
  { bucket: 'Decision', field: 'LinkedProcessUniqueId', action: 'Orphan' },
  { bucket: 'ProcessLink', field: 'LinkedProcessUniqueId', action: 'Remove' },
  { bucket: 'OrphanProcessLink', field: 'LinkedProcessUniqueId', action: 'Remove' },
  { bucket: 'EmbeddedProcessLink', field: 'LinkedProcessUniqueId', action: 'Remove' },
  { bucket: 'OrphanEmbeddedProcessLink', field: 'LinkedProcessUniqueId', action: 'Remove' },
  { bucket: 'ProcessGroupLink', field: 'LinkedProcessGroupUniqueId', action: 'Report' },
  { bucket: 'OrphanProcessGroupLink', field: 'LinkedProcessGroupUniqueId', action: 'Report' },
] as const satisfies ReadonlyArray<{ bucket: string; field: string; action: SiteAction }>;

export type ProcedureBucket = (typeof PROCEDURE_BUCKETS)[number]['bucket'];

/**
 * Typed arrays inside any node's `ChildProcessProcedures`. Children carry their own
 * `ChildProcessProcedures`, so the walk recurses rather than stopping one level down.
 */
export const CHILD_PROCEDURE_TYPES = [
  'Task',
  'Note',
  'Information',
  'Form',
  'Guide',
  'Image',
  'Policy',
  'Training',
  'Video',
  'WebLink',
] as const;

export type ChildProcedureType = (typeof CHILD_PROCEDURE_TYPES)[number];

/** Inputs and Outputs: two flat collections off the root, removed by dropping the element. */
export const IO_BUCKETS = [
  { container: 'Inputs', bucket: 'Input', field: 'FromProcessUniqueId', category: 'Input' },
  { container: 'Outputs', bucket: 'Output', field: 'ToProcessUniqueId', category: 'Output' },
] as const;

export type ReferenceBucket = ProcedureBucket | ChildProcedureType | 'Input' | 'Output';

/**
 * Fields cleared when a node is orphaned. `LinkedProcessDisplayName` is deliberately
 * absent: it is kept so the UI still shows what was linked.
 */
export const ORPHAN_CLEAR_FIELDS = [
  'LinkedProcessId',
  'LinkedProcessUniqueId',
  'LinkedProcessName',
  'LinkedProcessStateId',
  'EmbeddedLinkedProcessId',
  'LinkedProcessGroupId',
  'LinkedProcessGroupName',
  'LinkedProcessGroupUniqueId',
] as const;

/** A Decision's live link type, and what orphaning turns it into. */
export const DECISION_LINK_LIVE = 4;
export const DECISION_LINK_ORPHANED = 7;

/** One physical reference. Replaces the script's `New-ReferenceSite`, which only built this object. */
export interface ReferenceSite {
  /** The process whose model holds the reference. Empty when the model carried no UniqueId. */
  holderUniqueId: string;
  /** The target as the caller spelled it, whatever casing the payload used. */
  targetUniqueId: string;
  /** e.g. `ProcessProcedures.Activity[1].ChildProcessProcedures.Note[0]`. */
  path: string;
  bucket: ReferenceBucket;
  category: SiteCategory;
  action: SiteAction;
  matchedField: string;
  /** The element's own `Id`, as the payload gave it. */
  elementId: number | string | null;
  /** Found inside a `ChildProcessProcedures`, so always orphaned rather than removed. */
  isChild: boolean;
}

/** The result of cleaning one holder. */
export interface ReferenceRemoval {
  /** A deep copy with the references removed; null when the model was null. */
  cleaned: ProcessModel | null;
  referencesRemoved: number;
  /** The sites found before cleaning, for reconciliation. */
  sites: ReferenceSite[];
}

/** Deep clone, so the caller's model is never mutated. Port of `Copy-ProcessObject`. */
export function copyProcessObject(model: ProcessModel | null | undefined): ProcessModel | null {
  return notPorted('references');
}

/**
 * The target a node's field points at, matched case-insensitively (tenant payloads are
 * inconsistent about GUID casing), returned as the caller spelled it; null for a blank
 * field or no match. Port of `Test-TargetMatch`.
 */
export function matchTarget(node: unknown, field: string, targetUniqueIds: readonly string[]): string | null {
  const value = nodeString(node, field);
  if (value.trim() === '') return null;
  const lower = value.toLowerCase();
  // The first target that matches, in the caller's order, as the script's loop returns it.
  return targetUniqueIds.find((t) => t.toLowerCase() === lower) ?? null;
}

function elementId(node: unknown): number | string | null {
  const id = nodeValue(node, 'Id');
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

/** Sites under a node's `ChildProcessProcedures`, recursively. Port of `Find-ChildReferenceSite`. */
export function findChildReferenceSites(
  node: unknown,
  parentPath: string,
  holderUniqueId: string,
  targetUniqueIds: readonly string[],
): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const children = nodeValue(node, 'ChildProcessProcedures');
  if (children === null) return sites;

  for (const childType of CHILD_PROCEDURE_TYPES) {
    const items = nodeArray(children, childType);
    items.forEach((child, i) => {
      if (child === null || child === undefined) return;
      const path = `${parentPath}.ChildProcessProcedures.${childType}[${i}]`;
      const matched = matchTarget(child, 'LinkedProcessUniqueId', targetUniqueIds);
      if (matched) {
        // Children are always orphaned: they carry their own text, which has nothing to
        // do with the link being cleared.
        sites.push({
          holderUniqueId,
          targetUniqueId: matched,
          path,
          bucket: childType,
          category: 'Link',
          action: 'Orphan',
          matchedField: 'LinkedProcessUniqueId',
          elementId: elementId(child),
          isChild: true,
        });
      }
      sites.push(...findChildReferenceSites(child, path, holderUniqueId, targetUniqueIds));
    });
  }
  return sites;
}

/**
 * Every place one process references any of the targets: procedure buckets, their
 * children at any depth, Inputs and Outputs. Group-link buckets match
 * `targetGroupUniqueIds` instead and are Report-only. `LinkedStakeholders` is never a
 * site. Port of `Find-ProcessReferenceSite`.
 */
export function findProcessReferenceSites(
  model: ProcessModel | null | undefined,
  targetUniqueIds: readonly string[],
  targetGroupUniqueIds: readonly string[] = [],
): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  if (model === null || model === undefined) return sites;

  const holder = nodeString(model, 'UniqueId');
  const procedures = nodeValue(model, 'ProcessProcedures');

  if (procedures !== null) {
    for (const spec of PROCEDURE_BUCKETS) {
      nodeArray(procedures, spec.bucket).forEach((node, i) => {
        if (node === null || node === undefined) return;
        const path = `ProcessProcedures.${spec.bucket}[${i}]`;
        // Group link buckets match group ids, not process ids, and are only reported.
        const report = spec.action === 'Report';
        const matched = matchTarget(node, spec.field, report ? targetGroupUniqueIds : targetUniqueIds);
        if (matched) {
          sites.push({
            holderUniqueId: holder,
            targetUniqueId: matched,
            path,
            bucket: spec.bucket,
            category: report ? 'Group' : 'Link',
            action: spec.action,
            matchedField: spec.field,
            elementId: elementId(node),
            isChild: false,
          });
        }
        // Every procedure node can carry children, not just Activity.
        sites.push(...findChildReferenceSites(node, path, holder, targetUniqueIds));
      });
    }
  }

  sites.push(...findInputOutputReferenceSites(model, targetUniqueIds));
  return sites;
}

/**
 * Input and Output sites only, without walking the activity tree: what the archived
 * blind-spot sweep needs, at a fraction of the cost. Port of `Find-InputOutputReferenceSite`.
 */
export function findInputOutputReferenceSites(
  model: ProcessModel | null | undefined,
  targetUniqueIds: readonly string[],
): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  if (model === null || model === undefined) return sites;

  const holder = nodeString(model, 'UniqueId');
  for (const spec of IO_BUCKETS) {
    // Live payloads use null, not [], when unused.
    const container = nodeValue(model, spec.container);
    if (container === null) continue;
    nodeArray(container, spec.bucket).forEach((node, i) => {
      if (node === null || node === undefined) return;
      const matched = matchTarget(node, spec.field, targetUniqueIds);
      if (!matched) return;
      sites.push({
        holderUniqueId: holder,
        targetUniqueId: matched,
        path: `${spec.container}.${spec.bucket}[${i}]`,
        bucket: spec.bucket,
        category: spec.category,
        action: 'Remove',
        matchedField: spec.field,
        elementId: elementId(node),
        isChild: false,
      });
    });
  }
  return sites;
}

/**
 * Orphans a link in place: clears `ORPHAN_CLEAR_FIELDS` that exist, keeps the display
 * name, and turns a live Decision link (4) into an orphaned one (7). Mutates `node`.
 * Port of `Clear-NodeLink`.
 */
export function clearNodeLink(node: ProcessNode, bucket: string): void {
  return notPorted('references');
}

/** Orphans matching children under a node, recursively; returns how many. Mutates `node`. Port of `Remove-ChildReference`. */
export function removeChildReferences(node: ProcessNode, targetUniqueIds: readonly string[]): number {
  return notPorted('references');
}

/**
 * Every reference to the targets removed from one holder, on a copy, in one pass for all
 * targets. Filters by value rather than replaying site paths, because dropping an
 * element shifts the indices after it. Port of `Remove-ProcessReference`.
 */
export function removeProcessReferences(
  model: ProcessModel | null | undefined,
  targetUniqueIds: readonly string[],
): ReferenceRemoval {
  return notPorted('references');
}
