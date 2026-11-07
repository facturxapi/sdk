# Releasing

Nothing in this repository reads a registry token. Both registries trust the GitHub workflow itself (OIDC trusted
publishing), the workflows run only when started by hand, and a human approves every public release.

| Workflow | Package | Mode `dry-run` / `build` (default) | Mode `stage` / `publish` |
|---|---|---|---|
| `publish-npm.yml` | `@facturxapi/sdk` (`node/`) | checks only, nothing leaves the runner | `npm stage publish`: uploaded NOT public, a maintainer approves it with 2FA |
| `publish-pypi.yml` | `facturx-api` (`python/`), then `facturx-mcp` (`mcp/`) | builds the sdist and wheel, `twine check` | publishes, after the `pypi-publish` environment is approved |

Publish `facturx-api` before `facturx-mcp` (it depends on it). Only run the workflows from `main`.

## One-time setup

1. **GitHub → Settings → Environments**: create `npm-publish` and `pypi-publish`; tick *Required reviewers*, name the
   maintainers, limit deployment branches to `main`; add no secret.
2. **npm**: the organisation `@facturxapi` must exist and a maintainer must be an owner with 2FA. npm can only attach a
   trusted publisher to a package that already exists, so the **first** version of `@facturxapi/sdk` is published by hand
   from a clean clone of `main`:
   ```bash
   cd node && npm login && npm test && npm pack --dry-run && npm publish --access public --otp=<6 digits>
   ```
3. **npm trusted publisher** (when the next version is ready; a new configuration must succeed within 2 days):
   ```bash
   npm install -g "npm@^11.15.0"
   npm trust github @facturxapi/sdk --file publish-npm.yml --repo facturxapi/sdk --env npm-publish --allow-stage-publish
   ```
   or on npmjs.com → the package → Settings → Trusted publisher → GitHub Actions: Organization `facturxapi`, Repository
   `sdk`, Workflow `publish-npm.yml`, Environment `npm-publish`, allowed action **only** `npm stage publish`.
4. **PyPI pending publishers** (no manual first upload): pypi.org → Your account → Publishing → *Add a new pending
   publisher*, `facturx-api`: Owner `facturxapi`, Repository `sdk`, Workflow `publish-pypi.yml`, Environment `pypi-publish`;
   `facturx-mcp`: same, but Environment `pypi-publish-mcp` (PyPI refuses two pending publishers with the same
   repository + workflow + environment).

## Each release

1. Bump the version in the package (`node/package.json`, `python/pyproject.toml`, `mcp/pyproject.toml` and
   `mcp/server.json`), merge to `main`.
2. Actions → the workflow → *Run workflow* from `main` with the version and mode `dry-run` / `build`; read the
   `PREFLIGHT_OK` line and the file list.
3. Run it again with mode `stage` (npm) or `publish` (PyPI) and approve the environment when GitHub asks.
4. npm only, in a terminal logged in with 2FA: `npm stage list @facturxapi/sdk`, `npm stage view <stage-id>`, then
   `npm stage approve <stage-id>` (asks for the one-time code; the version becomes public) or `npm stage reject <stage-id>`.
5. MCP registry, after `facturx-mcp` is on PyPI: `mcp-publisher publish` from `mcp/` (namespace `com.facturxapi/mcp`,
   ownership proved by the DNS record on `facturxapi.com` and by the `mcp-name:` line of `mcp/README.md`).

## If something goes wrong

A staged npm version that is not approved is dropped with `npm stage reject`. A public version cannot be withdrawn at
will: run `npm deprecate @facturxapi/sdk@<version> "<message>"` and publish the next one. A workflow that fails before
the upload step leaves nothing on npm or PyPI.
