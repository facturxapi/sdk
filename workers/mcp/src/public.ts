import { SCOPES } from "./constants.ts";
import { handleMcp } from "./mcp.ts";

/**
 * Keyless trial endpoint: POST /mcp/public.
 *
 * An agent can check an existing Factur-X file (facturx_validate) or read a rule (facturx_explain_error)
 * without OAuth and without its own API key. The worker calls the API with ONE service key that lives only in
 * the deployment secrets (PUBLIC_VALIDATE_API_KEY): no key is ever written in this repository.
 * Every validation is limited per IP (hourly) and by a global daily cap; above either limit the answer is
 * HTTP 429 with a pointer to the free API key. Each call is counted without any invoice content.
 * The tool result is the /validate response, unchanged: the trial notice is a separate text block.
 */

export const PUBLIC_ROUTE = "/mcp/public";
export const PUBLIC_TOOLS = ["facturx_validate", "facturx_explain_error"] as const;
export const DEFAULT_IP_HOURLY_LIMIT = 10;
export const DEFAULT_DAILY_CAP = 500;
export const FREE_KEY_URL = "https://facturxapi.com/api-key";

export function publicNotice(ipHourlyLimit: number): string {
  return (
    `Keyless trial of the FacturX connector: ${ipHourlyLimit} validations per hour from one address, with a shared daily cap. ` +
    `For your own quota, create a free API key: ${FREE_KEY_URL}`
  );
}

export interface PublicEnv {
  FACTURX_BASE_URL: string;
  OAUTH_KV: KVNamespace;
  PUBLIC_VALIDATE_API_KEY?: string;
  PUBLIC_IP_HOURLY_LIMIT?: string;
  PUBLIC_DAILY_CAP?: string;
}

export interface PublicDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

type Outcome = "explain" | "validate" | "limited_ip" | "limited_daily" | "refused_tool" | "not_configured";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function ipBucket(ip: string): Promise<string> {
  // The raw address is never stored: a truncated SHA-256 is enough to count per address.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readCount(kv: KVNamespace, key: string): Promise<number> {
  const value = await kv.get(key);
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function bump(kv: KVNamespace, key: string, ttlSeconds: number): Promise<number> {
  // KV is eventually consistent: under a burst the count can lag by a few calls. It is a cost guard, not a meter.
  const next = (await readCount(kv, key)) + 1;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
  return next;
}

async function record(env: PublicEnv, deps: PublicDeps, day: string, outcome: Outcome): Promise<void> {
  await bump(env.OAUTH_KV, `public:count:${day}:${outcome}`, 40 * 24 * 3600);
  (deps.log ?? console.log)(JSON.stringify({ event: "mcp_public_call", day, outcome }));
}

function rpcError(id: unknown, status: number, code: number, message: string, data: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(status === 429 ? { "Retry-After": "3600" } : {}) },
  });
}

export async function handlePublicMcp(request: Request, env: PublicEnv, deps: PublicDeps = {}): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  const ipLimit = positiveInt(env.PUBLIC_IP_HOURLY_LIMIT, DEFAULT_IP_HOURLY_LIMIT);

  if (request.method !== "POST") {
    return handleMcp(request, { baseUrl: env.FACTURX_BASE_URL, apiKey: "", scope: [] });
  }
  const raw = await request.text();
  let rpc: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rpc = parsed as Record<string, unknown>;
  } catch {
    // handleMcp answers the parse error below.
  }
  const id = rpc.id;
  const params = rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
  const toolName = rpc.method === "tools/call" && typeof params.name === "string" ? params.name : null;

  const serviceKey = env.PUBLIC_VALIDATE_API_KEY?.trim() ?? "";
  if (!serviceKey) {
    if (toolName) await record(env, deps, day, "not_configured");
    return rpcError(id, 503, -32000, "The keyless trial is not configured on this server.", { free_api_key: FREE_KEY_URL });
  }

  if (toolName && !(PUBLIC_TOOLS as readonly string[]).includes(toolName)) {
    await record(env, deps, day, "refused_tool");
    return rpcError(id, 403, -32001, `${toolName} needs your own API key. Create a free one: ${FREE_KEY_URL}`, {
      public_tools: [...PUBLIC_TOOLS],
      free_api_key: FREE_KEY_URL,
    });
  }

  if (toolName === "facturx_validate") {
    const dailyCap = positiveInt(env.PUBLIC_DAILY_CAP, DEFAULT_DAILY_CAP);
    const dayKey = `public:day:${day}`;
    const ipKey = `public:ip:${await ipBucket(request.headers.get("CF-Connecting-IP") ?? "unknown")}:${hour}`;
    if ((await readCount(env.OAUTH_KV, dayKey)) >= dailyCap) {
      await record(env, deps, day, "limited_daily");
      return rpcError(id, 429, -32002, `The keyless trial reached its daily limit. Create a free API key: ${FREE_KEY_URL}`, {
        limit: "daily",
        free_api_key: FREE_KEY_URL,
      });
    }
    if ((await readCount(env.OAUTH_KV, ipKey)) >= ipLimit) {
      await record(env, deps, day, "limited_ip");
      return rpcError(id, 429, -32002, `Hourly limit of the keyless trial reached for this address. Create a free API key: ${FREE_KEY_URL}`, {
        limit: "ip_hourly",
        free_api_key: FREE_KEY_URL,
      });
    }
    await bump(env.OAUTH_KV, dayKey, 2 * 24 * 3600);
    await bump(env.OAUTH_KV, ipKey, 2 * 3600);
    await record(env, deps, day, "validate");
  } else if (toolName === "facturx_explain_error") {
    await record(env, deps, day, "explain");
  }

  return handleMcp(new Request(request.url, { method: "POST", headers: request.headers, body: raw }), {
    baseUrl: env.FACTURX_BASE_URL,
    apiKey: serviceKey,
    scope: [...SCOPES],
    allowedTools: PUBLIC_TOOLS,
    notice: publicNotice(ipLimit),
    fetchImpl: deps.fetchImpl,
  });
}
