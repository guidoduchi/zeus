@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "ZEUS_PYTHONW=%CD%\.venv\Scripts\pythonw.exe"

if not exist "%ZEUS_PYTHONW%" (
  echo Zeus is not installed yet. Run setup_windows.bat first.
  pause
  exit /b 1
)

rem pythonw keeps the backend and system tray alive without a console window.
rem Zeus itself opens the local dashboard in the configured default browser.
start "" "%ZEUS_PYTHONW%" -m zeus2 serve %*
if errorlevel 1 (
  echo Zeus could not be started. Run run_zeus_console.bat for diagnostics.
  pause
  exit /b 1
)
exit /b 0
