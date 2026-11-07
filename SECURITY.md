# Security policy

Please do not open a public issue for a vulnerability. Use GitHub's **private vulnerability reporting**
(this repository → Security → Report a vulnerability). Include the package, the version and a minimal way to reproduce.

These packages are thin clients: they never log or store an API key, they send it only in the `X-API-Key` header of
requests to the host you configure (HTTPS required), and the signed download URLs of the FacturX API are used without the key.
