'use client';

/**
 * The group tree with its processes, for choosing what an operation acts on. Shared by
 * Archive, Delete and Move.
 *
 * Rendering only: what is drawn comes from `visibleRows` (lib/select/rows.ts) and what a
 * click means from `toggle` (lib/select/selection.ts), both tested without a DOM. The
 * `useBrowseTree` hook owns loading.
 */

import { ChevronDown, ChevronRight } from '@exp-textura/icons';
import { useCallback, useEffect, useState } from 'react';

import type { PlanGateway } from '@/lib/plan/load.ts';
import { addBrowseLevel, emptyBrowseTree, type BrowseNode, type BrowseTree } from '@/lib/select/browse.ts';
import { visibleRows } from '@/lib/select/rows.ts';
import { EMPTY_SELECTION, toggle, type Selection } from '@/lib/select/selection.ts';
import { Notice } from '../_ui/kit.tsx';
import { Checkbox } from './Checkbox.tsx';

export interface BrowseState {
  tree: BrowseTree;
  selection: Selection;
  expanded: ReadonlySet<string>;
  error: string | null;
  /** True while the top level is being read. */
  loading: boolean;
  toggleNode(node: BrowseNode): void;
  toggleExpanded(node: BrowseNode): void;
  /** Replace the tree, keeping the selection, after a planner has read more of it. */
  setTree(tree: BrowseTree): void;
  refresh(): void;
}

/**
 * Lazy loading, one level per expand.
 *
 * `onError` sees every failure first, so a page can treat a dead session as a sign-out
 * rather than an error message.
 */
export function useBrowseTree(
  gateway: PlanGateway,
  onError?: (error: unknown) => void,
): BrowseState {
  const [tree, setTree] = useState<BrowseTree>(emptyBrowseTree);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  const fail = useCallback(
    (cause: unknown) => {
      onError?.(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    },
    [onError],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    gateway
      .groupsTree(null)
      .then((response) => {
        if (!live) return;
        setTree((current) => addBrowseLevel(current, null, response.treeItems ?? []));
        setError(null);
      })
      .catch((cause: unknown) => live && fail(cause))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [gateway, fail, generation]);

  const loadLevel = useCallback(
    (node: BrowseNode) => {
      gateway
        .groupsTree(node.uniqueId)
        .then((response) =>
          setTree((current) =>
            current.nodes.has(node.uniqueId)
              ? addBrowseLevel(current, node.uniqueId, response.treeItems ?? [])
              : current,
          ),
        )
        .catch(fail);
    },
    [gateway, fail],
  );

  return {
    tree,
    selection,
    expanded,
    error,
    loading,
    toggleNode: (node) => setSelection((current) => toggle(tree, current, node)),
    toggleExpanded: (node) => {
      const opening = !expanded.has(node.key);
      setExpanded((current) => {
        const next = new Set(current);
        if (opening) next.add(node.key);
        else next.delete(node.key);
        return next;
      });
      if (opening && !node.childrenLoaded) loadLevel(node);
    },
    setTree,
    refresh: () => {
      // Expanded levels are re-read as the operator opens them again.
      setTree(emptyBrowseTree());
      setExpanded(new Set());
      setGeneration((g) => g + 1);
    },
  };
}

export function TreeBrowser({ state, disabled }: { state: BrowseState; disabled?: boolean | undefined }) {
  if (state.loading && state.tree.roots === null) {
    return <p className="small">Reading the group tree…</p>;
  }

  const rows = visibleRows(state.tree, state.selection, state.expanded);

  return (
    <div className="tree">
      {state.error !== null && (
        <Notice tone="critical" title="Could not read the tree">
          {state.error}
        </Notice>
      )}
      <ul role="tree">
        {rows.map((row) => (
          <li
            key={row.node.key}
            role="treeitem"
            aria-expanded={row.expandable ? row.expanded : undefined}
            aria-level={row.depth + 1}
            style={{ paddingLeft: `${row.depth * 1.25}rem` }}
            className={`tree-row kind-${row.node.kind}`}
          >
            {row.expandable ? (
              <button
                type="button"
                className="disclosure"
                aria-label={row.expanded ? `Collapse ${row.node.title}` : `Expand ${row.node.title}`}
                onClick={() => state.toggleExpanded(row.node)}
              >
                {row.expanded ? <ChevronDown /> : <ChevronRight />}
              </button>
            ) : (
              <span className="disclosure-spacer" />
            )}
            <Checkbox
              state={row.check}
              disabled={disabled === true || !row.selectable}
              label={`Select ${row.node.title}`}
              onChange={() => state.toggleNode(row.node)}
            />
            <span className="title">{row.node.title}</span>
            {row.tag !== null && <span className="tag">{row.tag}</span>}
            {row.loading && <span className="small"> reading…</span>}
            {row.expanded && row.node.childrenLoaded && row.node.children.length === 0 && (
              <span className="small"> empty</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
