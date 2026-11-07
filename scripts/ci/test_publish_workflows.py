"""Structural guarantees of the two manual publication workflows (npm and PyPI trusted publishing): no token, manual only, hosted runner,
pinned actions, OIDC only on the job that publishes, a human-approved environment, and a staging step instead of a direct npm publish."""
from __future__ import annotations

import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
NPM = ROOT / ".github" / "workflows" / "publish-npm.yml"
PYPI = ROOT / ".github" / "workflows" / "publish-pypi.yml"
BOTH = [NPM, PYPI]
SHA = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
TOKEN_WORDS = re.compile(r"NODE_AUTH_TOKEN|NPM_TOKEN|PYPI_TOKEN|PYPI_API_TOKEN|TWINE_PASSWORD|_authToken|secrets\.", re.I)


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def triggers(doc: dict) -> dict:
    return doc.get("on") or doc.get(True)


def code_lines(path: Path) -> list[str]:
    return [line for line in path.read_text().splitlines() if not line.lstrip().startswith("#")]


@pytest.mark.parametrize("path", BOTH, ids=lambda p: p.name)
def test_manual_only(path):
    assert list(triggers(load(path))) == ["workflow_dispatch"]


@pytest.mark.parametrize("path", BOTH, ids=lambda p: p.name)
def test_no_token_anywhere(path):
    body = "\n".join(code_lines(path))
    assert not TOKEN_WORDS.search(body), TOKEN_WORDS.search(body)


@pytest.mark.parametrize("path", BOTH, ids=lambda p: p.name)
def test_top_level_permissions_are_read_only_and_oidc_only_on_the_publishing_job(path):
    doc = load(path)
    assert doc["permissions"] == {"contents": "read"}
    publishing = {"publish-npm.yml": "stage", "publish-pypi.yml": "publish"}[path.name]
    for name, job in doc["jobs"].items():
        perms = job.get("permissions", {})
        if name == publishing:
            assert perms == {"contents": "read", "id-token": "write"}
            assert job.get("environment") in {"npm-publish", "pypi-publish"}
        else:
            assert "id-token" not in perms and "environment" not in job, name


@pytest.mark.parametrize("path", BOTH, ids=lambda p: p.name)
def test_every_action_is_pinned_to_a_full_commit(path):
    uses = [step["uses"] for job in load(path)["jobs"].values() for step in job["steps"] if "uses" in step]
    assert uses
    assert all(SHA.match(u) for u in uses), uses


@pytest.mark.parametrize("path", BOTH, ids=lambda p: p.name)
def test_github_hosted_runner_only_and_no_repo_runner_variables(path):
    text = path.read_text()
    for job in load(path)["jobs"].values():
        assert job["runs-on"] == "ubuntu-24.04"  # npm trusted publishing does not support self-hosted runners
    assert "LIGHT_CI_RUNNER_LABELS" not in text and "merge_group" not in text and "self-hosted" not in "\n".join(code_lines(path))


@pytest.mark.parametrize("path", BOTH, ids=lambda p: p.name)
def test_only_main_or_staging_may_publish(path):
    first = load(path)["jobs"][{"publish-npm.yml": "verify", "publish-pypi.yml": "build"}[path.name]]["steps"][0]
    assert first["if"] == "${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/staging' }}"
    assert "exit 1" in first["run"]


def test_npm_default_is_a_dry_run_and_the_publish_step_is_a_staged_one():
    doc = load(NPM)
    inputs = triggers(doc)["workflow_dispatch"]["inputs"]
    assert inputs["mode"]["default"] == "dry-run" and inputs["mode"]["options"] == ["dry-run", "stage"]
    stage = doc["jobs"]["stage"]
    assert stage["needs"] == "verify" and stage["if"] == "${{ inputs.mode == 'stage' }}"
    commands = " ".join(step.get("run", "") for step in stage["steps"])
    assert "npm stage publish" in commands
    assert not re.search(r"\bnpm publish\b", "\n".join(code_lines(NPM)))  # a direct publish is never issued: the trusted publisher only allows staging
    assert "--registry" in commands and "npm_publish_preflight.mjs" in commands
    verify_cmds = [step.get("run", "") for step in doc["jobs"]["verify"]["steps"] if "npm_publish_preflight.mjs" in step.get("run", "")]
    assert len(verify_cmds) == 1 and "--registry" in verify_cmds[0]  # the dry-run also refuses a version already on the registry
    assert (ROOT / "scripts/ci/npm_publish_preflight.mjs").is_file()


def test_npm_requires_the_npm_and_node_versions_trusted_publishing_needs():
    text = NPM.read_text()
    assert 'npm@^11.15.0' in text and "Node >= 22.14 required" in text
    assert 'registry-url: "https://registry.npmjs.org"' in text


def test_pypi_default_is_a_build_and_publish_waits_for_the_environment():
    doc = load(PYPI)
    inputs = triggers(doc)["workflow_dispatch"]["inputs"]
    assert inputs["mode"]["default"] == "build" and inputs["package"]["options"] == ["facturx-api", "facturx-mcp"]
    publish = doc["jobs"]["publish"]
    assert publish["needs"] == "build" and publish["if"] == "${{ inputs.mode == 'publish' }}"
    assert any(step.get("uses", "").startswith("pypa/gh-action-pypi-publish@") for step in publish["steps"])
    assert all("password" not in (step.get("with") or {}) for step in publish["steps"])


def _pypi_preflight_script() -> str:
    run = next(s["run"] for s in load(PYPI)["jobs"]["build"]["steps"] if s.get("name", "").startswith("Locate the package"))
    match = re.search(r"python3 - \"\$DIR\" \"\$PACKAGE\" \"\$VERSION\" <<'PY'\n(.*?)\nPY\n", run, re.S)
    assert match, "pyproject preflight heredoc not found"
    return textwrap.dedent(match.group(1))


@pytest.mark.parametrize(
    "toml,args,expected",
    [
        ('name = "facturx-api"\nversion = "0.1.0"\nlicense = "MIT"\n', ["facturx-api", "0.1.0"], "PREFLIGHT_OK facturx-api==0.1.0"),
        ('name = "facturx-api"\nversion = "0.1.0"\n', ["facturx-api", "0.1.0"], "PREFLIGHT_REFUSED: pyproject has no license"),
        ('name = "facturx-api"\nversion = "0.1.0"\nlicense = {text = "TO-BE-DECIDED-BY-FOUNDER"}\n', ["facturx-api", "0.1.0"], "PREFLIGHT_REFUSED: pyproject license is a placeholder"),
        ('name = "facturx-api"\nversion = "0.1.0"\nlicense = "MIT"\n', ["facturx-api", "0.1.1"], "PREFLIGHT_REFUSED: pyproject version '0.1.0' is not the requested '0.1.1'"),
        ('name = "facturx-mcp"\nversion = "0.1.0"\nlicense = "MIT"\n', ["facturx-api", "0.1.0"], "PREFLIGHT_REFUSED: project name 'facturx-mcp' is not 'facturx-api'"),
        ('name = "facturx-api"\nversion = "0.1.0"\nlicense = "MIT"\n', ["facturx-api", "latest"], "PREFLIGHT_REFUSED: 'latest' is not a PEP 440 release"),
    ],
)
def test_pypi_pyproject_preflight_runs_and_refuses(tmp_path, toml, args, expected):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "pyproject.toml").write_text("[project]\n" + toml)
    script = tmp_path / "pre.py"
    script.write_text(_pypi_preflight_script())
    run = subprocess.run([sys.executable, str(script), "pkg", *args], cwd=tmp_path, capture_output=True, text=True)
    assert expected in run.stdout, (run.stdout, run.stderr)
    assert (run.returncode == 0) == expected.startswith("PREFLIGHT_OK")
