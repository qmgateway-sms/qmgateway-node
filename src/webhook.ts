import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignatureError } from './errors.js';
import { parseTime } from './models.js';

export type WebhookEventType = 'sms.incoming' | 'sms.sent' | 'sms.delivered' | 'sms.failed' | 'webhook.test';
export interface WebhookEvent {
  type: WebhookEventType | (string & {});
  id: string;
  attempt: number;
  data: Record<string, unknown>;
  messageId: number | null;
  phoneNumber: string | null;
  status: string | null;
  updatedAt: Date | null;
  isTest: boolean;
}
export const WEBHOOK_TOLERANCE = 300;

/**
 * Checks that a webhook really came from QMGateway. Pass the RAW body exactly as received (a string or Buffer), not re-encoded JSON.
 * Throws SignatureError when it is not genuine. `now` is unix seconds (tests pass a fixed one).
 */
export function verifyWebhook(body: string | Uint8Array, headers: Record<string, string | string[] | undefined>, secret: string, opts: { tolerance?: number; now?: number } = {}): WebhookEvent {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) { const x = Array.isArray(v) ? v[0] : v; if (x !== undefined) h[k.toLowerCase()] = x; }
  const signature = h['x-qmgateway-signature'], timestamp = h['x-qmgateway-timestamp'];
  if (!signature || !timestamp) throw new SignatureError('missing_header');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > (opts.tolerance ?? WEBHOOK_TOLERANCE)) throw new SignatureError('stale_timestamp');
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${timestamp}.${text}`).digest('hex'));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new SignatureError('bad_signature');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new SignatureError('bad_signature'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SignatureError('bad_signature');
  const d = data as Record<string, unknown>;
  const type = h['x-qmgateway-event'] ?? '';
  return { type, id: h['x-qmgateway-event-id'] ?? '', attempt: Number(h['x-qmgateway-attempt'] ?? 1), data: d, messageId: d.message_id == null ? null : Number(d.message_id), phoneNumber: d.phone_number == null ? null : String(d.phone_number), status: d.status == null ? null : String(d.status), updatedAt: parseTime(d.updated_at), isTest: type === 'webhook.test' };
}

/** Makes a correctly signed request, for testing your own webhook handler. */
export function signWebhook(body: string, secret: string, opts: { event?: string; timestamp?: number; eventId?: string } = {}): { body: string; headers: Record<string, string> } {
  const t = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  return { body, headers: { 'X-QMGateway-Timestamp': t, 'X-QMGateway-Signature': 'sha256=' + createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'), 'X-QMGateway-Event': opts.event ?? 'sms.delivered', 'X-QMGateway-Event-ID': opts.eventId ?? 'evt_test', 'X-QMGateway-Attempt': '1' } };
}
