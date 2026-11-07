"""Écrit carrier.pdf : la facture « visuelle » qu'un ERP produit déjà (PDF simple, pas PDF/A).

Bibliothèque standard uniquement ; reprend les valeurs de ../quickstart/invoice.json.
"""

import json

inv = json.load(open("../quickstart/invoice.json"))
lines = [
    f"FACTURE {inv['invoice_number']} du {inv['issue_date']}",
    f"Vendeur : {inv['seller']['name']} - TVA {inv['seller']['vat_id']}",
    f"Client : {inv['buyer']['name']}",
    f"{inv['line_items'][0]['description']} : {inv['totals']['net']} EUR HT",
    f"TVA 20 % : {inv['totals']['tax']} EUR - Total TTC : {inv['totals']['gross']} EUR",
]
text = "BT /F1 11 Tf 50 780 Td 16 TL " + " ".join(f"({s}) Tj T*" for s in lines) + " ET"
objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    f"<< /Length {len(text)} >>\nstream\n{text}\nendstream",
]
out, offsets = b"%PDF-1.4\n", []
for i, obj in enumerate(objs, 1):
    offsets.append(len(out))
    out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
xref = len(out)
out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
open("carrier.pdf", "wb").write(out)
print("carrier.pdf:", len(out), "bytes, PDF simple (non PDF/A, sans XML)")
