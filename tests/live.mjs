// Runs the SDK against a real server:
//   QMGATEWAY_BASE=https://qmgateway.com QMGATEWAY_LIVE_KEY=qm_live_... QMGATEWAY_TEST_KEY=qm_test_... node tests/live.mjs
import { QMGateway, AuthenticationError, InvalidRequestError } from '../dist/esm/index.js';

const base = process.env.QMGATEWAY_BASE ?? 'https://qmgateway.com';
const { QMGATEWAY_LIVE_KEY: live, QMGATEWAY_TEST_KEY: test } = process.env;
if (!live || !test) { console.error('Set QMGATEWAY_LIVE_KEY and QMGATEWAY_TEST_KEY.'); process.exit(2); }
const o = { baseUrl: base, timeout: 20, maxRetries: 1 };
const qm = new QMGateway(live, o), qt = QMGateway.forTest(test, o);
let n = 0, bad = 0;
const ok = (c, m = 'unexpected result') => { if (!c) throw new Error(m); };
async function step(name, fn) { n++; try { await fn(); console.log('  ok  ' + name); } catch (e) { bad++; console.log(`FAIL  ${name}: ${e.constructor.name}: ${e.message}`); } }

await step('account', async () => { const a = await qm.account.get(); ok(a.organisationName && !a.isTestKey && a.services.some((s) => s.key === 'sms')); });
await step('balance', async () => ok((await qm.account.balance()).quota > 0));
await step('devices', async () => ok((await qm.devices.list()).length > 0));
await step('statistics', async () => ok(typeof (await qm.account.statistics()).overview === 'object'));
await step('inbox pages', async () => { let c = 0; for await (const _ of qm.inbox.each({ pageSize: 1 })) c++; ok(c >= 1); });
await step('test-key send then read it back', async () => {
  const r = await qt.messages.send('+265991234567', 'SDK live test');
  const m = await qt.messages.get(r.messageIds[0]); ok(m.phoneNumber && m.mode === 'test');
});
await step('same Idempotency-Key does not send twice', async () => {
  const k = 'sdk-live-' + Math.random().toString(36).slice(2);
  const a = await qt.messages.send('+265991234567', 'Once', { idempotencyKey: k }), b = await qt.messages.send('+265991234567', 'Once', { idempotencyKey: k });
  ok(a.messageIds[0] === b.messageIds[0] && b.idempotentReplay);
});
await step('list messages with auto-pagination', async () => {
  for (let i = 0; i < 3; i++) await qt.messages.send('+265991234567', 'Page test ' + i);
  let c = 0; for await (const _ of qt.messages.each({ pageSize: 2 })) if (++c >= 5) break; ok(c >= 3);
});
await step('schedule, list, reschedule, cancel (live key)', async () => {
  const r = await qm.messages.send('+265991234567', 'SDK scheduled', { scheduledAt: new Date(Date.now() + 3 * 864e5) }); const id = r.messageIds[0];
  let found = false; for await (const s of qm.messages.eachScheduled(5)) if (s.id === id) found = true; ok(found, 'not listed');
  ok((await qm.messages.reschedule(id, new Date(Date.now() + 4 * 864e5))).id === id);
  ok((await qm.messages.cancel(id)).status);
});
await step('errors are typed', async () => {
  await new QMGateway('qm_live_' + '0'.repeat(48), o).account.get().then(() => ok(false, 'bad key accepted'), (e) => ok(e instanceof AuthenticationError && e.status === 401 && e.requestId));
  await qm.messages.send('not-a-number', 'x').then(() => ok(false, 'bad number accepted'), (e) => ok(e instanceof InvalidRequestError && e.code));
});
await step('test key is refused on account endpoints', async () => {
  await qt.account.balance().then(() => ok(false, 'allowed'), (e) => ok(e instanceof AuthenticationError && e.code === 'TEST_KEY_NOT_ALLOWED', e.code));
});
console.log(`\n${n - bad} passed, ${bad} failed`);
process.exitCode = bad ? 1 : 0;
