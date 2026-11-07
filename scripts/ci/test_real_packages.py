"""The REAL packages of this repository pass the REAL publication preflights (no network, no publication)."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
PYPI = yaml.safe_load((ROOT / ".github/workflows/publish-pypi.yml").read_text())


def _pypi_preflight() -> str:
    run = next(s["run"] for s in PYPI["jobs"]["build"]["steps"] if s.get("name", "").startswith("Locate the package"))
    return textwrap.dedent(re.search(r"python3 - \"\$DIR\" \"\$PACKAGE\" \"\$VERSION\" <<'PY'\n(.*?)\nPY\n", run, re.S).group(1))


@pytest.mark.parametrize(("directory", "name"), [("python", "facturx-api"), ("mcp", "facturx-mcp")])
def test_pypi_packages_pass_their_preflight(tmp_path, directory, name):
    version = re.search(r'^version = "([^"]+)"', (ROOT / directory / "pyproject.toml").read_text(), re.M).group(1)
    script = tmp_path / "pre.py"
    script.write_text(_pypi_preflight())
    run = subprocess.run([sys.executable, str(script), directory, name, version], cwd=ROOT, capture_output=True, text=True)
    assert run.returncode == 0 and f"PREFLIGHT_OK {name}=={version}" in run.stdout, (run.stdout, run.stderr)


def test_node_package_passes_the_npm_preflight():
    pkg = json.loads((ROOT / "node/package.json").read_text())
    run = subprocess.run(
        ["node", "scripts/ci/npm_publish_preflight.mjs", "node", pkg["name"], pkg["version"]],
        cwd=ROOT, capture_output=True, text=True, env={"GITHUB_REPOSITORY": "facturxapi/sdk", "PATH": __import__("os").environ["PATH"]},
    )
    assert run.returncode == 0 and "PREFLIGHT_OK @facturxapi/sdk@" in run.stdout, (run.stdout, run.stderr)


def test_the_mcp_registry_marker_matches_server_json():
    server = json.loads((ROOT / "mcp/server.json").read_text())
    assert server["name"] == "com.facturxapi/mcp"
    assert f"mcp-name: {server['name']}" in (ROOT / "mcp/README.md").read_text()
    assert server["repository"]["url"] == "https://github.com/facturxapi/sdk" and server["repository"]["subfolder"] == "mcp"
    assert server["packages"][0]["identifier"] == "facturx-mcp"
    assert server["version"] == re.search(r'^version = "([^"]+)"', (ROOT / "mcp/pyproject.toml").read_text(), re.M).group(1)
