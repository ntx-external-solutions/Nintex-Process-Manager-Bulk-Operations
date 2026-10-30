'use client';

/**
 * The front door.
 *
 * Session and activity are tracked separately on purpose: folding "working" into the
 * same state as "signed in" makes the form flash back mid-request. Only a session the
 * server actually rejected returns someone to this form.
 */

import { Button, Input } from '@exp-textura/react';
import { useState } from 'react';

import type { SessionInfo } from '@/lib/ui/gateway.ts';
import { Field, Notice, valueOf } from './_ui/kit.tsx';

export function SignInForm({ onSignedIn }: { onSignedIn: (session: SessionInfo) => void }) {
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, username, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        tenant?: string;
        baseUrl?: string;
        username?: string;
        expiresAt?: number;
      };

      if (!response.ok) {
        setError(payload.error ?? 'Sign-in failed.');
        return;
      }

      // Drop the password from component state as soon as it is spent.
      setPassword('');
      onSignedIn({
        tenant: payload.tenant ?? '',
        siteUrl: payload.baseUrl && payload.tenant ? `${payload.baseUrl}/${payload.tenant}` : '',
        username: payload.username ?? username,
        expiresAt: payload.expiresAt ?? 0,
      });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={submit} className="panel form-stack">
        <Field id="site" label="Process Manager address">
          <Input
            id="site"
            value={site}
            onChange={(e) => setSite(valueOf(e))}
            placeholder="https://demo.promapp.com/your-tenant"
            autoComplete="url"
            disabled={busy}
            required
          />
        </Field>

        <Field id="username" label="Username">
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(valueOf(e))}
            autoComplete="username"
            disabled={busy}
            required
          />
        </Field>

        <Field id="password" label="Password">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(valueOf(e))}
            autoComplete="current-password"
            disabled={busy}
            required
          />
        </Field>

        <div>
          <Button type="submit" isLoading={busy}>
            Sign in
          </Button>
        </div>
      </form>

      {error !== null && (
        <Notice tone="critical" title="Could not sign in">
          {error}
        </Notice>
      )}
    </>
  );
}
