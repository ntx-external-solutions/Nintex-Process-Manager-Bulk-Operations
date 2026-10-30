/**
 * What holds a document, and the sentence a skipped row gives for it (W8 decision 1).
 *
 * Three sources, and any one of them keeps the document:
 *  - `attachedProcesses` from its properties, active or archived holder;
 *  - `attachedTrainings` (training units count as attachments, decision 3);
 *  - a reference in the current model of an active process, which is the only way a
 *    reference in an unpublished draft is found (references.ts).
 */

import { nodeArray, nodeString, nodeValue } from '../delete/model.ts';
import type { ProcessIndex } from '../tenant/state.ts';
import type { ReferencingProcess } from './references.ts';

export interface DocumentProperties {
  /** Null when the answer did not say. */
  isArchived: boolean | null;
  isPending: boolean | null;
  /** The primary group's numeric id, for the results file's GroupId. */
  primaryGroupId: number | null;
  associatedGroups: Array<{ name: string; id: number | null }>;
  attachedProcesses: Array<{ name: string; uniqueId: string }>;
  attachedTrainings: Array<{ name: string }>;
}

function bool(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function positive(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

/** `associatedGroups` was measured as `{key: name, value: id}` pairs; a plain map is read too. */
function groupsOf(value: unknown): DocumentProperties['associatedGroups'] {
  if (Array.isArray(value)) {
    return value.map((pair) => ({ name: nodeString(pair, 'key'), id: positive(nodeValue(pair, 'value')) }));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).map(([name, id]) => ({ name, id: positive(id) }));
  }
  return [];
}

export function toDocumentProperties(raw: unknown, primaryGroupName = ''): DocumentProperties {
  const associatedGroups = groupsOf(nodeValue(raw, 'associatedGroups'));
  // `primaryProcessGroupId` was seen without its type being recorded; a number is taken
  // as is, and otherwise the primary group's own entry among the associated groups.
  const primaryGroupId =
    positive(nodeValue(raw, 'primaryProcessGroupId')) ??
    associatedGroups.find((g) => primaryGroupName !== '' && g.name === primaryGroupName)?.id ??
    null;
  return {
    isArchived: bool(nodeValue(raw, 'isArchived')),
    isPending: bool(nodeValue(raw, 'isPending')),
    primaryGroupId,
    associatedGroups,
    attachedProcesses: nodeArray(raw, 'attachedProcesses').map((p) => ({
      name: nodeString(p, 'processName').trim(),
      uniqueId: nodeString(p, 'processUniqueId').trim(),
    })),
    attachedTrainings: nodeArray(raw, 'attachedTrainings').map((t) => ({
      // The training unit's field was not recorded in the spike (R16 checks it).
      name:
        ['trainingName', 'trainingUnitName', 'name', 'title'].map((f) => nodeString(t, f).trim()).find((n) => n !== '') ??
        'a training unit with no name given',
    })),
  };
}

/** Up to five names, then how many more. */
export function nameList(names: readonly string[], shown = 5): string {
  const head = names.slice(0, shown);
  const rest = names.length - head.length;
  return rest > 0 ? `${head.join(', ')} and ${rest} more` : head.join(', ');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a document is held, naming every holder, or null when nothing holds it.
 *
 * "Attached to 2 processes: A (archived), B. Used by training unit C. In the unpublished
 * draft of D." A process the scan found that `attachedProcesses` also lists is named once.
 */
export function holdersMessage(
  properties: DocumentProperties,
  referencing: readonly ReferencingProcess[],
  index: ProcessIndex,
): string | null {
  const parts: string[] = [];

  const attached = properties.attachedProcesses;
  if (attached.length > 0) {
    const names = attached.map((p) => {
      const archived = index.get(p.uniqueId.toLowerCase())?.isArchived === true;
      const name = p.name || index.get(p.uniqueId.toLowerCase())?.name || p.uniqueId;
      return archived ? `${name} (archived)` : name;
    });
    parts.push(`Attached to ${plural(attached.length, 'process', 'processes')}: ${nameList(names)}`);
  }

  const trainings = properties.attachedTrainings;
  if (trainings.length === 1) parts.push(`Used by training unit ${trainings[0]!.name}`);
  else if (trainings.length > 1) parts.push(`Used by ${trainings.length} training units: ${nameList(trainings.map((t) => t.name))}`);

  const listed = new Set(attached.map((p) => p.uniqueId.toLowerCase()));
  const unlisted = referencing.filter((p) => !listed.has(p.uniqueId.toLowerCase()));
  const drafts = unlisted.filter((p) => !p.published).map((p) => p.name);
  const published = unlisted.filter((p) => p.published).map((p) => p.name);
  if (drafts.length === 1) parts.push(`In the unpublished draft of ${drafts[0]}`);
  else if (drafts.length > 1) parts.push(`In the unpublished drafts of ${drafts.length} processes: ${nameList(drafts)}`);
  // Published and not in attachedProcesses should not happen; named anyway, since it holds the document.
  if (published.length > 0) parts.push(`Referenced by ${plural(published.length, 'process', 'processes')}: ${nameList(published)}`);

  return parts.length > 0 ? `${parts.join('. ')}.` : null;
}

/** Whether the properties alone say something holds it: the per-batch re-check before a write. */
export function attachedNow(properties: DocumentProperties): boolean {
  return properties.attachedProcesses.length > 0 || properties.attachedTrainings.length > 0;
}
