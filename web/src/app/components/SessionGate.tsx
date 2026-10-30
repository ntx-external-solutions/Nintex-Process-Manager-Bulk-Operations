'use client';

/**
 * Every operation page starts the same way: find out who is signed in, and if nobody
 * is, or the session dies before any write, send them back to sign in.
 *
 * It also draws the page frame, so the title, breadcrumbs and who is signed in sit in
 * the same place on every operation.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { currentSession, type SessionInfo } from '@/lib/ui/gateway.ts';
import { AppShell } from '../_ui/AppShell.tsx';
import { SignedInAs } from '../_ui/kit.tsx';

export function SessionGate({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: (session: SessionInfo, onSignedOut: () => void) => ReactNode;
}) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    void currentSession().then((info) => {
      setSession(info);
      setChecking(false);
    });
  }, []);

  const frame = (meta: ReactNode, body: ReactNode) => (
    <AppShell
      title={title}
      {...(description !== undefined ? { description } : {})}
      meta={meta}
      breadcrumbs={[{ label: 'Bulk Operations', href: '/' }, { label: title }]}
    >
      {body}
    </AppShell>
  );

  if (checking) {
    return frame(<span className="muted">Checking your session…</span>, null);
  }

  if (session === null || signedOut) {
    return frame(
      undefined,
      <div className="panel warning">
        <h2>{signedOut ? 'Your session ended' : 'Not signed in'}</h2>
        <p>
          <a href="/">Sign in</a> to continue.
          {signedOut && ' Then plan again: anything already done is listed as skipped.'}
        </p>
      </div>,
    );
  }

  return frame(
    <SignedInAs username={session.username} tenant={session.tenant} />,
    children(session, () => setSignedOut(true)),
  );
}
