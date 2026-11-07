#!/usr/bin/env sh
# Même parcours en curl : simulation gratuite puis conversion finale (1 facture).
set -eu
API=https://api.facturxapi.com/api/v1/convert
curl -sS "$API?dry_run=true" -H "X-API-Key: $FACTURX_API_KEY" \
  -F "invoice_data=<invoice.json" -F output=facturx_pdfa3 -F validation_target=en16931 \
  | jq '{dry_run, ready: (.generationReadiness.status == "ready")}'
KEY=$(python3 -c "import uuid; print(uuid.uuid4())")  # gardez-la pour relancer la même opération
echo "Idempotency-Key: $KEY"
curl -sS "$API" -H "X-API-Key: $FACTURX_API_KEY" -H "Idempotency-Key: $KEY" \
  -F "invoice_data=<invoice.json" -F output=facturx_pdfa3 -F validation_target=en16931 \
  -o response.json
jq '{success, target: .target.status, profile: .result.targetProfile}' response.json
jq -r .result.pdf response.json | base64 -d > factur-x.pdf
jq -r .result.xml response.json | base64 -d > factur-x.xml
