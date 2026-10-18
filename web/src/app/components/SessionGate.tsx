'use client';

/**
 * Every operation page starts the same way: find out who is signed in, and if nobody
 * is, or the session dies before any write, send them back to sign in.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { currentSession, type SessionInfo } from '@/lib/ui/gateway.ts';

export function SessionGate({
  title,
  children,
}: {
  title: string;
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

  if (checking) {
    return (
      <main>
        <h1>{title}</h1>
        <p className="lede">Checking your session…</p>
      </main>
    );
  }

  if (session === null || signedOut) {
    return (
      <main>
        <h1>{title}</h1>
        <div className="panel warning">
          <h2>{signedOut ? 'Your session ended' : 'Not signed in'}</h2>
          <p>
            <a href="/">Sign in</a> to continue.
            {signedOut && ' Then plan again: anything already done is listed as skipped.'}
          </p>
        </div>
      </main>
    );
  }

  return <>{children(session, () => setSignedOut(true))}</>;
}
