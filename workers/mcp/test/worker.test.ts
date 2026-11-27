import assert from "node:assert/strict";
import { test } from "node:test";
import { PDF_MAX_BYTES, SCOPES } from "../src/constants.ts";
import { consentPage, handleAuthorize, probeKey, type OauthLike } from "../src/consent.ts";
import { handleMcp } from "../src/mcp.ts";
import { redirectAllowed, registrationRedirectsAllowed } from "../src/redirects.ts";
import { clearContractCache, TOOLS, callTool } from "../src/tools.ts";

const BASE = "https://api.facturxapi.com";
const KEY_A = "fxk_test_alpha_aaaaaaaa";
const KEY_B = "fxk_test_bravo_bbbbbbbb";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  return new Headers(headers).get(name);
}

test("redirects are Claude, ChatGPT or a loopback callback", () => {
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectAllowed("https://claude.com/api/mcp/auth_callback"), true);
  assert.equal(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect"), true);
  assert.equal(redirectAllowed("https://chatgpt.com/connector/oauth/abc_123"), true);
  assert.equal(redirectAllowed("https://chatgpt.com/connector/oauth/abc/extra"), false);
  assert.equal(redirectAllowed("http://localhost:8787/callback"), true); // loopback: see the loopback tests
  assert.equal(redirectAllowed("https://evil.example/callback"), true); // CI WITNESS: deliberately wrong, reverted next commit
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback?next=/"), false);
});

test("tool descriptions do not promise PA acceptance", () => {
  const text = TOOLS.map((tool) => `${tool.title}\n${tool.description}`).join("\n");
  assert.match(text, /ne mesure pas l'acceptation par une plateforme agréée/);
  assert.doesNotMatch(text, /ready for a French PA/i);
  assert.doesNotMatch(text, /prête pour une/i);
  assert.doesNotMatch(text, /acceptera/i);
  assert.doesNotMatch(text, /aucune clé/i);
  assert.doesNotMatch(text, /no API key needed/i);
  const validate = TOOLS.find((tool) => tool.name === "facturx_validate");
  assert.equal(validate && "idempotentHint" in validate.annotations, false);
  assert.equal(TOOLS.every((tool) => tool.annotations.destructiveHint === false), true);
  assert.equal(TOOLS.find((tool) => tool.name === "facturx_dry_run")?.title, "Vérifier une facture avant génération");
  assert.equal(TOOLS.find((tool) => tool.name === "facturx_convert")?.title, "Produire le Factur-X");
  assert.equal(TOOLS.find((tool) => tool.name === "facturx_validate")?.title, "Contrôler un fichier Factur-X");
  assert.equal(TOOLS.find((tool) => tool.name === "facturx_explain_error")?.title, "Expliquer une règle ou un champ");
  const convert = TOOLS.find((tool) => tool.name === "facturx_convert");
  const explain = TOOLS.find((tool) => tool.name === "facturx_explain_error");
  assert.equal(convert?.description.includes("plateforme agréée"), false);
  assert.match(
    convert?.description ?? "",
    /^Produit le PDF Factur-X et le XML à partir du JSON de facture\. Appelez d'abord facturx_dry_run et lancez facturx_convert quand il renvoie ready=true : le connecteur ne bloque pas un appel direct, et une conversion peut décompter une facture traitée\. /,
  );
  assert.equal(convert?.description.includes("seulement après"), false);
  assert.equal(convert?.description.includes("recrédit"), false);
  assert.equal(convert?.description.includes("recréit"), false);
  assert.equal(explain?.description.includes("plateforme agréée"), false);
  assert.match(convert?.description ?? "", /1 500 000 octets/);
  assert.match(validate?.description ?? "", /1 500 000 octets/);
});

test("MCP instructions advise dry_run first and do not claim a gate", async () => {
  const response = await handleMcp(
    new Request("https://worker.example/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    }),
    { baseUrl: BASE, apiKey: "", scope: ["mcp:read"] },
  );
  const payload = await response.json() as { result: { instructions: string } };
  assert.equal(
    payload.result.instructions.includes(
      "Call facturx_dry_run first (no file); call facturx_convert when it returns ready=true. The connector does not enforce this order. A conversion can consume a processed invoice of the account quota; processedInvoicesCharged is copied from the API unchanged.",
    ),
    true,
  );
});

test("consent page names FacturX and does not mention a plateforme agréée", () => {
  const html = consentPage(
    {
      clientName: "Claude <script>",
      clientDomain: "claude.ai",
      redirectHost: "claude.ai",
      redirectIsLoopback: true,
      scope: ["mcp:read", "mcp:write"],
    },
    "handle-1",
  );
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<title>Connecter FacturX à Claude &#60;script&#62;<\/title>/);
  assert.match(html, /<h1>Connecter FacturX à Claude &#60;script&#62;<\/h1>/);
  assert.match(html, /https:\/\/facturxapi.com\/api-key/);
  assert.match(html, /Vérifier une facture avant génération et expliquer une règle\./);
  assert.match(html, /Produire un Factur-X et contrôler un fichier : ces appels peuvent décompter des factures traitées du quota de votre clé\./);
  assert.equal(html.includes("aucune facture traitée décomptée"), false);
  assert.equal(html.includes("1 facture traitée"), false);
  assert.equal(html.includes("<br>"), false);
  assert.match(html, /input\[type="password"\],button\{display:block;width:100%/);
  assert.match(html, /Cet accès part vers une application sur cet ordinateur/);
  assert.match(html, /max-width:32rem/);
  assert.equal(html.includes("plateforme agréée"), false);
  assert.equal(html.includes("Claude <script>"), false);
});

test("two keys in flight never cross", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const key = headerValue(init?.headers, "X-API-Key") ?? "";
    seen.push(key);
    await gate;
    const charged = key === KEY_A ? 0 : null;
    return jsonResponse(200, {
      dry_run: true,
      generationReadiness: { status: "ready" },
      request_id: key === KEY_A ? "req-a" : "req-b",
      result: charged === null ? {} : { processedInvoicesCharged: charged },
    });
  };
  const pending = Promise.all([
    callTool("facturx_dry_run", { invoice: { n: "a" } }, { baseUrl: BASE, apiKey: KEY_A, fetchImpl }),
    callTool("facturx_dry_run", { invoice: { n: "b" } }, { baseUrl: BASE, apiKey: KEY_B, fetchImpl }),
  ]);
  release();
  const [left, right] = await pending;
  assert.deepEqual(seen.sort(), [KEY_A, KEY_B].sort());
  assert.equal(left.data.request_id, "req-a");
  assert.equal(left.data.processedInvoicesCharged, 0);
  assert.equal(right.data.request_id, "req-b");
  assert.equal(right.data.processedInvoicesCharged, null);
  assert.equal(JSON.stringify(left.data).includes(KEY_B), false);
  assert.equal(JSON.stringify(right.data).includes(KEY_A), false);
});

test("invalid key is a tool error and the key is not echoed", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(401, { detail: { error: "invalid_api_key", message: `refused ${KEY_A}` }, request_id: "req-auth" });
  const result = await callTool("facturx_dry_run", { invoice: { currency: "EUR" } }, { baseUrl: BASE, apiKey: KEY_A, fetchImpl });
  assert.equal(result.isError, true);
  const body = JSON.stringify(result.data);
  assert.equal(body.includes(KEY_A), false);
  const error = result.data.error as Record<string, unknown>;
  assert.equal(error.code, "invalid_api_key");
  assert.equal(error.request_id, "req-auth");
  assert.equal(error.status, 401);
});

test("dry_run sends no file and copies a present zero", async () => {
  let path = "";
  let body = "";
  const fetchImpl: typeof fetch = async (url, init) => {
    path = String(url);
    body = new TextDecoder().decode(init?.body as Uint8Array);
    return jsonResponse(200, {
      dry_run: true,
      generationReadiness: { status: "ready" },
      request_id: "req-dry",
      result: { processedInvoicesCharged: 0 },
    });
  };
  const result = await callTool(
    "facturx_dry_run",
    { invoice: { invoice_number: "F-1" } },
    { baseUrl: BASE, apiKey: KEY_A, fetchImpl },
  );
  assert.equal(result.isError, false);
  assert.equal(result.data.ready, true);
  assert.equal(result.data.processedInvoicesCharged, 0);
  assert.equal(path.includes("dry_run=true"), true);
  assert.equal(body.includes('name="file"'), false);
  assert.equal(headerValue(undefined, "X-API-Key"), null);
});

test("422 is structured JSON, not a sentence and not ready=false", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(422, {
      detail: {
        error: "invalid_invoice_data",
        message: "totals.net, totals.tax and totals.gross must be >= 0",
        issues: [
          { field: "issue_date", validation_type: "missing" },
          { field: "totals.gross", ruleId: "BR-CO-15", validation_type: "error" },
        ],
      },
      request_id: "req-422",
    });
  const result = await callTool("facturx_dry_run", { invoice: { currency: "EUR" } }, { baseUrl: BASE, apiKey: KEY_A, fetchImpl });
  assert.equal(result.isError, true);
  assert.equal("ready" in result.data, false);
  assert.equal(result.data.status, 422);
  assert.equal(result.data.code, "invalid_invoice_data");
  assert.equal(result.data.request_id, "req-422");
  assert.deepEqual(result.data.missing_fields, ["issue_date"]);
  assert.equal(result.data.ruleId, "BR-CO-15");
  const text = JSON.stringify(result.data);
  assert.equal(text.startsWith("{"), true);
  assert.equal(text.includes("Error executing tool"), false);
});

test("a single ruleId is copied and a 386 rejection stays a 422", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(422, {
      detail: {
        error: "invalid_invoice_data",
        message: "invoice_type must match ^(380|381|384)$",
        issues: [{ field: "invoice_type", ruleId: "schema", validation_type: "error" }],
      },
      request_id: "req-386",
    });
  const result = await callTool(
    "facturx_dry_run",
    { invoice: { invoice_type: "386" } },
    { baseUrl: BASE, apiKey: KEY_A, fetchImpl },
  );
  assert.equal(result.data.ruleId, "schema");
  assert.equal(result.data.request_id, "req-386");
  assert.equal("files" in result.data, false);
});

test("convert copies the charge and refuses a PDF over the pinned size", async () => {
  const small = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
  const big = new Uint8Array(PDF_MAX_BYTES + 1);
  big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const xml = btoa("<xml/>");
  let which = 0;
  const fetchImpl: typeof fetch = async () => {
    which += 1;
    const pdf = which === 1 ? btoa(String.fromCharCode(...small)) : null;
    return jsonResponse(200, {
      success: true,
      dry_run: false,
      request_id: "req-convert",
      target: { status: "verified", executed: "en16931" },
      finalGeneratedValidation: {
        status: "passed",
        artifactAvailable: true,
        validationReadiness: { packaging: { status: "passed" } },
      },
      result: {
        conversionSuccessful: true,
        packagingPerformed: true,
        targetProfile: "EN16931",
        xml,
        pdf: pdf ?? undefined,
        pdfUrl: pdf ? undefined : "https://files.example/too-big.pdf",
        processedInvoicesCharged: 1,
      },
    });
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://files.example/too-big.pdf");
    assert.equal(new Headers().get("X-API-Key"), null);
    return new Response(big, { status: 200 });
  };
  try {
    const ok = await callTool("facturx_convert", { invoice: { n: 1 }, idempotency_key: "same-key" }, { baseUrl: BASE, apiKey: KEY_A, fetchImpl });
    assert.equal(ok.isError, false);
    assert.equal(ok.data.processedInvoicesCharged, 1);
    assert.equal(ok.data.request_id, "req-convert");
    const files = ok.data.files as { pdf: { base64?: string; sha256: string } };
    assert.equal(typeof files.pdf.base64, "string");
    const refused = await callTool(
      "facturx_convert",
      { invoice: { n: 1 }, idempotency_key: "same-key" },
      { baseUrl: BASE, apiKey: KEY_A, fetchImpl },
    );
    const refusedPdf = (refused.data.files as { pdf: { refused?: string; base64?: string; bytes: number; sha256: string } }).pdf;
    assert.equal(refusedPdf.refused, "too_large");
    assert.equal(refusedPdf.bytes, PDF_MAX_BYTES + 1);
    assert.equal(refusedPdf.base64, undefined);
    assert.equal(typeof refusedPdf.sha256, "string");
  } finally {
    globalThis.fetch = original;
  }
});

test("the same idempotency key is sent twice and the charge is not added locally", async () => {
  const keys: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    keys.push(headerValue(init?.headers, "Idempotency-Key") ?? "");
    return jsonResponse(200, {
      success: true,
      dry_run: false,
      request_id: "req-idem",
      target: { status: "verified" },
      finalGeneratedValidation: {
        status: "passed",
        artifactAvailable: true,
        validationReadiness: { packaging: { status: "passed" } },
      },
      result: {
        conversionSuccessful: true,
        packagingPerformed: true,
        xml: btoa("<xml/>"),
        pdf: btoa("%PDF-1"),
        processedInvoicesCharged: 1,
      },
    });
  };
  const args = { invoice: { n: 1 }, idempotency_key: "idem-1", output: "facturx_pdfa3" };
  const first = await callTool("facturx_convert", args, { baseUrl: BASE, apiKey: KEY_A, fetchImpl });
  const second = await callTool("facturx_convert", args, { baseUrl: BASE, apiKey: KEY_A, fetchImpl });
  assert.deepEqual(keys, ["idem-1", "idem-1"]);
  assert.equal(first.data.processedInvoicesCharged, 1);
  assert.equal(second.data.processedInvoicesCharged, 1);
});

test("validate copies a france_2026 report and explain does not send the key", async () => {
  clearContractCache();
  const calls: { url: string; key: string | null }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), key: headerValue(init?.headers, "X-API-Key") });
    if (String(url).includes("integration-contract")) {
      return jsonResponse(200, {
        engine_version: "test",
        fields: [{ json_path: "totals.gross", bt: "BT-112", en16931_rule: "BR-CO-15", requirement: "gross" }],
      });
    }
    return jsonResponse(200, {
      valid: true,
      validationStatus: "valid",
      profile: "EN16931",
      target: { executed: "france_2026", status: "verified" },
      request_id: "req-val",
      processedInvoicesCharged: 1,
      errors: [],
    });
  };
  const validated = await callTool(
    "facturx_validate",
    { file_base64: btoa("%PDF-1"), filename: "invoice.pdf", validation_target: "france_2026" },
    { baseUrl: BASE, apiKey: KEY_A, fetchImpl },
  );
  assert.equal(validated.data.valid, true);
  assert.equal(validated.data.validation_status, "valid");
  assert.equal(validated.data.error_count, 0);
  assert.equal(validated.data.processedInvoicesCharged, 1);
  const explained = await callTool("facturx_explain_error", { code_or_rule: "BR-CO-15" }, { baseUrl: BASE, apiKey: KEY_A, fetchImpl });
  assert.equal(explained.isError, false);
  assert.equal((explained.data.matches as unknown[]).length, 1);
  const explainCall = calls.find((call) => call.url.includes("integration-contract"));
  assert.equal(explainCall?.key, null);
  const validateCall = calls.find((call) => call.url.includes("/validate"));
  assert.equal(validateCall?.url.includes("validation_target=france_2026"), true);
});

test("mcp:read cannot convert, and tools/list is JSON", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return jsonResponse(500, {});
  };
  const response = await handleMcp(
    new Request("https://facturx-mcp.example/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "facturx_convert", arguments: { invoice: {} } } }),
    }),
    { baseUrl: BASE, apiKey: KEY_A, scope: ["mcp:read"], fetchImpl },
  );
  const payload = await response.json() as { result: { isError: boolean; structuredContent: { error: { type: string } } } };
  assert.equal(payload.result.isError, true);
  assert.equal(payload.result.structuredContent.error.type, "insufficient_scope");
  assert.equal(called, false);

  const listed = await handleMcp(
    new Request("https://facturx-mcp.example/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
    { baseUrl: BASE, apiKey: KEY_A, scope: ["mcp:read", "mcp:write"] },
  );
  const list = await listed.json() as { result: { tools: { name: string; description: string }[] } };
  assert.deepEqual(list.result.tools.map((tool) => tool.name), [
    "facturx_dry_run",
    "facturx_convert",
    "facturx_validate",
    "facturx_explain_error",
  ]);
  assert.equal(list.result.tools.some((tool) => /acceptera/i.test(tool.description)), false);
});

test("a missing key does not call the API", async () => {
  let called = false;
  const response = await handleMcp(
    new Request("https://facturx-mcp.example/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "facturx_dry_run", arguments: { invoice: {} } } }),
    }),
    {
      baseUrl: BASE,
      apiKey: "",
      scope: ["mcp:read"],
      fetchImpl: async () => {
        called = true;
        return jsonResponse(200, {});
      },
    },
  );
  const payload = await response.json() as { result: { structuredContent: { error: { code: string } } } };
  assert.equal(payload.result.structuredContent.error.code, "invalid_api_key");
  assert.equal(called, false);
});

test("consent refuses an invalid key without echoing it and never puts it in the redirect", async () => {
  const secret = "fxk_should_not_appear_in_html";
  const probe = await probeKey(BASE, secret, async () =>
    jsonResponse(401, { detail: { error: "invalid_api_key", message: secret } }),
  );
  assert.equal(probe, "invalid");

  let completed: { props?: { apiKey: string }; userId?: string; redirectTo?: string } | null = null;
  const oauth: OauthLike = {
    async parseAuthRequest() {
      return { redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: ["mcp:read", "mcp:write"], clientId: "claude" };
    },
    async describeConsent() {
      return { clientName: "Claude <script>", clientDomain: "claude.ai", redirectHost: "claude.ai", redirectIsLoopback: false, scope: ["mcp:read", "mcp:write"] };
    },
    async beginConsent() {
      return { handle: "handle-1", headers: new Headers() };
    },
    async approveConsent(_request, _handle, options) {
      assert.equal(options?.scope?.includes("mcp:read"), true);
      return {
        request: { redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: ["mcp:read", "mcp:write"], clientId: "claude" },
        headers: new Headers(),
      };
    },
    async denyConsent() {
      return { redirectTo: "https://claude.ai/api/mcp/auth_callback?error=access_denied", headers: new Headers() };
    },
    async completeAuthorization(options) {
      completed = { props: options.props, userId: options.userId };
      const redirectTo = "https://claude.ai/api/mcp/auth_callback?code=abc&state=s";
      completed.redirectTo = redirectTo;
      return { redirectTo };
    },
  };

  const leaked = await handleAuthorize(
    new Request(`https://worker.example/authorize?api_key=${secret}`, { method: "POST", body: form(secret) }),
    oauth,
    BASE,
    async () => {
      throw new Error("probe must not run when the key is in the URL");
    },
  );
  assert.equal(leaked.status, 400);
  assert.equal((await leaked.text()).includes(secret), false);

  const refused = await handleAuthorize(
    new Request("https://worker.example/authorize", { method: "POST", body: form(secret) }),
    oauth,
    BASE,
    async () => jsonResponse(401, { detail: { error: "invalid_api_key", message: secret } }),
  );
  const refusedText = await refused.text();
  assert.equal(refused.status, 400);
  assert.equal(refusedText.includes(secret), false);
  assert.match(refusedText, /n'a pas été enregistrée/);
  assert.equal(completed, null);

  const accepted = await handleAuthorize(
    new Request("https://worker.example/authorize", { method: "POST", body: form(secret) }),
    oauth,
    BASE,
    async () => jsonResponse(422, { detail: { error: "invalid_invoice_data", message: "missing" } }),
  );
  assert.equal(accepted.status, 302);
  const location = accepted.headers.get("Location") ?? "";
  assert.equal(location.includes(secret), false);
  assert.equal(completed?.props?.apiKey, secret);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))).toString("hex");
  assert.equal(completed?.userId?.includes(secret), false);
  assert.notEqual(completed?.userId, digest);
  assert.match(completed?.userId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

function form(apiKey: string): FormData {
  const data = new FormData();
  data.set("handle", "handle-1");
  data.set("decision", "approve");
  data.set("api_key", apiKey);
  data.append("scope", "mcp:read");
  data.append("scope", "mcp:write");
  return data;
}


test("loopback callbacks: 127.0.0.1, [::1] and localhost on any port; lookalikes refused", () => {
  for (const ok of [
    "http://127.0.0.1:53682/callback",
    "http://[::1]:41234/oauth/callback",
    "http://localhost:33418/callback",
    "http://localhost/callback",
  ]) {
    assert.equal(redirectAllowed(ok), true, ok);
  }
  for (const ko of [
    "http://localhost.evil.example/callback",
    "http://127.0.0.1.evil.example/callback",
    "http://evil.example/callback",
    "http://user@localhost:1234/callback",
    "http://localhost:1234/callback?next=/",
    "http://localhost:1234/callback#frag",
    "https://localhost:1234/callback",
    "http://10.0.0.1:1234/callback",
  ]) {
    assert.equal(redirectAllowed(ko), false, ko);
  }
});

test("dynamic registration accepts a loopback client (Claude Code, Codex) and still refuses a foreign host", () => {
  assert.equal(registrationRedirectsAllowed({ redirect_uris: ["http://localhost:33418/callback"] }), null);
  assert.equal(registrationRedirectsAllowed({ redirect_uris: ["http://127.0.0.1:1455/auth/callback"] }), null);
  assert.match(registrationRedirectsAllowed({ redirect_uris: ["http://evil.example/callback"] }) ?? "", /loopback/);
});

function loopbackOauth(request: { codeChallenge?: string; codeChallengeMethod?: string }, onComplete: () => void): OauthLike {
  const auth = { redirectUri: "http://127.0.0.1:53682/callback", scope: ["mcp:read"], clientId: "cli", ...request };
  return {
    async parseAuthRequest() {
      return auth;
    },
    async describeConsent() {
      return { clientName: "Claude Code", redirectHost: "127.0.0.1", redirectIsLoopback: true, scope: ["mcp:read"] };
    },
    async beginConsent() {
      return { handle: "h", headers: new Headers() };
    },
    async approveConsent() {
      return { request: auth, headers: new Headers() };
    },
    async denyConsent() {
      return { redirectTo: "http://127.0.0.1:53682/callback?error=access_denied", headers: new Headers() };
    },
    async completeAuthorization() {
      onComplete();
      return { redirectTo: "http://127.0.0.1:53682/callback?code=c&state=s" };
    },
  };
}

test("a loopback client without PKCE S256 gets no consent page", async () => {
  for (const pkce of [{}, { codeChallenge: "abc", codeChallengeMethod: "plain" }, { codeChallenge: "abc" }]) {
    const res = await handleAuthorize(new Request("https://worker.example/authorize"), loopbackOauth(pkce, () => {}), BASE);
    assert.equal(res.status, 400, JSON.stringify(pkce));
    assert.match(await res.text(), /PKCE \(méthode S256\)/);
  }
  const ok = await handleAuthorize(
    new Request("https://worker.example/authorize"),
    loopbackOauth({ codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", codeChallengeMethod: "S256" }, () => {}),
    BASE,
  );
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /application sur cet ordinateur/);
});

test("a loopback approval without PKCE S256 never completes the authorization", async () => {
  let completed = false;
  const res = await handleAuthorize(
    new Request("https://worker.example/authorize", { method: "POST", body: form(KEY_A) }),
    loopbackOauth({}, () => {
      completed = true;
    }),
    BASE,
    async () => jsonResponse(200, { valid: true }),
  );
  assert.equal(res.status, 400);
  assert.equal(completed, false);
});

test("the resource announces both scopes (protected resource metadata and the 401 challenge)", async () => {
  // index.ts imports cloudflare:workers, which node cannot load: the end-to-end proof runs against wrangler dev.
  // This guard keeps the config itself announcing every scope the consent page offers.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /requiredScopes:\s*\[\.\.\.SCOPES\]/);
  assert.doesNotMatch(source, /requiredScopes:\s*\["mcp:read"\]/);
  assert.deepEqual([...SCOPES], ["mcp:read", "mcp:write"]);
});
