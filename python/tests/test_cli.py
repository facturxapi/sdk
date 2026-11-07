"""Offline CLI tests: same recorder transport as the SDK tests, no network."""

import base64
import contextlib
import io
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import facturx_api as fx
from facturx_api import cli

HERE = Path(__file__).resolve().parent
INVOICE_PATH = HERE / "fixtures" / "invoice.json"
XML = b"<?xml version='1.0'?><rsm:CrossIndustryInvoice>synthetic</rsm:CrossIndustryInvoice>"
PDF = b"%PDF-1.7\nSYNTHETIC"
DRY = {"dry_run": True, "success": False, "generationReadiness": {"status": "ready"}}
FINAL = {
    "success": True,
    "target": {"status": "verified"},
    "result": {
        "conversionSuccessful": True,
        "packagingPerformed": True,
        "xml": base64.b64encode(XML).decode(),
        "pdf": base64.b64encode(PDF).decode(),
    },
    "finalGeneratedValidation": {
        "status": "passed",
        "artifactAvailable": True,
        "validationReadiness": {"packaging": {"status": "passed"}},
    },
}


def reply(data, status=200, headers=None):
    return status, headers or {}, json.dumps(data).encode()


class CliTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(socket, "socket", side_effect=AssertionError("network forbidden"))
        guard.start()
        self.addCleanup(guard.stop)

    def run_cli(self, argv, *replies):
        self.calls = []
        queue = list(replies)

        def transport(method, url, headers, body):
            self.calls.append({"url": url, "headers": dict(headers)})
            item = queue.pop(0)
            if isinstance(item, BaseException):
                raise item
            return item

        client = fx.FacturX("offline-placeholder", "https://x.test", transport=transport)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(argv, client=client)
        return code, json.loads(out.getvalue())

    def test_dry_run_ready_exits_0_with_json(self):
        code, out = self.run_cli(["dry-run", str(INVOICE_PATH)], reply(DRY))
        self.assertEqual((code, out["ok"], out["ready"]), (0, True, True))
        self.assertEqual(out["idempotency_key"], self.calls[0]["headers"]["Idempotency-Key"])

    def test_dry_run_not_ready_exits_1(self):
        blocked = {**DRY, "generationReadiness": {"status": "blocked"}}
        code, out = self.run_cli(["dry-run", str(INVOICE_PATH)], reply(blocked))
        self.assertEqual((code, out["ok"]), (1, False))

    def test_convert_writes_files_and_reports_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self.run_cli(
                ["convert", str(INVOICE_PATH), "--out", tmp, "--idempotency-key", "op-1"],
                reply(FINAL),
            )
            self.assertEqual(code, 0)
            self.assertEqual(Path(out["files"]["pdf"]["path"]).read_bytes(), PDF)
            self.assertEqual(out["files"]["xml"]["bytes"], len(XML))
            self.assertEqual(out["idempotency_key"], "op-1")
            self.assertEqual(self.calls[0]["headers"]["Idempotency-Key"], "op-1")

    def test_200_without_verified_file_exits_1_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self.run_cli(
                ["convert", str(INVOICE_PATH), "--out", tmp], reply({**FINAL, "success": False})
            )
            self.assertEqual((code, out["error"]["type"]), (1, "NotDeliveredError"))
            self.assertIn("success == true", out["error"]["failed_checks"])
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_api_error_exits_3_with_code_and_message_verbatim(self):
        body = {
            "detail": {"error": "invalid_api_key", "message": "The API key provided is invalid."},
            "request_id": "req-1",
        }
        code, out = self.run_cli(["dry-run", str(INVOICE_PATH)], reply(body, 401))
        self.assertEqual(code, 3)
        err = out["error"]
        self.assertEqual((err["status"], err["code"]), (401, "invalid_api_key"))
        self.assertEqual(err["api_message"], "The API key provided is invalid.")
        self.assertEqual(err["request_id"], "req-1")
        self.assertIn("idempotency_key", err)

    def test_transport_failure_exits_4_and_keeps_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self.run_cli(
                ["convert", str(INVOICE_PATH), "--out", tmp, "--idempotency-key", "op-2"],
                TimeoutError("timed out"),
            )
        self.assertEqual(code, 4)
        self.assertEqual(out["error"]["idempotency_key"], "op-2")

    def test_unreadable_input_exits_2_before_any_request(self):
        code, out = self.run_cli(["dry-run", "/nonexistent/invoice.json"])
        self.assertEqual((code, out["ok"]), (2, False))
        self.assertEqual(self.calls, [])

    def test_validate_prints_report(self):
        with tempfile.NamedTemporaryFile(suffix=".xml") as f:
            f.write(XML)
            f.flush()
            code, out = self.run_cli(["validate", f.name], reply({"valid": True}))
        self.assertEqual((code, out["report"]["valid"]), (0, True))


if __name__ == "__main__":
    unittest.main()
