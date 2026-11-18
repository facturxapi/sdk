import { PDF_MAX_BYTES, USER_AGENT } from "./constants.ts";

export class TransportError extends Error {
  idempotencyKey: string | null;
  constructor(message: string, idempotencyKey: string | null) {
    super(message);
    this.name = "TransportError";
    this.idempotencyKey = idempotencyKey;
  }
}

export class ApiCallError extends Error {
  status: number;
  code: string | null;
  apiMessage: string | null;
  requestId: string | null;
  issues: unknown[];
  idempotencyKey: string | null;
  body: unknown;
  constructor(
    status: number,
    code: string | null,
    apiMessage: string | null,
    requestId: string | null,
    issues: unknown[],
    idempotencyKey: string | null,
    body: unknown,
  ) {
    super(`HTTP ${status} ${code ?? "unknown_error"}`);
    this.name = "ApiCallError";
    this.status = status;
    this.code = code;
    this.apiMessage = apiMessage;
    this.requestId = requestId;
    this.issues = issues;
    this.idempotencyKey = idempotencyKey;
    this.body = body;
  }
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  json: Record<string, unknown>;
}

function assertHttpsBase(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("FACTURX_BASE_URL must be https and must not carry credentials");
  }
  return url;
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function redact(value: unknown, secret: string): unknown {
  if (!secret) return value;
  const encoded = encodeURIComponent(secret);
  const scrub = (text: string) => text.split(secret).join("[redacted]").split(encoded).join("[redacted]");
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return scrub(current);
    if (Array.isArray(current)) return current.map(walk);
    if (current && typeof current === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        out[key] = walk(item);
      }
      return out;
    }
    return current;
  };
  return walk(value);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);

export async function multipart(
  fields: Record<string, string>,
  upload: { filename: string; bytes: Uint8Array } | null,
  seed: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const token = (await sha256Hex(text(seed))).slice(0, 32);
  const boundary = `facturx-sdk-${token}`;
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (upload) {
    const mime = latin1Head(upload.bytes, 5) === "%PDF-" ? "application/pdf" : "application/xml";
    const safe = upload.filename.replace(/["\r\n]/g, "_");
    parts.push(
      concat([
        text(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: ${mime}\r\n\r\n`,
        ),
        upload.bytes,
        text("\r\n"),
      ]),
    );
  }
  parts.push(text(`--${boundary}--\r\n`));
  const body = concat(parts);
  const occurrences = new TextDecoder("latin1").decode(body).split(boundary).length - 1;
  if (occurrences !== parts.length) throw new Error("multipart boundary collides with the payload");
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function latin1Head(bytes: Uint8Array, length: number): string {
  return String.fromCharCode(...bytes.subarray(0, length));
}

export function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

export async function facturxFetch(options: {
  baseUrl: string;
  apiKey: string | null;
  method: "GET" | "POST";
  path: string;
  body?: Uint8Array;
  contentType?: string;
  idempotencyKey?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<FetchResult> {
  const base = assertHttpsBase(options.baseUrl);
  const url = new URL(options.path, base);
  if (url.origin !== base.origin) throw new Error("refusing to send the request off the API origin");
  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  });
  if (options.contentType) headers.set("Content-Type", options.contentType);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.apiKey) headers.set("X-API-Key", options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method,
      headers,
      body: options.body ? options.body.slice() : undefined,
      redirect: "manual",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "transport failed";
    throw new TransportError(`${options.method} ${options.path}: outcome unknown (${message})`, options.idempotencyKey ?? null);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new TransportError(`${options.method} ${options.path}: redirect refused`, options.idempotencyKey ?? null);
  }
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength > PDF_MAX_BYTES * 4) {
    throw new TransportError(`${options.method} ${options.path}: response larger than the connector accepts`, options.idempotencyKey ?? null);
  }
  let json: Record<string, unknown> = {};
  if (raw.byteLength) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw));
      json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      if (response.status >= 200 && response.status < 300) {
        throw new TransportError(`HTTP ${response.status}: non-JSON response`, options.idempotencyKey ?? null);
      }
      json = { detail: { message: new TextDecoder().decode(raw.subarray(0, 500)) } };
    }
  }
  return { status: response.status, headers: headerMap(response.headers), json };
}

export function asApiError(result: FetchResult, idempotencyKey: string | null, secret: string): ApiCallError | null {
  if (result.status >= 200 && result.status < 300) return null;
  const data = result.json;
  let detail: Record<string, unknown> = {};
  const rawDetail = "detail" in data ? data.detail : data;
  if (typeof rawDetail === "string") detail = { message: rawDetail };
  else if (rawDetail && typeof rawDetail === "object") detail = rawDetail as Record<string, unknown>;
  const codeValue = detail.error ?? detail.code ?? data.error ?? null;
  const rawMessage = detail.message ?? null;
  const messageValue = typeof rawMessage === "string" ? (redact(rawMessage, secret) as string) : null;
  const requestId = typeof data.request_id === "string" ? data.request_id : result.headers["x-request-id"] ?? null;
  const issues = Array.isArray(detail.issues) ? detail.issues : [];
  return new ApiCallError(
    result.status,
    typeof codeValue === "string" ? codeValue : null,
    typeof messageValue === "string" ? messageValue : null,
    requestId,
    redact(issues, secret) as unknown[],
    idempotencyKey,
    redact(data, secret),
  );
}

/** Copy the API value. Absence stays null: it is not a measured zero. */
export function processedInvoicesCharged(raw: Record<string, unknown>): number | null {
  const result = raw.result;
  if (result && typeof result === "object" && "processedInvoicesCharged" in result) {
    const value = (result as Record<string, unknown>).processedInvoicesCharged;
    return typeof value === "number" ? value : null;
  }
  if ("processedInvoicesCharged" in raw) {
    return typeof raw.processedInvoicesCharged === "number" ? raw.processedInvoicesCharged : null;
  }
  return null;
}

export function requestIdOf(raw: Record<string, unknown>, headers: Record<string, string>): string | null {
  if (typeof raw.request_id === "string") return raw.request_id;
  return headers["x-request-id"] ?? null;
}
