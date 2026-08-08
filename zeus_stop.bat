@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "ZEUS_PYTHON=%CD%\.venv\Scripts\python.exe"

if not exist "%ZEUS_PYTHON%" (
  echo Zeus is not installed yet. Run setup_windows.bat first.
  pause
  exit /b 1
)

rem The registry contains only Zeus-owned PIDs plus creation markers and
rem control tokens. Unrelated Python and browser processes are never targeted.
"%ZEUS_PYTHON%" -m zeus2 stop
set "ZEUS_EXIT=%ERRORLEVEL%"
if "%ZEUS_EXIT%"=="0" exit /b 0

echo.
echo One or more registered Zeus instances could not be stopped safely.
if defined LOCALAPPDATA echo Diagnostic log: "%LOCALAPPDATA%\Zeus\logs\zeus.log"
pause
exit /b %ZEUS_EXIT%
