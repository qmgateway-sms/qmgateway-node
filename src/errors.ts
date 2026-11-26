/** Everything this SDK throws extends QMGatewayError, so one catch can handle it all. */
export class QMGatewayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** QMGateway answered with an error. Branch on `code` (stable); show `message` to people (it may be reworded). */
export class ApiError extends QMGatewayError {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /** Extra facts for some codes, for example remaining_units for INSUFFICIENT_BALANCE. */
  readonly details: Record<string, unknown>;
  constructor(message: string, status: number, code: string, requestId: string | null = null, details: Record<string, unknown> = {}) {
    super(requestId ? `${message} (request ${requestId})` : message);
    this.status = status; this.code = code; this.requestId = requestId; this.details = details;
  }
}
export class AuthenticationError extends ApiError {}
export class PermissionError extends ApiError {}
export class InvalidRequestError extends ApiError {}
export class NotFoundError extends ApiError {}
export class ConflictError extends ApiError {}
export class RateLimitError extends ApiError {
  /** Seconds the server asked you to wait, when it said. */
  readonly retryAfter: number | null;
  constructor(message: string, status: number, code: string, requestId: string | null, details: Record<string, unknown>, retryAfter: number | null) {
    super(message, status, code, requestId, details); this.retryAfter = retryAfter;
  }
}
export class ServerError extends ApiError {}

/** No answer could be read (DNS, connection, TLS or timeout), after the retries were used up. */
export class ConnectionError extends QMGatewayError {}

/** A webhook request is not genuine. `reason` is bad_signature, stale_timestamp or missing_header. Answer 401 and do nothing else. */
export class SignatureError extends QMGatewayError {
  readonly reason: 'bad_signature' | 'stale_timestamp' | 'missing_header';
  constructor(reason: SignatureError['reason']) { super(`The webhook could not be verified: ${reason}`); this.reason = reason; }
}
