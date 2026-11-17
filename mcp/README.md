# facturx-mcp

Serveur MCP officiel de FacturX API : un agent (Claude, Codex, Cursor…) peut simuler,
convertir en Factur-X PDF/A-3, valider un fichier et expliquer une règle EN16931, sans
écrire de code d'intégration. Construit sur le SDK `facturx-api` ; transports stdio et HTTP.

> Version 0.1.2, sur PyPI : `pip install facturx-mcp`. Testé avec le client MCP officiel (SDK Python), pas encore avec
> Claude Code, Codex ou Cursor (voir « Ce qui est prouvé »).

## Installation

```bash
pip install facturx-mcp                        # installe aussi facturx-api
export FACTURX_API_KEY=…   # clé Sandbox gratuite : https://facturxapi.com/api-key
# FACTURX_BASE_URL est facultatif à partir de 0.1.2 (production par défaut) ; obligatoire en 0.1.1
facturx-mcp                                   # stdio (défaut)
facturx-mcp --transport streamable-http --port 8765   # HTTP : http://127.0.0.1:8765/mcp
```

Déclaration type d'un serveur stdio dans un client MCP (format `mcpServers`, **non testée**
avec un client du marché) :

```json
{"mcpServers": {"facturx": {"command": "facturx-mcp",
  "env": {"FACTURX_API_KEY": "…"}}}}
```

## Connecteur hébergé (sans installation)

Le même jeu d'outils existe en serveur MCP hébergé, sans rien installer :

```text
https://mcp.facturxapi.com/mcp
```

La connexion passe par OAuth. Votre clé API FacturX est saisie une fois, sur la page de consentement de
mcp.facturxapi.com ; elle n'apparaît jamais dans une adresse web ni dans la configuration du client.
Pas encore de clé : [facturxapi.com/api-key](https://facturxapi.com/api-key).

### Dans Claude (claude.ai ou application de bureau)

1. Paramètres → Connecteurs → Ajouter un connecteur personnalisé.
2. URL : `https://mcp.facturxapi.com/mcp`, puis Connecter.
3. La page « Connecter FacturX à … » s'ouvre sur mcp.facturxapi.com :
   - collez votre clé API FacturX ;
   - `mcp:read` (vérifier, expliquer) est imposé ; `mcp:write` (produire et contrôler, décompte des factures traitées)
     est coché par défaut et peut être décoché ;
   - Autoriser.
4. Demandez par exemple : « vérifie cette facture avec FacturX ».

Si la clé est refusée, la page l'affiche (« Cette clé est refusée. Elle n'a pas été enregistrée. ») et rien n'est
enregistré ; relancez la connexion depuis Claude avec la bonne clé.

### Clients

| Client | État |
|---|---|
| Claude (claude.ai, application de bureau) | adresses de retour acceptées ; parcours de consentement vérifié le 17/11/2026 ; premier appel d'outil depuis Claude en cours de vérification |
| ChatGPT (connecteurs) | adresses de retour acceptées ; **non testé** |
| Claude Code, Cursor, Codex, autres clients locaux | **non pris en charge par le connecteur hébergé** : leur retour OAuth passe par `localhost`, que le serveur refuse. Utilisez le serveur local ci-dessus (`pip install facturx-mcp`). |

### Outils et coût

| Outil | Portée | Coût |
|---|---|---|
| `facturx_dry_run(invoice, validation_target?, output?)` | `mcp:read` | gratuit, aucun fichier écrit |
| `facturx_convert(invoice, validation_target?, output?, idempotency_key?)` | `mcp:write` | **1 facture traitée** ; renvoie le PDF s'il tient sous 1 500 000 octets |
| `facturx_validate(file_base64, filename, validation_target?)` | `mcp:write` | 1 facture traitée quand l'API rend un rapport ; fichier de 1 500 000 octets au plus |
| `facturx_explain_error(code_or_rule)` | `mcp:read` | gratuit |

Différence avec le serveur local : `facturx_validate` reçoit le fichier en base64 (pas de chemin de disque) et
`facturx_convert` renvoie les octets au lieu d'écrire dans un dossier. Les outils ne mesurent pas l'acceptation
par une plateforme agréée.

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
