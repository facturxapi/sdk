"""Offline tests: network sockets are forbidden, no API key is real.

Responses are either the real staging capture in fixtures/ (labelled) or
synthetic bodies built here from the shapes documented in the served OpenAPI.
"""

import base64
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import facturx_api as fx

HERE = Path(__file__).resolve().parent
INVOICE = json.loads((HERE / "fixtures" / "invoice.json").read_text())
BASE = "https://api-staging.facturxapi.com"
XML = b"<?xml version='1.0'?><rsm:CrossIndustryInvoice>synthetic</rsm:CrossIndustryInvoice>"
PDF = b"%PDF-1.7\nSYNTHETIC"


def reply(data, status=200, headers=None):
    return status, headers or {}, json.dumps(data).encode()


DRY = {  # synthetic: success=false yet ready, as observed on staging 05/11
    "dry_run": True,
    "success": False,
    "generationReadiness": {"status": "ready"},
    "request_id": "req_dry",
}


def final(**overrides):  # synthetic final body following ConvertResponse
    body = {
        "request_id": "req_final",
        "success": True,
        "target": {"requested": "en16931", "executed": "en16931", "status": "verified"},
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
    body.update(overrides)
    return body


class Recorder:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        item = self.replies.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


class ClientTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(socket, "socket", side_effect=AssertionError("network forbidden"))
        guard.start()
        self.addCleanup(guard.stop)

    def client(self, *replies):
        self.rec = Recorder(replies)
        return fx.FacturX("offline-placeholder", BASE, transport=self.rec)

    def test_default_host_is_production_and_https_only(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(fx.FacturX("k").base_url, "https://api.facturxapi.com")
        with patch.dict("os.environ", {"FACTURX_BASE_URL": "https://api-staging.facturxapi.com/"}, clear=True):
            self.assertEqual(fx.FacturX("k").base_url, "https://api-staging.facturxapi.com")
        with self.assertRaisesRegex(ValueError, "https"):
            fx.FacturX("k", "http://api-staging.facturxapi.com")

    def test_missing_api_key_says_where_to_get_a_free_one_before_any_request(self):
        with patch.dict("os.environ", {}, clear=True):
            client = fx.FacturX(base_url=BASE, transport=Recorder([]))
            with self.assertRaisesRegex(ValueError, r"https://facturxapi\.com/api-key"):
                client.dry_run(INVOICE)
            self.assertEqual(client._send.calls, [])

    def test_dry_run_ready_reads_generation_readiness_not_success(self):
        result = self.client(reply(DRY)).dry_run(INVOICE)
        self.assertTrue(result.ready)
        call = self.rec.calls[0]
        self.assertEqual(call["url"], BASE + "/api/v1/convert?dry_run=true")
        self.assertEqual(call["headers"]["X-API-Key"], "offline-placeholder")
        self.assertEqual(call["headers"]["Idempotency-Key"], result.idempotency_key)
        self.assertIn(b'name="invoice_data"', call["body"])
        self.assertIn(b"X08-DEMO-001", call["body"])
        blocked = {**DRY, "generationReadiness": {"status": "blocked"}}
        self.assertFalse(self.client(reply(blocked)).dry_run(INVOICE).ready)

    def test_convert_returns_verified_files_and_saves_them(self):
        result = self.client(reply(final())).convert(INVOICE)
        self.assertEqual((result.xml, result.pdf), (XML, PDF))
        self.assertEqual(self.rec.calls[0]["url"], BASE + "/api/v1/convert")
        with tempfile.TemporaryDirectory() as out:
            paths = result.save(out)
            self.assertEqual(paths["pdf"].read_bytes(), PDF)
            self.assertEqual(paths["xml"].read_bytes(), XML)

    def test_http_200_alone_is_not_a_delivery(self):
        bad_cases = {
            "success == true": final(success=False),
            "target.status == verified": final(target={"status": "not_run"}),
            "finalGeneratedValidation.status == passed": final(
                finalGeneratedValidation={"status": "failed"}
            ),
        }
        for check, body in bad_cases.items():
            with self.subTest(check=check):
                with self.assertRaises(fx.NotDeliveredError) as ctx:
                    self.client(reply(body)).convert(INVOICE, idempotency_key="k1")
                self.assertIn(check, ctx.exception.failed_checks)
                self.assertEqual(ctx.exception.idempotency_key, "k1")

    def test_presigned_pdf_url_never_receives_the_api_key(self):
        body = final()
        del body["result"]["pdf"]
        body["result"]["pdfUrl"] = "https://download.example.test/signed"
        result = self.client(reply(body), (200, {}, PDF)).convert(INVOICE)
        self.assertEqual(result.pdf, PDF)
        download = self.rec.calls[1]
        self.assertEqual(download["url"], "https://download.example.test/signed")
        self.assertNotIn("X-API-Key", download["headers"])
        self.assertNotIn("Authorization", download["headers"])

    def test_real_staging_401_is_typed_with_api_code_and_message_verbatim(self):
        raw = (HERE / "fixtures" / "staging-401-convert-noauth.json").read_bytes()
        expected = json.loads(raw)
        with self.assertRaises(fx.AuthenticationError) as ctx:
            self.client((401, {"x-request-id": expected["request_id"]}, raw)).dry_run(INVOICE)
        err = ctx.exception
        self.assertEqual(err.status, 401)
        self.assertEqual(err.code, "authentication_required")
        self.assertEqual(err.message, expected["detail"]["message"])
        self.assertEqual(err.request_id, expected["request_id"])

    def test_422_keeps_named_fields_and_is_not_retried(self):
        error = {
            "detail": {
                "error": "invalid_invoice_data",
                "message": "Invoice data failed validation",
                "issues": [{"field": "totals.gross", "message": "Totals inconsistent"}],
            },
            "request_id": "req_422",
        }
        with self.assertRaises(fx.InvalidRequestError) as ctx:
            self.client(reply(error, 422)).convert(INVOICE)
        self.assertEqual(ctx.exception.issues[0]["field"], "totals.gross")
        self.assertEqual(len(self.rec.calls), 1)

    def test_409_503_are_surfaced_with_server_hints_and_never_retried(self):
        cases = [
            (
                409,
                {"detail": {"error": "idempotency_in_progress", "retryable": True}},
                {},
                fx.ConflictError,
                True,
                None,
            ),
            (
                503,
                {"detail": {"error": "ocr_service_unavailable", "retry_after_seconds": 60}},
                {},
                fx.ServiceUnavailableError,
                None,
                60.0,
            ),
            (
                503,
                {"error": "PDFA_VERIFICATION_UNAVAILABLE"},
                {"retry-after": "3"},
                fx.ServiceUnavailableError,
                None,
                3.0,
            ),
        ]
        for status, body, headers, cls, retryable, retry_after in cases:
            with self.subTest(code=status):
                with self.assertRaises(cls) as ctx:
                    self.client(reply(body, status, headers)).convert(
                        INVOICE, idempotency_key="same"
                    )
                err = ctx.exception
                self.assertEqual((err.retryable, err.retry_after), (retryable, retry_after))
                self.assertEqual(err.idempotency_key, "same")
                self.assertEqual(len(self.rec.calls), 1)  # no automatic retry

    def test_same_key_resend_is_byte_identical(self):
        client = self.client(reply(final()), reply(final()))
        client.convert(INVOICE, idempotency_key="op-1")
        client.convert(INVOICE, idempotency_key="op-1")
        first, second = self.rec.calls
        self.assertEqual(first["body"], second["body"])
        self.assertEqual(first["headers"], second["headers"])

    def test_transport_failure_is_outcome_unknown_and_keeps_key(self):
        with self.assertRaises(fx.TransportError) as ctx:
            self.client(TimeoutError("timed out")).convert(INVOICE, idempotency_key="op-2")
        self.assertEqual(ctx.exception.idempotency_key, "op-2")

    def test_202_async_is_not_a_result(self):
        accepted = {"success": False, "result": {"status": "processing", "jobId": "job-1"}}
        with self.assertRaises(fx.ConversionPendingError) as ctx:
            self.client(reply(accepted, 202)).convert(INVOICE)
        self.assertEqual(ctx.exception.job_id, "job-1")

    def test_xml_cii_output_has_no_pdf(self):
        body = final()
        del body["result"]["pdf"]
        result = self.client(reply(body)).convert(INVOICE, output="xml_cii")
        self.assertIsNone(result.pdf)
        self.assertIn(b"xml_cii", self.rec.calls[0]["body"])

    def test_validate_uploads_file_and_meta_is_unauthenticated(self):
        client = self.client(reply({"valid": True}), reply({"public_api_version": "1.0.0"}))
        self.assertTrue(client.validate(XML, validation_target="en16931")["valid"])
        upload = self.rec.calls[0]
        self.assertEqual(upload["url"], BASE + "/api/v1/validate?validation_target=en16931")
        self.assertIn(b'filename="invoice.xml"', upload["body"])
        self.assertEqual(client.meta()["public_api_version"], "1.0.0")
        self.assertNotIn("X-API-Key", self.rec.calls[1]["headers"])

    def test_message_catalogue_entry_is_unauthenticated_and_quotes_the_rule(self):
        client = self.client(
            reply({"entry_id": "BR-FR-05"}),
            reply(
                {
                    "detail": {
                        "error": "rule_not_in_served_catalogue",
                        "message": "No served catalogue message for this rule.",
                    }
                },
                404,
            ),
        )
        self.assertEqual(client.message_catalogue_entry(" BR-FR-05 ")["entry_id"], "BR-FR-05")
        self.assertEqual(self.rec.calls[0]["url"], BASE + "/api/v1/message-catalogue/BR-FR-05")
        self.assertNotIn("X-API-Key", self.rec.calls[0]["headers"])
        with self.assertRaises(fx.ApiError) as caught:
            client.message_catalogue_entry("a/b")
        self.assertEqual(
            (caught.exception.status, caught.exception.code), (404, "rule_not_in_served_catalogue")
        )
        self.assertEqual(self.rec.calls[1]["url"], BASE + "/api/v1/message-catalogue/a%2Fb")

    def test_extract_uploads_pdf_and_returns_api_result(self):
        client = self.client(reply({"xml": "PD94", "profile": "EN16931"}))
        result = client.extract(PDF, validate=True)
        self.assertEqual(result["profile"], "EN16931")
        call = self.rec.calls[0]
        self.assertEqual(call["url"], BASE + "/api/v1/extract?validate=true")
        self.assertIn(b'filename="invoice.pdf"', call["body"])
        self.assertIn(b"Content-Type: application/pdf", call["body"])

    def test_replay_of_real_staging_conversion(self):
        # Real staging responses (06/11/2026), trimmed to the fields the SDK reads. The real
        # PDF is omitted for size (its sha256 is kept); a synthetic PDF stands in for it here.
        cassette = json.loads((HERE / "cassettes" / "staging-convert-invoice.json").read_text())
        final_result = cassette["interactions"][1]["response"]["body"]["result"]
        self.assertEqual(
            final_result["pdf_omitted"]["sha256"],
            "dd9abd2cbab9679abdaf6e397fd0805032413a406bd757de23d009b4108f41f7",
        )
        final_result["pdf"] = base64.b64encode(PDF).decode()
        replies = [
            (
                i["response"]["status"],
                i["response"]["headers"],
                json.dumps(i["response"]["body"]).encode(),
            )
            for i in cassette["interactions"]
        ]
        client = self.client(*replies)
        check = client.dry_run(INVOICE)
        self.assertTrue(check.ready)
        self.assertIs(check.raw["success"], False)  # ready although success=false
        doc = client.convert(INVOICE)
        self.assertEqual(doc.target["status"], "verified")
        self.assertEqual(
            doc.xml_sha256, "f332975e12f8dac94c926d8832c6434daf3ae718e3b10fb8acb9758bc940e03c"
        )
        self.assertEqual(doc.pdf, PDF)
        recorded = [i["request"]["url"] for i in cassette["interactions"]]
        self.assertEqual([c["url"] for c in self.rec.calls], recorded)
        for interaction in cassette["interactions"]:
            self.assertEqual(interaction["request"]["headers"]["X-API-Key"], "<redacted>")

    def test_invalid_arguments_fail_before_any_request(self):
        client = self.client()
        for kwargs in [{"output": "pdf"}, {"validation_target": "fr"}]:
            with self.subTest(**kwargs), self.assertRaises(ValueError):
                client.convert(INVOICE, **kwargs)
        with self.assertRaises(ValueError):
            client.convert()
        self.assertEqual(self.rec.calls, [])


if __name__ == "__main__":
    unittest.main()
