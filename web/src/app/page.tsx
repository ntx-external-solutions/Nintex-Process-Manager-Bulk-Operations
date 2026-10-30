'use client';

/**
 * Sign in, then pick an operation.
 *
 * The four operations are listed from the start so the operator can see what the app
 * will do, and each tile stays disabled until the task that builds it lands. A tile
 * that links to nothing would be worse than one that says it is not ready.
 */

import { Button } from '@exp-textura/react';
import { Archive, Delete, FolderOpen, Users } from '@exp-textura/icons';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { currentSession, type SessionInfo } from '@/lib/ui/gateway.ts';
import { AppShell } from './_ui/AppShell.tsx';
import { Notice, SignedInAs } from './_ui/kit.tsx';
import { SignInForm } from './SignInForm.tsx';

interface OperationTile {
  title: string;
  summary: string;
  icon: ReactNode;
  /** Null while the operation is not built yet. */
  href: string | null;
}

const OPERATIONS: readonly OperationTile[] = [
  {
    title: 'Bulk Archive',
    summary: 'Pick groups or processes from the tree and archive them.',
    icon: <Archive />,
    href: '/archive',
  },
  {
    title: 'Bulk Delete',
    summary:
      'Pick from the tree or the archived list and delete, removing references first.',
    icon: <Delete />,
    href: '/delete',
  },
  {
    title: 'Bulk Move',
    summary: 'Move processes or groups to another group.',
    icon: <FolderOpen />,
    href: '/move',
  },
  {
    title: 'Bulk Update Ownership',
    summary: 'Upload a CSV of owners and experts, check it, then apply.',
    icon: <Users />,
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
    return <AppShell title="Bulk Operations" meta={<span className="muted">Checking your session…</span>} pageWidth="default" />;
  }

  if (session === null) {
    return (
      <AppShell
        title="Bulk Operations"
        description="Sign in with your Process Manager username and password. They are exchanged for a token and are not stored."
        pageWidth="default"
      >
        <Notice tone="warning" title="Single sign-on is not supported">
          This app signs in with a Process Manager password. If your site signs you in through your
          organisation (SSO) and you have no Process Manager password, you cannot use it.
        </Notice>
        <SignInForm onSignedIn={setSession} />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Bulk Operations"
      meta={<SignedInAs username={session.username} tenant={session.tenant} />}
      description="Archive, delete, move and update ownership across many processes at once."
      actions={
        <Button buttonType="secondary" onClick={() => void signOut()} isLoading={signingOut}>
          Sign out
        </Button>
      }
    >
      <div className="tiles">
        {OPERATIONS.map((operation) => {
          const content = (
            <>
              <span className="tile-icon" aria-hidden="true">
                {operation.icon}
              </span>
              <h2>{operation.title}</h2>
              <p>{operation.summary}</p>
            </>
          );
          return operation.href === null ? (
            <div key={operation.title} className="tile" aria-disabled="true">
              {content}
              <span className="status">Not available yet</span>
            </div>
          ) : (
            <Link key={operation.title} className="tile" href={operation.href}>
              {content}
            </Link>
          );
        })}
      </div>

      <div className="panel">
        <h2>Every operation works the same way</h2>
        <ol className="steps">
          <li>Choose what to act on.</li>
          <li>Check the full list of what would change. This is a dry run.</li>
          <li>Apply it. Nothing is written before that.</li>
          <li>Download the results file.</li>
        </ol>
      </div>
    </AppShell>
  );
}
