from __future__ import annotations

import unittest
import tomllib
from pathlib import Path


SETUP_SCRIPT = Path(__file__).resolve().parents[1] / "setup_windows.bat"
RUN_SCRIPT = Path(__file__).resolve().parents[1] / "run_zeus.bat"
CONSOLE_RUNNER = Path(__file__).resolve().parents[1] / "run_zeus_console.bat"
STOP_SCRIPT = Path(__file__).resolve().parents[1] / "zeus_stop.bat"
WINDOWS_WORKFLOW = (
    Path(__file__).resolve().parents[1]
    / ".github"
    / "workflows"
    / "windows-compatibility.yml"
)
PROJECT_FILE = Path(__file__).resolve().parents[1] / "pyproject.toml"
VERSION_FILE = Path(__file__).resolve().parents[1] / "zeus2" / "version.py"
E2E_SERVER = Path(__file__).resolve().parent / "e2e_server.py"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


class WindowsInstallerRegressionTests(unittest.TestCase):
    def test_distributable_source_is_vendor_neutral(self) -> None:
        forbidden = (
            "hua" + "wei",
            "i" + "care",
            "la" + "spare",
            "itsa" + "net",
        )
        paths = [PROJECT_ROOT / "README.md", *sorted((PROJECT_ROOT / "docs").glob("*.md"))]
        paths.extend(sorted((PROJECT_ROOT / "zeus2").rglob("*.py")))
        paths.extend(
            path
            for path in sorted((PROJECT_ROOT / "frontend" / "src").rglob("*"))
            if path.suffix in {".css", ".ts", ".tsx"} and "test" not in path.parts
        )

        matches = []
        for path in paths:
            content = path.read_text(encoding="utf-8").lower()
            matches.extend(
                f"{path.relative_to(PROJECT_ROOT)}: {value}"
                for value in forbidden
                if value in content
            )
        self.assertEqual(matches, [])

    def test_negative_python_manager_exit_falls_through_to_compatible_python(self) -> None:
        """A missing ``py`` runtime must not be mistaken for probe success.

        The Windows Python Install Manager can return an HRESULT whose signed
        ``cmd.exe`` representation is negative.  ``if not errorlevel 1``
        accepts that value, so the installer used to select a runtime that did
        not exist and skipped the compatible ``python`` fallback.
        """

        manager_missing_runtime = -2147024894  # 0x80070002, signed by cmd.exe

        old_gate = not manager_missing_runtime >= 1
        exact_zero_gate = (
            manager_missing_runtime >= 0 and not manager_missing_runtime >= 1
        )
        self.assertTrue(old_gate, "the fixture must reproduce the old defect")
        self.assertFalse(exact_zero_gate)

        script = SETUP_SCRIPT.read_text(encoding="utf-8")

        success_gates = [
            line.strip().lower()
            for line in script.splitlines()
            if "if not errorlevel 1" in line.lower()
            and not line.lstrip().lower().startswith("rem ")
        ]
        self.assertTrue(success_gates)
        self.assertTrue(
            all(
                gate.startswith("if errorlevel 0 if not errorlevel 1")
                for gate in success_gates
            ),
            f"vulnerable success gate found: {success_gates}",
        )
        self.assertNotIn("py -3.11", script)
        self.assertLess(
            script.index("call :probe_python py -3"),
            script.index("call :probe_python python"),
        )
        self.assertIn("print(sys.executable)", script)
        self.assertIn('if not exist "%ZEUS_CANDIDATE%"', script)
        self.assertIn('"%ZEUS_PYTHON%" -m venv .venv', script)


class WindowsLauncherRegressionTests(unittest.TestCase):
    def test_default_launcher_uses_pythonw_and_local_web_server(self) -> None:
        """The default launch must not depend on a console or Node runtime."""

        script = RUN_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("pythonw.exe", script)
        self.assertIn("-m zeus2 serve", script)
        self.assertNotIn("wt.exe", script)
        self.assertNotIn("node", script.lower())

    def test_unexpected_exit_keeps_diagnostics_visible(self) -> None:
        """The detached terminal must remain useful when Zeus exits nonzero."""

        runner = CONSOLE_RUNNER.read_text(encoding="utf-8")
        self.assertIn("if \"%ZEUS_EXIT%\"==\"0\" exit /b 0", runner)
        self.assertIn("zeus.log", runner)
        self.assertIn("pause", runner.lower())

    def test_windows_ci_covers_both_supported_user_runtimes(self) -> None:
        workflow = WINDOWS_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("windows-latest", workflow)
        self.assertIn('"3.13"', workflow)
        self.assertIn('"3.14"', workflow)
        self.assertIn("python -m unittest discover -s tests -v", workflow)
        self.assertIn("npm ci", workflow)
        self.assertIn("npm run build", workflow)
        self.assertIn("npm run test", workflow)
        self.assertIn("npm run test:e2e", workflow)

    def test_windows_install_includes_iana_timezone_data(self) -> None:
        """Windows must supply the database used by ``zoneinfo`` itself."""

        project = tomllib.loads(PROJECT_FILE.read_text(encoding="utf-8"))
        dependencies = project["project"]["dependencies"]

        self.assertIn(
            "tzdata>=2025.2; platform_system == 'Windows'",
            dependencies,
        )

    def test_browser_fixture_is_independent_of_the_unit_test_modules(self) -> None:
        """Playwright starts this file directly from the frontend directory."""

        fixture = E2E_SERVER.read_text(encoding="utf-8")
        self.assertNotIn("from tests.", fixture)
        self.assertIn("sys.path.insert(0, str(PROJECT_ROOT))", fixture)

    def test_stop_launcher_delegates_to_the_verified_instance_registry(self) -> None:
        script = STOP_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("-m zeus2 stop", script)
        self.assertNotIn("taskkill", script.lower())
        self.assertNotIn("python.exe /f", script.lower())

    def test_release_version_is_3_1_10_everywhere(self) -> None:
        project = tomllib.loads(PROJECT_FILE.read_text(encoding="utf-8"))
        self.assertEqual(project["project"]["version"], "3.1.10")
        self.assertEqual(project["project"]["scripts"]["zeus"], "zeus2.main:main")
        self.assertIn('__version__ = "3.1.10"', VERSION_FILE.read_text(encoding="utf-8"))
        self.assertIn("Zeus 3.1.10", SETUP_SCRIPT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
