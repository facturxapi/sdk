# Exemples exécutés (SDK Python `facturx-api` et curl)

Chaque dossier contient le code à copier et `run.txt`, la sortie **réelle** de son exécution
contre staging (`https://api-staging.facturxapi.com`, release `900685311ea7`, 06/11/2026), avec
la commande et la date. La clé API vient de `$FACTURX_API_KEY` (clé sandbox de test, jamais
écrite dans ces fichiers). Prérequis : `pip install facturx-api` (wheel locale tant que le
paquet n'est pas publié), `curl` et `jq` pour les variantes shell.

| Dossier | Ce que l'exemple fait | Résultat réel (`run.txt`) |
|---|---|---|
| `quickstart/` | `first_file.py` : premier Factur-X en 12 lignes (simulation gratuite puis conversion) ; `quickstart.sh` : même parcours en curl | `ready: True`, `verified`, XML 4 584 o sha256 `f332975e…e03c` |
| `extract-xml/` | extraire le XML embarqué d'un PDF Factur-X (`extract_xml.py` SDK, `extract.sh` curl) | profil `EN16931`, 4 584 o, identique au XML produit |
| `pdf-to-pdfa3/` | partir du PDF que l'ERP produit déjà (`carrier.pdf`, PDF simple sans XML) et du JSON ERP pour obtenir un Factur-X PDF/A-3 | `verified EN16931 pdf_a3_compliant` |
| `urn-par-profil/` | identifiant de profil (BT-24) écrit par l'API pour chaque profil demandé, lu dans le XML produit | EN16931 et EXTENDED ; MINIMUM, BASIC_WL et BASIC refusés |

Ordre : `quickstart/` d'abord (il produit `out/factur-x.pdf`, lu par `extract-xml/`).

## Ce que les exécutions ont appris

- **Promesse conditionnelle (PDF → PDF/A-3)** : un fichier n'est rendu que si la simulation dit
  `ready` et si l'API atteste la cible et le packaging PDF/A-3 ; sinon le SDK lève
  `NotDeliveredError` et n'écrit rien. Ici le PDF de l'ERP sert de support visuel ; les valeurs
  de la facture viennent du JSON, pas d'une lecture du PDF.
- **URN par profil, testé** : avec un JSON ERP (`invoice_data`), l'API n'écrit que deux profils :

  | Profil demandé | URN écrit (BT-24) |
  |---|---|
  | `EN16931` | `urn:cen.eu:en16931:2017` |
  | `EXTENDED` | `urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended` |
  | `MINIMUM`, `BASIC_WL`, `BASIC` | refusé : `unsupported_output_profile_for_invoice_data` |

- **Débit sandbox limité** : enchaîner une dizaine d'appels en moins d'une minute a renvoyé
  `429 rate_limit_exceeded` (06/11, 16:11Z et 16:13Z). Le SDK ne relance rien ; l'exemple
  `urn-par-profil` attend le `retry_after` fourni par le serveur puis réessaie une seule fois,
  par choix explicite de l'appelant.
- **curl** : générez la clé d'idempotence avec un outil présent partout (`python3 -c "import
  uuid; print(uuid.uuid4())"`) ; `uuidgen` manque sur certaines images et laisse l'en-tête vide.

## Limites

PDF/A-3 et EN16931 sont attestés par l'API, pas revérifiés localement. Aucun envoi à une
plateforme agréée. Exemples Node non fournis ici (le SDK Node est dans `sdk/node/`).
