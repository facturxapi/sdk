# facturx-mcp

Vérifiez, simulez et générez des factures Factur-X depuis Claude Code, Codex ou Claude.
Il vous faut une clé API FacturX, gratuite : https://facturxapi.com/api-key

## Installer

**Claude Code**

```bash
claude mcp add --scope user --transport http facturx https://mcp.facturxapi.com/mcp
```

Puis, dans Claude Code : `/mcp`, choisissez `facturx`, puis Authenticate.

**Codex**

```bash
codex mcp add facturx --url https://mcp.facturxapi.com/mcp
```

Si la connexion ne s'ouvre pas d'elle-même : `codex mcp login facturx`.

**Claude (claude.ai ou application de bureau)** : ajoutez le connecteur `https://mcp.facturxapi.com/mcp`
(étapes dans [Connecteur hébergé](#connecteur-hébergé-sans-installation)).

La connexion ouvre une page « Connecter FacturX à … » qui demande votre clé API. Elle reste sur cette page : elle n'apparaît
ni dans une commande ni dans un fichier de configuration. Vérifié jusqu'à cette page : Claude Code et Codex le 18/11/2026,
Claude le 17/11/2026 ; le premier appel d'outil est en cours de vérification.

**Sans connecteur hébergé (serveur local)** : la même chose tourne sur votre machine avec `uvx`, fourni par
[uv](https://docs.astral.sh/uv/getting-started/installation/) :

```bash
claude mcp add --scope user facturx -e FACTURX_API_KEY=votre_clé -- uvx facturx-mcp
codex mcp add facturx --env FACTURX_API_KEY=votre_clé -- uvx facturx-mcp
```

## Essayer

Dans une session : « Explique la règle BR-CO-15 avec FacturX », ou « Vérifie cette facture avec FacturX » en joignant un PDF.

## Outils

| Outil | Ce qu'il fait | Coût |
|---|---|---|
| `facturx_explain_error` | explique une règle (BR-…), un champ (BT-…) | gratuit |
| `facturx_dry_run` | simule la génération et liste ce qui manque | gratuit |
| `facturx_convert` | produit le Factur-X PDF/A-3 | 1 facture |
| `facturx_validate` | contrôle un fichier existant | 1 facture |

## Connecteur hébergé (sans installation)

Le même jeu d'outils existe en serveur MCP hébergé, sans rien installer :

```text
https://mcp.facturxapi.com/mcp
```

La connexion passe par OAuth. Votre clé API FacturX est saisie une fois, sur la page de consentement de
mcp.facturxapi.com ; elle n'apparaît jamais dans une adresse web ni dans la configuration du client.
Pas encore de clé : [facturxapi.com/api-key](https://facturxapi.com/api-key).

### Dans Claude (claude.ai ou application de bureau)

1. Compte individuel (Free, Pro, Max) : Customize → Connectors → Add → Add custom connector.
   Compte Team ou Enterprise : le propriétaire l'ajoute dans Organization settings → Connectors → Add → Custom ;
   chaque membre fait ensuite l'étape 3 depuis Customize → Connectors.
2. Donnez un nom (par exemple FacturX) et l'URL `https://mcp.facturxapi.com/mcp`, puis suivez les écrans jusqu'à Add.
3. Si le connecteur affiche Connect, cliquez-le. Quand la connexion OAuth part, la page « Connecter FacturX à … » s'ouvre sur mcp.facturxapi.com :
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
| Claude Code (`claude mcp add --scope user --transport http facturx https://mcp.facturxapi.com/mcp`, puis `/mcp` → Authenticate) | retour OAuth local (localhost) accepté, PKCE S256 exigé, portées lecture et écriture demandées ; connexion vérifiée le 18/11/2026 jusqu'à la page de consentement ; premier appel d'outil non vérifié |
| Codex (`codex mcp add facturx --url https://mcp.facturxapi.com/mcp`, puis `codex mcp login facturx` si besoin) | retour OAuth local (127.0.0.1) accepté, PKCE S256 exigé, portées lecture et écriture demandées ; connexion vérifiée le 18/11/2026 jusqu'à la page de consentement ; premier appel d'outil non vérifié |
| Cursor, autres clients locaux | retours OAuth locaux (127.0.0.1, [::1], localhost) acceptés, PKCE S256 exigé ; **non essayés** avec le connecteur hébergé. Le serveur local reste disponible : commandes `uvx` en haut de page, ou `pip install facturx-mcp` dans « Avancé ». |

### Outils et coût

| Outil | Portée | Coût |
|---|---|---|
| `facturx_dry_run(invoice, validation_target?, output?)` | `mcp:read` | gratuit, aucun fichier écrit |
| `facturx_convert(invoice, validation_target?, output?, idempotency_key?)` | `mcp:write` | **1 facture traitée quand un fichier est produit** ; renvoie le PDF s'il tient sous 1 500 000 octets |
| `facturx_validate(file_base64, filename, validation_target?)` | `mcp:write` | 1 facture traitée quand l'API rend un rapport ; fichier de 1 500 000 octets au plus |
| `facturx_explain_error(code_or_rule)` | `mcp:read` | gratuit |

Différence avec le serveur local : `facturx_validate` reçoit le fichier en base64 (pas de chemin de disque) et
`facturx_convert` renvoie les octets au lieu d'écrire dans un dossier. Les outils ne mesurent pas l'acceptation
par une plateforme agréée.

## Avancé

Serveur MCP officiel de FacturX API : un agent (Claude, Codex, Cursor…) peut simuler,
convertir en Factur-X PDF/A-3, valider un fichier et expliquer une règle EN16931, sans
écrire de code d'intégration. Construit sur le SDK `facturx-api` ; transports stdio et HTTP.
> Version 0.1.2, sur PyPI : `pip install facturx-mcp`. Testé avec le client MCP officiel (SDK Python), pas encore avec
> Claude Code, Codex ou Cursor (voir « Ce qui est prouvé »).

### Installation (pip)

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

### Outils : détail

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
