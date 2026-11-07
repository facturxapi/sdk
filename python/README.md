# facturx-api (Python)

Client Python de FacturX API : simulation gratuite (`dry_run`), conversion finale en
Factur-X PDF/A-3 (ou XML CII), validation d'un fichier existant. Bibliothèque standard
uniquement, Python 3.10+.

> Statut 0.1.0 : **non publié sur PyPI.** Installation depuis la wheel construite localement.
> Parcours facture → fichiers exécuté contre staging le 06/11/2026 (voir « Ce qui est prouvé »).

## Installation (locale)

```bash
cd sdk/python && python -m build          # produit dist/facturx_api-0.1.0-py3-none-any.whl
pip install dist/facturx_api-0.1.0-py3-none-any.whl
```

## Utilisation

```python
import json
from facturx_api import FacturX

fx = FacturX(api_key="…", base_url="https://api.facturxapi.com")
invoice = json.load(open("invoice.json"))  # JSON ERP complet

check = fx.dry_run(invoice)  # gratuit, aucun livrable
if check.ready:  # generationReadiness.status == "ready"
    doc = fx.convert(invoice)  # 1 facture traitée sur le quota
    print(doc.save("out"))  # out/factur-x.pdf et out/factur-x.xml
```

Il n'y a **pas d'hôte par défaut** : `base_url` (ou `FACTURX_BASE_URL`) est obligatoire.
`api_key` peut venir de `FACTURX_API_KEY`.

- `ready` lit `generationReadiness.status`, pas `success` : une simulation peut répondre
  `success=false` et autoriser quand même la génération.
- `convert` ne renvoie un résultat que si tous les champs de succès documentés sont au bon
  état (`success`, `result.conversionSuccessful`, `target.status == verified`,
  `finalGeneratedValidation`, packaging PDF/A-3). Sinon `NotDeliveredError.failed_checks`
  dit lesquels : un HTTP 200 seul ne prouve rien.
- Si le PDF arrive par URL signée (`result.pdfUrl`), il est téléchargé **sans** la clé API.

Autres appels : `fx.validate(path_or_bytes, validation_target="en16931")`,
`fx.extract(pdf)` (XML embarqué d'un PDF Factur-X), `fx.meta()`, `fx.integration_contract()`
(ces deux derniers sans clé). Exemples exécutés : `sdk/examples/`.

## Ligne de commande `facturx`

Installée avec le paquet. Sortie JSON sur une ligne ; `FACTURX_API_KEY` et `FACTURX_BASE_URL`
(ou `--api-key`, `--base-url`).

| Commande | Effet | Code de sortie |
|---|---|---|
| `facturx dry-run invoice.json` | simulation gratuite | 0 prêt, 1 non prêt |
| `facturx convert invoice.json --out DIR` | conversion finale, écrit `DIR/factur-x.pdf` et `.xml` | 0, ou 1 sans fichier vérifié |
| `facturx validate FICHIER [--target en16931]` | rapport de validation de l'API | 0 |

Codes communs : 2 argument ou fichier invalide, 3 erreur API (`code`, `api_message`,
`request_id` tels que l'API les envoie), 4 transport coupé (résultat inconnu : relancer avec
`--idempotency-key` égal à la clé affichée). Options `--target`, `--output`, `--idempotency-key`.

Exécution réelle contre staging (release `900685311ea7`, 06/11/2026 15:56Z, clé sandbox de test) :

```text
$ facturx dry-run invoice.json
{"ok": true, "command": "dry-run", "ready": true, "generation_readiness": {"status": "ready", "blockingInputCount": 0, "reason": "no_generation_blocking_inputs"}, "request_id": "f0bb01da-564c-49ec-b4f0-2371f578773e", "idempotency_key": "b4aa1cc0-e675-4ffa-8ae6-644b111754f5"}
$ facturx convert invoice.json --out out-cli
{"ok": true, "command": "convert", "target": {"requested": "en16931", "executed": "en16931", "status": "verified", "missing_inputs": [], "not_run_reason": null}, "target_profile": "EN16931", "files": {"xml": {"path": "out-cli/factur-x.xml", "bytes": 4584, "sha256": "f332975e12f8dac94c926d8832c6434daf3ae718e3b10fb8acb9758bc940e03c"}, "pdf": {"path": "out-cli/factur-x.pdf", "bytes": 20624, "sha256": "75fd1d5e30ecf539a54ffc639134a17105b3b97e04941079c530cf2bb87ecd80"}}, "request_id": "66739ba5-e3c8-457b-9343-a90a9e836900", "idempotency_key": "df90c5ce-6b58-420d-a46b-4f72224b19e2"}
$ facturx validate out-cli/factur-x.pdf --target en16931   # extrait du rapport
ok= True | valid= True | validationStatus= valid | profile= EN16931 | target.status= verified | errors= 0
$ FACTURX_API_KEY=invalid facturx dry-run invoice.json      # code de sortie 3
{"ok": false, "command": "dry-run", "error": {"type": "AuthenticationError", "message": "HTTP 401 invalid_api_key: The API key provided is invalid or revoked.", "status": 401, "code": "invalid_api_key", "request_id": "1c393ffb-981e-4bca-b148-57b8170a8240", "api_message": "The API key provided is invalid or revoked.", "idempotency_key": "42b47d9a-8ef4-4b22-90dd-17405957ffa2"}}
```

## Erreurs

| Exception | Quand |
|---|---|
| `AuthenticationError` | 401 / 403 |
| `QuotaExceededError` | 402 |
| `RateLimitError` | 429 |
| `InvalidRequestError` | 400 / 413 / 415 / 422 ; `issues` nomme les champs |
| `ConflictError` | 409 (idempotence, contexte) |
| `ServiceUnavailableError` / `ServerError` | 503 / autres 5xx |
| `ConversionPendingError` | 202 : traitement asynchrone, `job_id` |
| `NotDeliveredError` | 200 sans fichier final vérifié |
| `TransportError` | réseau coupé : **résultat inconnu** |

Toute `ApiError` porte `status`, `code` et `message` **tels que l'API les a envoyés**, plus
`request_id`, `issues`, `detail`, et `retryable` / `retry_after` seulement si le serveur les
a fournis (`None` sinon).

## Idempotence et reprise

Chaque appel `convert` / `dry_run` envoie un `Idempotency-Key` (UUID généré, ou le vôtre
via `idempotency_key=`). La clé est rendue sur le résultat **et** sur toute erreur. Pour
connaître l'issue d'une opération interrompue sans payer deux fois, renvoyez la même
requête avec la même clé : le corps envoyé est identique à l'octet près. Réutiliser une clé
avec une autre facture provoque `409 idempotency_conflict`.

**Le SDK ne relance jamais rien automatiquement.** La règle « un 5xx peut-il être renvoyé
tel quel » est en cours de fixation côté API (api#2111) ; tant qu'elle n'est pas publiée,
la décision reste à l'appelant.

## Ce qui est prouvé (06/11/2026)

- 24 tests hors réseau (`PYTHONPATH=src python -m unittest discover -s tests`), sockets interdits,
  dont 8 pour la CLI et le rejeu de la conversion staging réelle (`tests/cassettes/` : réponses réelles réduites aux champs lus, PDF omis, XML réel).
- Parcours réel contre staging (release `900685311ea7`), clé sandbox de test, facture
  `tests/fixtures/invoice.json`, même enchaînement que l’exemple « Utilisation », 06/11/2026 15:48Z :

```text
dry_run.ready = True | generationReadiness.status = ready | success = False | request_id = ea443cc8-30dd-4c17-b991-697d52f97646
convert: target = {"requested": "en16931", "executed": "en16931", "status": "verified", "missing_inputs": [], "not_run_reason": null} | profile = EN16931 | request_id = 2db8ddcb-8541-48e1-ae99-a1416221f6b3
pdf bytes = 20624 sha256 = dd9abd2cbab9679abdaf6e397fd0805032413a406bd757de23d009b4108f41f7 | starts b'%PDF-1.7'
xml bytes = 4584 sha256 = f332975e12f8dac94c926d8832c6434daf3ae718e3b10fb8acb9758bc940e03c
seconds command -> files = 21.426
```

  Le XML est identique, octet pour octet, à celui obtenu le 05/11 par `examples/first-file`
  pour la même facture. PDF/A-3 et EN16931 sont attestés par l'API, pas revérifiés localement.
- Sans clé : `meta()`, `integration_contract()` et une clé invalide ⇒ `AuthenticationError`
  401 `invalid_api_key` avec le message de l'API intact.
- `validate` : exécuté réellement via la CLI sur le PDF produit (voir « Ligne de commande »).
- `extract` : exécuté réellement, XML extrait identique au XML produit (`sdk/examples/extract-xml/run.txt`).
- `output="xml_cii"` : exécuté réellement pour EN16931 et EXTENDED (`sdk/examples/urn-par-profil/run.txt`).

**Pas encore prouvé avec ce SDK** : téléchargement par URL signée (`pdfUrl`), réponses 409/503
réelles (exercées hors ligne uniquement).
