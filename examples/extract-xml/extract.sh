#!/usr/bin/env sh
# Même extraction en curl : le XML arrive en base64 dans .xml.
set -eu
curl -sS https://api-staging.facturxapi.com/api/v1/extract -H "X-API-Key: $FACTURX_API_KEY" \
  -F "file=@${1:-../quickstart/out/factur-x.pdf}" -o extract.json
jq '{profile, xmlSize}' extract.json
jq -r .xml extract.json | base64 -d > extracted-curl.xml
