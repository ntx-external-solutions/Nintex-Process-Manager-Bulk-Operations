'use client';

/**
 * Choosing where a move goes: one group, or the top level for groups.
 *
 * Shows groups only. Document groups are drawn so the tree matches Process Manager but
 * cannot be chosen, because nothing can be moved into one.
 */

import { visibleRows } from '@/lib/select/rows.ts';
import { EMPTY_SELECTION } from '@/lib/select/selection.ts';
import type { BrowseState } from './TreeBrowser.tsx';

export const TOP_LEVEL = '';

export function DestinationPicker({
  state,
  chosen,
  onChoose,
  allowTopLevel,
}: {
  state: BrowseState;
  /** A group key, TOP_LEVEL, or null for nothing chosen. */
  chosen: string | null;
  onChoose: (key: string) => void;
  allowTopLevel: boolean;
}) {
  if (state.loading && state.tree.roots === null) {
    return <p className="small">Reading the group tree…</p>;
  }

  const rows = visibleRows(state.tree, EMPTY_SELECTION, state.expanded).filter(
    (row) => row.node.kind === 'group' || row.node.kind === 'documentGroup',
  );

  return (
    <div className="tree" role="radiogroup" aria-label="Destination">
      {state.error !== null && <p className="error-text">{state.error}</p>}
      <ul>
        {allowTopLevel && (
          <li className="tree-row">
            <span className="disclosure-spacer" />
            <input
              type="radio"
              name="destination"
              aria-label="The top level"
              checked={chosen === TOP_LEVEL}
              onChange={() => onChoose(TOP_LEVEL)}
            />
            <span className="title">The top level</span>
          </li>
        )}
        {rows.map((row) => (
          <li key={row.node.key} className={`tree-row kind-${row.node.kind}`} style={{ paddingLeft: `${row.depth * 1.25}rem` }}>
            {row.expandable ? (
              <button
                type="button"
                className="disclosure"
                aria-label={row.expanded ? `Collapse ${row.node.title}` : `Expand ${row.node.title}`}
                onClick={() => state.toggleExpanded(row.node)}
              >
                <span className="marker">{row.expanded ? '▾' : '▸'}</span>
              </button>
            ) : (
              <span className="disclosure-spacer" />
            )}
            <input
              type="radio"
              name="destination"
              aria-label={`Move into ${row.node.title}`}
              disabled={row.node.kind !== 'group'}
              checked={chosen === row.node.key}
              onChange={() => onChoose(row.node.key)}
            />
            <span className="title">{row.node.title}</span>
            {row.tag !== null && <span className="tag">{row.tag}</span>}
            {row.loading && <span className="small"> reading…</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
