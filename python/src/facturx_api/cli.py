"""``facturx`` command line, built on the SDK. JSON on stdout, one line per run.

Exit codes: 0 success; 1 dry run not ready / no verified file; 2 usage error;
3 API error; 4 transport failure (outcome unknown: resend with the same key).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ._client import OUTPUTS, TARGETS, FacturX, __version__
from ._errors import (
    ApiError,
    ConversionPendingError,
    NotDeliveredError,
    TransportError,
)

EXIT_OK, EXIT_NOT_READY, EXIT_USAGE, EXIT_API, EXIT_TRANSPORT = 0, 1, 2, 3, 4


def _parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-url", help="API host (default: $FACTURX_BASE_URL, else https://api.facturxapi.com)")
    common.add_argument("--api-key", help="API key (default: $FACTURX_API_KEY)")
    common.add_argument("--timeout", type=float, default=120.0, help="seconds (default 120)")

    conv = argparse.ArgumentParser(add_help=False)
    conv.add_argument("invoice", type=Path, help="complete ERP invoice JSON file")
    conv.add_argument("--target", choices=TARGETS, default="en16931")
    conv.add_argument("--output", choices=OUTPUTS, default="facturx_pdfa3")
    conv.add_argument("--idempotency-key", help="reuse it to resend the same operation")

    parser = argparse.ArgumentParser(prog="facturx", description="FacturX API command line")
    parser.add_argument("--version", action="version", version=f"facturx {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("dry-run", parents=[common, conv], help="free check, no deliverable (no quota)")
    convert = sub.add_parser(
        "convert", parents=[common, conv], help="final conversion (1 invoice on the quota)"
    )
    convert.add_argument("--out", type=Path, required=True, help="directory for the files")
    validate = sub.add_parser("validate", parents=[common], help="validate a PDF or XML file")
    validate.add_argument("file", type=Path)
    validate.add_argument("--target", choices=TARGETS)
    return parser


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _error(exc: Exception) -> dict[str, Any]:
    out: dict[str, Any] = {"type": type(exc).__name__, "message": str(exc)}
    for name in ("status", "code", "request_id", "retryable", "retry_after", "issues"):
        if getattr(exc, name, None) not in (None, []):
            out[name] = getattr(exc, name)
    if isinstance(exc, ApiError) and exc.message is not None:
        out["api_message"] = exc.message
    for name in ("idempotency_key", "job_id", "failed_checks"):
        if getattr(exc, name, None):
            out[name] = getattr(exc, name)
    return out


def main(argv: list[str] | None = None, client: FacturX | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        fx = client or FacturX(args.api_key, args.base_url, timeout=args.timeout)
        if args.command == "validate":
            report = fx.validate(args.file, validation_target=args.target)
            _emit({"ok": True, "command": "validate", "report": report})
            return EXIT_OK
        invoice = json.loads(args.invoice.read_text(encoding="utf-8"))
        kwargs = {
            "output": args.output,
            "validation_target": args.target,
            "idempotency_key": args.idempotency_key,
        }
        if args.command == "dry-run":
            check = fx.dry_run(invoice, **kwargs)
            _emit(
                {
                    "ok": check.ready,
                    "command": "dry-run",
                    "ready": check.ready,
                    "generation_readiness": check.generation_readiness,
                    "request_id": check.request_id,
                    "idempotency_key": check.idempotency_key,
                }
            )
            return EXIT_OK if check.ready else EXIT_NOT_READY
        doc = fx.convert(invoice, **kwargs)
        paths = doc.save(args.out)
        files = {kind: {"path": str(path)} for kind, path in paths.items()}
        files["xml"].update(bytes=len(doc.xml), sha256=doc.xml_sha256)
        if doc.pdf is not None:
            files["pdf"].update(bytes=len(doc.pdf), sha256=doc.pdf_sha256)
        _emit(
            {
                "ok": True,
                "command": "convert",
                "target": doc.target,
                "target_profile": doc.target_profile,
                "files": files,
                "request_id": doc.request_id,
                "idempotency_key": doc.idempotency_key,
            }
        )
        return EXIT_OK
    except (ValueError, OSError) as exc:  # bad arguments, unreadable input, invalid JSON
        _emit({"ok": False, "command": args.command, "error": _error(exc)})
        return EXIT_USAGE
    except (NotDeliveredError, ConversionPendingError) as exc:
        _emit({"ok": False, "command": args.command, "error": _error(exc)})
        return EXIT_NOT_READY
    except ApiError as exc:
        _emit({"ok": False, "command": args.command, "error": _error(exc)})
        return EXIT_API
    except TransportError as exc:
        _emit({"ok": False, "command": args.command, "error": _error(exc)})
        return EXIT_TRANSPORT


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
