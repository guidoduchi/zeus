@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "ZEUS_PYTHON=%CD%\.venv\Scripts\python.exe"

if not exist "%ZEUS_PYTHON%" (
  echo Zeus is not installed yet. Run setup_windows.bat first.
  pause
  exit /b 1
)

"%ZEUS_PYTHON%" -m zeus2 serve --console --no-tray %*
set "ZEUS_EXIT=%ERRORLEVEL%"

if "%ZEUS_EXIT%"=="0" exit /b 0
if "%ZEUS_EXIT%"=="130" exit /b 130

echo.
echo Zeus stopped unexpectedly with exit code %ZEUS_EXIT%.
if defined LOCALAPPDATA echo Diagnostic log: "%LOCALAPPDATA%\Zeus\logs\zeus.log"
echo This window will remain open so the error can be inspected.
pause
exit /b %ZEUS_EXIT%
