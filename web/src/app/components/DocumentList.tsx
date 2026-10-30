'use client';

/**
 * A document list to tick from, searchable by name, with each document's group path, type
 * and location (W8). The document pages share it; what it lists is the page's choice.
 */

import { Input } from '@exp-textura/react';
import { useState } from 'react';

import { documentPath, type DocumentEntry } from '@/lib/documents/list.ts';
import { searchDocuments } from '@/lib/documents/select.ts';
import { Field, valueOf } from '../_ui/kit.tsx';
import { Checkbox } from './Checkbox.tsx';

/** Enough to scroll through; past it, the search narrows. */
const SHOWN = 300;

export function DocumentList({
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
  const [query, setQuery] = useState('');
  const found = searchDocuments(entries, query);
  const shown = found.slice(0, SHOWN);
  const keyOf = (e: DocumentEntry) => e.uniqueId.toLowerCase();
  const allShownTicked = shown.length > 0 && shown.every((e) => selected.has(keyOf(e)));

  const toggle = (keys: readonly string[], on: boolean) => {
    const next = new Set(selected);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    onChange(next);
  };

  return (
    <div className="panel">
      <Field id="document-search" label="Search by name">
        <Input id="document-search" value={query} onChange={(e) => setQuery(valueOf(e))} placeholder="Part of a document's name" />
      </Field>
      <p className="small">
        {found.length} of {entries.length} document{entries.length === 1 ? '' : 's'}
        {found.length > shown.length && `, the first ${shown.length} shown. Search to narrow the list`}. {selected.size} ticked.
      </p>
      <table className="plan">
        <thead>
          <tr>
            <th>
              <Checkbox
                state={allShownTicked ? 'checked' : 'unchecked'}
                label="Tick every document shown"
                onChange={() => toggle(shown.map(keyOf), !allShownTicked)}
              />
            </th>
            <th>Document</th>
            <th>Group</th>
            <th>Type</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.uniqueId}>
              <td>
                <Checkbox
                  state={selected.has(keyOf(e)) ? 'checked' : 'unchecked'}
                  label={`Select document ${e.name}`}
                  onChange={() => toggle([keyOf(e)], !selected.has(keyOf(e)))}
                />
              </td>
              <td>
                {e.name}
                {e.isPending && <span className="tag">pending</span>}
              </td>
              <td>{documentPath(e, paths).join(' / ')}</td>
              <td>{e.type}</td>
              <td>{e.location}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
