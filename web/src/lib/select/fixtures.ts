/**
 * A recorded tree and archived listing, in the exact response shapes of
 * GetChildProcessGroupTreeItems and /Bff/Process/api/v1/processes.
 *
 * Synthetic: the structure mirrors what the demo tenant returns (shortcuts, variations,
 * document groups, in-progress processes, an empty group, and orphaned archive rows in
 * both measured shapes), but no name or id comes from a tenant. Shared by the tests and
 * by the development-only preview page (app/preview), which renders both views from it.
 */

import type { PlanGateway } from '../plan/load.ts';
import type { ProcessListItem, ProcessListPage } from '../pm/processes.ts';
import type { ChildTreeItemsResponse, TreeItem } from '../pm/types.ts';

let id = 100;
function item(uniqueId: string, title: string, itemType: string, extra: Partial<TreeItem> = {}): TreeItem {
  return {
    id: id++,
    uniqueId,
    title,
    itemType: itemType as TreeItem['itemType'],
    itemOrder: 0,
    hasChild: itemType === 'group' ? true : null,
    totalSubgroups: null,
    totalStakeholderUsers: null,
    totalPermissionRoles: null,
    totalPermissionUsers: null,
    variationSetId: null,
    ...extra,
  };
}

/** Levels keyed by parent group id; '' is the top level. */
export const TREE_LEVELS: Readonly<Record<string, TreeItem[]>> = {
  '': [
    item('g-fin', 'Finance', 'group'),
    item('g-hr', 'People', 'group'),
    item('g-docs', 'Policies', 'documentgroup'),
  ],
  'g-fin': [
    item('g-ap', 'Accounts Payable', 'group'),
    item('p-close', 'Month-end close', 'process'),
    item('p-exp', 'Expense claims', 'process', { variationSetId: 5 }),
    item('p-exp-c', 'Expense claims::Contractors', 'process', { variationSetId: 5 }),
    // A shortcut to a process that lives under People.
    item('p-onb', 'Onboarding', 'linked-process'),
  ],
  'g-ap': [
    item('p-pay', 'Pay a supplier', 'vanillaprocess'),
    item('p-inv', 'Approve an invoice', 'inprogress-process'),
    item('g-empty', 'Retired', 'group', { hasChild: false }),
  ],
  'g-empty': [],
  'g-hr': [
    item('p-onb', 'Onboarding', 'process'),
    item('p-off', 'Offboarding', 'process'),
    item('p-emb', 'Payroll (embedded)', 'embeddedprocess'),
  ],
};

/** A gateway over the recorded levels, counting reads. */
export function fixtureGateway(levels: Readonly<Record<string, TreeItem[]>> = TREE_LEVELS) {
  const reads: string[] = [];
  const gateway: PlanGateway = {
    async groupsTree(parentUniqueId): Promise<ChildTreeItemsResponse> {
      const key = parentUniqueId ?? '';
      reads.push(key);
      const items = levels[key];
      if (!items) throw new Error(`No recorded level for ${key || 'the top level'}`);
      return { treeItems: items, parentUniqueId };
    },
  };
  return { gateway, reads };
}

function archivedRow(
  processUniqueId: string,
  processName: string,
  group: { groupId: number; groupUniqueId: string; groupName: string },
  groupExists?: boolean,
): ProcessListItem {
  return {
    processId: id++,
    processName,
    processUniqueId,
    processState: 'Archived',
    ...group,
    processOwner: '',
    processExpert: '',
    ...(groupExists === undefined ? {} : { groupExists }),
  };
}

const FINANCE = { groupId: 101, groupUniqueId: 'g-fin', groupName: 'Finance' };
const AP = { groupId: 104, groupUniqueId: 'g-ap', groupName: 'Accounts Payable' };
/** What the API returns for a deleted group: id 1 and the tenant's own name. */
const PLACEHOLDER = { groupId: 1, groupUniqueId: 'g-tenant', groupName: 'Example Organisation' };
/** The rarer measured shape: a real numeric id for a group that has since gone. */
const GONE = { groupId: 977, groupUniqueId: 'g-gone', groupName: 'Old Projects' };

export const ARCHIVED_ROWS: readonly ProcessListItem[] = [
  archivedRow('a-1', 'Petty cash', FINANCE, true),
  archivedRow('a-2', 'Cheque runs', AP, true),
  archivedRow('a-3', 'Fax approvals', AP, true),
  archivedRow('a-4', 'Y2K readiness', PLACEHOLDER, false),
  archivedRow('a-5', 'Project kickoff', GONE, false),
  // No flag at all: treated as having a group, and counted as unreported.
  archivedRow('a-6', 'Bank reconciliation', FINANCE),
];

/** The listing as one short page, which ends the walk. */
export function archivedPage(page: number): ProcessListPage {
  return page === 1
    ? { items: [...ARCHIVED_ROWS], totalItemCount: ARCHIVED_ROWS.length }
    : { items: [], totalItemCount: ARCHIVED_ROWS.length };
}
