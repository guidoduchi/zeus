@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Run setup_windows.bat first.
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -m pip install -e ".[build,outlook]"
if errorlevel 1 goto :failed
".venv\Scripts\pyinstaller.exe" --noconfirm --clean zeus2.spec
if errorlevel 1 goto :failed

echo.
echo Build complete: dist\zeus.exe
pause
exit /b 0

:failed
echo.
echo Build failed. Review the message above.
pause
exit /b 1

