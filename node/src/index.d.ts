/// <reference types="node" />
export declare const VERSION: string;

export type Output = "facturx_pdfa3" | "xml_cii";
export type ValidationTarget = "en16931" | "france_2026";
export type FileInput = string | Uint8Array;
export type TransportResponse = [status: number, headers: Record<string, string>, body: Uint8Array];
export type Transport = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | null,
) => Promise<TransportResponse>;

export interface ClientOptions {
  /** Defaults to process.env.FACTURX_API_KEY. */
  apiKey?: string;
  /** Required (or FACTURX_BASE_URL). No default host on purpose. */
  baseUrl?: string;
  timeoutMs?: number;
  transport?: Transport;
}

export interface ConvertOptions {
  file?: FileInput;
  output?: Output;
  validationTarget?: ValidationTarget;
  /** Sent as the `options` JSON form field. */
  options?: Record<string, unknown>;
  lang?: "en" | "fr";
  /** Reuse it to resend the identical request safely. */
  idempotencyKey?: string;
}

export interface ValidateOptions {
  validationTarget?: ValidationTarget;
  validationProfile?: string;
  lang?: "en" | "fr";
  idempotencyKey?: string;
}

export declare class DryRunResult {
  readonly raw: Record<string, any>;
  readonly idempotencyKey: string;
  /** generationReadiness.status === "ready" (not `success`). */
  readonly ready: boolean;
  readonly generationReadiness: Record<string, any>;
  readonly requestId: string | null;
}

export declare class ConvertResult {
  readonly raw: Record<string, any>;
  readonly idempotencyKey: string;
  readonly xml: Buffer;
  readonly pdf: Buffer | null;
  readonly output: Output;
  readonly headers: Record<string, string>;
  readonly requestId: string | null;
  readonly target: Record<string, any>;
  readonly targetProfile: string | null;
  readonly xmlSha256: string;
  readonly pdfSha256: string | null;
  save(directory: string, stem?: string): Promise<{ xml: string; pdf?: string }>;
}

export declare class FacturX {
  constructor(options?: ClientOptions);
  readonly baseUrl: string;
  dryRun(invoiceData?: Record<string, unknown> | string | null, options?: ConvertOptions): Promise<DryRunResult>;
  convert(invoiceData?: Record<string, unknown> | string | null, options?: ConvertOptions): Promise<ConvertResult>;
  validate(file: FileInput, options?: ValidateOptions): Promise<Record<string, any>>;
  meta(): Promise<Record<string, any>>;
  integrationContract(): Promise<Record<string, any>>;
}

export declare function fetchTransport(options?: { timeoutMs?: number }): Transport;
export declare function finalChecks(data: Record<string, any>, output: Output): string[];

export declare class FacturXError extends Error {}
export declare class TransportError extends FacturXError {
  readonly idempotencyKey: string | null;
}
export declare class ApiError extends FacturXError {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly detail: Record<string, any>;
  /** detail.error (or detail.code), verbatim. */
  readonly code: string | null;
  /** detail.message, verbatim. */
  readonly apiMessage: string | null;
  readonly issues: Array<Record<string, any>>;
  /** Only what the server said; null = nothing said. */
  readonly retryable: boolean | null;
  readonly retryAfter: number | null;
  readonly requestId: string | null;
  readonly idempotencyKey: string | null;
}
export declare class AuthenticationError extends ApiError {}
export declare class QuotaExceededError extends ApiError {}
export declare class RateLimitError extends ApiError {}
export declare class InvalidRequestError extends ApiError {}
export declare class ConflictError extends ApiError {}
export declare class ServerError extends ApiError {}
export declare class ServiceUnavailableError extends ServerError {}
export declare class ConversionPendingError extends FacturXError {
  readonly response: Record<string, any>;
  readonly jobId: string | null;
  readonly requestId: string | null;
  readonly idempotencyKey: string | null;
}
export declare class NotDeliveredError extends FacturXError {
  readonly response: Record<string, any>;
  readonly failedChecks: string[];
  readonly requestId: string | null;
  readonly idempotencyKey: string | null;
}
