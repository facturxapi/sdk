// FacturX API client for Node.js 18+: no runtime dependency, no automatic retry.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  ConversionPendingError,
  FacturXError,
  NotDeliveredError,
  TransportError,
  apiError,
} from "./errors.js";

export * from "./errors.js";

export const VERSION = "0.1.1";
const OUTPUTS = ["facturx_pdfa3", "xml_cii"];
const TARGETS = ["en16931", "france_2026"];

/** Default transport: one fetch, redirects not followed, no retry. */
export function fetchTransport({ timeoutMs = 120_000 } = {}) {
  return async (method, url, headers, body) => {
    const response = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      redirect: "manual", // a redirect must never carry the API key elsewhere
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseHeaders = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value;
    });
    return [response.status, responseHeaders, Buffer.from(await response.arrayBuffer())];
  };
}

export class DryRunResult {
  constructor(raw, idempotencyKey) {
    this.raw = raw;
    this.idempotencyKey = idempotencyKey;
  }
  /** generationReadiness.status === "ready" — NOT `success` (a dry run may say success=false and still allow generation). */
  get ready() {
    return this.raw.dry_run === true && this.raw.generationReadiness?.status === "ready";
  }
  get generationReadiness() {
    return { ...(this.raw.generationReadiness ?? {}) };
  }
  get requestId() {
    return this.raw.request_id ?? null;
  }
}

export class ConvertResult {
  constructor({ raw, idempotencyKey, xml, pdf, output, headers }) {
    Object.assign(this, { raw, idempotencyKey, xml, pdf, output, headers });
  }
  get requestId() {
    return this.raw.request_id ?? this.headers["x-request-id"] ?? null;
  }
  get target() {
    return { ...(this.raw.target ?? {}) };
  }
  get targetProfile() {
    return this.raw.result?.targetProfile ?? null;
  }
  get xmlSha256() {
    return sha256(this.xml);
  }
  get pdfSha256() {
    return this.pdf ? sha256(this.pdf) : null;
  }
  /** Write the deliverable(s) into `directory`; returns their paths. */
  async save(directory, stem = "factur-x") {
    await mkdir(directory, { recursive: true });
    const paths = { xml: join(directory, `${stem}.xml`) };
    await writeFile(paths.xml, this.xml);
    if (this.pdf) {
      paths.pdf = join(directory, `${stem}.pdf`);
      await writeFile(paths.pdf, this.pdf);
    }
    return paths;
  }
}

export class FacturX {
  /**
   * No default host on purpose: pass baseUrl (e.g. https://api.facturxapi.com) or set FACTURX_BASE_URL.
   */
  constructor({ apiKey, baseUrl, timeoutMs = 120_000, transport } = {}) {
    this.apiKey = apiKey ?? process.env.FACTURX_API_KEY ?? "";
    const base = baseUrl ?? process.env.FACTURX_BASE_URL ?? "";
    if (!base) throw new TypeError("baseUrl is required (or set FACTURX_BASE_URL).");
    if (new URL(base).protocol !== "https:") throw new TypeError("baseUrl must use https.");
    this.baseUrl = base.replace(/\/+$/, "");
    this.send = transport ?? fetchTransport({ timeoutMs });
  }

  /** Check an invoice without producing a deliverable (does not consume quota). */
  async dryRun(invoiceData, options = {}) {
    const key = options.idempotencyKey ?? randomUUID();
    const [data] = await this.#convertCall(invoiceData, options, key, true);
    return new DryRunResult(data, key);
  }

  /** Final conversion (1 processed invoice on the quota, refunded without deliverable). */
  async convert(invoiceData, options = {}) {
    const key = options.idempotencyKey ?? randomUUID();
    const output = options.output ?? "facturx_pdfa3";
    const [data, headers] = await this.#convertCall(invoiceData, options, key, false);
    const failed = finalChecks(data, output);
    if (failed.length) throw new NotDeliveredError(data, failed, { idempotencyKey: key });
    let xml, pdf;
    try {
      xml = decodeBase64(data.result.xml);
      pdf = output === "facturx_pdfa3" ? await this.#pdf(data.result) : null;
    } catch (error) {
      const notDelivered = new NotDeliveredError(data, ["result.xml/pdf decodable"], {
        idempotencyKey: key,
      });
      notDelivered.cause = error;
      throw notDelivered;
    }
    return new ConvertResult({ raw: data, idempotencyKey: key, xml, pdf, output, headers });
  }

  /** Validate an existing Factur-X PDF or XML (Buffer/Uint8Array or file path). Returns the API report as is. */
  async validate(file, { validationTarget, validationProfile, lang, idempotencyKey } = {}) {
    const query = toQuery({
      validation_target: validationTarget,
      validation_profile: validationProfile,
      lang,
    });
    const [filename, content] = await readInput(file);
    const [body, contentType] = multipart({}, ["file", filename, content], idempotencyKey);
    const headers = { "Content-Type": contentType };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const [data] = await this.#request("POST", `/api/v1/validate${query}`, body, headers, idempotencyKey);
    return data;
  }

  /** GET /meta: public versions, limits and capabilities. */
  async meta() {
    return (await this.#request("GET", "/meta", null, {}, null, false))[0];
  }

  /** GET /api/v1/integration-contract: public ERP integration contract. */
  async integrationContract() {
    return (await this.#request("GET", "/api/v1/integration-contract", null, {}, null, false))[0];
  }

  async #convertCall(invoiceData, options, key, dryRun) {
    const output = options.output ?? "facturx_pdfa3";
    const target = options.validationTarget ?? "en16931";
    if (!OUTPUTS.includes(output)) throw new TypeError(`output must be one of ${OUTPUTS}`);
    if (!TARGETS.includes(target)) throw new TypeError(`validationTarget must be one of ${TARGETS}`);
    if (invoiceData == null && options.file == null) {
      throw new TypeError("Provide invoiceData, options.file, or both.");
    }
    const fields = { output, validation_target: target };
    if (invoiceData != null) fields.invoice_data = toJson(invoiceData);
    if (options.options != null) fields.options = toJson(options.options);
    const upload = options.file != null ? ["file", ...(await readInput(options.file))] : null;
    const [body, contentType] = multipart(fields, upload, key);
    const query = toQuery({ dry_run: dryRun ? "true" : undefined, lang: options.lang });
    const headers = { "Content-Type": contentType, "Idempotency-Key": key };
    const [data, responseHeaders, status] = await this.#request(
      "POST",
      `/api/v1/convert${query}`,
      body,
      headers,
      key,
    );
    if (status === 202) throw new ConversionPendingError(data, { idempotencyKey: key });
    return [data, responseHeaders];
  }

  async #request(method, path, body, headers, idempotencyKey, auth = true) {
    const allHeaders = {
      Accept: "application/json",
      "User-Agent": `facturx-api-node/${VERSION}`,
      ...headers,
    };
    if (auth) {
      if (!this.apiKey) throw new TypeError("apiKey is required (or set FACTURX_API_KEY).");
      allHeaders["X-API-Key"] = this.apiKey;
    }
    let status, responseHeaders, raw;
    try {
      [status, responseHeaders, raw] = await this.send(method, this.baseUrl + path, allHeaders, body);
    } catch (cause) {
      throw new TransportError(`${method} ${path}: transport failed, outcome unknown (${cause?.message ?? cause})`, {
        idempotencyKey,
        cause,
      });
    }
    let data;
    try {
      data = raw && raw.length ? JSON.parse(Buffer.from(raw).toString("utf8")) : {};
    } catch {
      if (status >= 200 && status < 300) throw new FacturXError(`HTTP ${status}: non-JSON response`);
      data = { detail: { message: Buffer.from(raw).subarray(0, 500).toString("utf8") } };
    }
    if (status < 200 || status >= 300) {
      throw apiError(status, data, responseHeaders, { idempotencyKey });
    }
    return [data, responseHeaders, status];
  }

  async #pdf(result) {
    const inline = result.pdf;
    const url = result.pdfUrl;
    if (Boolean(inline) === Boolean(url)) throw new Error("expected exactly one of result.pdf / result.pdfUrl");
    let pdf;
    if (inline) {
      pdf = decodeBase64(inline);
    } else {
      if (new URL(url).protocol !== "https:") throw new Error("pdfUrl is not https");
      // Presigned URL: the API key is NEVER sent to it.
      const [status, , body] = await this.send("GET", url, {}, null);
      if (status !== 200) throw new Error(`pdfUrl download HTTP ${status}`);
      pdf = Buffer.from(body);
    }
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("deliverable is not a PDF");
    return pdf;
  }
}

/** Documented success fields; HTTP 200 alone does not prove a conversion. */
export function finalChecks(data, output) {
  const result = data.result ?? {};
  const checks = {
    "dry_run is not true": data.dry_run !== true,
    "success == true": data.success === true,
    "result.conversionSuccessful == true": result.conversionSuccessful === true,
    "target.status == verified": data.target?.status === "verified",
    "result.xml present": Boolean(result.xml),
  };
  if (output === "facturx_pdfa3") {
    const generated = data.finalGeneratedValidation ?? {};
    Object.assign(checks, {
      "result.packagingPerformed == true": result.packagingPerformed === true,
      "finalGeneratedValidation.status == passed": generated.status === "passed",
      "finalGeneratedValidation.artifactAvailable == true": generated.artifactAvailable === true,
      "packaging.status == passed": generated.validationReadiness?.packaging?.status === "passed",
    });
  }
  return Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) {
    throw new Error("invalid base64");
  }
  return Buffer.from(value, "base64");
}

function toJson(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toQuery(params) {
  const kept = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  return kept.length ? `?${new URLSearchParams(kept)}` : "";
}

async function readInput(file) {
  if (typeof file === "string") return [basename(file), await readFile(file)];
  const content = Buffer.from(file);
  const name = content.subarray(0, 64).toString("latin1").trimStart().startsWith("<") ? "invoice.xml" : "invoice.pdf";
  return [name, content];
}

function multipart(fields, upload, seed) {
  // Same idempotency key + same fields => byte-identical body on a resend.
  const token = sha256(seed ?? randomUUID()).slice(0, 32);
  const boundary = `facturx-sdk-${token}`;
  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"),
  );
  if (upload) {
    const [name, filename, content] = upload;
    const mime = content.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : "application/xml";
    const safe = filename.replace(/["\r\n]/g, "_");
    parts.push(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${safe}"\r\nContent-Type: ${mime}\r\n\r\n`,
          "utf8",
        ),
        content,
        Buffer.from("\r\n"),
      ]),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const occurrences = body.toString("latin1").split(boundary).length - 1;
  if (occurrences !== parts.length) throw new Error("multipart boundary collides with the payload");
  return [body, `multipart/form-data; boundary=${boundary}`];
}
