import { asApiError, facturxFetch, multipart } from "./api.ts";
import { SCOPES } from "./constants.ts";
import { isLoopbackRedirect, redirectAllowed } from "./redirects.ts";

export interface ConsentFacts {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scope: string[];
}

export interface AuthRequestLike {
  redirectUri: string;
  scope: string[];
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/** A loopback callback is a native client that cannot keep a secret: PKCE S256 or nothing. */
export function loopbackWithoutS256(request: AuthRequestLike): boolean {
  return isLoopbackRedirect(request.redirectUri) && (!request.codeChallenge || request.codeChallengeMethod !== "S256");
}

const PKCE_REQUIRED = "<p>Une application locale doit utiliser PKCE (méthode S256). Rien n'a été enregistré.</p>";

export interface OauthLike {
  parseAuthRequest(request: Request): Promise<AuthRequestLike>;
  describeConsent(request: AuthRequestLike): Promise<ConsentFacts>;
  beginConsent(request: AuthRequestLike): Promise<{ handle: string; headers: Headers }>;
  approveConsent(
    request: Request,
    handle: string,
    options?: { scope?: string[] },
  ): Promise<{ request: AuthRequestLike; headers: Headers }>;
  denyConsent(request: Request, handle: string): Promise<{ redirectTo: string; headers: Headers }>;
  completeAuthorization(options: {
    request: AuthRequestLike;
    userId: string;
    metadata: Record<string, unknown>;
    scope: string[];
    props: { apiKey: string };
  }): Promise<{ redirectTo: string }>;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function scopeCaption(scope: string): string {
  if (scope === "mcp:read") {
    return "Vérifier une facture avant génération et expliquer une règle.";
  }
  if (scope === "mcp:write") {
    return "Produire un Factur-X et contrôler un fichier : ces appels peuvent décompter des factures traitées du quota de votre clé.";
  }
  return scope;
}

export function consentPage(details: ConsentFacts, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Publié par <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "Cette application s'est déclarée elle-même ; son nom n'est pas vérifié.";
  const scopes = details.scope
    .map((scope) => {
      const safe = escapeHtml(scope);
      const required = scope === "mcp:read" ? " checked disabled" : " checked";
      const hidden = scope === "mcp:read" ? `<input type="hidden" name="scope" value="${safe}">` : "";
      return `${hidden}<label><input type="checkbox" name="scope" value="${safe}"${required}> ${escapeHtml(scopeCaption(scope))}</label>`;
    })
    .join("");
  const loopback = details.redirectIsLoopback
    ? "<p><strong>Cet accès part vers une application sur cet ordinateur.</strong> Continuez seulement si vous venez de lancer la connexion.</p>"
    : "";
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connecter FacturX à ${name}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:32rem;margin:1.5rem auto;padding:0 1rem;line-height:1.45}
  label{display:block;margin:.5rem 0}
  input[type="password"],button{display:block;width:100%;box-sizing:border-box;font:inherit}
  button+button{margin-top:.5rem}
</style>
</head>
<body>
<h1>Connecter FacturX à ${name}</h1>
<p>${name} pourra utiliser votre clé API FacturX pour vérifier, expliquer et produire des factures Factur-X depuis la conversation. ${origin} L'accès sera envoyé à <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <label>Votre clé API FacturX <input type="password" name="api_key" autocomplete="off" required></label>
  <p>Pas encore de clé ? <a href="https://facturxapi.com/api-key">Créez-en une sur facturxapi.com/api-key</a>.</p>
  <div>${scopes}</div>
  <p>Ces autorisations limitent ce que ${name} peut faire avec votre clé ; elles ne changent pas son quota.</p>
  <p>Votre clé est chiffrée avec cette autorisation ; elle n'apparaît jamais dans une adresse web.</p>
  <p><button name="decision" value="approve">Autoriser</button> <button name="decision" value="deny">Refuser</button></p>
</form>
</body>
</html>`;
}

export async function probeKey(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<"ok" | "invalid" | "unavailable"> {
  try {
    const idempotencyKey = crypto.randomUUID();
    const { body, contentType } = await multipart(
      { output: "facturx_pdfa3", validation_target: "en16931", invoice_data: "{}" },
      null,
      idempotencyKey,
    );
    const result = await facturxFetch({
      baseUrl,
      apiKey,
      method: "POST",
      path: "/api/v1/convert?dry_run=true",
      body,
      contentType,
      idempotencyKey,
      fetchImpl,
    });
    if (result.status === 401) return "invalid";
    const error = asApiError(result, idempotencyKey, apiKey);
    if (!error) return "ok";
    if (error.status === 422 || error.status === 400) return "ok";
    if (error.code === "invalid_api_key") return "invalid";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

function page(body: string, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Frame-Options", "DENY");
  return new Response(body, { status, headers: responseHeaders });
}

export async function handleAuthorize(
  request: Request,
  oauth: OauthLike,
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/authorize") {
    return new Response("FacturX MCP. The connector is /mcp. The API key is never put in a URL.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method === "GET") {
    const auth = await oauth.parseAuthRequest(request);
    if (!redirectAllowed(auth.redirectUri)) {
      return page("<p>Cette adresse de retour n'est pas celle de Claude, de ChatGPT ni d'une application locale.</p>", 400);
    }
    if (loopbackWithoutS256(auth)) return page(PKCE_REQUIRED, 400);
    const details = await oauth.describeConsent(auth);
    const consent = await oauth.beginConsent(auth);
    return page(consentPage(details, consent.handle), 200, consent.headers);
  }
  if (request.method !== "POST") return page("<p>Méthode refusée.</p>", 405);
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    const headers = denied.headers;
    headers.set("Location", denied.redirectTo);
    return new Response(null, { status: 302, headers });
  }
  const apiKey = String(form.get("api_key") ?? "");
  if (!apiKey || url.searchParams.has("api_key")) {
    return page("<p>La clé se poste dans le formulaire, jamais dans l'URL. Rien n'a été enregistré.</p>", 400);
  }
  const verdict = await probeKey(baseUrl, apiKey, fetchImpl);
  if (verdict !== "ok") {
    const sentence =
      verdict === "invalid"
        ? "Cette clé est refusée. Elle n'a pas été enregistrée."
        : "La clé n'a pas pu être vérifiée. Elle n'a pas été enregistrée.";
    const html = `<p>${sentence}</p>`;
    if (html.includes(apiKey)) throw new Error("refusing to render a page that echoes the key");
    return page(html, 400);
  }
  const granted = form
    .getAll("scope")
    .map(String)
    .filter((scope) => (SCOPES as readonly string[]).includes(scope));
  if (!granted.includes("mcp:read")) {
    return page("<p>La portée mcp:read est requise. Rien n'a été enregistré.</p>", 400);
  }
  const approved = await oauth.approveConsent(request, handle, { scope: granted });
  if (!redirectAllowed(approved.request.redirectUri)) {
    return page("<p>Cette adresse de retour n'est pas celle de Claude, de ChatGPT ni d'une application locale.</p>", 400);
  }
  if (loopbackWithoutS256(approved.request)) return page(PKCE_REQUIRED, 400);
  if (!approved.request.scope.includes("mcp:read")) {
    return page("<p>Le client doit demander mcp:read. Rien n'a été enregistré.</p>", 400);
  }
  // userId is stored in the clear by the OAuth library. It must not be the key or its hash.
  const userId = crypto.randomUUID();
  const completed = await oauth.completeAuthorization({
    request: approved.request,
    userId,
    metadata: {},
    scope: granted.filter((scope) => approved.request.scope.includes(scope)),
    props: { apiKey },
  });
  if (completed.redirectTo.includes(apiKey) || completed.redirectTo.includes(encodeURIComponent(apiKey))) {
    throw new Error("refusing a redirect that echoes the key");
  }
  approved.headers.set("Location", completed.redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}
