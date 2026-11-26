import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { QMGateway, AuthenticationError, PermissionError, InvalidRequestError, NotFoundError, RateLimitError, ServerError, ConnectionError, ApiError, SignatureError, verifyWebhook, signWebhook, isFinished } from '../dist/esm/index.js';
import { FakeTransport } from '../dist/esm/testing.js';

const dir = process.env.QMGATEWAY_CONTRACT_DIR ?? (existsSync(new URL('../../sdk-contract/', import.meta.url)) ? new URL('../../sdk-contract/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') : new URL('./contract/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const contract = (f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const sent = { success: true, data: { message_ids: [7], recipients: 1, sms_units: 1, status: 'Queued', remaining_units: 99, idempotent_replay: false, numbers: ['+265999123456'] } };
function make(fake, maxRetries = 4) {
  const sleeps = [];
  return { sleeps, qm: new QMGateway('qm_test_abc', { transport: fake.transport, maxRetries, sleep: async (s) => { sleeps.push(s); } }) };
}

test('send builds the request and the result', async () => {
  const fake = new FakeTransport().queueJson(sent, 202);
  const r = await make(fake).qm.messages.send('+265999123456', 'Hi', { scheduledAt: '2026-12-01 08:00:00' });
  assert.deepEqual(r.messageIds, [7]); assert.equal(r.remainingUnits, 99);
  const q = fake.last;
  assert.equal(q.method, 'POST'); assert.equal(q.url, 'https://qmgateway.com/api/v1/messages'); assert.equal(q.headers['x-api-key'], 'qm_test_abc');
  assert.deepEqual(JSON.parse(q.body), { phone: '+265999123456', message: 'Hi', scheduled_at: '2026-12-01 08:00:00' });
  assert.equal(q.headers['idempotency-key'].length, 32);
});
test('a Date is sent as Malawi time', async () => {
  const fake = new FakeTransport().queueJson(sent, 202);
  await make(fake).qm.messages.send('+265999123456', 'Hi', { scheduledAt: new Date('2026-12-01T06:00:00Z') });
  assert.equal(JSON.parse(fake.last.body).scheduled_at, '2026-12-01 08:00:00');
});
test('lists use recipients, drop undefined query values and encode', async () => {
  const fake = new FakeTransport().queueJson(sent, 202).queueJson({ success: true, data: [], next_before_id: null });
  const { qm } = make(fake);
  await qm.messages.send(['+265999123456', '+265888123456'], 'Hi');
  assert.deepEqual(JSON.parse(fake.last.body).recipients, ['+265999123456', '+265888123456']);
  await qm.messages.list({ status: 'Failed', phone: '+265999123456' });
  assert.equal(fake.last.url, 'https://qmgateway.com/api/v1/messages?status=Failed&phone=%2B265999123456');
});
test('unknown fields are ignored and kept in raw', async () => {
  const r = await make(new FakeTransport().queueJson({ ...sent, data: { ...sent.data, brand_new: 'x' } }, 202)).qm.messages.send('+265999123456', 'Hi');
  assert.equal(r.raw.brand_new, 'x');
});
test('options are checked', () => {
  assert.throws(() => new QMGateway('k', { baseUrl: 'http://qmgateway.com' }), TypeError);
  assert.throws(() => new QMGateway('k', { timeout: 0 }), TypeError);
  assert.throws(() => new QMGateway('bad key'), TypeError);
  new QMGateway('k', { baseUrl: 'http://127.0.0.1:8120' });
});

test('an idempotency key with a line break is refused', async () => {
  await assert.rejects(make(new FakeTransport()).qm.messages.send('+265999123456', 'x', { idempotencyKey: 'a\r\nX-Evil: 1' }), TypeError);
});
test('statuses map to typed errors', async () => {
  for (const [status, cls] of [[401, AuthenticationError], [403, PermissionError], [404, NotFoundError], [422, InvalidRequestError], [400, InvalidRequestError]]) {
    const fake = new FakeTransport().queueError(status, 'SOME_CODE', 'Bad thing');
    await assert.rejects(make(fake).qm.account.get(), (e) => { assert.ok(e instanceof cls); assert.equal(e.code, 'SOME_CODE'); assert.equal(e.requestId, 'req_fake'); assert.equal(e.status, status); return true; });
    assert.equal(fake.requests.length, 1, 'no retry on ' + status);
  }
});
test('error details are kept; unreadable answers are typed errors', async () => {
  await assert.rejects(make(new FakeTransport().queueError(402, 'INSUFFICIENT_BALANCE', 'No units', { details: { remaining_units: 0 } })).qm.messages.send('+265999123456', 'x'), (e) => e instanceof ApiError && e.details.remaining_units === 0);
  await assert.rejects(make(new FakeTransport().queueRaw(200, '<html>oops</html>')).qm.account.get(), (e) => e instanceof ApiError && e.code === 'INVALID_RESPONSE');
});

test('retry: 429 then 503 then ok, same idempotency key', async () => {
  const fake = new FakeTransport().queueError(429, 'RATE_LIMITED', 'x', { headers: { 'Retry-After': '1' } }).queueError(503, 'SERVICE_UNAVAILABLE').queueJson(sent, 202);
  const { qm, sleeps } = make(fake);
  await qm.messages.send('+265999123456', 'Hi');
  assert.equal(fake.requests.length, 3); assert.equal(sleeps[0], 1); assert.ok(sleeps[1] >= 2 && sleeps[1] <= 2.4);
  assert.equal(new Set(fake.requests.map((r) => r.headers['idempotency-key'])).size, 1);
});
test('retry: always unavailable gives 5 attempts then ServerError', async () => {
  const fake = new FakeTransport(); for (let i = 0; i < 5; i++) fake.queueError(503, 'SERVICE_UNAVAILABLE');
  await assert.rejects(make(fake).qm.messages.send('+265999123456', 'Hi'), (e) => e instanceof ServerError && e.status === 503);
  assert.equal(fake.requests.length, 5);
});
test('retry: Retry-After is capped at 60', async () => {
  const fake = new FakeTransport().queueError(429, 'RATE_LIMITED', 'x', { headers: { 'Retry-After': '3600' } }).queueJson(sent, 202);
  const { qm, sleeps } = make(fake); await qm.messages.send('+265999123456', 'Hi'); assert.deepEqual(sleeps, [60]);
});
test('retry: network errors retried then ConnectionError; maxRetries 0 turns it off', async () => {
  const fake = new FakeTransport(); for (let i = 0; i < 3; i++) fake.queueNetworkError();
  await assert.rejects(make(fake, 2).qm.messages.send('+265999123456', 'Hi'), ConnectionError); assert.equal(fake.requests.length, 3);
  const f2 = new FakeTransport().queueError(503, 'X'); await assert.rejects(make(f2, 0).qm.account.get(), ServerError); assert.equal(f2.requests.length, 1);
});
test('codes are not repeated after 5xx or network errors, but are after 429', async () => {
  let f = new FakeTransport().queueError(503, 'X'); await assert.rejects(make(f).qm.otp.send({ phone: '+265999123456' }), ServerError); assert.equal(f.requests.length, 1);
  f = new FakeTransport().queueNetworkError(); await assert.rejects(make(f).qm.otp.send({ phone: '+265999123456' }), ConnectionError); assert.equal(f.requests.length, 1);
  f = new FakeTransport().queueError(429, 'R', 'x', { headers: { 'Retry-After': '1' } }).queueJson({ success: true, data: { request_reference: 'r1', expires_in: 300, status: 'sent', channel: 'sms' } });
  assert.equal((await make(f).qm.otp.send({ phone: '+265999123456' })).requestReference, 'r1');
});
test('a final rate limit carries retryAfter', async () => {
  const fake = new FakeTransport(); for (let i = 0; i < 5; i++) fake.queueError(429, 'R', 'x', { headers: { 'Retry-After': '7' } });
  await assert.rejects(make(fake).qm.account.get(), (e) => e instanceof RateLimitError && e.retryAfter === 7);
});

for (const c of contract('pagination-cases.json').cases) {
  test('pagination: ' + c.name, async () => {
    const fake = new FakeTransport(); const inbox = c.operationId === 'get_inbox';
    c.pages.forEach((ids, i) => fake.queueJson({ success: true, data: ids.map((id) => inbox ? { id, from: '+265999', message: 'm', received_at: '2026-11-19 10:29:41' } : { id, phone_number: '+265999', status: 'Sent', message_type: 'sms', sms_units: 1 }), [c.next_field]: i + 1 < c.pages.length ? ids.at(-1) : null }));
    const { qm } = make(fake); const got = [];
    for await (const m of inbox ? qm.inbox.each() : qm.messages.each()) got.push(m.id);
    assert.deepEqual(got, c.expect_ids); assert.equal(fake.requests.length, c.pages.length);
    if (c.pages.length > 1) assert.ok(fake.requests[1].url.includes(c.param + '='));
  });
}

const wc = contract('webhook-cases.json');
for (const c of wc.cases) {
  test('webhook: ' + c.id, () => {
    const run = () => verifyWebhook(c.body, c.headers, wc.secret, { tolerance: wc.tolerance_seconds, now: wc.now });
    if (c.expect_verified) { const e = run(); assert.equal(e.type, c.headers['X-QMGateway-Event']); assert.equal(e.messageId, 1052); }
    else assert.throws(run, (e) => e instanceof SignatureError && e.reason === c.reason);
  });
}
test('signWebhook is accepted by verifyWebhook, also from a Buffer', () => {
  const r = signWebhook('{"message_id":5,"status":"Failed"}', 'whsec_x', { event: 'sms.failed' });
  const e = verifyWebhook(Buffer.from(r.body), r.headers, 'whsec_x'); assert.equal(e.type, 'sms.failed'); assert.equal(e.status, 'Failed');
});

test('models parse', async () => {
  const a = await make(new FakeTransport().queueJson({ success: true, data: { organisation: { id: 3, name: 'Acme' }, key: { mode: 'test', scopes: ['messages:send'] }, services: [{ key: 'sms', name: 'SMS', status: 'active', details: { ready_to_send: true } }] } })).qm.account.get();
  assert.equal(a.organisationName, 'Acme'); assert.ok(a.isTestKey); assert.ok(a.services[0].readyToSend);
  const d = await make(new FakeTransport().queueJson({ success: true, data: [{ id: 1, name: 'Phone', status: 'online', last_seen_at: '2026-11-19 10:29:41', networks: ['Airtel'], capacity: 2, queued: 0 }] })).qm.devices.list();
  assert.ok(d[0].online); assert.equal(d[0].lastSeenAt.toISOString(), '2026-11-19T08:29:41.000Z');
  const m = await make(new FakeTransport().queueJson({ success: true, data: { id: 9, phone_number: '+265999123456', status: 'Delivered', message_type: 'sms', sms_units: 1 } })).qm.messages.get(9);
  assert.ok(isFinished(m));
});

test('CommonJS require works', () => {
  const { QMGateway: Q, verifyWebhook: v } = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.equal(typeof Q, 'function'); assert.equal(typeof v, 'function');
});
