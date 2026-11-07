"""Quel identifiant de profil (BT-24, GuidelineSpecifiedDocumentContextParameter/ID) l'API
écrit-elle pour chaque profil demandé ? Conversion xml_cii réelle par profil, URN lu dans le XML.

Chaque conversion consomme 1 facture du quota. Le compte sandbox est limité en débit : sur un
429, l'exemple attend le délai donné par le serveur (retry_after) et réessaie UNE fois. C'est un
choix de l'appelant ; le SDK, lui, ne relance jamais rien.
"""

import json
import time
import xml.etree.ElementTree as ET

from facturx_api import ApiError, FacturX, NotDeliveredError, RateLimitError

NS = {
    "rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
    "ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
}
fx = FacturX(base_url="https://api.facturxapi.com")  # clé : $FACTURX_API_KEY
invoice = json.load(open("../quickstart/invoice.json"))

for profile in ["MINIMUM", "BASIC_WL", "BASIC", "EN16931", "EXTENDED"]:
    try:
        try:
            doc = fx.convert(invoice, output="xml_cii", options={"output_profile": profile})
        except RateLimitError as exc:
            print(f"{profile:9} -> 429, attente {exc.retry_after}s demandée par le serveur")
            time.sleep(exc.retry_after or 30)
            doc = fx.convert(invoice, output="xml_cii", options={"output_profile": profile})
    except (ApiError, NotDeliveredError) as exc:
        print(f"{profile:9} -> refusé : {getattr(exc, 'code', None) or exc}")
        continue
    urn = (
        ET.fromstring(doc.xml)
        .find(
            "rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID", NS
        )
        .text
    )
    print(f"{profile:9} -> targetProfile={doc.target_profile:9} URN={urn}")
