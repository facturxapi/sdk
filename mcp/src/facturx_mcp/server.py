"""Official FacturX API MCP server, built on the ``facturx-api`` SDK.

Tools are written for an agent: when to use each one, what it returns and what it
costs. API errors are returned as tool errors carrying the API's own code and message.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from facturx_api import ApiError, FacturX, FacturXError, NotDeliveredError, TransportError
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

__version__ = "0.1.2"

INSTRUCTIONS = (
    "FacturX API turns a complete ERP invoice JSON into a Factur-X PDF/A-3 (EN16931). "
    "Always call facturx_dry_run first (free); call facturx_convert only when it says "
    "ready=true, because each conversion consumes 1 invoice of the account quota. "
    "When a call fails, read error.code and error.api_message; use facturx_explain_error "
    "for an EN16931 rule (BR-…), a business term (BT-…) or an invoice JSON path."
)


def _error_payload(exc: FacturXError) -> str:
    out: dict[str, Any] = {"type": type(exc).__name__, "message": str(exc)}
    for name in ("status", "code", "request_id", "retryable", "retry_after", "issues"):
        value = getattr(exc, name, None)
        if value not in (None, []):
            out[name] = value
    if isinstance(exc, ApiError) and exc.message is not None:
        out["api_message"] = exc.message
    for name in ("idempotency_key", "failed_checks", "job_id"):
        if getattr(exc, name, None):
            out[name] = getattr(exc, name)
    if isinstance(exc, TransportError):
        out["hint"] = "Outcome unknown: call again with the same idempotency_key."
    return json.dumps({"error": out}, ensure_ascii=False)


def _contract_matches(contract: dict[str, Any], query: str) -> list[dict[str, Any]]:
    q = query.strip().upper()
    keys = ("bt", "bg", "en16931_rule", "france_2026_rule", "target_policy_rule")
    hits = []
    for field in contract.get("fields") or []:
        # Rule columns hold one value or a comma-separated list ("BR-AF-02, BR-AG-02").
        tokens = {
            token.strip().upper()
            for k in keys
            for token in str(field.get(k) or "").split(",")
            if token.strip()
        }
        if q in tokens or q == str(field.get("json_path", "")).upper():
            hits.append(
                {
                    k: field.get(k)
                    for k in (
                        "json_path",
                        "bt",
                        "bg",
                        "requirement",
                        "en16931_rule",
                        "france_2026_rule",
                        "cii_xpath",
                        "accepted_values",
                        "input_format",
                        "coverage_status",
                    )
                    if field.get(k) not in (None, [], "")
                }
            )
    return hits


def build_server(client_factory: Callable[[], FacturX] | None = None) -> MCPServer:
    """Create the server. ``client_factory`` is injectable for tests."""
    make_client = client_factory or (lambda: FacturX())
    server = MCPServer(
        name="facturx",
        title="FacturX API",
        instructions=INSTRUCTIONS,
        version=__version__,
        website_url="https://facturxapi.com",
    )
    cache: dict[str, Any] = {}

    def client() -> FacturX:
        if "client" not in cache:
            cache["client"] = make_client()
        return cache["client"]

    @server.tool(
        description=(
            "Check a complete ERP invoice JSON WITHOUT producing a file and WITHOUT using quota. "
            "Use it first, every time. Returns ready (true only when generationReadiness.status "
            "is 'ready'; success=false can still be ready), the readiness detail, request_id and "
            "idempotency_key."
        ),
        annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True, idempotentHint=True),
    )
    def facturx_dry_run(
        invoice: dict[str, Any],
        validation_target: str = "en16931",
        output: str = "facturx_pdfa3",
    ) -> dict[str, Any]:
        try:
            check = client().dry_run(invoice, validation_target=validation_target, output=output)
        except (FacturXError, ValueError) as exc:
            raise ToolError(_error_payload(exc) if isinstance(exc, FacturXError) else str(exc))
        return {
            "ready": check.ready,
            "generation_readiness": check.generation_readiness,
            "target": check.raw.get("target"),
            "request_id": check.request_id,
            "idempotency_key": check.idempotency_key,
        }

    @server.tool(
        description=(
            "Final conversion: COSTS 1 invoice of the account quota (refunded by the API when no "
            "file is produced). Call it only after facturx_dry_run returned ready=true. Writes "
            "factur-x.pdf and factur-x.xml into out_dir and returns their paths, sizes, sha256, "
            "the verified target and the idempotency_key. If the call fails without an answer, "
            "call again with the SAME idempotency_key: the API will not charge twice."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True
        ),
    )
    def facturx_convert(
        invoice: dict[str, Any],
        out_dir: str,
        validation_target: str = "en16931",
        output: str = "facturx_pdfa3",
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        try:
            doc = client().convert(
                invoice,
                validation_target=validation_target,
                output=output,
                idempotency_key=idempotency_key,
            )
        except NotDeliveredError as exc:
            raise ToolError(_error_payload(exc))
        except (FacturXError, ValueError) as exc:
            raise ToolError(_error_payload(exc) if isinstance(exc, FacturXError) else str(exc))
        paths = doc.save(Path(out_dir))
        files = {
            "xml": {"path": str(paths["xml"]), "bytes": len(doc.xml), "sha256": doc.xml_sha256}
        }
        if doc.pdf is not None:
            files["pdf"] = {
                "path": str(paths["pdf"]),
                "bytes": len(doc.pdf),
                "sha256": doc.pdf_sha256,
            }
        return {
            "files": files,
            "target": doc.target,
            "target_profile": doc.target_profile,
            "request_id": doc.request_id,
            "idempotency_key": doc.idempotency_key,
        }

    @server.tool(
        description=(
            "Validate an existing Factur-X PDF or CII XML file from the local disk against "
            "validation_target (default en16931, the same target as facturx_dry_run and "
            "facturx_convert; pass france_2026 for the French e-invoicing checks). Returns valid, "
            "validationStatus, profile, target and the first errors as reported by the API. Counts "
            "1 invoice of the account quota when the API returns a report."
        ),
        annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True),
    )
    def facturx_validate(file_path: str, validation_target: str = "en16931") -> dict[str, Any]:
        try:
            report = client().validate(Path(file_path), validation_target=validation_target)
        except (FacturXError, ValueError, OSError) as exc:
            raise ToolError(_error_payload(exc) if isinstance(exc, FacturXError) else str(exc))
        errors = report.get("errors") or []
        return {
            "valid": report.get("valid"),
            "validation_status": report.get("validationStatus"),
            "profile": report.get("profile"),
            "target": report.get("target"),
            "error_count": len(errors),
            "errors": errors[:10],
        }

    @server.tool(
        description=(
            "Explain an EN16931 / France 2026 rule (e.g. BR-CO-15), a business term (e.g. BT-1) "
            "or an invoice JSON path (e.g. totals.gross): returns the matching invoice fields from "
            "the API's public integration contract (JSON path, BT, rule, CII XPath, requirement). "
            "Free, no API key needed. API error codes (409/503 …) are not in this public source yet."
        ),
        annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True, idempotentHint=True),
    )
    def facturx_explain_error(code_or_rule: str) -> dict[str, Any]:
        if "contract" not in cache:
            try:
                cache["contract"] = client().integration_contract()
            except FacturXError as exc:
                raise ToolError(_error_payload(exc))
        matches = _contract_matches(cache["contract"], code_or_rule)
        result: dict[str, Any] = {
            "query": code_or_rule,
            "source": "GET /api/v1/integration-contract",
            "engine_version": cache["contract"].get("engine_version"),
            "matches": matches,
        }
        if not matches:
            result["note"] = (
                "No invoice field of the public integration contract references this value. For an "
                "API error code, rely on error.api_message and error.issues returned by the failed "
                "call; the public API error-code registry is not published yet."
            )
        return result

    return server


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="facturx-mcp", description="FacturX API MCP server")
    parser.add_argument("--transport", choices=["stdio", "streamable-http"], default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--version", action="version", version=f"facturx-mcp {__version__}")
    args = parser.parse_args(argv)
    server = build_server()
    if args.transport == "stdio":
        server.run("stdio")
    else:
        server.run("streamable-http", host=args.host, port=args.port)


if __name__ == "__main__":  # pragma: no cover
    main()
