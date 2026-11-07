// Typed errors. Code and message are the API's own values, never rewritten.

export class FacturXError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request may or may not have reached the API: outcome unknown. Resend with the same idempotencyKey. */
export class TransportError extends FacturXError {
  constructor(message, { idempotencyKey = null, cause } = {}) {
    super(message);
    this.idempotencyKey = idempotencyKey;
    if (cause) this.cause = cause;
  }
}

/** Non-success HTTP status. retryable / retryAfter are only what the server said (null = nothing). */
export class ApiError extends FacturXError {
  constructor(status, body, headers, { idempotencyKey = null } = {}) {
    const data = body && typeof body === "object" ? body : {};
    let detail = "detail" in data ? data.detail : data;
    if (typeof detail === "string") detail = { message: detail };
    if (!detail || typeof detail !== "object") detail = {};
    const code = detail.error ?? detail.code ?? data.error ?? null;
    const message = detail.message ?? null;
    super(`HTTP ${status} ${code ?? "unknown_error"}: ${message ?? ""}`.trim());
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.detail = detail;
    this.code = code;
    this.apiMessage = message;
    this.issues = Array.isArray(detail.issues) ? detail.issues : [];
    this.retryable = typeof detail.retryable === "boolean" ? detail.retryable : null;
    this.requestId = data.request_id ?? headers["x-request-id"] ?? null;
    this.retryAfter = retryAfter(headers, detail);
    this.idempotencyKey = idempotencyKey;
  }
}

export class AuthenticationError extends ApiError {}
export class QuotaExceededError extends ApiError {}
export class RateLimitError extends ApiError {}
export class InvalidRequestError extends ApiError {}
export class ConflictError extends ApiError {}
export class ServerError extends ApiError {}
export class ServiceUnavailableError extends ServerError {}

/** 202: accepted for async processing. No file yet; the SDK does not poll. */
export class ConversionPendingError extends FacturXError {
  constructor(response, { idempotencyKey = null } = {}) {
    const jobId = response?.result?.jobId ?? null;
    super(`Conversion accepted for async processing (jobId=${jobId})`);
    this.response = response;
    this.jobId = jobId;
    this.requestId = response?.request_id ?? null;
    this.idempotencyKey = idempotencyKey;
  }
}

/** HTTP 200 without a verified final deliverable: HTTP 200 alone proves nothing. */
export class NotDeliveredError extends FacturXError {
  constructor(response, failedChecks, { idempotencyKey = null } = {}) {
    super(`No verified final file: ${failedChecks.join(", ")}`);
    this.response = response;
    this.failedChecks = failedChecks;
    this.requestId = response?.request_id ?? null;
    this.idempotencyKey = idempotencyKey;
  }
}

const BY_STATUS = {
  400: InvalidRequestError,
  401: AuthenticationError,
  402: QuotaExceededError,
  403: AuthenticationError,
  409: ConflictError,
  413: InvalidRequestError,
  415: InvalidRequestError,
  422: InvalidRequestError,
  429: RateLimitError,
  503: ServiceUnavailableError,
};

export function apiError(status, body, headers, options) {
  const Cls = BY_STATUS[status] ?? (status >= 500 ? ServerError : ApiError);
  return new Cls(status, body, headers, options);
}

function retryAfter(headers, detail) {
  for (const raw of [headers["retry-after"], detail.retry_after_seconds]) {
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
