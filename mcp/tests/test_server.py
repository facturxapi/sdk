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
NOT_SERVED = {
    "detail": {
        "error": "rule_not_in_served_catalogue",
        "message": "No served catalogue message for this rule.",
    }
}
CATALOGUE_BR_FR_05 = {
    "rule": "BR-FR-05",
    "entry_id": "BR-FR-05",
    "language": "fr",
    "title": "Mention obligatoire absente des notes (BR-FR-05)",
    "enum_labels": {"example": {"PMT": "pmt text", "PMD": "pmd text", "AAB": "aab text"}},
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

    pages = {"https://facturxapi.com/errors/br-fr-05"}

    def server(self, *replies):
        self.calls = []
        queue = list(replies)

        def transport(method, url, headers, body):
            self.calls.append({"method": method, "url": url, "headers": dict(headers)})
            return queue.pop(0)

        self.probed = []

        def page_exists(url):
            self.probed.append(url)
            return url in self.pages

        return build_server(
            lambda: FacturX("offline-placeholder", "https://x.test", transport=transport),
            page_exists=page_exists,
        )

    def call(self, server, name, args):
        """Returns (is_error, structured_content, error_payload)."""
        try:
            result = asyncio.run(server.call_tool(name, args))
        except ToolError as exc:  # surfaced to MCP clients as an is_error tool result
            return True, None, json.loads(str(exc).split(": ", 1)[1])
        return result.is_error, result.structured_content, None

    def test_validate_defaults_to_the_target_convert_verified(self):
        report = {"valid": True, "validationStatus": "valid", "profile": "EN16931", "errors": []}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "factur-x.xml"
            path.write_bytes(b"<?xml version='1.0'?><rsm:CrossIndustryInvoice/>")
            server = self.server(reply(report))
            is_error, content, _ = self.call(server, "facturx_validate", {"file_path": str(path)})
        self.assertFalse(is_error)
        self.assertIn("validation_target=en16931", self.calls[0]["url"])

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
        server = self.server(reply(CONTRACT), reply(NOT_SERVED, 404), reply(NOT_SERVED, 404))
        _, data, _ = self.call(server, "facturx_explain_error", {"code_or_rule": "br-s-02"})
        self.assertEqual([m["json_path"] for m in data["matches"]], ["seller.vat_id"])
        self.assertNotIn("X-API-Key", self.calls[0]["headers"])
        _, data, _ = self.call(
            server, "facturx_explain_error", {"code_or_rule": "idempotency_conflict"}
        )
        self.assertEqual(data["matches"], [])
        self.assertIn("not published yet", data["note"])
        contract_calls = [c for c in self.calls if c["url"].endswith("/integration-contract")]
        self.assertEqual(len(contract_calls), 1)  # contract fetched once, then cached
        self.assertNotIn("catalogue", data)  # 404: no served message, no key

    def test_explain_error_links_the_public_error_page_only_when_it_exists(self):
        contract = {
            "engine_version": "test",
            "fields": [
                {"json_path": "document_notes", "bt": "BT-22", "france_2026_rule": "BR-FR-05"}
            ],
        }
        server = self.server(
            reply(contract),
            reply(CATALOGUE_BR_FR_05),
            reply(NOT_SERVED, 404),
            reply(NOT_SERVED, 404),
        )
        _, data, _ = self.call(server, "facturx_explain_error", {"code_or_rule": " BR-FR-05 "})
        self.assertEqual(
            data["catalogue"], CATALOGUE_BR_FR_05
        )  # the API's text, passed through whole
        self.assertTrue(self.calls[1]["url"].endswith("/api/v1/message-catalogue/BR-FR-05"))
        self.assertNotIn("X-API-Key", self.calls[1]["headers"])
        self.assertEqual(data["learn_more"], "https://facturxapi.com/errors/br-fr-05")
        self.assertEqual([m["json_path"] for m in data["matches"]], ["document_notes"])
        _, data, _ = self.call(server, "facturx_explain_error", {"code_or_rule": "BT-1"})
        self.assertNotIn("learn_more", data)  # page answers 404: no link
        _, data, _ = self.call(server, "facturx_explain_error", {"code_or_rule": "totals.gross"})
        self.assertNotIn("learn_more", data)  # a JSON path is never turned into a page URL
        self.call(server, "facturx_explain_error", {"code_or_rule": "br-fr-05"})
        catalogue_calls = [c["url"] for c in self.calls if "/message-catalogue/" in c["url"]]
        self.assertEqual(len(catalogue_calls), 2)  # BR-FR-05 and BT-1, each once; never a JSON path
        self.assertEqual(
            self.probed,
            ["https://facturxapi.com/errors/br-fr-05", "https://facturxapi.com/errors/bt-1"],
        )  # one probe per page, then cached; no key, no API call

    def test_default_probe_sends_head_with_its_own_user_agent(self):
        from facturx_mcp import server as module

        seen = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        class Opener:
            def open(self, request, timeout):
                seen.append((request.get_method(), request.get_header("User-agent"), timeout))
                return Response()

        with patch.object(module.urllib.request, "build_opener", return_value=Opener()):
            self.assertTrue(module._catalog_page_exists("https://facturxapi.com/errors/br-fr-05"))
        self.assertEqual(seen, [("HEAD", module.USER_AGENT, 3)])
        self.assertTrue(module.USER_AGENT.startswith("facturx-mcp/"))

    def test_default_probe_follows_no_redirect_and_fails_closed(self):
        from facturx_mcp import server as module

        self.assertFalse(module._catalog_page_exists("https://facturxapi.com/errors/br-fr-05"))
        self.assertIsNone(
            module._NoRedirect().redirect_request(None, None, 301, "", {}, "https://x.test/")
        )


if __name__ == "__main__":
    unittest.main()
