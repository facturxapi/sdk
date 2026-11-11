// Offline tests: fetch is forbidden, no API key is real.
// Responses are the real staging capture in fixtures/ (labelled) or synthetic bodies built here
// from the shapes documented in the served OpenAPI.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import * as fx from "../src/index.js";

const here = new URL(".", import.meta.url).pathname;
const INVOICE = JSON.parse(await readFile(join(here, "fixtures/invoice.json"), "utf8"));
const BASE = "https://api-staging.facturxapi.com";
const XML = Buffer.from("<?xml version='1.0'?><rsm:CrossIndustryInvoice>synthetic</rsm:CrossIndustryInvoice>");
const PDF = Buffer.from("%PDF-1.7\nSYNTHETIC");
const reply = (data, status = 200, headers = {}) => [status, headers, Buffer.from(JSON.stringify(data))];
const DRY = { dry_run: true, success: false, generationReadiness: { status: "ready" }, request_id: "req_dry" };

function final(overrides = {}) {
  return {
    request_id: "req_final",
    success: true,
    target: { requested: "en16931", executed: "en16931", status: "verified" },
    result: {
      conversionSuccessful: true,
      packagingPerformed: true,
      targetProfile: "EN16931",
      xml: XML.toString("base64"),
      pdf: PDF.toString("base64"),
    },
    finalGeneratedValidation: {
      status: "passed",
      artifactAvailable: true,
      validationReadiness: { packaging: { status: "passed" } },
    },
    ...overrides,
  };
}

let calls;
function client(...replies) {
  calls = [];
  const transport = async (method, url, headers, body) => {
    calls.push({ method, url, headers: { ...headers }, body });
    const item = replies.shift();
    if (item instanceof Error) throw item;
    return item;
  };
  return new fx.FacturX({ apiKey: "offline-placeholder", baseUrl: BASE, transport });
}

beforeEach(() => {
  globalThis.fetch = () => {
    throw new Error("network forbidden");
  };
});

test("default host is production and https only", () => {
  const saved = process.env.FACTURX_BASE_URL;
  delete process.env.FACTURX_BASE_URL;
  try {
    assert.equal(new fx.FacturX({ apiKey: "k" }).baseUrl, "https://api.facturxapi.com");
    assert.throws(() => new fx.FacturX({ apiKey: "k", baseUrl: "http://x.test" }), /https/);
  } finally {
    if (saved !== undefined) process.env.FACTURX_BASE_URL = saved;
  }
});

test("a missing API key says where to get a free one, before any request", async () => {
  const saved = process.env.FACTURX_API_KEY;
  delete process.env.FACTURX_API_KEY;
  const calls = [];
  try {
    const client = new fx.FacturX({ baseUrl: BASE, transport: async (...args) => { calls.push(args); throw new Error("no call expected"); } });
    await assert.rejects(() => client.dryRun(INVOICE), /https:\/\/facturxapi\.com\/api-key/);
    assert.equal(calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.FACTURX_API_KEY = saved;
  }
});

test("dryRun.ready reads generationReadiness, not success", async () => {
  const result = await client(reply(DRY)).dryRun(INVOICE);
  assert.equal(result.ready, true);
  assert.equal(calls[0].url, `${BASE}/api/v1/convert?dry_run=true`);
  assert.equal(calls[0].headers["X-API-Key"], "offline-placeholder");
  assert.equal(calls[0].headers["Idempotency-Key"], result.idempotencyKey);
  assert.match(calls[0].body.toString(), /name="invoice_data"[\s\S]*X08-DEMO-001/);
  const blocked = await client(reply({ ...DRY, generationReadiness: { status: "blocked" } })).dryRun(INVOICE);
  assert.equal(blocked.ready, false);
});

test("convert returns verified files and saves them", async () => {
  const result = await client(reply(final())).convert(INVOICE);
  assert.deepEqual([result.xml, result.pdf], [XML, PDF]);
  assert.equal(calls[0].url, `${BASE}/api/v1/convert`);
  const out = await mkdtemp(join(tmpdir(), "fx-"));
  const paths = await result.save(out);
  assert.deepEqual(await readFile(paths.pdf), PDF);
  assert.deepEqual(await readFile(paths.xml), XML);
});

test("HTTP 200 alone is not a delivery", async () => {
  const cases = {
    "success == true": final({ success: false }),
    "target.status == verified": final({ target: { status: "not_run" } }),
    "finalGeneratedValidation.status == passed": final({ finalGeneratedValidation: { status: "failed" } }),
  };
  for (const [check, body] of Object.entries(cases)) {
    await assert.rejects(client(reply(body)).convert(INVOICE, { idempotencyKey: "k1" }), (error) => {
      assert.ok(error instanceof fx.NotDeliveredError);
      assert.ok(error.failedChecks.includes(check));
      assert.equal(error.idempotencyKey, "k1");
      return true;
    });
  }
});

test("presigned pdfUrl never receives the API key", async () => {
  const body = final();
  delete body.result.pdf;
  body.result.pdfUrl = "https://download.example.test/signed";
  const result = await client(reply(body), [200, {}, PDF]).convert(INVOICE);
  assert.deepEqual(result.pdf, PDF);
  assert.equal(calls[1].url, "https://download.example.test/signed");
  assert.equal(calls[1].headers["X-API-Key"], undefined);
  assert.equal(calls[1].headers.Authorization, undefined);
});

test("real staging 401 is typed, API code and message verbatim", async () => {
  const raw = await readFile(join(here, "fixtures/staging-401-convert-noauth.json"));
  const expected = JSON.parse(raw);
  await assert.rejects(client([401, { "x-request-id": expected.request_id }, raw]).dryRun(INVOICE), (error) => {
    assert.ok(error instanceof fx.AuthenticationError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "authentication_required");
    assert.equal(error.apiMessage, expected.detail.message);
    assert.equal(error.requestId, expected.request_id);
    return true;
  });
});

test("422 keeps named fields and is not retried", async () => {
  const error = {
    detail: {
      error: "invalid_invoice_data",
      message: "Invoice data failed validation",
      issues: [{ field: "totals.gross", message: "Totals inconsistent" }],
    },
  };
  await assert.rejects(client(reply(error, 422)).convert(INVOICE), (e) => {
    assert.ok(e instanceof fx.InvalidRequestError);
    assert.equal(e.issues[0].field, "totals.gross");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("409 / 503 surface server hints and are never retried", async () => {
  const cases = [
    [409, { detail: { error: "idempotency_in_progress", retryable: true } }, {}, fx.ConflictError, true, null],
    [503, { detail: { error: "ocr_service_unavailable", retry_after_seconds: 60 } }, {}, fx.ServiceUnavailableError, null, 60],
    [503, { error: "PDFA_VERIFICATION_UNAVAILABLE" }, { "retry-after": "3" }, fx.ServiceUnavailableError, null, 3],
  ];
  for (const [status, body, headers, Cls, retryable, retryAfter] of cases) {
    await assert.rejects(client(reply(body, status, headers)).convert(INVOICE, { idempotencyKey: "same" }), (e) => {
      assert.ok(e instanceof Cls);
      assert.deepEqual([e.retryable, e.retryAfter, e.idempotencyKey], [retryable, retryAfter, "same"]);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("same-key resend is byte-identical", async () => {
  const c = client(reply(final()), reply(final()));
  await c.convert(INVOICE, { idempotencyKey: "op-1" });
  await c.convert(INVOICE, { idempotencyKey: "op-1" });
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.deepEqual(calls[0].headers, calls[1].headers);
});

test("transport failure is outcome-unknown and keeps the key", async () => {
  await assert.rejects(client(new Error("socket hang up")).convert(INVOICE, { idempotencyKey: "op-2" }), (e) => {
    assert.ok(e instanceof fx.TransportError);
    assert.equal(e.idempotencyKey, "op-2");
    return true;
  });
});

test("202 async is not a result", async () => {
  const accepted = { success: false, result: { status: "processing", jobId: "job-1" } };
  await assert.rejects(client(reply(accepted, 202)).convert(INVOICE), (e) => {
    assert.ok(e instanceof fx.ConversionPendingError);
    assert.equal(e.jobId, "job-1");
    return true;
  });
});

test("xml_cii output has no pdf", async () => {
  const body = final();
  delete body.result.pdf;
  const result = await client(reply(body)).convert(INVOICE, { output: "xml_cii" });
  assert.equal(result.pdf, null);
  assert.match(calls[0].body.toString(), /xml_cii/);
});

test("validate uploads the file; meta is unauthenticated", async () => {
  const c = client(reply({ valid: true }), reply({ public_api_version: "1.0.0" }));
  assert.equal((await c.validate(XML, { validationTarget: "en16931" })).valid, true);
  assert.equal(calls[0].url, `${BASE}/api/v1/validate?validation_target=en16931`);
  assert.match(calls[0].body.toString(), /filename="invoice.xml"/);
  assert.equal((await c.meta()).public_api_version, "1.0.0");
  assert.equal(calls[1].headers["X-API-Key"], undefined);
});

test("replay of a real staging conversion", async () => {
  // Real staging responses (06/11/2026), trimmed to the fields the SDK reads. The real PDF is
  // omitted for size (its sha256 is kept); a synthetic PDF stands in for it here.
  const cassette = JSON.parse(await readFile(join(here, "cassettes/staging-convert-invoice.json"), "utf8"));
  const finalResult = cassette.interactions[1].response.body.result;
  assert.equal(finalResult.pdf_omitted.sha256, "46210e491fcfca8952875a9afc39ceb1719f94ce15106db38392678fc18dddd1");
  finalResult.pdf = PDF.toString("base64");
  const replies = cassette.interactions.map((i) => [i.response.status, i.response.headers, Buffer.from(JSON.stringify(i.response.body))]);
  const c = client(...replies);
  const check = await c.dryRun(INVOICE);
  assert.equal(check.ready, true);
  assert.equal(check.raw.success, false); // ready although success=false
  const doc = await c.convert(INVOICE);
  assert.equal(doc.target.status, "verified");
  assert.equal(doc.xmlSha256, "f332975e12f8dac94c926d8832c6434daf3ae718e3b10fb8acb9758bc940e03c");
  assert.deepEqual(doc.pdf, PDF);
  assert.deepEqual(calls.map((x) => x.url), cassette.interactions.map((i) => i.request.url));
  for (const i of cassette.interactions) assert.equal(i.request.headers["X-API-Key"], "<redacted>");
});

test("invalid arguments fail before any request", async () => {
  const c = client();
  await assert.rejects(c.convert(INVOICE, { output: "pdf" }), TypeError);
  await assert.rejects(c.convert(INVOICE, { validationTarget: "fr" }), TypeError);
  await assert.rejects(c.convert(), TypeError);
  assert.equal(calls.length, 0);
});

test("python and node build the same multipart for the same key", async () => {
  // Cross-check with the Python SDK: the boundary is derived from the key the same way.
  const c = client(reply(final()));
  await c.convert(INVOICE, { idempotencyKey: "cross-1" });
  const boundary = calls[0].headers["Content-Type"].split("boundary=")[1];
  assert.equal(boundary, "facturx-sdk-" + (await import("node:crypto")).createHash("sha256").update("cross-1").digest("hex").slice(0, 32));
});
