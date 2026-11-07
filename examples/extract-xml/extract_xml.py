"""Extraire le XML embarqué d'un PDF Factur-X (ici celui produit par quickstart/)."""

import base64
import sys

from facturx_api import FacturX

fx = FacturX(base_url="https://api-staging.facturxapi.com")  # clé : $FACTURX_API_KEY
result = fx.extract(sys.argv[1] if len(sys.argv) > 1 else "../quickstart/out/factur-x.pdf")
xml = base64.b64decode(result["xml"])
open("extracted.xml", "wb").write(xml)
print("profile:", result.get("profile"), "| xmlSize:", result.get("xmlSize"), "| bytes:", len(xml))
