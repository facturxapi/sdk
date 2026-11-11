# Minimal image of the published facturx-mcp server, started on stdio.
# Build: docker build -t facturx-mcp mcp
# Run:   docker run -i --rm -e FACTURX_API_KEY facturx-mcp
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir facturx-mcp==0.1.2 \
    && useradd --create-home --uid 10001 mcp
USER mcp
WORKDIR /home/mcp

ENTRYPOINT ["facturx-mcp"]
