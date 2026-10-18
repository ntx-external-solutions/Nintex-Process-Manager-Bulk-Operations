/**
 * The Process Manager proxy.
 *
 * Exists only because Process Manager will not send CORS headers for this origin.
 * It is a transport shim, not a service: it holds no state between requests and
 * stores nothing.
 *
 * Two properties keep it from becoming an open relay:
 *
 *  - the destination is never caller-supplied. baseUrl and tenant come from the
 *    sealed session cookie, and the path comes from the operation allowlist;
 *  - the operation name must match a known entry, so there is no generic
 *    pass-through. Write operations are added one task at a time, each taking exactly
 *    one id (lib/pm/operations.ts).
 */

import { NextResponse } from 'next/server';

import { readCookie } from '@/lib/auth/cookie.ts';
import { SESSION_COOKIE, unseal } from '@/lib/auth/session.ts';
import type { PmContext } from '@/lib/pm/client.ts';
import { execute, parseOperation } from '@/lib/pm/operations.ts';
import { proxyError } from '@/lib/pm/proxyError.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env['AUTH_SECRET'];
  if (!secret || secret.length < 32) {
    return NextResponse.json({ error: 'This deployment is missing AUTH_SECRET.' }, { status: 500 });
  }

  const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const session = await unseal(cookie, secret);
  if (!session) {
    // Covers absent, tampered, and expired alike — all mean "sign in again".
    return NextResponse.json({ error: 'Not signed in.', signedOut: true }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const parsed = parseOperation(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const ctx: PmContext = {
    baseUrl: session.baseUrl,
    tenant: session.tenant,
    token: session.token,
    fetch,
  };

  try {
    const result = await execute(ctx, parsed.operation);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const failure = proxyError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}

