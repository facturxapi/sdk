# @facturxapi/sdk (Node.js)

Client Node.js de FacturX API : simulation gratuite (`dryRun`), conversion finale en
Factur-X PDF/A-3 (ou XML CII), validation d'un fichier existant. Aucune dépendance,
Node 18.17+, ESM, types inclus.

> Statut 0.1.0 : **non publié sur npm** (`"private": true` bloque toute publication
> accidentelle). Installation depuis l'archive construite localement. Parcours
> facture → fichiers exécuté contre staging le 06/11/2026 (voir « Ce qui est prouvé »).

## Installation (locale)

```bash
cd sdk/node && npm pack                  # produit facturxapi-sdk-0.1.0.tgz
npm install ./facturxapi-sdk-0.1.0.tgz
```

## Utilisation

```js
import { readFile } from "node:fs/promises";
import { FacturX } from "@facturxapi/sdk";

const fx = new FacturX({ apiKey: "…", baseUrl: "https://api-staging.facturxapi.com" });
const invoice = JSON.parse(await readFile("invoice.json", "utf8"));   // JSON ERP complet

const check = await fx.dryRun(invoice);          // gratuit, aucun livrable
if (check.ready) {                               // generationReadiness.status === "ready"
  const doc = await fx.convert(invoice);         // 1 facture traitée sur le quota
  console.log(await doc.save("out"));            // out/factur-x.pdf et out/factur-x.xml
}
```

Pas d'hôte par défaut : `baseUrl` (ou `FACTURX_BASE_URL`) est obligatoire ; `apiKey` peut
venir de `FACTURX_API_KEY`. Mêmes garanties que le SDK Python :

- `ready` lit `generationReadiness.status`, pas `success`.
- `convert` exige tous les champs de succès documentés ; sinon `NotDeliveredError.failedChecks`.
- Le PDF par URL signée est téléchargé **sans** la clé API ; les redirections ne sont pas suivies.

Autres appels : `fx.validate(pathOrBuffer, { validationTarget })`, `fx.meta()`,
`fx.integrationContract()`.

## Erreurs

`AuthenticationError` (401/403), `QuotaExceededError` (402), `RateLimitError` (429),
`InvalidRequestError` (400/413/415/422, `issues`), `ConflictError` (409),
`ServiceUnavailableError` / `ServerError` (5xx), `ConversionPendingError` (202, `jobId`),
`NotDeliveredError` (200 sans fichier vérifié), `TransportError` (résultat inconnu).

Toute `ApiError` porte `status`, `code` et `apiMessage` **tels que l'API les a envoyés**,
plus `requestId`, `issues`, `detail`, et `retryable` / `retryAfter` seulement si le serveur
les a fournis (`null` sinon). `error.message` est une ligne lisible qui les reprend.

## Idempotence et reprise

Chaque `convert` / `dryRun` envoie un `Idempotency-Key` (UUID, ou `idempotencyKey`),
rendu sur le résultat et sur toute erreur. Renvoyer la même requête avec la même clé
produit un corps identique à l'octet près (et identique à celui du SDK Python).
**Aucune relance automatique** : la règle de renvoi des 5xx est en cours de fixation côté
API (api#2111).

## Ce qui est prouvé (06/11/2026)

- 16 tests hors réseau (`npm test`), `fetch` interdit, dont le rejeu de la conversion staging
  réelle (`test/cassettes/` : réponses réelles réduites aux champs lus, PDF omis, XML réel).
- Parcours réel contre staging (release `900685311ea7`), clé sandbox de test, facture
  `test/fixtures/invoice.json`, même enchaînement que l’exemple « Utilisation », 06/11/2026 15:48Z :

```text
dryRun.ready = true | generationReadiness.status = ready | success = false | requestId = a752fdab-7db7-42fd-95ed-9c805f761c9e
convert: target = {"requested":"en16931","executed":"en16931","status":"verified","missing_inputs":[],"not_run_reason":null} | profile = EN16931 | requestId = ab2bc8c9-300d-42c5-a191-fd3beef1301d
pdf bytes = 20625 sha256 = 46210e491fcfca8952875a9afc39ceb1719f94ce15106db38392678fc18dddd1 | xml bytes = 4584 sha256 = f332975e12f8dac94c926d8832c6434daf3ae718e3b10fb8acb9758bc940e03c
seconds command -> files = 19.249
```

  XML identique, octet pour octet, à celui du SDK Python et de `examples/first-file` pour la
  même facture. PDF/A-3 et EN16931 sont attestés par l'API, pas revérifiés localement.
- Sans clé : `meta()` et une clé invalide ⇒ `AuthenticationError` 401 `invalid_api_key`.

**Pas encore prouvé avec ce SDK** : `xml_cii`, URL signée (`pdfUrl`), `validate`, réponses
409/503 réelles (hors ligne uniquement).
