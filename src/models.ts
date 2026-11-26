type Raw = Record<string, unknown>;

/** Reads the dates QMGateway sends. "2026-11-19 10:29:41" is Malawi time (UTC+2); "2026-12-01T08:00:00+02:00" has its own offset. */
export function parseTime(v: unknown): Date | null {
  if (typeof v !== 'string' || v === '') return null;
  const s = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v) ? v.replace(' ', 'T') + '+02:00' : v;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Malawi time as the API wants it when you schedule: "2026-12-01 08:00:00". */
export function toMalawiTime(d: Date): string {
  return new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
const str = (v: unknown): string => String(v ?? '');
const num = (v: unknown, d = 0): number => (v === undefined || v === null ? d : Number(v));
const nstr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

export interface Message { id: number; phoneNumber: string; status: string; messageType: string; smsUnits: number; scheduledTime: Date | null; createdAt: Date | null; sentAt: Date | null; deliveredAt: Date | null; failedAt: Date | null; failureReason: string | null; mode: string | null; raw: Raw }
export const toMessage = (d: Raw): Message => ({ id: num(d.id), phoneNumber: str(d.phone_number), status: str(d.status), messageType: str(d.message_type), smsUnits: num(d.sms_units, 1), scheduledTime: parseTime(d.scheduled_time), createdAt: parseTime(d.created_at), sentAt: parseTime(d.sent_at), deliveredAt: parseTime(d.delivered_at), failedAt: parseTime(d.failed_at), failureReason: nstr(d.failure_reason), mode: nstr(d.mode), raw: d });
/** Delivered, failed or cancelled: nothing more will happen to it. */
export const isFinished = (m: Pick<Message, 'status'>): boolean => ['Delivered', 'Failed', 'Cancelled'].includes(m.status);

export interface SendResult { messageIds: number[]; recipients: number; smsUnits: number; status: string; remainingUnits: number; idempotentReplay: boolean; numbers: string[]; raw: Raw }
export const toSendResult = (d: Raw): SendResult => ({ messageIds: ((d.message_ids as unknown[]) ?? []).map(Number), recipients: num(d.recipients), smsUnits: num(d.sms_units), status: str(d.status), remainingUnits: num(d.remaining_units), idempotentReplay: Boolean(d.idempotent_replay), numbers: ((d.numbers as unknown[]) ?? []).map(String), raw: d });

export interface InboxMessage { id: number; from: string; message: string; receivedAt: Date | null; raw: Raw }
export const toInbox = (d: Raw): InboxMessage => ({ id: num(d.id), from: str(d.from), message: str(d.message), receivedAt: parseTime(d.received_at), raw: d });

export interface ScheduledMessage { id: number; phoneNumber: string; message: string; smsUnits: number; scheduledAt: Date | null; createdAt: Date | null; raw: Raw }
export const toScheduled = (d: Raw): ScheduledMessage => ({ id: num(d.id), phoneNumber: str(d.phone_number), message: str(d.message), smsUnits: num(d.sms_units, 1), scheduledAt: parseTime(d.scheduled_at), createdAt: parseTime(d.created_at), raw: d });

export interface Device { id: number; name: string; status: string; lastSeenAt: Date | null; networks: string[]; capacity: number; queued: number; online: boolean; raw: Raw }
export const toDevice = (d: Raw): Device => ({ id: num(d.id), name: str(d.name), status: str(d.status), lastSeenAt: parseTime(d.last_seen_at), networks: ((d.networks as unknown[]) ?? []).map(String), capacity: num(d.capacity, 1), queued: num(d.queued), online: d.status === 'online', raw: d });

export interface EmailOtpBalance { included: boolean; quota: number; used: number; remaining: number; periodStart: string | null; resetsAt: string | null }
export interface Balance { active: boolean; plan: string | null; quota: number; used: number; reserved: number; remaining: number; percentLeft: number; level: string; startsAt: string | null; expiresAt: string | null; daysLeft: number | null; emailOtp: EmailOtpBalance | null; low: boolean; raw: Raw }
export const toBalance = (d: Raw): Balance => {
  const e = d.email_otp as Raw | undefined;
  return { active: Boolean(d.active), plan: nstr(d.plan), quota: num(d.quota), used: num(d.used), reserved: num(d.reserved), remaining: num(d.remaining), percentLeft: num(d.percent_left), level: str(d.level), startsAt: nstr(d.starts_at), expiresAt: nstr(d.expires_at), daysLeft: d.days_left == null ? null : num(d.days_left),
    emailOtp: e ? { included: Boolean(e.included), quota: num(e.quota), used: num(e.used), remaining: num(e.remaining), periodStart: nstr(e.period_start), resetsAt: nstr(e.resets_at) } : null, low: ['low', 'critical', 'empty'].includes(str(d.level)), raw: d };
};

export interface Service { key: string; name: string; status: string; details: Raw; readyToSend: boolean }
export interface Account { organisationId: number; organisationName: string; keyMode: string; scopes: string[]; services: Service[]; isTestKey: boolean; raw: Raw }
export const toAccount = (d: Raw): Account => {
  const org = (d.organisation ?? {}) as Raw, key = (d.key ?? {}) as Raw;
  const services = ((d.services as Raw[]) ?? []).map((s) => ({ key: str(s.key), name: str(s.name), status: str(s.status), details: (s.details ?? {}) as Raw, readyToSend: Boolean(((s.details ?? {}) as Raw).ready_to_send) }));
  return { organisationId: num(org.id), organisationName: str(org.name), keyMode: str(key.mode ?? 'live'), scopes: ((key.scopes as unknown[]) ?? []).map(String), services, isTestKey: key.mode === 'test', raw: d };
};

export interface OtpRequest { requestReference: string; expiresIn: number; status: string; channel: string; emailOtpRemaining: number | null; emailOtpResetsAt: string | null; raw: Raw }
export const toOtpRequest = (d: Raw): OtpRequest => ({ requestReference: str(d.request_reference), expiresIn: num(d.expires_in), status: str(d.status), channel: str(d.channel), emailOtpRemaining: d.email_otp_remaining == null ? null : num(d.email_otp_remaining), emailOtpResetsAt: nstr(d.email_otp_resets_at), raw: d });
/** A wrong code is a normal answer (verified false), not an error. */
export interface OtpVerification { verified: boolean; status: string }
export const toOtpVerification = (d: Raw): OtpVerification => ({ verified: Boolean(d.verified), status: str(d.status) });

export interface Statistics { overview: Record<string, number>; quota: Raw; recentMessages: Raw[]; daily: Raw[]; statusDistribution: Raw[]; topRecipients: Raw[]; counts: Record<string, number>; period: Raw; raw: Raw }
export const toStatistics = (d: Raw): Statistics => { const s = (d.statistics ?? {}) as Raw; return { overview: (s.overview ?? {}) as Record<string, number>, quota: (s.quota ?? {}) as Raw, recentMessages: (s.recent_messages ?? []) as Raw[], daily: (s.daily ?? []) as Raw[], statusDistribution: (s.status_distribution ?? []) as Raw[], topRecipients: (s.top_recipients ?? []) as Raw[], counts: (s.counts ?? {}) as Record<string, number>, period: (d.period ?? {}) as Raw, raw: d }; };

/** One page of a list, and where the next one starts (null when there is no more). */
export interface Page<T> { items: T[]; nextCursor: number | null }
