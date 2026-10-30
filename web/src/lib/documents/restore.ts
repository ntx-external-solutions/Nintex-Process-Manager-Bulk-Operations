/**
 * Restore documents (W8c): archived documents back to active.
 *
 * `POST .../documents/bulk/restore` returns each document to its primary group with its
 * associations (spike). Attachments don't matter: restoring is always safe. Two things
 * keep a document out: it isn't archived, or its primary group is gone, so a restore
 * would have nowhere to go. An archived document blocks its group's deletion (spike), so
 * the second shouldn't happen; it is checked rather than assumed.
 */

import { resultRow, type ResultRow } from '../exec/report.ts';
import type { Controls } from '../exec/runner.ts';
import { runDocumentBatches, type DocumentRunOptions, type DocumentTarget, type PropertiesRead } from './archive.ts';
import { restoreWrite, settleDocumentDelete, type DocumentDeleteGateway } from './delete.ts';
import { documentPath, type DocumentIndex } from './list.ts';
import type { ChosenDocument } from './select.ts';

export const NOT_ARCHIVED = 'Not archived';
export const GROUP_GONE = 'Its group no longer exists';
export const GROUP_UNKNOWN = 'Neither the list nor the document says what its group is, so it is not restored';

/** Per primary group (lowercased GUID): whether it exists, or why that couldn't be read. */
export type GroupCheck = ReadonlyMap<string, boolean | { error: string }>;

export interface DocumentRestorePlan {
  targets: DocumentTarget[];
  skipped: ResultRow[];
}

/**
 * Whether each group exists, from its breadcrumb: a deleted group's comes back empty
 * (spike S1). One call per distinct group. A dead session ends the plan.
 */
export async function checkGroupsExist(
  groupUniqueIds: readonly string[],
  breadcrumb: (groupUniqueId: string) => Promise<string[]>,
  options: { isFatal?: (error: unknown) => boolean; errorText?: (error: unknown) => string; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, boolean | { error: string }>> {
  const unique = [...new Set(groupUniqueIds.map((g) => g.toLowerCase()))];
  const out = new Map<string, boolean | { error: string }>();
  for (let i = 0; i < unique.length; i += 4) {
    await Promise.all(
      unique.slice(i, i + 4).map(async (g) => {
        try {
          out.set(g, (await breadcrumb(g)).length > 0);
        } catch (error) {
          if (options.isFatal?.(error)) throw error;
          out.set(g, { error: options.errorText?.(error) ?? String(error) });
        }
      }),
    );
    options.onProgress?.(Math.min(i + 4, unique.length), unique.length);
  }
  return out;
}

export function buildDocumentRestorePlan(input: {
  chosen: readonly ChosenDocument[];
  resolveSkipped?: readonly ResultRow[];
  paths: ReadonlyMap<string, string[]>;
  properties: ReadonlyMap<string, PropertiesRead>;
  groups: GroupCheck;
}): DocumentRestorePlan {
  const targets: DocumentTarget[] = [];
  const skipped: ResultRow[] = [...(input.resolveSkipped ?? [])];

  for (const c of input.chosen) {
    const read = input.properties.get(c.entry.uniqueId.toLowerCase());
    const props = read && !('error' in read) ? read : null;
    const groupId = props?.primaryGroupId ?? null;
    const skip = (message: string) =>
      skipped.push(resultRow({ objectType: 'Document', objectId: c.entry.uniqueId, name: c.entry.name, operation: 'Restore', status: 'Skipped', message, groupId }));

    if (!(props?.isArchived ?? c.entry.isArchived)) {
      skip(NOT_ARCHIVED);
      continue;
    }
    if (read && 'error' in read) {
      skip(`Could not read it (${read.error}), so it is not restored. Build the plan again to retry.`);
      continue;
    }
    const group = c.entry.primaryGroupUniqueId?.toLowerCase();
    const exists = group === undefined ? undefined : input.groups.get(group);
    if (group === undefined) {
      skip(GROUP_UNKNOWN);
      continue;
    }
    if (exists === false) {
      skip(GROUP_GONE);
      continue;
    }
    if (exists === undefined || typeof exists === 'object') {
      skip(`Could not check that its group still exists (${exists?.error ?? 'not read'}), so it is not restored. Build the plan again to retry.`);
      continue;
    }
    targets.push({
      documentId: c.entry.documentId,
      uniqueId: c.entry.uniqueId,
      name: c.entry.name,
      path: documentPath(c.entry, input.paths),
      groupId,
      groupUniqueId: c.entry.primaryGroupUniqueId,
      isArchived: true,
      chosen: c.chosen,
      location: c.entry.location,
      type: c.entry.type,
    });
  }
  return { targets, skipped };
}

export function restorePreviewRows(plan: DocumentRestorePlan): ResultRow[] {
  return [
    ...plan.skipped,
    ...plan.targets.map((t) =>
      resultRow({ objectType: 'Document', objectId: t.uniqueId, name: t.name, operation: 'Restore', status: 'Preview', message: 'Would be restored to its group', groupId: t.groupId }),
    ),
  ];
}

/** Batches of up to 50, no re-check, every `errors` entry a Failed row. */
export function runDocumentRestore(
  gateway: Pick<DocumentDeleteGateway, 'properties' | 'restore'>,
  targets: readonly DocumentTarget[],
  controls: Controls,
  options: Omit<DocumentRunOptions, 'index'>,
): Promise<ResultRow[]> {
  return runDocumentBatches(gateway, targets, controls, restoreWrite(gateway), options);
}

/** Restore rows' final status: active is restored, still archived is not, in neither list is unconfirmed. */
export function settleDocumentRestore(rows: readonly ResultRow[], after: DocumentIndex): ResultRow[] {
  return settleDocumentDelete(rows, after);
}

export const DOCUMENT_RESTORE_STATUSES = ['Success', 'Preview', 'Skipped', 'Unverified', 'Failed'] as const;
