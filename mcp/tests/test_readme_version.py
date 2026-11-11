"""The README, the package metadata, the server and the registry entry announce the same version."""

import json
import re
import unittest
from pathlib import Path

from facturx_mcp.server import __version__

ROOT = Path(__file__).resolve().parents[1]


class VersionConsistencyTests(unittest.TestCase):
    def test_readme_announces_the_package_version(self):
        pyproject = (ROOT / "pyproject.toml").read_text()
        version = re.search(r'^version = "([^"]+)"', pyproject, re.M).group(1)
        readme = (ROOT / "README.md").read_text()
        announced = re.findall(r"^Version (\d+\.\d+\.\d+) on PyPI", readme, re.M)
        self.assertEqual(announced, [version])
        self.assertEqual(__version__, version)
        self.assertIn(f"facturx-mcp=={version}", (ROOT / "Dockerfile").read_text())
        server = json.loads((ROOT / "server.json").read_text())
        self.assertEqual(server["version"], version)
        self.assertEqual([p["version"] for p in server["packages"]], [version])

    def test_readme_keeps_the_registry_name_and_no_internal_reference(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("mcp-name: com.facturxapi/mcp", readme)
        self.assertIsNone(re.search(r"\b(api|web)#\d+|\bol_\d|\bart_\d", readme))


if __name__ == "__main__":
    unittest.main()
