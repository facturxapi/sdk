/**
 * « Se connecter avec mon compte FacturX »: connect an agent without pasting a key.
 *
 * Flow (design and review on the FacturX side, conditions S1–S5):
 * 1. On the consent page the user picks this button. The Worker approves the consent, then calls the
 *    OAuth library's `beginUpstream`: a 256-bit `state`, the request stored encrypted in KV for 600 s,
 *    and a `__Host-` cookie holding the state's hash. Only this browser can finish the flow (S1).
 * 2. The Worker signs a consent token (S2) and sends the browser to the fixed address
 *    `${webOrigin}/connecter-agent#consent=<token>`. The token travels in the fragment.
 * 3. facturxapi.com shows what the token covers, records the user's consent and sends the browser
 *    back to the fixed path `/authorize/retour?state=…&code=…` (S4).
 * 4. `finishUpstream` refuses a browser that did not start the flow, before anything else. Only then
 *    does the Worker exchange the code, server to server, with its dedicated secret (S5). The API
 *    creates the agent key at this exchange only (S3), so a refused return leaves no key behind.
 *
 * The key is never in a URL, a page or the browser.
 */

export const RETURN_PATH = "/authorize/retour";
export const CONSENT_TTL_SECONDS = 600; // the API refuses more than 15 minutes
const EXCHANGE_PATH = "/api/v1/internal/agent-connections/exchange";
const MAX_FIELD = 200;
const MAX_CODE = 200;

export interface AgentConnectConfig {
  webOrigin: string;
  signingSecret: string;
  exchangeSecret: string;
}

export interface AgentConnectEnv {
  WEB_ORIGIN?: string;
  AGENT_CONNECT_SIGNING_SECRET?: string;
  AGENT_CONNECT_EXCHANGE_SECRET?: string;
}

/** A bare https origin (scheme, host, optional port), nothing else; anything else disables the flow. */
export function bareHttpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.origin !== value.replace(/\/$/, "")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The flow is offered only when every piece is configured; otherwise the paste field stays alone. */
export function agentConnectConfig(env: AgentConnectEnv): AgentConnectConfig | null {
  const webOrigin = bareHttpsOrigin(env.WEB_ORIGIN);
  const signingSecret = env.AGENT_CONNECT_SIGNING_SECRET ?? "";
  const exchangeSecret = env.AGENT_CONNECT_EXCHANGE_SECRET ?? "";
  if (!webOrigin || signingSecret.length < 32 || exchangeSecret.length < 32) return null;
  return { webOrigin, signingSecret, exchangeSecret };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class ConsentFieldError extends Error {}

/** The API refuses any field over 200 characters: an identifier that long is refused here, never cut (IMPL-2). */
function exactField(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD) throw new ConsentFieldError("consent field empty or too long");
  return trimmed;
}

/** Only the displayed name may be shortened: the page shows it as plain text, at most 60 characters. */
function displayField(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ConsentFieldError("empty client name");
  return trimmed.slice(0, MAX_FIELD);
}

/** Whether a client can use the account flow at all (identifiers the API will accept). */
export function consentFieldsAcceptable(clientId: string, redirectHost: string): boolean {
  const ok = (value: string) => value.trim().length > 0 && value.trim().length <= MAX_FIELD;
  return ok(clientId) && ok(redirectHost);
}

export interface ConsentClaims {
  state: string;
  clientId: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
}

/**
 * The token the API verifies (agent_connect_token.py): base64url(JSON payload) "." base64url(HMAC-SHA256(secret,
 * payload part)), no padding. The API recomputes the MAC over the payload part exactly as received.
 */
export async function signConsentToken(
  claims: ConsentClaims,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload = {
    v: 1,
    state: exactField(claims.state),
    client_id: exactField(claims.clientId),
    client_name: displayField(claims.clientName),
    redirect_host: exactField(claims.redirectHost),
    scopes: claims.scopes,
    exp: nowSeconds + CONSENT_TTL_SECONDS,
  };
  const payloadPart = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart)));
  return `${payloadPart}.${base64url(mac)}`;
}

/** The only place the browser is sent: the fixed page on the configured web origin. */
export function consentRedirect(config: AgentConnectConfig, token: string): string {
  return `${config.webOrigin}/connecter-agent#consent=${token}`;
}

/** The return parameters, or null when they are missing or not plausible. Never echoed anywhere. */
export function returnParams(url: URL): { state: string; code: string } | null {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code || state.length > MAX_FIELD || code.length > MAX_CODE) return null;
  return { state, code };
}

export type ExchangeResult = { ok: true; apiKey: string; scopes: string[] } | { ok: false; status: number };

/** Server-to-server exchange of the single-use code for the agent key. */
export async function exchangeCode(
  baseUrl: string,
  config: AgentConnectConfig,
  params: { state: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${EXCHANGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Connect-Secret": config.exchangeSecret,
      },
      body: JSON.stringify({ code: params.code, state: params.state }),
      redirect: "manual",
    });
  } catch {
    return { ok: false, status: 502 };
  }
  if (response.status !== 200) return { ok: false, status: response.status };
  try {
    const body = (await response.json()) as { api_key?: unknown; scopes?: unknown };
    if (typeof body.api_key !== "string" || !body.api_key) return { ok: false, status: 502 };
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
    return { ok: true, apiKey: body.api_key, scopes };
  } catch {
    return { ok: false, status: 502 };
  }
}
