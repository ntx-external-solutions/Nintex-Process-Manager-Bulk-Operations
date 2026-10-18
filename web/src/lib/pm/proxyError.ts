/**
 * What the proxy answers when an operation throws.
 *
 * Kept out of the route handler so it can be tested without Next.js: the R12 defect was
 * in exactly this mapping, where a dead session reached the browser as a 500
 * "Unexpected error" on every row instead of as "sign in again".
 */

import { isPmError, isSessionEnded, tenantMessage } from './client.ts';
import { isScimError } from './scim.ts';

export interface ProxyErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

export function proxyError(error: unknown): ProxyErrorResponse {
  // Checked before the Process Manager branch below: a SCIM key the directory refuses
  // is a wrong key, not a dead session, and signing the operator out over one would
  // lose the plan they were part-way through building.
  if (isScimError(error)) return { status: 400, body: { error: error.message } };

  if (isPmError(error)) {
    // A 401, a redirect to the sign-in page, or that page itself (R12) means our token
    // died mid-run; tell the client to stop and re-authenticate rather than hammering
    // through the rest of a plan.
    //
    // PGM treated 403 the same way. This app does not: a 403 from a write is far more
    // likely to be the tenant refusing one process to this user than a dead session,
    // and signing the operator out over one process would stop a bulk archive that
    // should carry on and report it. The process is reported with its status code
    // instead. R12 never saw a 403 for a dead token.
    if (isSessionEnded(error)) {
      return { status: 401, body: { error: 'Process Manager rejected the session. Sign in again.', signedOut: true } };
    }
    return {
      status: 502,
      body: {
        error: error.message,
        status: error.status,
        // The tenant's own words, for a results file an administrator has to act on.
        message: tenantMessage(error.bodyText),
        // Useful for diagnosis and safe: it is the tenant's own response.
        detail: error.bodyText.slice(0, 2_000),
      },
    };
  }
  return { status: 500, body: { error: 'Unexpected error handling the request.' } };
}
