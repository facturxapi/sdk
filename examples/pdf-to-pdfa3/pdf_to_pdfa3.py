"""PDF existant de l'ERP + JSON ERP  ->  Factur-X PDF/A-3 (XML EN16931 embarqué).

Promesse conditionnelle : le fichier n'est rendu que si la simulation dit ready ET si l'API
atteste la cible et le packaging PDF/A-3 ; sinon le SDK lève NotDeliveredError et n'écrit rien.
"""

import json

from facturx_api import FacturX, NotDeliveredError

fx = FacturX(base_url="https://api-staging.facturxapi.com")  # clé : $FACTURX_API_KEY
invoice = json.load(open("../quickstart/invoice.json"))

check = fx.dry_run(invoice, file="carrier.pdf")
print("ready:", check.ready, check.generation_readiness)
if check.ready:
    try:
        doc = fx.convert(invoice, file="carrier.pdf")
    except NotDeliveredError as exc:
        print("pas de fichier vérifié :", exc.failed_checks)
    else:
        packaging = doc.raw["finalGeneratedValidation"]["validationReadiness"]["packaging"]
        print(doc.target["status"], doc.target_profile, packaging["reason"], doc.save("out"))
