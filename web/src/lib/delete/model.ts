/**
 * Process models as the API returns them, and the index entries the engine reads.
 *
 * A model is the unwrapped `processJson`: plain JSON whose collections may be absent,
 * null, a bare object or an array ("Outputs": null is a live payload, not an edge case).
 * The script reads every field through `Get-NodeValue` and friends, which are
 * case-insensitive because PowerShell property access is. These keep that, so a tenant
 * that sends `linkedProcessUniqueId` is not read as one that sends nothing.
 */

import { notPorted } from './phases.ts';
import type { IndexEntry } from '../tenant/state.ts';

export type ProcessNode = Record<string, unknown>;

/** The unwrapped `processJson` of one process. */
export type ProcessModel = ProcessNode;

/**
 * An index entry with the two fields the script's index carries and `IndexEntry` does
 * not.
 *
 * DIFFERS: `Get-NpmProcessIndex` records `NumericId` (the listing's `id`) and
 * `GroupExistsReported` (whether the row carried `groupExists` at all).
 * `tenant/state.ts` keeps neither. The snapshot and plan ledger need the first, and
 * `groupExistsCoverage` needs the second, so the delete engine reads this wider entry.
 * Whoever ports discovery decides whether `loadProcessIndex` grows them.
 */
export interface DeleteIndexEntry extends IndexEntry {
  numericId: number | null;
  groupExistsReported: boolean;
}

/** Keyed by lowercased process id, as `ProcessIndex` is. */
export type DeleteIndex = ReadonlyMap<string, DeleteIndexEntry>;

/** A field's value, matched case-insensitively; null when the node or field is absent. Port of `Get-NodeValue`. */
export function nodeValue(node: unknown, name: string): unknown {
  return notPorted('discovery');
}

/** Whether the payload carried the field at all, distinct from its being null. Port of `Test-NodeHasProperty`. */
export function nodeHas(node: unknown, name: string): boolean {
  return notPorted('discovery');
}

/** Assigns only to a field that already exists, so a write never invents schema. Port of `Set-NodeValue`. */
export function setNodeValue(node: unknown, name: string, value: unknown): boolean {
  return notPorted('discovery');
}

/** A collection field as an array: absent or null is empty, a bare object is one element. Port of `Get-NodeArray`. */
export function nodeArray(node: unknown, name: string): unknown[] {
  return notPorted('discovery');
}
