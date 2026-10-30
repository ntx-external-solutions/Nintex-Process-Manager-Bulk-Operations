'use client';

/**
 * Archived documents to tick, bucketed by their primary group's path (W8b, W8c), as the
 * process Delete page buckets archived processes. A bucket's box is shorthand for its
 * rows as they are listed now.
 */

import { useMemo } from 'react';

import { documentPath, type DocumentEntry } from '@/lib/documents/list.ts';
import type { CheckState } from '@/lib/select/selection.ts';
import { Checkbox } from './Checkbox.tsx';

const NO_GROUP = '(no group given)';

function bucketState(keys: readonly string[], selected: ReadonlySet<string>): CheckState {
  const count = keys.filter((k) => selected.has(k)).length;
  if (count === 0) return 'unchecked';
  return count === keys.length ? 'checked' : 'mixed';
}

export function ArchivedDocumentList({
  entries,
  paths,
  selected,
  onChange,
}: {
  entries: readonly DocumentEntry[];
  paths: ReadonlyMap<string, string[]>;
  /** Lowercased `documentUniqueId`s. */
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const buckets = useMemo(() => {
    const out = new Map<string, DocumentEntry[]>();
    for (const e of entries) {
      const label = documentPath(e, paths).join(' / ') || NO_GROUP;
      out.set(label, [...(out.get(label) ?? []), e]);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries, paths]);
  const keyOf = (e: DocumentEntry) => e.uniqueId.toLowerCase();

  const flip = (keys: readonly string[], on: boolean) => {
    const next = new Set(selected);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    onChange(next);
  };

  return (
    <div className="archived">
      <p className="small">
        {entries.length} archived document{entries.length === 1 ? '' : 's'} in {buckets.length} group{buckets.length === 1 ? '' : 's'}.{' '}
        {selected.size} ticked.
      </p>
      {buckets.map(([label, docs]) => {
        const keys = docs.map(keyOf);
        const state = bucketState(keys, selected);
        return (
          <details key={label} className="panel bucket">
            <summary>
              {/* A click on the box must not also open or close the bucket. */}
              <span onClick={(event) => event.stopPropagation()}>
                <Checkbox state={state} label={`Select every archived document in ${label}`} onChange={() => flip(keys, state !== 'checked')} />
              </span>
              <span className="title">{label}</span>
              <span className="small"> {docs.length}</span>
            </summary>
            <ul>
              {docs.map((e) => (
                <li key={e.uniqueId}>
                  <label>
                    <Checkbox
                      state={selected.has(keyOf(e)) ? 'checked' : 'unchecked'}
                      label={`Select archived document ${e.name}`}
                      onChange={() => flip([keyOf(e)], !selected.has(keyOf(e)))}
                    />{' '}
                    {e.name || e.uniqueId} <span className="small">{[e.type, e.location].filter((x) => x !== '').join(', ')}</span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
