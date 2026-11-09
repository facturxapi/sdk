# FacturX SDK

Official clients for the [FacturX API](https://facturxapi.com): check an invoice with a dry run, convert it to a
Factur-X PDF/A-3 file, validate it — from Python, Node.js, a command line, or an MCP-compatible assistant.

| Directory | Package | Registry | What it is |
|---|---|---|---|
| [`python/`](python) | `facturx-api` | PyPI | Python client and the `facturx` command (`dry-run`, `convert`, `validate`) |
| [`node/`](node) | `@facturxapi/sdk` | npm | Node.js client (ESM, TypeScript types) |
| [`mcp/`](mcp) | `facturx-mcp` | PyPI | MCP server (registry name `com.facturxapi/mcp`); an npm launcher may follow |
| [`examples/`](examples) | — | — | Runnable examples with their recorded output |

**Status: alpha.** `facturx-api` and `facturx-mcp` 0.1.1 are on PyPI (`pip install facturx-api`, `pip install facturx-mcp`);
`@facturxapi/sdk` 0.1.1 is on npm (`npm install @facturxapi/sdk`). See [`RELEASING.md`](RELEASING.md).

## Design choices worth knowing

- **No default host.** Pass `base_url` / `baseUrl` or set `FACTURX_BASE_URL`; it must be `https`.
- **A final file is checked, not assumed.** A dry run reads the API's `generationReadiness`; a conversion is only
  reported as done when the final file is present, not on the HTTP status alone.
- **One idempotency key per operation**, and signed download URLs are fetched without your API key.
- **No automatic retry** of 409 / 503 answers: the caller decides.
- The examples in [`examples/`](examples) were recorded against the staging host and say so; they will move to the
  production host with the first release.

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
