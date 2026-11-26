import { ConnectionError } from './errors.js';
import type { Transport, TransportRequest, TransportResponse } from './http.js';

/**
 * A pretend network for your own tests: queue answers, run your code, then look at `requests`.
 *   const fake = new FakeTransport().queueJson({ success: true, data: {} }, 202);
 *   const qm = new QMGateway('qm_test_x', { transport: fake.transport });
 */
export class FakeTransport {
  readonly requests: TransportRequest[] = [];
  private answers: Array<TransportResponse | ConnectionError> = [];

  queueRaw(status: number, body: string, headers: Record<string, string> = {}): this {
    const h: Record<string, string> = {}; for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
    this.answers.push({ status, headers: h, body }); return this;
  }
  queueJson(json: unknown, status = 200, headers: Record<string, string> = {}): this { return this.queueRaw(status, JSON.stringify(json), headers); }
  queueError(status: number, code: string, message = 'Error', opts: { headers?: Record<string, string>; details?: Record<string, unknown> } = {}): this {
    return this.queueJson({ success: false, error: { code, message, request_id: 'req_fake', details: opts.details ?? {} } }, status, opts.headers);
  }
  queueNetworkError(message = 'Could not connect'): this { this.answers.push(new ConnectionError(message)); return this; }

  readonly transport: Transport = async (request) => {
    this.requests.push(request);
    const next = this.answers.shift();
    if (!next) throw new Error(`FakeTransport has no answer queued for ${request.method} ${request.url}`);
    if (next instanceof ConnectionError) throw next;
    return next;
  };
  get last(): TransportRequest { const r = this.requests.at(-1); if (!r) throw new Error('Nothing was sent yet.'); return r; }
}
