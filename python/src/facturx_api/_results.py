"""Result objects. ``raw`` always holds the full API response, unmodified."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class DryRunResult:
    """``POST /api/v1/convert?dry_run=true``: free check, no deliverable.

    ``ready`` reads ``generationReadiness.status == "ready"``. It is NOT
    ``success``: a dry run can report ``success=false`` and still allow the
    final generation (observed on the staging contract, 05/11/2026).
    """

    raw: dict[str, Any]
    idempotency_key: str

    @property
    def ready(self) -> bool:
        readiness = self.raw.get("generationReadiness") or {}
        return self.raw.get("dry_run") is True and readiness.get("status") == "ready"

    @property
    def generation_readiness(self) -> dict[str, Any]:
        return dict(self.raw.get("generationReadiness") or {})

    @property
    def request_id(self) -> str | None:
        return self.raw.get("request_id")


@dataclass(frozen=True)
class ConvertResult:
    """Verified final conversion (1 processed invoice on the quota).

    Only built when every documented success field is in its required state;
    otherwise :class:`~facturx_api.NotDeliveredError` is raised instead.
    """

    raw: dict[str, Any]
    idempotency_key: str
    xml: bytes
    pdf: bytes | None
    output: str
    headers: dict[str, str] = field(default_factory=dict, repr=False)

    @property
    def request_id(self) -> str | None:
        return self.raw.get("request_id") or self.headers.get("x-request-id")

    @property
    def target(self) -> dict[str, Any]:
        return dict(self.raw.get("target") or {})

    @property
    def target_profile(self) -> str | None:
        return (self.raw.get("result") or {}).get("targetProfile")

    @property
    def xml_sha256(self) -> str:
        return hashlib.sha256(self.xml).hexdigest()

    @property
    def pdf_sha256(self) -> str | None:
        return hashlib.sha256(self.pdf).hexdigest() if self.pdf is not None else None

    def save(self, directory: str | Path, stem: str = "factur-x") -> dict[str, Path]:
        """Write the deliverable(s) to ``directory`` and return their paths."""
        out = Path(directory)
        out.mkdir(parents=True, exist_ok=True)
        paths = {"xml": out / f"{stem}.xml"}
        paths["xml"].write_bytes(self.xml)
        if self.pdf is not None:
            paths["pdf"] = out / f"{stem}.pdf"
            paths["pdf"].write_bytes(self.pdf)
        return paths
