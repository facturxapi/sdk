"""FacturX API client: Python standard library only, no automatic retry."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from ._errors import (
    ConversionPendingError,
    FacturXError,
    NotDeliveredError,
    TransportError,
    api_error,
)
from ._results import ConvertResult, DryRunResult

__version__ = "0.1.2"
DEFAULT_BASE_URL = "https://api.facturxapi.com"
API_KEY_HELP = "Get a free Sandbox key at https://facturxapi.com/api-key"

Response = tuple[int, dict[str, str], bytes]
Transport = Callable[[str, str, Mapping[str, str], bytes | None], Response]
FileInput = bytes | str | Path

OUTPUTS = ("facturx_pdfa3", "xml_cii")
TARGETS = ("en16931", "france_2026")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None  # A redirect must never carry the API key elsewhere.


def urllib_transport(timeout: float = 120.0) -> Transport:
    """Default transport: one HTTP request, no redirect, no retry."""
    opener = urllib.request.build_opener(_NoRedirect)

    def send(method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> Response:
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return (
                response.status,
                {k.lower(): v for k, v in response.headers.items()},
                response.read(),
            )

    return send


class FacturX:
    """Client for the FacturX API.

    The host defaults to production (``https://api.facturxapi.com``); pass ``base_url`` or set
    ``FACTURX_BASE_URL`` to target another one. It must use https.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        *,
        timeout: float = 120.0,
        transport: Transport | None = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else os.environ.get("FACTURX_API_KEY", "")
        base = base_url if base_url is not None else os.environ.get("FACTURX_BASE_URL", "")
        base = base or DEFAULT_BASE_URL
        if urllib.parse.urlparse(base).scheme != "https":
            raise ValueError("base_url must use https.")
        self.base_url = base.rstrip("/")
        self._send = transport or urllib_transport(timeout)

    # ------------------------------------------------------------------ public

    def dry_run(
        self,
        invoice_data: Mapping[str, Any] | str | None = None,
        *,
        file: FileInput | None = None,
        output: str = "facturx_pdfa3",
        validation_target: str = "en16931",
        options: Mapping[str, Any] | None = None,
        lang: str | None = None,
        idempotency_key: str | None = None,
    ) -> DryRunResult:
        """Check an invoice without producing a deliverable (does not consume quota)."""
        key = idempotency_key or str(uuid.uuid4())
        data = self._convert_call(
            invoice_data, file, output, validation_target, options, lang, key, dry_run=True
        )[0]
        return DryRunResult(raw=data, idempotency_key=key)

    def convert(
        self,
        invoice_data: Mapping[str, Any] | str | None = None,
        *,
        file: FileInput | None = None,
        output: str = "facturx_pdfa3",
        validation_target: str = "en16931",
        options: Mapping[str, Any] | None = None,
        lang: str | None = None,
        idempotency_key: str | None = None,
    ) -> ConvertResult:
        """Final conversion (1 processed invoice on the quota, refunded without deliverable).

        Keep ``idempotency_key`` (on the result or on the raised error) to resend
        the identical request safely; reusing it with a different payload is a
        ``409 idempotency_conflict``.
        """
        key = idempotency_key or str(uuid.uuid4())
        data, headers = self._convert_call(
            invoice_data, file, output, validation_target, options, lang, key, dry_run=False
        )
        failed = _final_checks(data, output)
        if failed:
            raise NotDeliveredError(data, failed, idempotency_key=key)
        result = data["result"]
        try:
            xml = base64.b64decode(result["xml"], validate=True)
            pdf = self._pdf(result) if output == "facturx_pdfa3" else None
        except (ValueError, KeyError) as exc:
            raise NotDeliveredError(
                data, ["result.xml/pdf decodable"], idempotency_key=key
            ) from exc
        return ConvertResult(
            raw=data, idempotency_key=key, xml=xml, pdf=pdf, output=output, headers=headers
        )

    def validate(
        self,
        file: FileInput,
        *,
        validation_target: str | None = None,
        validation_profile: str | None = None,
        lang: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Validate an existing Factur-X PDF or XML. Returns the API report as is."""
        query = _query(
            validation_target=validation_target, validation_profile=validation_profile, lang=lang
        )
        filename, content = _read_file(file)
        body, content_type = _multipart({}, ("file", filename, content), seed=idempotency_key)
        headers = {"Content-Type": content_type}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return self._request("POST", "/api/v1/validate" + query, body, headers, idempotency_key)[0]

    def extract(
        self,
        file: FileInput,
        *,
        validate: bool = False,
        lang: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Extract the XML embedded in a Factur-X PDF (``result`` as returned by the API).

        The response carries ``xml`` (base64), ``xmlSize`` and the detected ``profile``;
        ``validate=True`` also runs validation in the same processed-invoice call.
        """
        query = _query(validate="true" if validate else None, lang=lang)
        filename, content = _read_file(file)
        body, content_type = _multipart({}, ("file", filename, content), seed=idempotency_key)
        headers = {"Content-Type": content_type}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return self._request("POST", "/api/v1/extract" + query, body, headers, idempotency_key)[0]

    def meta(self) -> dict[str, Any]:
        """``GET /meta``: public versions, limits and capabilities."""
        return self._request("GET", "/meta", None, {}, None, auth=False)[0]

    def integration_contract(self) -> dict[str, Any]:
        """``GET /api/v1/integration-contract``: public ERP integration contract."""
        return self._request("GET", "/api/v1/integration-contract", None, {}, None, auth=False)[0]

    # ----------------------------------------------------------------- private

    def _convert_call(
        self,
        invoice_data: Mapping[str, Any] | str | None,
        file: FileInput | None,
        output: str,
        validation_target: str,
        options: Mapping[str, Any] | None,
        lang: str | None,
        key: str,
        *,
        dry_run: bool,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        if output not in OUTPUTS:
            raise ValueError(f"output must be one of {OUTPUTS}")
        if validation_target not in TARGETS:
            raise ValueError(f"validation_target must be one of {TARGETS}")
        if invoice_data is None and file is None:
            raise ValueError("Provide invoice_data, file, or both.")
        fields: dict[str, str] = {"output": output, "validation_target": validation_target}
        if invoice_data is not None:
            fields["invoice_data"] = _json(invoice_data)
        if options is not None:
            fields["options"] = _json(options)
        upload = ("file", *_read_file(file)) if file is not None else None
        body, content_type = _multipart(fields, upload, seed=key)
        query = _query(dry_run="true" if dry_run else None, lang=lang)
        headers = {"Content-Type": content_type, "Idempotency-Key": key}
        data, response_headers, status = self._request(
            "POST", "/api/v1/convert" + query, body, headers, key
        )
        if status == 202:
            raise ConversionPendingError(data, idempotency_key=key)
        return data, response_headers

    def _request(
        self,
        method: str,
        path: str,
        body: bytes | None,
        headers: dict[str, str],
        idempotency_key: str | None,
        *,
        auth: bool = True,
    ) -> tuple[dict[str, Any], dict[str, str], int]:
        headers = {
            "Accept": "application/json",
            "User-Agent": f"facturx-api-python/{__version__}",
            **headers,
        }
        if auth:
            if not self.api_key:
                raise ValueError(f"api_key is required (or set FACTURX_API_KEY). {API_KEY_HELP}.")
            headers["X-API-Key"] = self.api_key
        try:
            status, response_headers, raw = self._send(method, self.base_url + path, headers, body)
        except (OSError, TimeoutError) as exc:
            raise TransportError(
                f"{method} {path}: transport failed, outcome unknown ({exc})",
                idempotency_key=idempotency_key,
            ) from exc
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            data = {"detail": {"message": raw[:500].decode("utf-8", "replace")}}
            if 200 <= status < 300:
                raise FacturXError(f"HTTP {status}: non-JSON response") from None
        if not 200 <= status < 300:
            raise api_error(status, data, response_headers, idempotency_key=idempotency_key)
        return data, response_headers, status

    def _pdf(self, result: dict[str, Any]) -> bytes:
        inline, url = result.get("pdf"), result.get("pdfUrl")
        if bool(inline) == bool(url):
            raise KeyError("expected exactly one of result.pdf / result.pdfUrl")
        if inline:
            pdf = base64.b64decode(inline, validate=True)
        else:
            if urllib.parse.urlparse(url).scheme != "https":
                raise ValueError("pdfUrl is not https")
            # Presigned URL: the API key is NEVER sent to it.
            status, _, pdf = self._send("GET", url, {}, None)
            if status != 200:
                raise ValueError(f"pdfUrl download HTTP {status}")
        if not pdf.startswith(b"%PDF-"):
            raise ValueError("deliverable is not a PDF")
        return pdf


def _final_checks(data: dict[str, Any], output: str) -> list[str]:
    """Documented success fields; HTTP 200 alone does not prove a conversion."""
    result = data.get("result") or {}
    checks = {
        "dry_run is not true": data.get("dry_run") is not True,
        "success == true": data.get("success") is True,
        "result.conversionSuccessful == true": result.get("conversionSuccessful") is True,
        "target.status == verified": (data.get("target") or {}).get("status") == "verified",
        "result.xml present": bool(result.get("xml")),
    }
    if output == "facturx_pdfa3":
        generated = data.get("finalGeneratedValidation") or {}
        packaging = (generated.get("validationReadiness") or {}).get("packaging") or {}
        checks.update(
            {
                "result.packagingPerformed == true": result.get("packagingPerformed") is True,
                "finalGeneratedValidation.status == passed": generated.get("status") == "passed",
                "finalGeneratedValidation.artifactAvailable == true": generated.get(
                    "artifactAvailable"
                )
                is True,
                "packaging.status == passed": packaging.get("status") == "passed",
            }
        )
    return [name for name, ok in checks.items() if not ok]


def _json(value: Mapping[str, Any] | str) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _query(**params: str | None) -> str:
    kept = {k: v for k, v in params.items() if v is not None}
    return "?" + urllib.parse.urlencode(kept) if kept else ""


def _read_file(file: FileInput) -> tuple[str, bytes]:
    if isinstance(file, bytes):
        return ("invoice.xml" if file.lstrip().startswith(b"<") else "invoice.pdf"), file
    path = Path(file)
    return path.name, path.read_bytes()


def _multipart(
    fields: Mapping[str, str],
    upload: tuple[str, str, bytes] | None = None,
    seed: str | None = None,
) -> tuple[bytes, str]:
    # Same idempotency key + same fields => byte-identical body on a resend.
    token = hashlib.sha256((seed or uuid.uuid4().hex).encode()).hexdigest()[:32]
    boundary = "facturx-sdk-" + token
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            + value.encode()
            + b"\r\n"
        )
    if upload is not None:
        name, filename, content = upload
        mime = "application/pdf" if content.startswith(b"%PDF-") else "application/xml"
        safe = filename.replace('"', "_").replace("\r", "_").replace("\n", "_")
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{safe}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
            + content
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    if body.count(boundary.encode()) != len(parts):
        raise ValueError("multipart boundary collides with the payload")
    return body, "multipart/form-data; boundary=" + boundary
