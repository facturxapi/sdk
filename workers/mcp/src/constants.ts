/** Returned PDF / accepted validate upload. The test pins this number. */
export const PDF_MAX_BYTES = 1_500_000;

export const WORKER_VERSION = "0.1.0";

export const USER_AGENT = `facturx-mcp-worker/${WORKER_VERSION}`;

export const SCOPES = ["mcp:read", "mcp:write"] as const;

export type Scope = (typeof SCOPES)[number];

export const OUTPUTS = ["facturx_pdfa3", "xml_cii"] as const;

export const TARGETS = ["en16931", "france_2026"] as const;

export type OutputName = (typeof OUTPUTS)[number];

export type TargetName = (typeof TARGETS)[number];

/** Claude hosted apps and ChatGPT connectors. No wildcard, no loopback. */
export const REDIRECT_URIS = {
  claude: [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
  ],
  chatgptExact: "https://chatgpt.com/connector_platform_oauth_redirect",
  chatgptPrefix: "https://chatgpt.com/connector/oauth/",
} as const;
