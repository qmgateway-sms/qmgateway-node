# Changelog

## 0.1.0 (2026-11-26)
- First version: messages (send, send to many, status, list, scheduled, cancel, reschedule), inbox, devices, one-time passwords, account, balance and statistics.
- Written in TypeScript; ships ESM and CommonJS builds with types. No runtime dependencies. Node 20 or newer.
- Typed results and typed errors (`AuthenticationError`, `PermissionError`, `InvalidRequestError`, `NotFoundError`, `RateLimitError`, `ServerError`, `ConnectionError`).
- Safe retries with the same `Idempotency-Key`, `Retry-After` support, 30 second timeout.
- Auto-pagination with `for await` (`messages.each()`, `inbox.each()`, `messages.eachScheduled()`).
- `verifyWebhook` with typed events, `signWebhook`, `FakeTransport` (`@qmgateway/sdk/testing`) and the `qmgateway` command-line tool.
- Security: a caller-supplied idempotency key must be 1 to 255 visible characters with no spaces, so it cannot be used to inject a header.
