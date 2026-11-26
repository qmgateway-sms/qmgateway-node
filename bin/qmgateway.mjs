#!/usr/bin/env node
// Command-line tool.  QMGATEWAY_API_KEY=qm_live_... npx qmgateway account
// The key is read from the environment on purpose: a key typed as an argument stays in your shell history.
import { readFileSync } from 'node:fs';
import { QMGateway, QMGatewayError, ApiError, verifyWebhook, SignatureError } from '../dist/esm/index.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const json = rest.includes('--json'); const args = rest.filter((a) => a !== '--json');
const out = (v) => console.log(json ? JSON.stringify(v, null, 2) : typeof v === 'string' ? v : Object.entries(v).map(([k, x]) => k.padEnd(18) + (typeof x === 'object' ? JSON.stringify(x) : x)).join('\n'));
const fail = (m, code = 1) => { console.error(m); process.exit(code); };
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (['help', '--help', '-h'].includes(cmd)) {
  console.log(`qmgateway command-line tool

Set QMGATEWAY_API_KEY (and QMGATEWAY_BASE_URL for a non-default server), then:
  account                       who the key belongs to and which services are ready
  balance                       what is left of your plan
  devices                       your gateway phones
  send <phone> <message>        queue a message (add --at="2026-12-01 08:00:00" to schedule it)
  status <id>                   where a message is now
  messages [--status=Failed]    the latest messages
  verify-webhook --secret=...   check a webhook: raw body on standard input, --header="Name: value" for each header
Add --json for machine-readable output.`);
  process.exit(0);
}
if (cmd === 'verify-webhook') {
  const secret = opt('secret') ?? process.env.QMGATEWAY_WEBHOOK_SECRET ?? fail('Give --secret=... or set QMGATEWAY_WEBHOOK_SECRET.', 2);
  const headers = {}; for (const a of args) if (a.startsWith('--header=') && a.includes(':')) { const [n, ...v] = a.slice(9).split(':'); headers[n.trim()] = v.join(':').trim(); }
  try { const e = verifyWebhook(readFileSync(0), headers, secret); out({ verified: true, event: e.type, event_id: e.id, message_id: e.messageId }); }
  catch (e) { if (e instanceof SignatureError) { out({ verified: false, reason: e.reason }); process.exit(3); } throw e; }
  process.exit(0);
}
const key = process.env.QMGATEWAY_API_KEY ?? fail('Set the QMGATEWAY_API_KEY environment variable.', 2);
try {
  const qm = new QMGateway(key, process.env.QMGATEWAY_BASE_URL ? { baseUrl: process.env.QMGATEWAY_BASE_URL } : {});
  switch (cmd) {
    case 'account': { const a = await qm.account.get(); out(json ? a.raw : { organisation: a.organisationName, key: a.keyMode, sms_ready: a.services.find((s) => s.key === 'sms')?.readyToSend ?? false }); break; }
    case 'balance': { const b = await qm.account.balance(); out(json ? b.raw : { plan: b.plan, remaining: `${b.remaining} of ${b.quota}`, level: b.level, expires_at: b.expiresAt }); break; }
    case 'devices': for (const d of await qm.devices.list()) out(json ? d.raw : `#${d.id} ${d.name} (${d.status}, ${d.queued} queued)`); break;
    case 'send': {
      const at = opt('at'); const p = args.filter((a) => !a.startsWith('--at='));
      if (p.length < 2) fail('Usage: qmgateway send <phone> <message> [--at="YYYY-MM-DD HH:MM:SS"]', 2);
      const r = await qm.messages.send(p[0], p.slice(1).join(' '), at ? { scheduledAt: at } : {});
      out(json ? r.raw : `Queued message ${r.messageIds[0]} (${r.remainingUnits} units left)`); break;
    }
    case 'status': { const m = await qm.messages.get(Number(args[0] ?? 0)); out(json ? m.raw : `#${m.id} ${m.phoneNumber}: ${m.status}${m.failureReason ? ` (${m.failureReason})` : ''}`); break; }
    case 'messages': for (const m of (await qm.messages.list({ ...(opt('status') ? { status: opt('status') } : {}), limit: 20 })).items) out(json ? m.raw : `#${m.id} ${m.phoneNumber} ${m.status}`); break;
    default: fail(`Unknown command "${cmd}". Run qmgateway help.`, 2);
  }
} catch (e) {
  if (e instanceof QMGatewayError) fail(`Error: ${e.message}${e instanceof ApiError ? ` [${e.code}]` : ''}`);
  throw e;
}
