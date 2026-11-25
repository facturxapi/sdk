# FacturX SDK

Official clients for the [FacturX API](https://facturxapi.com): check an invoice with a dry run, convert it to a
Factur-X PDF/A-3 file, validate it — from Python, Node.js, a command line, or an MCP-compatible assistant.

[![facturxapi/sdk MCP server](https://glama.ai/mcp/servers/facturxapi/sdk/badges/score.svg)](https://glama.ai/mcp/servers/facturxapi/sdk)

| Directory | Package | Registry | What it is |
|---|---|---|---|
| [`python/`](python) | `facturx-api` | PyPI | Python client and the `facturx` command (`dry-run`, `convert`, `validate`) |
| [`node/`](node) | `@facturxapi/sdk` | npm | Node.js client (ESM, TypeScript types) |
| [`mcp/`](mcp) | `facturx-mcp` | PyPI | MCP server (registry name `com.facturxapi/mcp`); an npm launcher may follow |
| [`examples/`](examples) | — | — | Runnable examples with their recorded output |

**Status: alpha.** Checked against the registries on 25/11/2026: `facturx-api` 0.1.2 is on PyPI (11/11/2026),
`facturx-mcp` 0.1.3 is on PyPI (21/11/2026), `@facturxapi/sdk` 0.1.2 is on npm (11/11/2026).
`pip install facturx-api`, `pip install facturx-mcp`, `npm install @facturxapi/sdk`. See [`RELEASING.md`](RELEASING.md).

Hosted connector `https://mcp.facturxapi.com/mcp` — [`mcp/README.md`](mcp/README.md): checked up to the consent page
(Claude on 17/11/2026; Claude Code and Codex on 18/11/2026, read and write requested). The first tool call from those
clients is not yet verified. ChatGPT: callbacks accepted, not tested. Cursor: not tried with the hosted connector.

## Design choices worth knowing

- **Production by default** (from 0.1.2): the host is `https://api.facturxapi.com` unless you pass `base_url` / `baseUrl` or set `FACTURX_BASE_URL`; it must be `https`. In 0.1.1 the host is required.
- **A final file is checked, not assumed.** A dry run reads the API's `generationReadiness`; a conversion is only
  reported as done when the final file is present, not on the HTTP status alone.
- **One idempotency key per operation**, and signed download URLs are fetched without your API key.
- **No automatic retry** of 409 / 503 answers: the caller decides.
- The outputs recorded in [`examples/`](examples) are from the staging host on 06/11/2026 (release `900685311ea7`)
  and say so. Since 0.1.2 the example code calls production (`https://api.facturxapi.com`) by default; those recorded
  runs are not a production proof.

## Tests (offline, no network, no API key)

```bash
cd python && PYTHONPATH=src python -m unittest discover -s tests -v && ruff check .
cd node && npm test
cd mcp && pip install ../python . pytest && pytest tests
```

## Security

See [`SECURITY.md`](SECURITY.md). Releases use trusted publishing (OIDC): no registry token is stored in this
repository.

## License

[MIT](LICENSE).
