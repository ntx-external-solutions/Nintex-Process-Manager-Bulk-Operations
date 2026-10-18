/**
 * Request plumbing for the Process Manager API.
 *
 * Deliberately has no Next.js or browser dependencies: the same client runs in a
 * route handler, in tests, and (via the proxy) on behalf of the browser. The fetch
 * implementation is injected so tests never touch the network.
 */

export interface PmContext {
  /** Origin only, no trailing slash. e.g. https://demo.promapp.com */
  baseUrl: string;
  /** Tenant path segment. e.g. 0123456789abcdef0123456789abcdef */
  tenant: string;
  /** OAuth bearer token from /oauth2/token. */
  token: string;
  /**
   * ASP.NET antiforgery token.
   *
   * Confirmed **not required** for bearer-authenticated calls, reads or writes — the
   * token in the HAR captures is a browser-session artefact, and Nintex's own bulk
   * PowerShell script writes to production tenants without one. Retained only as an
   * escape hatch if some endpoint ever turns out to differ; nothing sets it today.
   */
  antiforgeryToken?: string | undefined;
  fetch: typeof fetch;
  /** Injected so tests do not actually wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Whether a failed attempt may be retried.
 *
 * - `read`   nothing was changed, so anything transient is safe to repeat.
 * - `write`  the request may have been applied before the failure. Only retried when
 *            the server tells us it definitely was not (429/408), because repeating
 *            a CreateGroup that actually succeeded leaves an orphan behind.
 */
export type RetryPolicy = 'read' | 'write';

export interface PmRequestOptions {
  /** Path below the tenant segment, starting with a slash. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Serialised as JSON unless `form` is set. */
  body?: unknown;
  /** Send as application/x-www-form-urlencoded instead of JSON. */
  form?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  retry?: RetryPolicy;
  /** Overrides the default attempt count. */
  attempts?: number;
  /**
   * How to read a successful body. `text` is for endpoints that return CSV rather
   * than JSON, such as the process list report.
   */
  parse?: 'json' | 'text';
}

export interface PmError extends Error {
  name: 'PmError';
  status: number | null;
  url: string;
  bodyText: string;
  /** The tenant no longer accepts the token. Every call after this one will fail too. */
  sessionEnded: boolean;
}

export function isPmError(e: unknown): e is PmError {
  return e instanceof Error && e.name === 'PmError';
}

/** True when the error means "sign in again", not "this one call failed". */
export function isSessionEnded(e: unknown): boolean {
  return isPmError(e) && e.sessionEnded === true;
}

function pmError(message: string, status: number | null, url: string, bodyText: string, sessionEnded = false): PmError {
  const err = new Error(message) as PmError;
  err.name = 'PmError';
  err.status = status;
  err.url = url;
  err.bodyText = bodyText;
  err.sessionEnded = sessionEnded;
  return err;
}

/** How much of an unexpected body an error carries. */
const EXCERPT_LENGTH = 200;

/** A sign-in page, not an API answer. */
function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text);
}

/**
 * Defaults taken from the tenant's own advertised resilience config
 * (`ResilienceApiCallAttemptsCount`, `ResilienceApiCallDelaySec`) rather than invented.
 */
export const DEFAULT_ATTEMPTS = 5;
export const BASE_DELAY_MS = 3_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function buildUrl(ctx: PmContext, path: string, query?: PmRequestOptions['query']): string {
  const url = new URL(`${ctx.baseUrl}/${ctx.tenant}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Retry-After is either seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function shouldRetry(status: number | null, policy: RetryPolicy): boolean {
  // A transport failure with no status: we cannot know whether the server applied it.
  if (status === null) return policy === 'read';
  if (status === 429 || status === 408) return true;
  if (status >= 500) return policy === 'read';
  return false;
}

export async function pmRequest<T>(ctx: PmContext, options: PmRequestOptions): Promise<T> {
  const {
    path,
    method = 'GET',
    body,
    form,
    query,
    retry = 'read',
    attempts = DEFAULT_ATTEMPTS,
    parse = 'json',
  } = options;

  const url = buildUrl(ctx, path, query);
  const sleep = ctx.sleep ?? defaultSleep;

  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${ctx.token}`,
    // Process Manager's MVC endpoints branch on this; without it some return HTML.
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (ctx.antiforgeryToken) headers['__RequestVerificationToken'] = ctx.antiforgeryToken;

  let payload: string | undefined;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let lastError: PmError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method,
        headers,
        // Measured in R12: with a dead token, some endpoints answer 401 and others 302 to
        // the sign-in page (`GET /Api/v1/Processes/{id}`, `ArchiveProcess`). Followed, the
        // 302 ends in an HTML page with a 2xx, which then failed as a JSON SyntaxError and
        // reached the browser as "Unexpected error" on every row, never as "sign in
        // again". Not following it lets the 3xx itself say the session has gone.
        redirect: 'manual',
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (cause) {
      lastError = pmError(
        `Network error calling ${method} ${path}: ${(cause as Error).message}`,
        null,
        url,
        '',
      );
      if (attempt < attempts && shouldRetry(null, retry)) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw lastError;
    }

    // A manual redirect is an opaque response with status 0 in a browser, and the 3xx
    // itself in Node. Either way nothing was done, and the tenant wants a sign-in.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399)) {
      throw pmError(
        `Process Manager redirected ${method} ${path} to its sign-in page: the session has ended`,
        response.status || null,
        url,
        '',
        true,
      );
    }

    if (response.ok) return parseBody<T>(response, parse, { method, path, url });

    const text = await safeText(response);
    lastError = pmError(
      `Process Manager returned ${response.status} for ${method} ${path}`,
      response.status,
      url,
      text,
      response.status === 401,
    );

    if (attempt < attempts && shouldRetry(response.status, retry)) {
      await sleep(backoffMs(attempt, retryAfterMs(response.headers.get('retry-after'))));
      continue;
    }
    throw lastError;
  }

  throw lastError ?? pmError(`Request failed: ${method} ${path}`, null, url, '');
}

/** Exponential backoff, unless the server named its own delay. */
export function backoffMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return retryAfter;
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function parseBody<T>(
  response: Response,
  parse: 'json' | 'text',
  call: { method: string; path: string; url: string },
): Promise<T> {
  // 204 is the documented success for the process PUT.
  if (response.status === 204) return undefined as T;
  const text = await safeText(response);
  if (parse === 'text') return text as T;
  if (text.trim() === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // An HTML page where JSON was expected is the sign-in page (R12); anything else is
    // a response this client does not understand. Either way a PmError, with the status
    // and an excerpt, never a bare SyntaxError the proxy can only call "unexpected".
    const html = looksLikeHtml(text);
    throw pmError(
      `Process Manager answered ${call.method} ${call.path} with ${html ? 'an HTML page' : 'something that is not JSON'} (${response.status}): ${text.trim().slice(0, EXCERPT_LENGTH)}`,
      response.status,
      call.url,
      text.slice(0, EXCERPT_LENGTH),
      html,
    );
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Long enough for any reason a tenant gives; short enough that an HTML error page cannot flood a results cell. */
export const TENANT_MESSAGE_MAX_LENGTH = 500;

/**
 * The tenant's own words for a failed request, not the status line.
 *
 * Ported from the script's `Get-NpmErrorDetail`. A 400 from ArchiveProcess is the tenant
 * refusing on the process's own data (a deleted linked document, a disabled owner), and
 * the reason an administrator needs is in the response body. Where the body is JSON the
 * human-readable field is pulled out, because the envelope is what would otherwise end
 * up in a CSV cell. ASP.NET problem details and the Promapp handlers each use a
 * different field, so the first one carrying text wins.
 *
 * Returns null when there is nothing to say.
 */
export function tenantMessage(bodyText: string): string | null {
  const raw = bodyText.trim();
  if (raw === '') return null;

  let text = raw;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        for (const field of ['message', 'Message', 'error', 'errorMessage', 'title', 'detail']) {
          const value = record[field];
          if (typeof value === 'string' && value.trim() !== '') {
            text = value.trim();
            break;
          }
        }
      }
    } catch {
      // Not JSON after all. The raw text is still better than nothing.
    }
  }

  return text.length > TENANT_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, TENANT_MESSAGE_MAX_LENGTH).trimEnd()}...`
    : text;
}
