import json

from facturx_api import FacturX

fx = FacturX(base_url="https://api.facturxapi.com")  # clé : $FACTURX_API_KEY
invoice = json.load(open("invoice.json"))  # JSON ERP complet

check = fx.dry_run(invoice)  # gratuit, aucun fichier
print("ready:", check.ready)
if check.ready:
    doc = fx.convert(invoice)  # 1 facture traitée sur le quota
    print(doc.target["status"], doc.save("out"))
