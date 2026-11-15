import {
  ApiCallError,
  TransportError,
  asApiError,
  decodeBase64,
  encodeBase64,
  facturxFetch,
  multipart,
  processedInvoicesCharged,
  redact,
  requestIdOf,
  sha256Hex,
} from "./api.ts";
import { OUTPUTS, PDF_MAX_BYTES, TARGETS, type OutputName, type TargetName } from "./constants.ts";

export interface ToolContext {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface ToolOk {
  isError: false;
  data: Record<string, unknown>;
}

export interface ToolErr {
  isError: true;
  data: Record<string, unknown>;
}

export type ToolResult = ToolOk | ToolErr;

const contractCache = new Map<string, Record<string, unknown>>();

export function clearContractCache(): void {
  contractCache.clear();
}

export const TOOLS = [
  {
    name: "facturx_dry_run",
    title: "Vérifier une facture avant génération",
    description:
      "Vérifie un JSON de facture sans écrire de fichier et sans débiter de facture traitée. ready n'est vrai que si generationReadiness.status vaut ready. Si l'API répond 422, le résultat est un JSON structuré (status, code, request_id, missing_fields, ruleId, issues) ; ready n'est alors pas renseigné. processedInvoicesCharged : la valeur envoyée par l'API, ou null si elle ne l'envoie pas. Cela ne mesure pas l'acceptation par une plateforme agréée.",
    inputSchema: {
      type: "object",
      properties: {
        invoice: { type: "object" },
        validation_target: { type: "string", enum: [...TARGETS] },
        output: { type: "string", enum: [...OUTPUTS] },
      },
      required: ["invoice"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: "mcp:read" as const,
  },
  {
    name: "facturx_convert",
    title: "Produire le Factur-X",
    description:
      "Produit le PDF Factur-X et le XML à partir du JSON de facture. Le connecteur ne vérifie pas qu'un facturx_dry_run a déjà renvoyé ready. Il recopie request_id et processedInvoicesCharged : la valeur envoyée par l'API, ou null si elle ne l'envoie pas, plus les tailles et les sha256. Il ne modifie pas ce nombre. Le PDF n'est renvoyé que s'il tient sous 1 500 000 octets ; au-delà, refus explicite avec la taille et le sha256, sans les octets. La même idempotency_key est renvoyée à l'API pour ne pas traiter une seconde facture.",
    inputSchema: {
      type: "object",
      properties: {
        invoice: { type: "object" },
        validation_target: { type: "string", enum: [...TARGETS] },
        output: { type: "string", enum: [...OUTPUTS] },
        idempotency_key: { type: "string" },
      },
      required: ["invoice"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: "mcp:write" as const,
  },
  {
    name: "facturx_validate",
    title: "Contrôler un fichier Factur-X",
    description:
      "Contrôle un PDF Factur-X ou un XML CII déjà produit, envoyé en octets (base64), pas comme un chemin de disque. Cible par défaut : en16931. france_2026 lance les règles françaises de cette cible. Cela ne mesure pas l'acceptation par une plateforme agréée. Coût : 1 facture traitée quand l'API rend un rapport. Un fichier de plus de 1 500 000 octets est refusé par le connecteur, sans appel à l'API. Recopie processedInvoicesCharged, request_id et validationStatus.",
    inputSchema: {
      type: "object",
      properties: {
        file_base64: { type: "string" },
        filename: { type: "string" },
        validation_target: { type: "string", enum: [...TARGETS] },
      },
      required: ["file_base64", "filename"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    scope: "mcp:write" as const,
  },
  {
    name: "facturx_explain_error",
    title: "Expliquer une règle ou un champ",
    description:
      "Explique une règle EN 16931, un BT, ou un chemin JSON, à partir du contrat d'intégration public. Ne débite pas de facture traitée. Pour une erreur HTTP, lisez error.api_message et error.issues renvoyés par l'appel.",
    inputSchema: {
      type: "object",
      properties: { code_or_rule: { type: "string" } },
      required: ["code_or_rule"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: "mcp:read" as const,
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export function toolByName(name: string): (typeof TOOLS)[number] | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function failure(error: unknown, secret: string): ToolErr {
  if (error instanceof ApiCallError && error.status === 422) {
    return { isError: true, data: structured422(error) };
  }
  if (error instanceof ApiCallError) {
    return {
      isError: true,
      data: redact(
        {
          error: {
            type: "ApiCallError",
            status: error.status,
            code: error.code,
            api_message: error.apiMessage,
            request_id: error.requestId,
            issues: error.issues,
            idempotency_key: error.idempotencyKey,
          },
        },
        secret,
      ) as Record<string, unknown>,
    };
  }
  if (error instanceof TransportError) {
    return {
      isError: true,
      data: {
        error: {
          type: "TransportError",
          message: "Outcome unknown: call again with the same idempotency_key.",
          idempotency_key: error.idempotencyKey,
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : "tool failed";
  return { isError: true, data: redact({ error: { type: "Error", message } }, secret) as Record<string, unknown> };
}

function structured422(error: ApiCallError): Record<string, unknown> {
  const missing: string[] = [];
  const ruleIds: string[] = [];
  for (const issue of error.issues) {
    if (!issue || typeof issue !== "object") continue;
    const record = issue as Record<string, unknown>;
    const rule = record.ruleId;
    if (typeof rule === "string" && rule && !ruleIds.includes(rule)) ruleIds.push(rule);
    if (record.validation_type === "missing" && typeof record.field === "string") missing.push(record.field);
  }
  const out: Record<string, unknown> = {
    status: error.status,
    code: error.code,
    request_id: error.requestId,
    missing_fields: missing,
    ruleId: ruleIds.length === 1 ? ruleIds[0] : null,
    issues: error.issues,
  };
  if (error.apiMessage !== null) out.api_message = error.apiMessage;
  if (error.idempotencyKey) out.idempotency_key = error.idempotencyKey;
  return out;
}

async function postConvert(
  ctx: ToolContext,
  invoice: unknown,
  output: OutputName,
  target: TargetName,
  idempotencyKey: string,
  dryRun: boolean,
): Promise<{ raw: Record<string, unknown>; headers: Record<string, string> }> {
  if (invoice === null || typeof invoice !== "object" || Array.isArray(invoice)) {
    throw new Error("invoice must be a JSON object");
  }
  const fields = {
    output,
    validation_target: target,
    invoice_data: JSON.stringify(invoice),
  };
  const { body, contentType } = await multipart(fields, null, idempotencyKey);
  const path = dryRun ? "/api/v1/convert?dry_run=true" : "/api/v1/convert";
  const result = await facturxFetch({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    method: "POST",
    path,
    body,
    contentType,
    idempotencyKey,
    fetchImpl: ctx.fetchImpl,
  });
  const error = asApiError(result, idempotencyKey, ctx.apiKey);
  if (error) throw error;
  if (result.status === 202) {
    throw new ApiCallError(202, "pending", "Conversion accepted for async processing. No file yet.", requestIdOf(result.json, result.headers), [], idempotencyKey, result.json);
  }
  return { raw: result.json, headers: result.headers };
}

export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (name === "facturx_dry_run") return { isError: false, data: await dryRun(args, ctx) };
    if (name === "facturx_convert") return { isError: false, data: await convert(args, ctx) };
    if (name === "facturx_validate") return { isError: false, data: await validate(args, ctx) };
    if (name === "facturx_explain_error") return { isError: false, data: await explain(args, ctx) };
    return { isError: true, data: { error: { type: "Error", message: "unknown tool" } } };
  } catch (error) {
    return failure(error, ctx.apiKey);
  }
}

async function dryRun(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  const output = oneOf(args.output, OUTPUTS, "facturx_pdfa3");
  const target = oneOf(args.validation_target, TARGETS, "en16931");
  const idempotencyKey = crypto.randomUUID();
  const { raw, headers } = await postConvert(ctx, args.invoice, output, target, idempotencyKey, true);
  const readiness = raw.generationReadiness;
  return {
    ready: raw.dry_run === true && !!readiness && typeof readiness === "object" && (readiness as Record<string, unknown>).status === "ready",
    generation_readiness: readiness && typeof readiness === "object" ? readiness : {},
    target: raw.target ?? null,
    request_id: requestIdOf(raw, headers),
    processedInvoicesCharged: processedInvoicesCharged(raw),
    idempotency_key: idempotencyKey,
  };
}

function finalChecks(data: Record<string, unknown>, output: OutputName): string[] {
  const result = (data.result ?? {}) as Record<string, unknown>;
  const checks: Record<string, boolean> = {
    "dry_run is not true": data.dry_run !== true,
    "success == true": data.success === true,
    "result.conversionSuccessful == true": result.conversionSuccessful === true,
    "target.status == verified": (data.target as Record<string, unknown> | undefined)?.status === "verified",
    "result.xml present": Boolean(result.xml),
  };
  if (output === "facturx_pdfa3") {
    const generated = (data.finalGeneratedValidation ?? {}) as Record<string, unknown>;
    const packaging = (generated.validationReadiness as Record<string, unknown> | undefined)?.packaging as
      | Record<string, unknown>
      | undefined;
    Object.assign(checks, {
      "result.packagingPerformed == true": result.packagingPerformed === true,
      "finalGeneratedValidation.status == passed": generated.status === "passed",
      "finalGeneratedValidation.artifactAvailable == true": generated.artifactAvailable === true,
      "packaging.status == passed": packaging?.status === "passed",
    });
  }
  return Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
}

async function pdfBytes(result: Record<string, unknown>): Promise<Uint8Array> {
  const inline = result.pdf;
  const pdfUrl = result.pdfUrl;
  if (Boolean(inline) === Boolean(pdfUrl)) throw new Error("expected exactly one of result.pdf / result.pdfUrl");
  if (typeof inline === "string") return decodeBase64(inline);
  if (typeof pdfUrl !== "string") throw new Error("pdfUrl missing");
  const url = new URL(pdfUrl);
  if (url.protocol !== "https:") throw new Error("pdfUrl is not https");
  // Presigned URL: never the API client, so the key is not attached.
  const response = await fetch(url, { redirect: "manual" });
  if (response.status !== 200) throw new Error(`pdfUrl download HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (latin1(bytes, 5) !== "%PDF-") throw new Error("deliverable is not a PDF");
  return bytes;
}

function latin1(bytes: Uint8Array, length: number): string {
  return String.fromCharCode(...bytes.subarray(0, length));
}

async function filePayload(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const sha = await sha256Hex(bytes);
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { refused: "too_large", bytes: bytes.byteLength, sha256: sha, max_bytes: PDF_MAX_BYTES };
  }
  return { base64: encodeBase64(bytes), bytes: bytes.byteLength, sha256: sha };
}

async function convert(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  const output = oneOf(args.output, OUTPUTS, "facturx_pdfa3");
  const target = oneOf(args.validation_target, TARGETS, "en16931");
  const idempotencyKey = typeof args.idempotency_key === "string" && args.idempotency_key ? args.idempotency_key : crypto.randomUUID();
  const { raw, headers } = await postConvert(ctx, args.invoice, output, target, idempotencyKey, false);
  const failed = finalChecks(raw, output);
  if (failed.length) {
    throw new ApiCallError(200, "not_delivered", `No verified final file: ${failed.join(", ")}`, requestIdOf(raw, headers), [], idempotencyKey, raw);
  }
  const result = raw.result as Record<string, unknown>;
  const xml = decodeBase64(String(result.xml));
  const files: Record<string, unknown> = { xml: await filePayload(xml) };
  if (output === "facturx_pdfa3") {
    const pdf = await pdfBytes(result);
    if (latin1(pdf, 5) !== "%PDF-") throw new Error("deliverable is not a PDF");
    files.pdf = await filePayload(pdf);
  }
  return {
    files,
    target: raw.target ?? null,
    target_profile: result.targetProfile ?? null,
    request_id: requestIdOf(raw, headers),
    processedInvoicesCharged: processedInvoicesCharged(raw),
    idempotency_key: idempotencyKey,
  };
}

async function validate(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (typeof args.file_base64 !== "string" || typeof args.filename !== "string" || !args.filename) {
    throw new Error("file_base64 and filename are required");
  }
  const bytes = decodeBase64(args.file_base64);
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return {
      refused: "too_large",
      bytes: bytes.byteLength,
      max_bytes: PDF_MAX_BYTES,
      request_id: null,
      processedInvoicesCharged: null,
    };
  }
  const target = oneOf(args.validation_target, TARGETS, "en16931");
  const idempotencyKey = crypto.randomUUID();
  const { body, contentType } = await multipart({}, { filename: args.filename, bytes }, idempotencyKey);
  const result = await facturxFetch({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    method: "POST",
    path: `/api/v1/validate?validation_target=${target}`,
    body,
    contentType,
    idempotencyKey,
    fetchImpl: ctx.fetchImpl,
  });
  const error = asApiError(result, idempotencyKey, ctx.apiKey);
  if (error) throw error;
  const report = result.json;
  const errors = Array.isArray(report.errors) ? report.errors : [];
  return {
    valid: report.valid ?? null,
    validation_status: report.validationStatus ?? null,
    profile: report.profile ?? null,
    target: report.target ?? null,
    request_id: requestIdOf(report, result.headers),
    processedInvoicesCharged: processedInvoicesCharged(report),
    error_count: errors.length,
    errors: errors.slice(0, 10),
  };
}

function contractMatches(contract: Record<string, unknown>, query: string): Record<string, unknown>[] {
  const q = query.trim().toUpperCase();
  const keys = ["bt", "bg", "en16931_rule", "france_2026_rule", "target_policy_rule"] as const;
  const fields = Array.isArray(contract.fields) ? contract.fields : [];
  const hits: Record<string, unknown>[] = [];
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const record = field as Record<string, unknown>;
    const tokens = new Set<string>();
    for (const key of keys) {
      for (const token of String(record[key] ?? "").split(",")) {
        if (token.trim()) tokens.add(token.trim().toUpperCase());
      }
    }
    if (tokens.has(q) || q === String(record.json_path ?? "").toUpperCase()) {
      const hit: Record<string, unknown> = {};
      for (const key of ["json_path", "bt", "bg", "requirement", "en16931_rule", "france_2026_rule", "cii_xpath", "accepted_values", "input_format", "coverage_status"]) {
        const value = record[key];
        if (value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)) hit[key] = value;
      }
      hits.push(hit);
    }
  }
  return hits;
}

async function explain(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  const query = typeof args.code_or_rule === "string" ? args.code_or_rule : "";
  const cacheKey = new URL("/api/v1/integration-contract", ctx.baseUrl).href;
  let contract = contractCache.get(cacheKey);
  if (!contract) {
    const result = await facturxFetch({
      baseUrl: ctx.baseUrl,
      apiKey: null,
      method: "GET",
      path: "/api/v1/integration-contract",
      fetchImpl: ctx.fetchImpl,
    });
    const error = asApiError(result, null, ctx.apiKey);
    if (error) throw error;
    contract = result.json;
    contractCache.set(cacheKey, contract);
  }
  const matches = contractMatches(contract, query);
  const out: Record<string, unknown> = {
    query,
    source: "GET /api/v1/integration-contract",
    engine_version: contract.engine_version ?? null,
    matches,
  };
  if (!matches.length) {
    out.note =
      "No invoice field of the public integration contract references this value. For an API error code, rely on error.api_message and error.issues returned by the failed call; the public API error-code registry is not published yet.";
  }
  return out;
}
