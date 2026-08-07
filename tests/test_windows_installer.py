from __future__ import annotations

import unittest
from pathlib import Path


SETUP_SCRIPT = Path(__file__).resolve().parents[1] / "setup_windows.bat"
RUN_SCRIPT = Path(__file__).resolve().parents[1] / "run_zeus.bat"


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
        self.assertIn('"%ZEUS_EXE%" %*', script)


if __name__ == "__main__":
    unittest.main()
