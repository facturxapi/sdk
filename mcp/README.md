# facturx-mcp

Serveur MCP officiel de FacturX API : un agent (Claude, Codex, Cursor…) peut simuler,
convertir en Factur-X PDF/A-3, valider un fichier et expliquer une règle EN16931, sans
écrire de code d'intégration. Construit sur le SDK `facturx-api` ; transports stdio et HTTP.

> Version 0.1.1, sur PyPI : `pip install facturx-mcp`. Testé avec le client MCP officiel (SDK Python), pas encore avec
> Claude Code, Codex ou Cursor (voir « Ce qui est prouvé »).

## Installation

```bash
pip install facturx-mcp                        # installe aussi facturx-api
export FACTURX_BASE_URL=https://api.facturxapi.com FACTURX_API_KEY=…
facturx-mcp                                   # stdio (défaut)
facturx-mcp --transport streamable-http --port 8765   # HTTP : http://127.0.0.1:8765/mcp
```

Déclaration type d'un serveur stdio dans un client MCP (format `mcpServers`, **non testée**
avec un client du marché) :

```json
{"mcpServers": {"facturx": {"command": "facturx-mcp",
  "env": {"FACTURX_BASE_URL": "https://api.facturxapi.com", "FACTURX_API_KEY": "…"}}}}
```

## Outils

| Outil | Ce qu'il fait | Coût |
|---|---|---|
| `facturx_dry_run(invoice, validation_target?, output?)` | simulation ; `ready` lit `generationReadiness` | gratuit |
| `facturx_convert(invoice, out_dir, validation_target?, output?, idempotency_key?)` | écrit `factur-x.pdf` / `.xml`, rend chemins, tailles, sha256, cible vérifiée | **1 facture** |
| `facturx_validate(file_path, validation_target?)` | rapport de validation résumé (10 premières erreurs) | facture traitée |
| `facturx_explain_error(code_or_rule)` | champs du contrat d'intégration public liés à une règle (BR-…), un BT ou un chemin JSON | gratuit, sans clé |

Les descriptions d'outils disent à l'agent quand les appeler, ce qu'ils renvoient et ce qui
coûte. Une erreur API devient un résultat `is_error` dont le texte est
`Error executing tool <nom>: {"error": {...}}` avec `status`, `code`, `api_message`,
`request_id` et `idempotency_key` tels que l'API les envoie. Aucune relance automatique
(api#2111). Le registre public des codes d'erreur API n'existe pas encore (api#2089) :
`facturx_explain_error` le dit au lieu d'inventer une explication.

## Ce qui est prouvé (06/11/2026)

- 6 tests hors réseau (`PYTHONPATH=src python -m unittest discover -s tests`, avec `facturx-api`
  et `mcp` installés), connexions sortantes interdites.
- Client MCP officiel (SDK Python `mcp` 2.3.0, `ClientSession`) lançant `facturx-mcp` en
  **stdio**, contre staging (release `900685311ea7`), clé sandbox de test, 16:02Z. Trace
  complète dans `traces/stdio-staging-full-path.json` :

```text
facturx_explain_error BR-CO-15 -> totals.net (BT-109), totals.tax (BT-110), … depuis GET /api/v1/integration-contract
facturx_dry_run  -> ready=true, generationReadiness ready (request f51f89da-69df-4eea-bf8f-0da1a3e57163)
facturx_convert  -> target verified en16931, xml 4584 o sha256 f332975e…e03c, pdf 20624 o
facturx_validate -> valid=true, validationStatus=valid, profile EN16931, 0 erreur
```

- Même serveur en **streamable HTTP** (16:03Z) : `tools/list`, `facturx_explain_error BT-1`
  et `facturx_dry_run` OK ; avec une clé invalide, `facturx_dry_run` renvoie `is_error` avec
  `invalid_api_key` et le message API intact (`traces/http-staging-*.json`).
- Aucune clé dans les traces ni dans les journaux du serveur (vérifié).

**Pas encore prouvé** : essai depuis Claude Code, Codex ou Cursor (à faire depuis une session
du fondateur) ; `xml_cii`, URL signée, 409/503 réels ; soumission aux annuaires MCP (geste du
fondateur).

<!-- mcp-name: com.facturxapi/mcp -->
mcp-name: com.facturxapi/mcp
