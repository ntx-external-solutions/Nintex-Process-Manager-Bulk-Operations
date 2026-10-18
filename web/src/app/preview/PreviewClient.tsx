'use client';

import { useMemo, useState } from 'react';

import { groupArchived, toArchivedProcess } from '@/lib/select/archived.ts';
import { ARCHIVED_ROWS, fixtureGateway } from '@/lib/select/fixtures.ts';
import { resolveSelection } from '@/lib/select/resolve.ts';
import { ArchivedView } from '../components/ArchivedView.tsx';
import { TreeBrowser, useBrowseTree } from '../components/TreeBrowser.tsx';

export function PreviewClient() {
  const gateway = useMemo(() => fixtureGateway().gateway, []);
  const browse = useBrowseTree(gateway);
  const [archivedSelection, setArchivedSelection] = useState<ReadonlySet<string>>(new Set());

  const archived = useMemo(
    () => groupArchived(ARCHIVED_ROWS.map(toArchivedProcess).filter((p) => p !== null)),
    [],
  );
  const resolution = resolveSelection(browse.tree, browse.selection);

  return (
    <main>
      <h1>Selection preview</h1>
      <p className="lede">Recorded fixture data. Nothing here talks to a tenant.</p>

      <h2>Tree</h2>
      <TreeBrowser state={browse} />
      <p className="small">
        {resolution.status === 'complete'
          ? `${resolution.processes.length} process(es) selected, ${resolution.excluded.length} left out.`
          : `Expand ${resolution.unloaded.length} more group(s) or plan to resolve the selection.`}
      </p>

      <h2>Archived</h2>
      <ArchivedView view={archived} selected={archivedSelection} onChange={setArchivedSelection} />
    </main>
  );
}
