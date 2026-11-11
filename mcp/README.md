# facturx-mcp

Official MCP server for the [FacturX API](https://facturxapi.com). It lets an AI agent (Claude Code, Codex, any MCP
client) check an invoice JSON, turn it into a Factur-X PDF/A-3 file (EN16931), validate an existing Factur-X PDF or
CII XML, and look up an EN16931 rule or business term, without writing integration code.

```bash
pip install facturx-mcp                 # or run it without installing: uvx facturx-mcp
export FACTURX_API_KEY=your_key         # free Sandbox key: https://facturxapi.com/api-key
facturx-mcp                             # stdio server, production host by default
```

Version 0.1.2 on PyPI. Built on the [`facturx-api`](../python) Python SDK. MIT licensed.

## Add it to your client

Claude Code:

```bash
claude mcp add facturx -e FACTURX_API_KEY=your_key -- uvx facturx-mcp
```

Codex CLI:

```bash
codex mcp add facturx --env FACTURX_API_KEY=your_key -- uvx facturx-mcp
```

Generic `mcpServers` entry (the format most clients read; not tried in Cursor):

```json
{"mcpServers": {"facturx": {"command": "uvx", "args": ["facturx-mcp"],
  "env": {"FACTURX_API_KEY": "your_key"}}}}
```

In Claude Code, put the server name (`facturx`) before the `-e` option. A server added with `--scope project` asks for
your approval the first time you open Claude Code in that folder.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `FACTURX_API_KEY` | for `facturx_dry_run`, `facturx_convert`, `facturx_validate` | none |
| `FACTURX_BASE_URL` | no | `https://api.facturxapi.com` (must be `https`) |

HTTP transport instead of stdio: `facturx-mcp --transport streamable-http --port 8765` serves
`http://127.0.0.1:8765/mcp`.

Docker: the [`Dockerfile`](Dockerfile) in this folder installs `facturx-mcp` from PyPI and starts it on stdio
(`docker build -t facturx-mcp mcp && docker run -i --rm -e FACTURX_API_KEY facturx-mcp`).

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `facturx_dry_run(invoice, validation_target?, output?)` | Checks an invoice JSON without producing a file; `ready` is true only when the API says generation can proceed | free |
| `facturx_convert(invoice, out_dir, validation_target?, output?, idempotency_key?)` | Writes `factur-x.pdf` and `factur-x.xml` to `out_dir`; returns paths, sizes, sha256 and the verified target | 1 invoice |
| `facturx_validate(file_path, validation_target?)` | Validates a local Factur-X PDF or CII XML; returns the status and the first 10 errors | 1 invoice when a report is returned |
| `facturx_explain_error(code_or_rule)` | Finds the invoice fields linked to a rule (`BR-CO-15`), a business term (`BT-1`) or a JSON path, from the API's public integration contract | free, no key |

`validation_target` defaults to `en16931` for all three invoice tools. Pass `france_2026` to check the French
e-invoicing rules.

Each tool description tells the agent when to call it, what it returns and what it costs. An API error comes back as
a tool error whose text holds the API's own `status`, `code`, `api_message`, `request_id` and `idempotency_key`. The
server never retries on its own. If `facturx_convert` fails without an answer, calling it again with the same
`idempotency_key` does not charge twice. A public registry of API error codes is not published yet, so
`facturx_explain_error` says so instead of guessing.

## What has been tested

- Offline test suite in this folder (fake transport, outbound network blocked): `pip install ../python . pytest && pytest tests`.
- Production, 11 November 2026: the official MCP Python client started `facturx-mcp` 0.1.1 from PyPI on stdio and
  called all four tools on `https://api.facturxapi.com`: rule lookup, dry run (`ready`), conversion (target
  `en16931` verified, PDF and XML written) and validation of the produced PDF.
- Production, 11 November 2026: `facturx-mcp` 0.1.2 from PyPI, started by `uvx` with no `FACTURX_BASE_URL`, answered
  `facturx_explain_error` from the production host.
- Docker, 11 November 2026: the image built from the [`Dockerfile`](Dockerfile) started on stdio and answered
  `facturx_explain_error` from the production host, running as a non-root user.
- Claude Code 2.1.322 and Codex CLI 0.167.0, 11 November 2026: `facturx-mcp` 0.1.1 declared as `uvx facturx-mcp`
  and `facturx_explain_error` called from each client (staging host).
- Streamable HTTP transport: tool listing, rule lookup and dry run, and a clear `invalid_api_key` error with a wrong
  key (staging host, 6 November 2026; recordings in [`traces/`](traces)).

Not tried yet: Cursor, and the three tools that need a key called from inside Claude Code or Codex.

## En français

Serveur MCP officiel de FacturX API : contrôle d'une facture JSON, conversion en Factur-X PDF/A-3 (EN16931),
validation d'un fichier et explication d'une règle, depuis un agent IA. Installation : `pip install facturx-mcp`, clé
Sandbox gratuite sur https://facturxapi.com/api-key. Pour vérifier les règles françaises, passez
`validation_target=france_2026`.

<!-- mcp-name: com.facturxapi/mcp -->
mcp-name: com.facturxapi/mcp
