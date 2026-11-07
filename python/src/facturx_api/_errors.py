"""Typed errors. Code and message are the API's own values, never rewritten."""

from __future__ import annotations

from typing import Any


class FacturXError(Exception):
    """Base class of every error raised by this SDK."""


class TransportError(FacturXError):
    """The request may or may not have reached the API: its outcome is unknown.

    Send the same request again with the same ``idempotency_key`` to learn the
    outcome without being charged twice. The SDK never does it for you.
    """

    def __init__(self, message: str, *, idempotency_key: str | None = None) -> None:
        super().__init__(message)
        self.idempotency_key = idempotency_key


class ApiError(FacturXError):
    """The API answered with a non-success HTTP status.

    Attributes mirror the response body: ``code`` is ``detail.error`` (or
    ``detail.code``), ``message`` is ``detail.message``. ``retryable`` and
    ``retry_after`` are only what the server said; ``None`` means it said nothing.
    """

    def __init__(
        self,
        status: int,
        body: Any,
        headers: dict[str, str],
        *,
        idempotency_key: str | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.headers = headers
        self.idempotency_key = idempotency_key
        data = body if isinstance(body, dict) else {}
        detail = data.get("detail", data)
        if not isinstance(detail, dict):
            detail = {"message": detail} if isinstance(detail, str) else {}
        self.detail: dict[str, Any] = detail
        self.code: str | None = detail.get("error") or detail.get("code") or data.get("error")
        self.message: str | None = detail.get("message")
        self.issues: list[Any] = list(detail.get("issues") or [])
        self.retryable: bool | None = detail.get("retryable")
        self.request_id: str | None = data.get("request_id") or headers.get("x-request-id")
        self.retry_after: float | None = _retry_after(headers, detail)
        super().__init__(
            f"HTTP {status} {self.code or 'unknown_error'}: {self.message or ''}".strip()
        )


class AuthenticationError(ApiError):
    """401 / 403: missing, invalid or unauthorised API key."""


class QuotaExceededError(ApiError):
    """402: monthly quota of processed invoices reached."""


class RateLimitError(ApiError):
    """429: too many requests."""


class InvalidRequestError(ApiError):
    """400 / 413 / 415 / 422: the request must be fixed; ``issues`` names the fields."""


class ConflictError(ApiError):
    """409: idempotency or context conflict. Read ``code`` before doing anything."""


class ServerError(ApiError):
    """5xx returned by the API."""


class ServiceUnavailableError(ServerError):
    """503: a dependency of the API is unavailable."""


class ConversionPendingError(FacturXError):
    """202: the API accepted the conversion for asynchronous processing.

    No final file is available yet. ``job_id`` and ``idempotency_key`` are kept
    so the caller decides what to do; the SDK does not poll.
    """

    def __init__(self, response: dict[str, Any], *, idempotency_key: str | None) -> None:
        result = response.get("result") or {}
        self.response = response
        self.job_id: str | None = result.get("jobId")
        self.request_id: str | None = response.get("request_id")
        self.idempotency_key = idempotency_key
        super().__init__(f"Conversion accepted for async processing (jobId={self.job_id})")


class NotDeliveredError(FacturXError):
    """HTTP 200 without a verified final deliverable.

    HTTP 200 alone does not prove a successful conversion: ``failed_checks``
    lists which documented fields were not in the required state, ``response``
    holds the full body.
    """

    def __init__(
        self,
        response: dict[str, Any],
        failed_checks: list[str],
        *,
        idempotency_key: str | None,
    ) -> None:
        self.response = response
        self.failed_checks = failed_checks
        self.request_id: str | None = response.get("request_id")
        self.idempotency_key = idempotency_key
        super().__init__("No verified final file: " + ", ".join(failed_checks))


_BY_STATUS: dict[int, type[ApiError]] = {
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
}


def api_error(
    status: int, body: Any, headers: dict[str, str], *, idempotency_key: str | None
) -> ApiError:
    cls = _BY_STATUS.get(status) or (ServerError if status >= 500 else ApiError)
    return cls(status, body, headers, idempotency_key=idempotency_key)


def _retry_after(headers: dict[str, str], detail: dict[str, Any]) -> float | None:
    for raw in (headers.get("retry-after"), detail.get("retry_after_seconds")):
        if raw is None:
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue  # An HTTP-date stays readable in ``headers``; not converted here.
    return None
