# QMGateway for Node.js and TypeScript

Send SMS and one-time passwords from Node.js. Needs **Node 20 or newer**. No other packages are installed with it. Written in TypeScript, so you get types in editors with no extra setup.

```
npm install @qmgateway/sdk
```

## Send a message

```js
import { QMGateway } from '@qmgateway/sdk';

const qm = new QMGateway(process.env.QMGATEWAY_API_KEY);

const sent = await qm.messages.send('+265999123456', 'Your order is ready.');
console.log(`Queued message ${sent.messageIds[0]}, ${sent.remainingUnits} SMS left`);

const message = await qm.messages.get(sent.messageIds[0]);
console.log(message.status);
```

`require('@qmgateway/sdk')` works too. Use a test key (it starts with `qm_test_`; create one on the API keys page of your account) while you build: nothing reaches a phone and no SMS are used. Keep keys out of your code: read them from the environment.

## What you can do

| | |
|---|---|
| `qm.messages.send(to, text, { scheduledAt })` | one number, or an array for several |
| `qm.messages.get(id)` / `list()` / `each()` | track delivery; `each()` fetches more pages for you |
| `qm.messages.scheduled()` / `cancel(id)` / `reschedule(id, time)` | scheduled messages |
| `qm.inbox.list()` / `each()` | replies received |
| `qm.otp.send({ phone })` / `verify(ref, code)` | one-time passwords |
| `qm.devices.list()` | your gateway phones |
| `qm.account.get()` / `balance()` / `statistics()` | account and usage |

```js
for await (const m of qm.messages.each({ status: 'Failed' })) {
  console.log(`${m.id} to ${m.phoneNumber} failed: ${m.failureReason}`);
}
```

## Errors

Everything the SDK throws extends `QMGatewayError`. API errors are `ApiError`s with a stable `code`, the HTTP `status` and a `requestId` to quote to support.

```js
import { ApiError, RateLimitError, ConnectionError } from '@qmgateway/sdk';

try {
  await qm.messages.send(phone, text);
} catch (e) {
  if (e instanceof RateLimitError) console.error('rate limited, try again in', e.retryAfter, 'seconds')
  else if (e instanceof ApiError) console.error(e.code, e.status, e.requestId);
  else if (e instanceof ConnectionError) console.error('no answer; resend with the same idempotencyKey to be safe')
  else throw e;
}
```

## Retries and duplicates

Network errors, rate limits (429) and server errors (5xx) are retried up to 4 times, waiting for `Retry-After` when given, otherwise 1, 2, 4, 8 seconds. Other errors are never retried. Every send carries an `Idempotency-Key` (made for you), kept the same across retries, so a retry can never send twice. For jobs that may run again, pass your own: `send(to, text, { idempotencyKey: 'order-' + orderId })`. Sending a one-time password is retried only after a 429.

```js
const qm = new QMGateway(key, { timeout: 10, maxRetries: 2 });
```

## Webhooks

```js
import { verifyWebhook, SignatureError } from '@qmgateway/sdk';

// Express: use express.raw({ type: 'application/json' }) so req.body is the untouched body.
app.post('/webhooks/qmgateway', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.headers, process.env.QMGATEWAY_WEBHOOK_SECRET);
    if (event.type === 'sms.delivered') { console.log('delivered', event.messageId); }
    res.sendStatus(200);
  } catch (e) {
    if (e instanceof SignatureError) return res.sendStatus(401);
    throw e;
  }
});
```

Use the raw body exactly as received. Requests older than 5 minutes are refused.

## Testing your own code

```js
import { FakeTransport } from '@qmgateway/sdk/testing';

const fake = new FakeTransport().queueJson({ success: true, data: { message_ids: [7], recipients: 1, sms_units: 1, status: 'Queued', remaining_units: 99, idempotent_replay: false, numbers: ['+265999123456'] } }, 202);
const qm = new QMGateway('qm_test_x', { transport: fake.transport });

const sent = await qm.messages.send('+265999123456', 'Hello');
console.log(sent.messageIds[0]);               // 7
console.log(fake.last.headers['x-api-key']);   // qm_test_x
```

`queueError()` and `queueNetworkError()` play failures; `fake.requests` shows what was sent. `signWebhook()` builds a correctly signed request for testing your handler.

## Command line

```
# paste a test key from the API keys page of your QMGateway account (it starts with qm_test_)
export QMGATEWAY_API_KEY="<your test key>"      # Windows PowerShell: $env:QMGATEWAY_API_KEY = "<your test key>"
npx qmgateway send +265999123456 "Hello"
npx qmgateway help
```

## Developing this SDK

`npm test` builds and runs the tests (they use the shared contract files in `tests/contract`, or `QMGATEWAY_CONTRACT_DIR`). `npm run typecheck` checks the types. `npm run test:live` checks it against a real server: set `QMGATEWAY_BASE`, `QMGATEWAY_LIVE_KEY` and `QMGATEWAY_TEST_KEY` first. Use the keys of a test organisation, because the live checks queue real messages.

Security problems: see [SECURITY.md](SECURITY.md). Licence: MIT.
