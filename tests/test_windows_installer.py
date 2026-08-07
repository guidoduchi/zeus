from __future__ import annotations

import unittest
import tomllib
from pathlib import Path


SETUP_SCRIPT = Path(__file__).resolve().parents[1] / "setup_windows.bat"
RUN_SCRIPT = Path(__file__).resolve().parents[1] / "run_zeus.bat"
CONSOLE_RUNNER = Path(__file__).resolve().parents[1] / "run_zeus_console.bat"
WINDOWS_WORKFLOW = (
    Path(__file__).resolve().parents[1]
    / ".github"
    / "workflows"
    / "windows-compatibility.yml"
)
PROJECT_FILE = Path(__file__).resolve().parents[1] / "pyproject.toml"
VERSION_FILE = Path(__file__).resolve().parents[1] / "zeus2" / "version.py"


class WindowsInstallerRegressionTests(unittest.TestCase):
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
    def test_terminal_starting_directory_cannot_end_with_a_quoted_backslash(self) -> None:
        """Keep ``%~dp0`` from corrupting Windows Terminal's arguments."""

        script = RUN_SCRIPT.read_text(encoding="utf-8")

        self.assertNotIn('-d "%~dp0"', script)
        self.assertNotIn('--startingDirectory "%~dp0"', script)
        self.assertIn('set "ZEUS_ROOT=%CD%"', script)
        self.assertIn(
            'set "ZEUS_EXE=%ZEUS_ROOT%\\.venv\\Scripts\\zeus.exe"',
            script,
        )
        self.assertIn('--startingDirectory "%ZEUS_ROOT%"', script)
        self.assertIn("run_zeus_console.bat", script)

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

    def test_release_version_is_2_0_3_everywhere(self) -> None:
        project = tomllib.loads(PROJECT_FILE.read_text(encoding="utf-8"))
        self.assertEqual(project["project"]["version"], "2.0.3")
        self.assertIn('__version__ = "2.0.3"', VERSION_FILE.read_text(encoding="utf-8"))
        self.assertIn("Zeus 2.0.3", RUN_SCRIPT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
