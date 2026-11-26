import { randomBytes } from 'node:crypto';
import { HttpClient, type Options } from './http.js';
import * as M from './models.js';

type Raw = Record<string, unknown>;
const data = (a: Raw): Raw => (a.data && typeof a.data === 'object' && !Array.isArray(a.data) ? (a.data as Raw) : {});
const list = (a: Raw): Raw[] => (Array.isArray(a.data) ? (a.data as Raw[]) : []);
const cursor = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const at = (v: string | Date): string => (v instanceof Date ? M.toMalawiTime(v) : v);

export interface SendOptions {
  type?: string;
  deviceId?: number;
  /** Malawi time as text ("2026-12-01 08:00:00") or a Date. */
  scheduledAt?: string | Date;
  /** Pass your own for jobs that may run again; otherwise one is made for you and kept the same across retries. */
  idempotencyKey?: string;
}

export class Messages {
  constructor(private readonly http: HttpClient) {}

  /** Queue a message for one number or a list of numbers. */
  async send(to: string | string[], message: string, o: SendOptions = {}): Promise<M.SendResult> {
    const body: Raw = { ...(Array.isArray(to) ? { recipients: to } : { phone: to }), message };
    if (o.type !== undefined) body.type = o.type;
    if (o.deviceId !== undefined) body.device_id = o.deviceId;
    if (o.scheduledAt !== undefined) body.scheduled_at = at(o.scheduledAt);
    if (o.idempotencyKey !== undefined && !/^[!-~]{1,255}$/.test(o.idempotencyKey)) throw new TypeError('idempotencyKey must be 1 to 255 visible characters with no spaces.');
    const key = o.idempotencyKey ?? randomBytes(16).toString('hex');
    return M.toSendResult(data(await this.http.request('POST', '/api/v1/messages', { body, headers: { 'idempotency-key': key } })));
  }

  /** One message and where it is now. */
  async get(id: number): Promise<M.Message> {
    return M.toMessage(data(await this.http.request('GET', '/api/v1/message_status', { query: { id } })));
  }

  /** One page of messages, newest first. Pass `nextCursor` as `beforeId` for the next page. */
  async list(o: { status?: string; phone?: string; since?: string; limit?: number; beforeId?: number } = {}): Promise<M.Page<M.Message>> {
    const a = await this.http.request('GET', '/api/v1/messages', { query: { status: o.status, phone: o.phone, since: o.since, limit: o.limit, before_id: o.beforeId } });
    return { items: list(a).map(M.toMessage), nextCursor: cursor(a.next_before_id) };
  }

  /** Every matching message, newest first: `for await (const m of qm.messages.each())`. */
  async *each(o: { status?: string; phone?: string; since?: string; pageSize?: number } = {}): AsyncGenerator<M.Message> {
    let c: number | null = null;
    do {
      const p: M.Page<M.Message> = await this.list({ ...o, limit: o.pageSize ?? 100, ...(c !== null ? { beforeId: c } : {}) });
      yield* p.items;
      c = p.nextCursor;
    } while (c !== null);
  }

  async scheduled(o: { limit?: number; afterId?: number } = {}): Promise<M.Page<M.ScheduledMessage>> {
    const a = await this.http.request('GET', '/api/v1/scheduled', { query: { limit: o.limit, after_id: o.afterId } });
    return { items: list(a).map(M.toScheduled), nextCursor: cursor(a.next_after_id) };
  }

  async *eachScheduled(pageSize = 100): AsyncGenerator<M.ScheduledMessage> {
    let c: number | null = null;
    do {
      const p: M.Page<M.ScheduledMessage> = await this.scheduled({ limit: pageSize, ...(c !== null ? { afterId: c } : {}) });
      yield* p.items;
      c = p.nextCursor;
    } while (c !== null);
  }

  /** Cancel a scheduled message. Its SMS units go back to your balance. */
  async cancel(id: number): Promise<{ id: number; status: string; remaining_units: number }> {
    return data(await this.http.request('POST', '/api/v1/message_cancel', { body: { id } })) as { id: number; status: string; remaining_units: number };
  }

  /** Move a scheduled message to a new time. */
  async reschedule(id: number, scheduledAt: string | Date): Promise<{ id: number; status: string; scheduled_at: string }> {
    return data(await this.http.request('POST', '/api/v1/message_reschedule', { body: { id, scheduled_at: at(scheduledAt) } })) as { id: number; status: string; scheduled_at: string };
  }
}

/** Replies received on your gateway phones, oldest first. */
export class Inbox {
  constructor(private readonly http: HttpClient) {}

  async list(o: { afterId?: number; from?: string; limit?: number } = {}): Promise<M.Page<M.InboxMessage>> {
    const a = await this.http.request('GET', '/api/v1/inbox', { query: { after_id: o.afterId, from: o.from, limit: o.limit } });
    return { items: list(a).map(M.toInbox), nextCursor: cursor(a.next_after_id) };
  }

  async *each(o: { from?: string; afterId?: number; pageSize?: number } = {}): AsyncGenerator<M.InboxMessage> {
    let c: number | null = o.afterId ?? null;
    do {
      const p: M.Page<M.InboxMessage> = await this.list({ limit: o.pageSize ?? 100, ...(o.from !== undefined ? { from: o.from } : {}), ...(c !== null ? { afterId: c } : {}) });
      yield* p.items;
      c = p.nextCursor;
    } while (c !== null);
  }
}

export class Devices {
  constructor(private readonly http: HttpClient) {}
  async list(): Promise<M.Device[]> {
    return list(await this.http.request('GET', '/api/v1/devices')).map(M.toDevice);
  }
}

/** One-time passwords by SMS or email. */
export class Otp {
  constructor(private readonly http: HttpClient) {}

  /** Send a code. Retried only after a 429, so a code is never sent twice by accident. */
  async send(o: { channel?: 'sms' | 'email'; phone?: string; email?: string; purpose?: string; expirySeconds?: number }): Promise<M.OtpRequest> {
    const body: Raw = { channel: o.channel ?? 'sms' };
    if (o.phone !== undefined) body.phone = o.phone;
    if (o.email !== undefined) body.email = o.email;
    if (o.purpose !== undefined) body.purpose = o.purpose;
    if (o.expirySeconds !== undefined) body.expiry_seconds = o.expirySeconds;
    return M.toOtpRequest(data(await this.http.request('POST', '/api/v1/otp/send', { body, safeToRepeat: false })));
  }

  /** A wrong or expired code gives verified = false. It is only an error when the request itself is wrong. */
  async verify(requestReference: string, code: string): Promise<M.OtpVerification> {
    return M.toOtpVerification(data(await this.http.request('POST', '/api/v1/otp/verify', { body: { request_reference: requestReference, code }, safeToRepeat: false })));
  }
}

export class Account {
  constructor(private readonly http: HttpClient) {}
  async get(): Promise<M.Account> { return M.toAccount(data(await this.http.request('GET', '/api/v1/account'))); }
  async balance(): Promise<M.Balance> { return M.toBalance(data(await this.http.request('GET', '/api/v1/balance'))); }
  async statistics(o: { period?: string; startDate?: string; endDate?: string } = {}): Promise<M.Statistics> {
    return M.toStatistics(await this.http.request('GET', '/api/v1/statistics', { query: { period: o.period, start_date: o.startDate, end_date: o.endDate } }));
  }
}

/**
 *   const qm = new QMGateway(process.env.QMGATEWAY_API_KEY!);
 *   const sent = await qm.messages.send('+265999123456', 'Your order is ready.');
 */
export class QMGateway {
  readonly messages: Messages;
  readonly inbox: Inbox;
  readonly devices: Devices;
  readonly otp: Otp;
  readonly account: Account;

  constructor(apiKey: string, options: Options = {}) {
    const http = new HttpClient(apiKey, options);
    this.messages = new Messages(http);
    this.inbox = new Inbox(http);
    this.devices = new Devices(http);
    this.otp = new Otp(http);
    this.account = new Account(http);
  }

  /** Same as the constructor; reads better with a test key (qm_test_...): nothing reaches a phone and no units are used. */
  static forTest(apiKey: string, options: Options = {}): QMGateway {
    return new QMGateway(apiKey, options);
  }
}
