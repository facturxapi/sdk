import { REDIRECT_URIS } from "./constants.ts";

/** RFC 8252 §7.3 loopback hosts. Any port: native clients pick a free one per login. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * A native client's loopback callback (Claude Code, Codex, Cursor…): plain http on
 * 127.0.0.1, [::1] or localhost, any port, no userinfo, query or fragment. Such a client
 * cannot keep a secret, so handleAuthorize also requires PKCE S256 for it.
 */
export function isLoopbackRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Exact Claude callbacks, the ChatGPT platform callback, one ChatGPT per-connection
 * path segment, or a loopback callback (see isLoopbackRedirect). Anything else is refused.
 */
export function redirectAllowed(uri: string): boolean {
  if (isLoopbackRedirect(uri)) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol !== "https:") return false;
  const normalized = url.origin + url.pathname;
  if ((REDIRECT_URIS.claude as readonly string[]).includes(normalized)) return true;
  if (normalized === REDIRECT_URIS.chatgptExact) return true;
  if (normalized.startsWith(REDIRECT_URIS.chatgptPrefix)) {
    const rest = normalized.slice(REDIRECT_URIS.chatgptPrefix.length);
    return /^[A-Za-z0-9_-]+$/.test(rest);
  }
  return false;
}

export function registrationRedirectsAllowed(metadata: Record<string, unknown>): string | null {
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return "redirect_uris must list at least one HTTPS callback";
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || !redirectAllowed(uri)) {
      return "redirect_uri is not a Claude or ChatGPT callback, nor a loopback (127.0.0.1, [::1], localhost) callback";
    }
  }
  return null;
}
