/**
 * Which of the groups an archive covered can now be deleted, and why the rest cannot.
 *
 * The server checks almost nothing here (spike S1): `DeleteGroup` deletes a group that
 * holds archived processes, orphaning them so they can never be restored to it, and only
 * refuses when the group holds a document. So the app does the checking:
 *
 *  - a group that still holds anything in the tree (an active process, a shortcut, a
 *    document group, an item of a type nobody has measured) is kept;
 *  - a group with any document, archived or not, is kept, rather than sending a delete
 *    the tenant is known to refuse;
 *  - a group holding a subgroup that is kept is kept, which is why groups are decided
 *    deepest first;
 *  - a group whose contents could not be read is kept. Not knowing is not "empty".
 *
 * Every group that would be deleted carries the archived processes that will lose their
 * home, so the warning can name each one.
 */

import { kindOf } from '../select/browse.ts';
import type { CoveredGroup } from '../select/resolve.ts';
import type { TreeItem } from '../pm/types.ts';

export interface OrphanedByDelete {
  uniqueId: string;
  name: string;
}

export interface GroupFacts {
  /** The group's level from the tree, read after the archive. null when unreadable. */
  children: readonly TreeItem[] | null;
  /** Documents in the group. null when unreadable. */
  documents: { total: number; names: string[] } | null;
  /** Archived processes whose group this is. */
  archived: readonly OrphanedByDelete[];
}

export type CleanupDecision =
  | { group: CoveredGroup; action: 'delete'; orphans: OrphanedByDelete[] }
  | { group: CoveredGroup; action: 'keep'; reason: string };

function listNames(items: readonly { title: string }[], limit = 5): string {
  const names = items.slice(0, limit).map((item) => `'${item.title}'`);
  return items.length > limit ? `${names.join(', ')} and ${items.length - limit} more` : names.join(', ');
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Deepest first, so a group is decided only after everything below it. */
export function deepestFirst<T extends { group: CoveredGroup } | CoveredGroup>(items: readonly T[]): T[] {
  const depth = (item: T): number => ('group' in item ? item.group.depth : item.depth);
  return [...items].sort((a, b) => depth(b) - depth(a));
}

export interface CleanupPlanOptions {
  /**
   * What an archived process left in a group means. After Archive it is what the run
   * made, so the group is offered and the warning names each process it orphans. After
   * a Delete it is one the run kept (still referenced, or not selected), so the group is
   * kept: deleting it would strand a process the operator just chose not to delete (W6).
   */
  archivedProcesses?: 'orphan' | 'keep' | undefined;
}

export function planCleanup(
  candidates: readonly CoveredGroup[],
  facts: ReadonlyMap<string, GroupFacts>,
  options: CleanupPlanOptions = {},
): CleanupDecision[] {
  const decided = new Map<string, CleanupDecision>();

  for (const group of deepestFirst(candidates)) {
    const known = facts.get(group.uniqueId);
    const keep = (reason: string): void => {
      decided.set(group.uniqueId, { group, action: 'keep', reason });
    };

    if (!known || known.children === null) {
      keep('Its contents could not be read, so it is not known to be empty.');
      continue;
    }

    const processes = known.children.filter((item) => kindOf(item.itemType) === 'process');
    const shortcuts = known.children.filter((item) => item.itemType === 'linked-process');
    const documentGroups = known.children.filter((item) => kindOf(item.itemType) === 'documentGroup');
    const others = known.children.filter(
      (item) => kindOf(item.itemType) === 'other' && item.itemType !== 'linked-process',
    );
    const keptGroups = known.children.filter(
      (item) => kindOf(item.itemType) === 'group' && decided.get(item.uniqueId)?.action !== 'delete',
    );

    if (processes.length > 0) {
      keep(`It still holds ${plural(processes.length, 'active process', 'active processes')}: ${listNames(processes)}.`);
      continue;
    }
    if (shortcuts.length > 0) {
      keep(`It holds ${plural(shortcuts.length, 'shortcut')} to processes in other groups: ${listNames(shortcuts)}.`);
      continue;
    }
    if (documentGroups.length > 0) {
      keep(`It holds ${plural(documentGroups.length, 'document group')}: ${listNames(documentGroups)}.`);
      continue;
    }
    if (others.length > 0) {
      keep(`It holds ${plural(others.length, 'item')} this app does not act on: ${listNames(others)}.`);
      continue;
    }
    if (keptGroups.length > 0) {
      keep(`It holds ${plural(keptGroups.length, 'subgroup')} that ${keptGroups.length === 1 ? 'is' : 'are'} kept: ${listNames(keptGroups)}.`);
      continue;
    }
    if (known.documents === null) {
      keep('Its documents could not be read, and documents block a group from being deleted.');
      continue;
    }
    if (known.documents.total > 0) {
      const names = known.documents.names.map((title) => ({ title }));
      keep(
        `It holds ${plural(known.documents.total, 'document')}` +
          (names.length > 0 ? `: ${listNames(names)}` : '') +
          '. Documents, archived or not, stop a group from being deleted.',
      );
      continue;
    }

    if (options.archivedProcesses === 'keep' && known.archived.length > 0) {
      const names = known.archived.map((p) => ({ title: p.name }));
      keep(
        `It still holds ${plural(known.archived.length, 'archived process', 'archived processes')} the delete did not remove: ${listNames(names)}. ` +
          'Deleting the group would leave them with no group to be restored to.',
      );
      continue;
    }

    decided.set(group.uniqueId, { group, action: 'delete', orphans: [...known.archived] });
  }

  return deepestFirst([...decided.values()]);
}

export function describeGroupPath(group: CoveredGroup): string {
  return [...group.path, group.title].join(' / ');
}
