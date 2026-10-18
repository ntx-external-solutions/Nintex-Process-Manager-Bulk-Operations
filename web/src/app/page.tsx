'use client';

/**
 * Sign in, then pick an operation.
 *
 * The four operations are listed from the start so the operator can see what the app
 * will do, and each tile stays disabled until the task that builds it lands. A tile
 * that links to nothing would be worse than one that says it is not ready.
 */

import { useEffect, useState } from 'react';

import { currentSession, type SessionInfo } from '@/lib/ui/gateway.ts';
import { SignInForm } from './SignInForm.tsx';

interface OperationTile {
  title: string;
  summary: string;
  /** Null while the operation is not built yet. */
  href: string | null;
}

const OPERATIONS: readonly OperationTile[] = [
  {
    title: 'Bulk Archive',
    summary: 'Pick groups or processes from the tree and archive them.',
    href: '/archive',
  },
  {
    title: 'Bulk Delete',
    summary:
      'Pick from the tree or the archived list and delete, removing references first.',
    href: null,
  },
  {
    title: 'Bulk Move',
    summary: 'Move processes or groups to another group.',
    href: '/move',
  },
  {
    title: 'Bulk Update Ownership',
    summary: 'Upload a CSV of owners and experts, check it, then apply.',
    href: '/ownership',
  },
];

export default function Home() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    void currentSession().then((info) => {
      setSession(info);
      setChecking(false);
    });
  }, []);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth', { method: 'DELETE' });
    } finally {
      setSession(null);
      setSigningOut(false);
    }
  }

  if (checking) {
    return (
      <main>
        <h1>Bulk Operations</h1>
        <p className="lede">Checking your session…</p>
      </main>
    );
  }

  if (session === null) {
    return (
      <main>
        <h1>Bulk Operations</h1>
        <p className="lede">
          Sign in with your Process Manager username and password. They are exchanged for
          a token and are not stored.
        </p>
        <div className="panel warning">
          <h2>Single sign-on is not supported</h2>
          <p>
            This app signs in with a Process Manager password. If your site signs you in
            through your organisation (SSO) and you have no Process Manager password, you
            cannot use it.
          </p>
        </div>
        <SignInForm onSignedIn={setSession} />
      </main>
    );
  }

  return (
    <main>
      <h1>Bulk Operations</h1>
      <p className="lede">
        Signed in as {session.username} on tenant <code>{session.tenant}</code>.
      </p>

      <div className="tiles">
        {OPERATIONS.map((operation) =>
          operation.href === null ? (
            <div key={operation.title} className="tile" aria-disabled="true">
              <h2>{operation.title}</h2>
              <p>{operation.summary}</p>
              <span className="status">Not available yet</span>
            </div>
          ) : (
            <a key={operation.title} className="tile" href={operation.href}>
              <h2>{operation.title}</h2>
              <p>{operation.summary}</p>
            </a>
          ),
        )}
      </div>

      <div className="panel">
        <h2>Every operation works the same way</h2>
        <ul className="checklist">
          <li>Choose what to act on.</li>
          <li>Check the full list of what would change. This is a dry run.</li>
          <li>Apply it. Nothing is written before that.</li>
          <li>Download the results file.</li>
        </ul>
      </div>

      <div className="row">
        <button type="button" className="secondary" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </main>
  );
}
