import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { SCOPES } from "./constants.ts";
import { handleAuthorize } from "./consent.ts";
import { handleMcp } from "./mcp.ts";
import { handlePublicMcp, PUBLIC_ROUTE } from "./public.ts";
import { registrationRedirectsAllowed } from "./redirects.ts";

export interface Env {
  OAUTH_KV: KVNamespace;
  FACTURX_BASE_URL: string;
  PUBLIC_BASE_URL?: string;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Keyless trial (POST /mcp/public): the service key lives only in the deployment secrets. Absent → 503. */
  PUBLIC_VALIDATE_API_KEY?: string;
  PUBLIC_IP_HOURLY_LIMIT?: string;
  PUBLIC_DAILY_CAP?: string;
}

function publicOrigin(request: Request, configured: string | undefined): string {
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(request.url);
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".workers.dev")) return url.origin;
  throw new Error("PUBLIC_BASE_URL is not set");
}

function providerFor(request: Request, env: Env): OAuthProvider<Env> {
  const origin = publicOrigin(request, env.PUBLIC_BASE_URL);
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(incoming, handlerEnv, ctx) {
        const props = (ctx as ExecutionContext & { props?: { apiKey?: string } }).props;
        const auth = (ctx as ExecutionContext & { auth?: { scope?: string[] } }).auth;
        return handleMcp(incoming, {
          baseUrl: handlerEnv.FACTURX_BASE_URL,
          apiKey: props?.apiKey ?? "",
          scope: auth?.scope ?? [],
        });
      },
    },
    defaultHandler: {
      async fetch(incoming, handlerEnv) {
        try {
          return await handleAuthorize(incoming, handlerEnv.OAUTH_PROVIDER, handlerEnv.FACTURX_BASE_URL);
        } catch (error) {
          if (error instanceof AuthorizationError && error.redirectTo) {
            return Response.redirect(error.redirectTo, 302);
          }
          if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
            const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
            return new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }
          throw error;
        }
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [...SCOPES],
    // Both scopes are announced (protected resource metadata and the 401 challenge), so a client asks
    // for write too; the consent page keeps mcp:write checked by default and optional. Not enforced here.
    requiredScopes: [...SCOPES],
    clientIdMetadataDocumentEnabled: true,
    disallowPublicClientRegistration: false,
    clientRegistrationCallback(options) {
      const reason = registrationRedirectsAllowed(options.clientMetadata);
      if (reason) return { code: "invalid_client_metadata", description: reason, status: 400 };
      return undefined;
    },
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "FacturX API",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Before the OAuth provider: its apiRoute "/mcp" also matches "/mcp/public" by prefix.
    if (new URL(request.url).pathname === PUBLIC_ROUTE) return handlePublicMcp(request, env);
    return providerFor(request, env).fetch(request, env, ctx);
  },
};
