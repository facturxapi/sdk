import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FREE_KEY_URL, handlePublicMcp, PUBLIC_TOOLS, type PublicEnv } from "../src/public.ts";

const BASE = "https://api.facturxapi.com";
const SERVICE_KEY = "fxk_test_service_zzzzzzzz";
const NOW = () => new Date("2026-11-19T09:15:00Z");

class MemoryKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function env(overrides: Partial<PublicEnv> = {}): PublicEnv & { OAUTH_KV: MemoryKv } {
  return {
    FACTURX_BASE_URL: BASE,
    OAUTH_KV: new MemoryKv() as unknown as KVNamespace,
    PUBLIC_VALIDATE_API_KEY: SERVICE_KEY,
    ...overrides,
  } as PublicEnv & { OAUTH_KV: MemoryKv };
}

function rpc(method: string, params: Record<string, unknown> = {}, ip = "203.0.113.7"): Request {
  return new Request("https://mcp.facturxapi.com/mcp/public", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const VALIDATE_ARGS = {
  name: "facturx_validate",
  arguments: { file_base64: Buffer.from("<rsm:CrossIndustryInvoice/>").toString("base64"), filename: "facture.xml" },
};

function apiStub(calls: { url: string; key: string | null }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get("X-API-Key") });
    return new Response(
      JSON.stringify({ valid: true, request_id: "req-1", processedInvoicesCharged: 1, validationStatus: "valid", issues: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

test("without the service key secret the keyless route answers 503 and never calls the API", async () => {
  const calls: { url: string; key: string | null }[] = [];
  const e = env({ PUBLIC_VALIDATE_API_KEY: undefined });
  const res = await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS), e, { now: NOW, fetchImpl: apiStub(calls), log: () => {} });
  assert.equal(res.status, 503);
  assert.match(JSON.stringify(await res.json()), /not configured/);
  assert.equal(calls.length, 0);
});

test("tools/list shows only facturx_validate and facturx_explain_error", async () => {
  const res = await handlePublicMcp(rpc("tools/list"), env(), { now: NOW, log: () => {} });
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  assert.deepEqual(body.result.tools.map((tool) => tool.name).sort(), [...PUBLIC_TOOLS].sort());
});

test("facturx_convert and facturx_dry_run are refused with the free key link, without an API call", async () => {
  for (const name of ["facturx_convert", "facturx_dry_run"]) {
    const calls: { url: string; key: string | null }[] = [];
    const res = await handlePublicMcp(rpc("tools/call", { name, arguments: {} }), env(), { now: NOW, fetchImpl: apiStub(calls), log: () => {} });
    assert.equal(res.status, 403, name);
    assert.ok(JSON.stringify(await res.json()).includes(FREE_KEY_URL), name);
    assert.equal(calls.length, 0, name);
  }
});

test("a validation goes to /validate with the service key; structuredContent is the tool result, the notice is a second block", async () => {
  const calls: { url: string; key: string | null }[] = [];
  const res = await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS), env(), { now: NOW, fetchImpl: apiStub(calls), log: () => {} });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { content: { text: string }[]; structuredContent: Record<string, unknown>; isError: boolean } };
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/v1\/validate\?validation_target=en16931$/);
  assert.equal(calls[0]!.key, SERVICE_KEY);
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.valid, true);
  assert.equal(body.result.content.length, 2);
  assert.equal(body.result.content[0]!.text, JSON.stringify(body.result.structuredContent));
  assert.match(body.result.content[1]!.text, /Keyless trial/);
});

test("the hourly limit is per address: the third call from one IP gets 429, another IP still passes", async () => {
  const e = env({ PUBLIC_IP_HOURLY_LIMIT: "2" });
  const deps = { now: NOW, fetchImpl: apiStub([]), log: () => {} };
  assert.equal((await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS), e, deps)).status, 200);
  assert.equal((await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS), e, deps)).status, 200);
  const limited = await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS), e, deps);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "3600");
  assert.match(JSON.stringify(await limited.json()), /ip_hourly/);
  assert.equal((await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS, "198.51.100.9"), e, deps)).status, 200);
});

test("the global daily cap stops every address", async () => {
  const e = env({ PUBLIC_DAILY_CAP: "1" });
  const deps = { now: NOW, fetchImpl: apiStub([]), log: () => {} };
  assert.equal((await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS, "203.0.113.1"), e, deps)).status, 200);
  const limited = await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS, "203.0.113.2"), e, deps);
  assert.equal(limited.status, 429);
  assert.match(JSON.stringify(await limited.json()), /"daily"/);
});

test("every call is counted by outcome, without the raw address or any invoice content", async () => {
  const e = env({ PUBLIC_IP_HOURLY_LIMIT: "1" });
  const lines: string[] = [];
  const deps = { now: NOW, fetchImpl: apiStub([]), log: (line: string) => lines.push(line) };
  await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS), e, deps);
  await handlePublicMcp(rpc("tools/call", VALIDATE_ARGS), e, deps);
  await handlePublicMcp(rpc("tools/call", { name: "facturx_convert", arguments: {} }), e, deps);
  const store = e.OAUTH_KV.store;
  assert.equal(store.get("public:count:2026-11-19:validate"), "1");
  assert.equal(store.get("public:count:2026-11-19:limited_ip"), "1");
  assert.equal(store.get("public:count:2026-11-19:refused_tool"), "1");
  const everything = [...store.keys(), ...store.values(), ...lines].join("\n");
  assert.doesNotMatch(everything, /203\.0\.113\.7/);
  assert.doesNotMatch(everything, /CrossIndustryInvoice|facture\.xml/);
});

test("the worker routes /mcp/public before the OAuth provider and ships no service key value", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const publicCheck = index.indexOf("=== PUBLIC_ROUTE) return handlePublicMcp(");
  assert.ok(publicCheck > 0 && publicCheck < index.indexOf("return providerFor(request, env).fetch("));
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /PUBLIC_VALIDATE_API_KEY"\s*:/);
  assert.doesNotMatch(wrangler, /fxk_[A-Za-z0-9_]{8,}/);
});
