import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentConnectConfig,
  bareHttpsOrigin,
  CONSENT_TTL_SECONDS,
  signConsentToken,
  type AgentConnectConfig,
} from "../src/agent-connect.ts";
import { consentPage, handleAuthorize, type AuthRequestLike, type OauthLike } from "../src/consent.ts";

const BASE = "https://api.facturxapi.com";
const SIGNING = "s".repeat(40);
const EXCHANGE = "e".repeat(40);
const CONFIG: AgentConnectConfig = { webOrigin: "https://facturxapi.com", signingSecret: SIGNING, exchangeSecret: EXCHANGE };
const AGENT_KEY = "fxk_test_agent_zzzzzzzz";
const AUTH: AuthRequestLike = {
  redirectUri: "http://127.0.0.1:33418/callback",
  scope: ["mcp:read", "mcp:write"],
  clientId: "client-abc",
  codeChallenge: "x".repeat(43),
  codeChallengeMethod: "S256",
};

function b64urlDecode(part: string): Uint8Array {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

interface Calls {
  begin: number;
  finish: number;
  complete: Array<{ scope: string[]; props: { apiKey: string } }>;
}

function fakeOauth(calls: Calls, finish: () => Promise<{ request: AuthRequestLike; data?: unknown; headers: Headers }>): OauthLike {
  return {
    async parseAuthRequest() {
      return AUTH;
    },
    async describeConsent() {
      return { clientName: "Claude Code", redirectHost: "127.0.0.1:33418", redirectIsLoopback: true, scope: AUTH.scope };
    },
    async beginConsent() {
      return { handle: "handle-1", headers: new Headers() };
    },
    async approveConsent(_request, _handle, options) {
      return { request: { ...AUTH, scope: AUTH.scope }, headers: new Headers({ "X-Approved": String(options?.scope) }) };
    },
    async denyConsent() {
      return { redirectTo: "http://127.0.0.1:33418/callback?error=access_denied", headers: new Headers() };
    },
    async beginUpstream(_request, options) {
      calls.begin += 1;
      const headers = options?.headers ?? new Headers();
      headers.append("Set-Cookie", "__Host-oauth-upstream-abc=hash; Path=/; Secure; HttpOnly; SameSite=Lax");
      return { state: "state-from-library", headers };
    },
    async finishUpstream() {
      calls.finish += 1;
      return finish();
    },
    async completeAuthorization(options) {
      calls.complete.push({ scope: options.scope, props: options.props });
      return { redirectTo: "http://127.0.0.1:33418/callback?code=oauth-code&state=client-state" };
    },
  };
}

function postForm(fields: Record<string, string | string[]>, query = ""): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(name, item);
  }
  return new Request(`https://mcp.facturxapi.com/authorize${query}`, { method: "POST", body: form });
}

test("the signed token is the exact format the API verifies, valid 600 s", async () => {
  const now = 1_800_000_000;
  const token = await signConsentToken(
    { state: "st", clientId: "cid", clientName: "Claude Code", redirectHost: "127.0.0.1:33418", scopes: ["mcp:read"] },
    SIGNING,
    now,
  );
  assert.equal(token.split(".").length, 2);
  assert.doesNotMatch(token, /[=+/]/);
  const [payloadPart, macPart] = token.split(".");
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadPart)));
  assert.deepEqual(payload, {
    v: 1,
    state: "st",
    client_id: "cid",
    client_name: "Claude Code",
    redirect_host: "127.0.0.1:33418",
    scopes: ["mcp:read"],
    exp: now + 600,
  });
  assert.ok(CONSENT_TTL_SECONDS <= 15 * 60);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify("HMAC", key, b64urlDecode(macPart), new TextEncoder().encode(payloadPart)), true);
});

test("the web origin must be a bare https origin; otherwise the flow is off", () => {
  assert.equal(bareHttpsOrigin("https://facturxapi.com"), "https://facturxapi.com");
  assert.equal(bareHttpsOrigin("https://facturxapi.com/"), "https://facturxapi.com");
  for (const bad of ["http://facturxapi.com", "https://facturxapi.com/path", "https://facturxapi.com?x=1", "https://u:p@facturxapi.com", "", undefined]) {
    assert.equal(bareHttpsOrigin(bad), null, String(bad));
  }
  assert.equal(agentConnectConfig({ WEB_ORIGIN: "https://facturxapi.com", AGENT_CONNECT_SIGNING_SECRET: SIGNING }), null);
  assert.equal(agentConnectConfig({ WEB_ORIGIN: "https://facturxapi.com", AGENT_CONNECT_SIGNING_SECRET: "short", AGENT_CONNECT_EXCHANGE_SECRET: EXCHANGE }), null);
  assert.deepEqual(
    agentConnectConfig({ WEB_ORIGIN: "https://facturxapi.com", AGENT_CONNECT_SIGNING_SECRET: SIGNING, AGENT_CONNECT_EXCHANGE_SECRET: EXCHANGE }),
    CONFIG,
  );
});

test("the account button appears only when the flow is configured, and skips the key field's validation", () => {
  const facts = { clientName: "Claude Code", redirectHost: "127.0.0.1:33418", redirectIsLoopback: true, scope: ["mcp:read"] };
  assert.doesNotMatch(consentPage(facts, "h"), /Se connecter avec mon compte FacturX/);
  const html = consentPage(facts, "h", true);
  assert.match(html, /<button name="decision" value="facturx" formnovalidate>Se connecter avec mon compte FacturX<\/button>/);
  assert.match(html, /name="api_key"/); // the paste field stays as a fallback
});

test("account connect: approve, bind to this browser, then 303 to the fixed web page with a signed token", async () => {
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => {
    throw new Error("not expected");
  });
  const response = await handleAuthorize(
    postForm({ handle: "handle-1", decision: "facturx", scope: ["mcp:read", "mcp:write"] }, "?web=https://evil.example"),
    oauth,
    BASE,
    undefined,
    CONFIG,
  );
  assert.equal(response.status, 303);
  assert.equal(calls.begin, 1);
  const location = response.headers.get("Location") ?? "";
  assert.ok(location.startsWith("https://facturxapi.com/connecter-agent#consent="), location); // S4: ?web= ignored
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(location.split("#consent=")[1].split(".")[0])));
  assert.equal(payload.state, "state-from-library"); // the library's browser-bound state, nothing else
  assert.equal(payload.client_name, "Claude Code");
  assert.equal(payload.redirect_host, "127.0.0.1:33418");
  assert.deepEqual(payload.scopes, ["mcp:read", "mcp:write"]);
  assert.match(response.headers.get("Set-Cookie") ?? "", /__Host-oauth-upstream-/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("account connect is refused when the flow is not configured, and nothing is bound", async () => {
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => {
    throw new Error("not expected");
  });
  const response = await handleAuthorize(postForm({ handle: "h", decision: "facturx", scope: "mcp:read" }), oauth, BASE, undefined, null);
  assert.equal(response.status, 400);
  assert.equal(calls.begin, 0);
});

function countingFetch(status: number, body: unknown) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, seen };
}

const RETURN = "https://mcp.facturxapi.com/authorize/retour?state=state-from-library&code=one-time-code";

test("S1: a return from another browser is refused and the code is NEVER exchanged", async () => {
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => {
    // What the library throws when this browser has no cookie for the state (or another one).
    throw new Error("This authorization was not started in this browser; start again");
  });
  const exchange = countingFetch(200, { api_key: AGENT_KEY });
  const response = await handleAuthorize(new Request(RETURN), oauth, BASE, exchange.impl, CONFIG);
  assert.equal(response.status, 400);
  assert.equal(calls.finish, 1);
  assert.equal(exchange.seen.length, 0);
  assert.equal(calls.complete.length, 0);
  const text = await response.text();
  assert.match(text, /Aucune clé n'a été créée/);
  assert.doesNotMatch(text, /browser|authorization|start again/i); // IMPL-4: our French page, never the library's English
  assert.doesNotMatch(text, /one-time-code|state-from-library/);
});

test("the right browser: exchange with the dedicated secret, then authorization with the agent key", async () => {
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => ({
    request: AUTH,
    data: { scope: ["mcp:read", "mcp:write"] },
    headers: new Headers({ "Set-Cookie": "__Host-oauth-upstream-abc=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax" }),
  }));
  const exchange = countingFetch(200, { api_key: AGENT_KEY, api_key_id: "k1", scopes: ["mcp:read", "mcp:write"], revoked_api_key_ids: [] });
  const response = await handleAuthorize(new Request(RETURN), oauth, BASE, exchange.impl, CONFIG);
  assert.equal(response.status, 302);
  assert.equal(exchange.seen.length, 1);
  assert.equal(exchange.seen[0].url, "https://api.facturxapi.com/api/v1/internal/agent-connections/exchange");
  assert.equal(new Headers(exchange.seen[0].init.headers).get("X-Agent-Connect-Secret"), EXCHANGE);
  assert.deepEqual(JSON.parse(String(exchange.seen[0].init.body)), { code: "one-time-code", state: "state-from-library" });
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0].props.apiKey, AGENT_KEY);
  assert.deepEqual(calls.complete[0].scope, ["mcp:read", "mcp:write"]);
  const location = response.headers.get("Location") ?? "";
  assert.ok(!location.includes(AGENT_KEY));
  assert.match(response.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
});

test("an exchange the API refuses (expired, replayed, foreign state) ends on the restart page", async () => {
  for (const status of [400, 403, 409, 500]) {
    const calls: Calls = { begin: 0, finish: 0, complete: [] };
    const oauth = fakeOauth(calls, async () => ({ request: AUTH, data: { scope: ["mcp:read"] }, headers: new Headers() }));
    const exchange = countingFetch(status, { detail: "invalid_exchange" });
    const response = await handleAuthorize(new Request(RETURN), oauth, BASE, exchange.impl, CONFIG);
    assert.equal(response.status, 400, String(status));
    assert.equal(calls.complete.length, 0);
  }
});

test("a return without its parameters, or with the flow off, touches neither the library nor the API", async () => {
  for (const [url, config] of [
    ["https://mcp.facturxapi.com/authorize/retour?state=s", CONFIG],
    ["https://mcp.facturxapi.com/authorize/retour?code=c", CONFIG],
    [RETURN, null],
  ] as const) {
    const calls: Calls = { begin: 0, finish: 0, complete: [] };
    const oauth = fakeOauth(calls, async () => ({ request: AUTH, data: { scope: ["mcp:read"] }, headers: new Headers() }));
    const exchange = countingFetch(200, { api_key: AGENT_KEY });
    const response = await handleAuthorize(new Request(url), oauth, BASE, exchange.impl, config);
    assert.equal(response.status, 400, url);
    assert.equal(calls.finish, 0);
    assert.equal(exchange.seen.length, 0);
  }
});

test("IMPL-1: after finishUpstream, a bad redirect or a missing PKCE ends before the exchange", async () => {
  for (const request of [
    { ...AUTH, redirectUri: "https://evil.example/callback" },
    { ...AUTH, codeChallenge: undefined, codeChallengeMethod: undefined },
    { ...AUTH, scope: ["mcp:write"] },
  ]) {
    const calls: Calls = { begin: 0, finish: 0, complete: [] };
    const oauth = fakeOauth(calls, async () => ({ request, data: { scope: ["mcp:read"] }, headers: new Headers() }));
    const exchange = countingFetch(200, { api_key: AGENT_KEY, scopes: ["mcp:read"] });
    const response = await handleAuthorize(new Request(RETURN), oauth, BASE, exchange.impl, CONFIG);
    assert.equal(response.status, 400, JSON.stringify(request));
    assert.equal(calls.complete.length, 0);
    // mcp:read missing is only known after the exchange's scopes; the two others never reach it.
    if (request.scope.includes("mcp:read")) assert.equal(exchange.seen.length, 0, JSON.stringify(request));
  }
});

test("IMPL-2: identifiers over 200 characters are refused before anything is bound; only the name is shortened", async () => {
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => {
    throw new Error("not expected");
  });
  oauth.approveConsent = async () => ({ request: { ...AUTH, clientId: "https://client.example/" + "x".repeat(250) }, headers: new Headers() });
  const response = await handleAuthorize(postForm({ handle: "h", decision: "facturx", scope: "mcp:read" }), oauth, BASE, undefined, CONFIG);
  assert.equal(response.status, 400);
  assert.equal(calls.begin, 0);
  await assert.rejects(
    signConsentToken({ state: "s".repeat(201), clientId: "c", clientName: "n", redirectHost: "h", scopes: ["mcp:read"] }, SIGNING),
  );
  const token = await signConsentToken(
    { state: "s", clientId: "c", clientName: "N".repeat(300), redirectHost: "h", scopes: ["mcp:read"] },
    SIGNING,
  );
  assert.equal(JSON.parse(new TextDecoder().decode(b64urlDecode(token.split(".")[0]))).client_name.length, 200);
});

test("IMPL-3: the granted scopes are also limited to those the API recorded for the key", async () => {
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => ({ request: AUTH, data: { scope: ["mcp:read", "mcp:write"] }, headers: new Headers() }));
  const exchange = countingFetch(200, { api_key: AGENT_KEY, scopes: ["mcp:read"] });
  const response = await handleAuthorize(new Request(RETURN), oauth, BASE, exchange.impl, CONFIG);
  assert.equal(response.status, 302);
  assert.deepEqual(calls.complete[0].scope, ["mcp:read"]);
});

test("the exchange never follows a redirect: the dedicated secret is not re-sent to another host", async () => {
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => ({ request: AUTH, data: { scope: ["mcp:read"] }, headers: new Headers() }));
  const seen: RequestInit[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    if (init?.redirect !== "manual") throw new Error("the exchange must not follow redirects");
    return new Response(null, { status: 302, headers: { Location: "https://evil.example/collect" } });
  }) as typeof fetch;
  const response = await handleAuthorize(new Request(RETURN), oauth, BASE, impl, CONFIG);
  assert.equal(response.status, 400);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, "manual");
  assert.equal(calls.complete.length, 0);
});

test("after a 200 exchange, a failure never claims that no key was created", async () => {
  for (const body of ["not json", JSON.stringify({ scopes: ["mcp:read"] })]) {
    const calls: Calls = { begin: 0, finish: 0, complete: [] };
    const oauth = fakeOauth(calls, async () => ({ request: AUTH, data: { scope: ["mcp:read"] }, headers: new Headers() }));
    const impl = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const response = await handleAuthorize(new Request(RETURN), oauth, BASE, impl, CONFIG);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /Relancez-la depuis votre agent/);
    assert.doesNotMatch(text, /Aucune clé/);
  }
  // Same when the exchange succeeds but the final scope lacks mcp:read.
  const calls: Calls = { begin: 0, finish: 0, complete: [] };
  const oauth = fakeOauth(calls, async () => ({ request: AUTH, data: { scope: ["mcp:read"] }, headers: new Headers() }));
  const impl = (async () => new Response(JSON.stringify({ api_key: AGENT_KEY, scopes: ["mcp:write"] }), { status: 200 })) as typeof fetch;
  const text = await (await handleAuthorize(new Request(RETURN), oauth, BASE, impl, CONFIG)).text();
  assert.doesNotMatch(text, /Aucune clé/);
});
