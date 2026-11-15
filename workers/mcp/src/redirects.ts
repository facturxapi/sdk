import { REDIRECT_URIS } from "./constants.ts";

/**
 * Exact Claude callbacks, the ChatGPT platform callback, or one ChatGPT
 * per-connection path segment. Anything else, including localhost, is refused.
 */
export function redirectAllowed(uri: string): boolean {
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
      return "redirect_uri is not a Claude or ChatGPT callback";
    }
  }
  return null;
}
