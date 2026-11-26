import { randomInt } from 'node:crypto';
import { ApiError, AuthenticationError, ConflictError, ConnectionError, InvalidRequestError, NotFoundError, PermissionError, RateLimitError, ServerError } from './errors.js';

export interface TransportRequest { method: string; url: string; headers: Record<string, string>; body: string | null; timeoutMs: number; retryable: boolean }
export interface TransportResponse { status: number; headers: Record<string, string>; body: string }
/** Sends one request. Throw ConnectionError when no answer could be read. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface Options {
  /** Where the API lives. https only; plain http is accepted for localhost (testing). Default https://qmgateway.com */
  baseUrl?: string;
  /** Seconds to wait for one request. A timeout counts as a network error. Default 30. */
  timeout?: number;
  /** Extra tries after the first, for network errors, 429 and 5xx. 0 turns retries off. Default 4. */
  maxRetries?: number;
  /** Replaces the network (tests use FakeTransport from @qmgateway/sdk/testing). */
  transport?: Transport;
  /** Replaces the real pause between retries. Tests use it to run fast. */
  sleep?: (seconds: number) => Promise<void>;
  /** Appended to the SDK's User-Agent. */
  userAgent?: string;
}
export const VERSION = '0.1.0';
const MAX_WAIT = 60;

export function checkOptions(o: Options): { baseUrl: string; timeout: number; maxRetries: number } {
  const baseUrl = o.baseUrl ?? 'https://qmgateway.com';
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new TypeError('baseUrl is not a valid web address.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new TypeError('baseUrl must use https (plain http is only allowed for localhost).');
  if (u.username || u.password) throw new TypeError('baseUrl must not contain a user name or password.');
  const timeout = o.timeout ?? 30, maxRetries = o.maxRetries ?? 4;
  if (!(timeout > 0 && timeout <= 300)) throw new TypeError('timeout must be between 0 and 300 seconds.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new TypeError('maxRetries must be a whole number from 0 to 10.');
  if (o.userAgent && /[\r\n]/.test(o.userAgent)) throw new TypeError('userAgent must be one line.');
  return { baseUrl: u.origin + u.pathname.replace(/\/+$/, ''), timeout, maxRetries };
}

/** The built-in transport: fetch (Node 20+), no redirects, one timeout for the whole request. */
export const fetchTransport: Transport = async (r) => {
  try {
    const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body, redirect: 'error', signal: AbortSignal.timeout(r.timeoutMs) });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, headers, body: await res.text() };
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'The request timed out.' : `Could not reach QMGateway (${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message}).`;
    throw new ConnectionError(reason, { cause: e });
  }
};

type Query = Record<string, string | number | boolean | null | undefined>;

/**
 * Sends requests and does what every call needs: the key, the retries, and turning an error answer into the right error.
 * Retry rules (the shared SDK contract): network errors, 429 and 5xx are retried, other 4xx never; wait Retry-After (max 60 s) or 1, 2, 4, 8 s
 * plus up to 20% jitter; same Idempotency-Key every try. A request that is not safe to repeat is retried only on 429.
 */
export class HttpClient {
  readonly settings: ReturnType<typeof checkOptions>;
  constructor(private readonly apiKey: string, private readonly options: Options = {}) {
    if (!apiKey || /\s/.test(apiKey)) throw new TypeError('The API key is missing or has spaces in it.');
    this.settings = checkOptions(options);
  }

  async request(method: string, path: string, opts: { query?: Query; body?: unknown; headers?: Record<string, string>; safeToRepeat?: boolean } = {}): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) params.append(k, String(v));
    const qs = params.toString();
    const headers: Record<string, string> = { 'x-api-key': this.apiKey, accept: 'application/json', 'user-agent': `qmgateway-node/${VERSION} node/${process.versions.node}${this.options.userAgent ? ' ' + this.options.userAgent : ''}`, ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const request: TransportRequest = { method, url: this.settings.baseUrl + path + (qs ? '?' + qs : ''), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : null, timeoutMs: this.settings.timeout * 1000, retryable: opts.safeToRepeat ?? true };
    const transport = this.options.transport ?? fetchTransport;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.settings.maxRetries;
      let res: TransportResponse;
      try { res = await transport(request); }
      catch (e) {
        if (!(e instanceof ConnectionError) || last || !request.retryable) throw e;
        await this.pause(backoff(attempt)); continue;
      }
      if ((res.status === 429 || (res.status >= 500 && request.retryable)) && !last) { await this.pause(waitFor(res, attempt)); continue; }
      return decode(res);
    }
  }

  private async pause(seconds: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(seconds);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

function backoff(attempt: number): number { return Math.min(2 ** attempt, MAX_WAIT) * (1 + randomInt(0, 201) / 1000); }
function waitFor(res: TransportResponse, attempt: number): number {
  const after = res.headers['retry-after'];
  return after !== undefined && /^\d+$/.test(after) ? Math.min(Number(after), MAX_WAIT) : backoff(attempt);
}

function decode(res: TransportResponse): Record<string, unknown> {
  let data: unknown = null;
  try { data = JSON.parse(res.body); } catch { /* not JSON */ }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (res.status >= 200 && res.status < 300 && obj?.success === true) return obj;
  const e = (obj?.error && typeof obj.error === 'object' ? obj.error : {}) as Record<string, unknown>;
  const s = res.status;
  const code = typeof e.code === 'string' ? e.code : s >= 500 ? 'SERVER_ERROR' : 'INVALID_RESPONSE';
  const message = typeof e.message === 'string' ? e.message : s >= 500 ? 'QMGateway had a problem. Please try again shortly.' : 'QMGateway sent an answer this SDK cannot read.';
  const id = typeof e.request_id === 'string' ? e.request_id : (res.headers['x-request-id'] ?? null);
  const details = (e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
  if (s === 401) throw new AuthenticationError(message, s, code, id, details);
  if (s === 403) throw new PermissionError(message, s, code, id, details);
  if (s === 404) throw new NotFoundError(message, s, code, id, details);
  if (s === 409) throw new ConflictError(message, s, code, id, details);
  if (s === 429) { const ra = res.headers['retry-after']; throw new RateLimitError(message, s, code, id, details, ra !== undefined && /^\d+$/.test(ra) ? Number(ra) : null); }
  if (s >= 500) throw new ServerError(message, s, code, id, details);
  if (s >= 400) throw new InvalidRequestError(message, s, code, id, details);
  throw new ApiError(message, s, code, id, details);
}
