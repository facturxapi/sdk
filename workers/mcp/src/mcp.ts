import { WORKER_VERSION } from "./constants.ts";
import { callTool, TOOLS, toolByName, type ToolContext } from "./tools.ts";

const INSTRUCTIONS =
  "FacturX API turns a complete ERP invoice JSON into a Factur-X PDF/A-3 (EN16931). " +
  "Call facturx_dry_run first (no file); call facturx_convert when it returns ready=true. The connector does not enforce this order. A conversion can consume a processed invoice of the account quota; processedInvoicesCharged is copied from the API unchanged. " +
  "facturx_validate checks a file that already exists. It does not measure acceptance by a plateforme agréée. " +
  "When a call fails, read the structured error (status, code, request_id, missing_fields, ruleId). " +
  "Use facturx_explain_error for an EN16931 rule, a business term, or an invoice JSON path.";

export interface McpRequestContext extends ToolContext {
  scope: readonly string[];
  /** When set (keyless trial), only these tools are listed and callable. */
  allowedTools?: readonly string[];
  /** When set (keyless trial), added as a second text block after a tool result; structuredContent stays the API data. */
  notice?: string;
}

export async function handleMcp(request: Request, ctx: McpRequestContext): Promise<Response> {
  if (request.method === "GET") {
    return new Response("This connector accepts POST /mcp.", {
      status: 405,
      headers: { Allow: "POST, DELETE", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return jsonRpc(null, { code: -32700, message: "parse error" });
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpc(null, { code: -32600, message: "invalid request" });
  }
  const rpc = message as Record<string, unknown>;
  const id = "id" in rpc ? rpc.id : undefined;
  const method = typeof rpc.method === "string" ? rpc.method : "";
  if (id === undefined) return new Response(null, { status: 202 });

  if (method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "facturx", title: "FacturX API", version: WORKER_VERSION },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "ping") return jsonRpc(id, {});
  if (method === "tools/list") {
    return jsonRpc(id, {
      tools: TOOLS.filter((tool) => !ctx.allowedTools || ctx.allowedTools.includes(tool.name)).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    });
  }
  if (method === "tools/call") {
    const params = rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
    const tool = toolByName(name);
    if (!tool || (ctx.allowedTools && !ctx.allowedTools.includes(tool.name))) {
      return jsonRpc(id, toolError({ error: { type: "Error", message: "unknown tool" } }));
    }
    if (!ctx.scope.includes(tool.scope)) {
      return jsonRpc(id, toolError({ error: { type: "insufficient_scope", required: tool.scope } }));
    }
    if (!ctx.apiKey && tool.name !== "facturx_explain_error") {
      return jsonRpc(id, toolError({ error: { type: "Error", code: "invalid_api_key", message: "The API key is missing." } }));
    }
    const result = await callTool(name, args, ctx);
    const text = JSON.stringify(result.data);
    return jsonRpc(id, {
      content: ctx.notice ? [{ type: "text", text }, { type: "text", text: ctx.notice }] : [{ type: "text", text }],
      structuredContent: result.data,
      isError: result.isError,
    });
  }
  return jsonRpc(id, { code: -32601, message: "method not found" }, true);
}

function toolError(data: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}

function jsonRpc(id: unknown, result: unknown, error = false): Response {
  const body = error
    ? { jsonrpc: "2.0", id: id ?? null, error: result }
    : { jsonrpc: "2.0", id: id ?? null, result };
  return json(body, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
