@echo off
setlocal
cd /d "%~dp0"
set "ZEUS_ROOT=%CD%"
set "ZEUS_EXE=%ZEUS_ROOT%\.venv\Scripts\zeus.exe"
set "ZEUS_RUNNER=run_zeus_console.bat"

if not exist "%ZEUS_EXE%" (
  echo Zeus is not installed yet. Run setup_windows.bat first.
  pause
  exit /b 1
)

where wt.exe >nul 2>nul
if errorlevel 1 goto classic_console

rem ZEUS_ROOT deliberately has no trailing backslash. A quoted %%~dp0 would
rem escape its closing quote in wt.exe's argument parser and corrupt the
rem title, options, and executable into one invalid command line.
start "" wt.exe --window new --fullscreen new-tab --startingDirectory "%ZEUS_ROOT%" --title "Zeus 2.0.3" --suppressApplicationTitle cmd.exe /d /c call "%ZEUS_RUNNER%" %*
exit /b 0

:classic_console
rem Windows Terminal is unavailable: use a maximized classic console window.
start "Zeus 2.0.3" /max cmd.exe /d /c call "%ZEUS_ROOT%\%ZEUS_RUNNER%" %*
