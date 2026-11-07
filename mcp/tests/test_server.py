"""Offline tests of the MCP tools: fake SDK transport, network sockets forbidden."""

import asyncio
import base64
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from facturx_api import FacturX
from mcp.server.mcpserver.exceptions import ToolError

from facturx_mcp import build_server

XML = b"<?xml version='1.0'?><rsm:CrossIndustryInvoice>synthetic</rsm:CrossIndustryInvoice>"
PDF = b"%PDF-1.7\nSYNTHETIC"
INVOICE = {"invoice_number": "X08-DEMO-001"}
DRY = {"dry_run": True, "success": False, "generationReadiness": {"status": "ready"}}
FINAL = {
    "success": True,
    "target": {"status": "verified"},
    "result": {
        "conversionSuccessful": True,
        "packagingPerformed": True,
        "targetProfile": "EN16931",
        "xml": base64.b64encode(XML).decode(),
        "pdf": base64.b64encode(PDF).decode(),
    },
    "finalGeneratedValidation": {
        "status": "passed",
        "artifactAvailable": True,
        "validationReadiness": {"packaging": {"status": "passed"}},
    },
}
CONTRACT = {
    "engine_version": "test",
    "fields": [
        {"json_path": "totals.gross", "bt": "BT-112", "en16931_rule": "BR-CO-15"},
        {"json_path": "seller.vat_id", "bt": "BT-31", "en16931_rule": "BR-AF-02, BR-S-02"},
    ],
}


def reply(data, status=200):
    return status, {}, json.dumps(data).encode()


class ServerTests(unittest.TestCase):
    def setUp(self):
        # asyncio needs a local socketpair; only outbound connections are forbidden.
        guard = patch.object(
            socket.socket, "connect", side_effect=AssertionError("network forbidden")
        )
        guard.start()
        self.addCleanup(guard.stop)

    def server(self, *replies):
        self.calls = []
        queue = list(replies)

        def transport(method, url, headers, body):
            self.calls.append({"method": method, "url": url, "headers": dict(headers)})
            return queue.pop(0)

        return build_server(
            lambda: FacturX("offline-placeholder", "https://x.test", transport=transport)
        )

    def call(self, server, name, args):
        """Returns (is_error, structured_content, error_payload)."""
        try:
            result = asyncio.run(server.call_tool(name, args))
        except ToolError as exc:  # surfaced to MCP clients as an is_error tool result
            return True, None, json.loads(str(exc).split(": ", 1)[1])
        return result.is_error, result.structured_content, None

    def test_tools_are_listed_with_cost_in_descriptions(self):
        tools = {t.name: t for t in asyncio.run(self.server().list_tools())}
        self.assertEqual(
            set(tools),
            {"facturx_dry_run", "facturx_convert", "facturx_validate", "facturx_explain_error"},
        )
        self.assertIn("WITHOUT using quota", tools["facturx_dry_run"].description)
        self.assertIn("COSTS 1 invoice", tools["facturx_convert"].description)
        self.assertTrue(tools["facturx_dry_run"].annotations.read_only_hint)

    def test_dry_run_returns_ready_and_key(self):
        is_error, data, _ = self.call(
            self.server(reply(DRY)), "facturx_dry_run", {"invoice": INVOICE}
        )
        self.assertFalse(is_error)
        self.assertTrue(data["ready"])
        self.assertEqual(data["idempotency_key"], self.calls[0]["headers"]["Idempotency-Key"])

    def test_convert_writes_files(self):
        with tempfile.TemporaryDirectory() as out:
            is_error, data, _ = self.call(
                self.server(reply(FINAL)),
                "facturx_convert",
                {"invoice": INVOICE, "out_dir": out, "idempotency_key": "op-1"},
            )
            self.assertFalse(is_error)
            self.assertEqual(Path(data["files"]["pdf"]["path"]).read_bytes(), PDF)
            self.assertEqual(data["idempotency_key"], "op-1")

    def test_api_error_is_a_tool_error_with_code_and_message_verbatim(self):
        body = {
            "detail": {"error": "invalid_api_key", "message": "The API key provided is invalid."}
        }
        is_error, _, payload = self.call(
            self.server(reply(body, 401)), "facturx_dry_run", {"invoice": INVOICE}
        )
        self.assertTrue(is_error)
        error = payload["error"]
        self.assertEqual((error["status"], error["code"]), (401, "invalid_api_key"))
        self.assertEqual(error["api_message"], "The API key provided is invalid.")
        self.assertIn("idempotency_key", error)

    def test_unverified_200_is_a_tool_error_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as out:
            is_error, _, payload = self.call(
                self.server(reply({**FINAL, "success": False})),
                "facturx_convert",
                {"invoice": INVOICE, "out_dir": out},
            )
            self.assertTrue(is_error)
            self.assertIn("success == true", payload["error"]["failed_checks"])
            self.assertEqual(list(Path(out).iterdir()), [])

    def test_explain_error_matches_rule_lists_and_is_unauthenticated(self):
        server = self.server(reply(CONTRACT))
        _, data, _ = self.call(server, "facturx_explain_error", {"code_or_rule": "br-s-02"})
        self.assertEqual([m["json_path"] for m in data["matches"]], ["seller.vat_id"])
        self.assertNotIn("X-API-Key", self.calls[0]["headers"])
        _, data, _ = self.call(
            server, "facturx_explain_error", {"code_or_rule": "idempotency_conflict"}
        )
        self.assertEqual(data["matches"], [])
        self.assertIn("not published yet", data["note"])
        self.assertEqual(len(self.calls), 1)  # contract fetched once, then cached


if __name__ == "__main__":
    unittest.main()
