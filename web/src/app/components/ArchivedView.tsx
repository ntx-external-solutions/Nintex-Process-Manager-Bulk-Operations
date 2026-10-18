'use client';

/**
 * Archived processes grouped by the group they were archived from, with the orphans
 * (whose group no longer exists) in a bucket of their own. Used by Bulk Delete.
 *
 * Selection here is a plain set of process ids: there is no hierarchy below a bucket,
 * and a bucket's checkbox is shorthand for its rows as they are listed now.
 */

import type { ArchivedView as View } from '@/lib/select/archived.ts';
import type { CheckState } from '@/lib/select/selection.ts';
import { Checkbox } from './Checkbox.tsx';

function bucketState(ids: readonly string[], selected: ReadonlySet<string>): CheckState {
  const count = ids.filter((id) => selected.has(id)).length;
  if (count === 0) return 'unchecked';
  return count === ids.length ? 'checked' : 'mixed';
}

export function ArchivedView({
  view,
  selected,
  onChange,
  disabled,
}: {
  view: View;
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  disabled?: boolean | undefined;
}) {
  const flip = (ids: readonly string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  };

  return (
    <div className="archived">
      <p className="small">
        {view.total} archived process{view.total === 1 ? '' : 'es'} in {view.buckets.length} group
        {view.buckets.length === 1 ? '' : 's'}. {view.orphaned} of them belong to a group that no
        longer exists.
        {view.unreported > 0 &&
          ` ${view.unreported} row${view.unreported === 1 ? '' : 's'} did not say whether their group still exists, so they are listed under the group they name.`}
      </p>

      {view.buckets.map((bucket) => {
        const ids = bucket.processes.map((p) => p.uniqueId);
        const state = bucketState(ids, selected);
        return (
          <details key={bucket.key} className={`panel bucket${bucket.groupExists ? '' : ' warning'}`}>
            <summary>
              {/* A click on the box must not also open or close the bucket. */}
              <span onClick={(event) => event.stopPropagation()}>
                <Checkbox
                  state={state}
                  disabled={disabled}
                  label={`Select every process in ${bucket.label}`}
                  onChange={() => flip(ids, state !== 'checked')}
                />
              </span>
              <span className="title">{bucket.label}</span>
              <span className="small"> {bucket.processes.length}</span>
            </summary>
            {!bucket.groupExists && (
              <p>
                These cannot be restored, because their group is gone. Deleting them is the only
                way to clear them.
              </p>
            )}
            <ul>
              {bucket.processes.map((process) => (
                <li key={process.uniqueId}>
                  <label>
                    <Checkbox
                      state={selected.has(process.uniqueId) ? 'checked' : 'unchecked'}
                      disabled={disabled}
                      label={`Select ${process.name}`}
                      onChange={() => flip([process.uniqueId], !selected.has(process.uniqueId))}
                    />{' '}
                    {process.name || process.uniqueId}
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
