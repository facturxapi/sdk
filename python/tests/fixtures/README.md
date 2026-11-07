# Test fixtures

- `invoice.json`: copied verbatim from `examples/first-file/fixtures/invoice.json` (fictitious data).
- `staging-401-convert-noauth.json`: real body returned by `https://api-staging.facturxapi.com`
  (release `900685311ea7`) on 06/11/2026 to `POST /api/v1/convert?dry_run=true` sent
  without any credential. No account, no key, no quota involved.

`../cassettes/staging-convert-invoice.json`: real staging dry run + conversion of `invoice.json`
recorded on 06/11/2026 with a sandbox test key (key redacted), trimmed to the fields the SDK
reads (the real PDF is omitted for size, its sha256 kept); `original_body_sha256` identifies
each full original body.

Every other response used by the tests is synthetic and built in the test file from the
documented OpenAPI shapes; it is labelled as such.
