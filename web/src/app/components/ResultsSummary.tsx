'use client';

/**
 * The end of every run: counts by status, the results file, and everything that needs a
 * person, each linked to the item in Process Manager.
 */

import type { ReactNode } from 'react';

import { itemLink } from '@/lib/archive/run.ts';
import { countByStatus, resultsToCsv, type ResultRow } from '@/lib/exec/report.ts';
import { datedFilename, downloadCsv } from '@/lib/ui/download.ts';

const NEEDS_ATTENTION: ReadonlySet<string> = new Set(['Blocked', 'Failed', 'Pending', 'Unverified', 'Unreversed']);

export function ResultsSummary({
  rows,
  vocabulary,
  warning,
  siteUrl,
  filenameStem,
  actions,
}: {
  rows: readonly ResultRow[];
  vocabulary: readonly string[];
  warning: string | null;
  siteUrl: string;
  filenameStem: string;
  /** Extra buttons beside the download. */
  actions?: ReactNode;
}) {
  const counts = countByStatus(rows, vocabulary);
  const attention = rows.filter((r) => NEEDS_ATTENTION.has(r.status));

  return (
    <>
      <div className="panel">
        <h2>Done</h2>
        {warning !== null && <p>{warning}</p>}
        <div className="counts">
          {counts.map((c) => (
            <div key={c.status} className={`count${NEEDS_ATTENTION.has(c.status) || c.unexpected ? ' loud' : ''}`}>
              <span className="value">{c.count}</span>
              <span className="label">{c.status}</span>
            </div>
          ))}
        </div>
        <div className="row">
          <button type="button" onClick={() => downloadCsv(datedFilename(filenameStem), resultsToCsv(rows))}>
            Download the results
          </button>
          {actions}
        </div>
      </div>

      {attention.length > 0 && (
        <div className="panel warning">
          <h2>Needs attention ({attention.length})</h2>
          <table className="plan">
            <thead>
              <tr>
                <th>Item</th>
                <th>Status</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {attention.map((row) => {
                const link = itemLink(siteUrl, row);
                return (
                  <tr key={`${row.operation}|${row.objectId}`}>
                    <td>
                      {link !== '' ? (
                        <a href={link} target="_blank" rel="noreferrer">
                          {row.name}
                        </a>
                      ) : (
                        row.name
                      )}
                    </td>
                    <td>{row.status}</td>
                    <td>{row.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
