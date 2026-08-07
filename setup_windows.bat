@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" goto :find_python

".venv\Scripts\python.exe" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 0 if not errorlevel 1 goto :install

echo The existing Zeus virtual environment uses Python older than 3.11.
echo Rename or remove the .venv folder, then run this file again.
pause
exit /b 1

:find_python
set "ZEUS_PYTHON="

rem Ask the launcher for its current Python 3 runtime. Do not request one
rem specific minor version: any installed Python 3.11 or newer is supported.
call :probe_python py -3
if defined ZEUS_PYTHON goto :python_found

call :probe_python python
if defined ZEUS_PYTHON goto :python_found

call :probe_python python3
if defined ZEUS_PYTHON goto :python_found

echo Python 3.11 or newer was not found.
echo Zeus accepts the py launcher, python command, or python3 command.
pause
exit /b 1

:python_found
echo Using compatible Python:
"%ZEUS_PYTHON%" --version
echo Creating the Zeus virtual environment...
"%ZEUS_PYTHON%" -m venv .venv
if errorlevel 0 if not errorlevel 1 goto :venv_created
goto :venv_failed

:venv_created
if exist ".venv\Scripts\python.exe" goto :install

:venv_failed
echo Could not create the Zeus virtual environment with:
echo "%ZEUS_PYTHON%"
pause
exit /b 1

:install
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 0 if not errorlevel 1 goto :install_zeus
goto :failed

:install_zeus
".venv\Scripts\python.exe" -m pip install -e ".[outlook]"
if errorlevel 0 if not errorlevel 1 goto :installed
goto :failed

:installed
echo.
echo Zeus 2.0.3 setup completed.
echo Run run_zeus.bat to start.
pause
exit /b 0

:failed
echo.
echo Zeus setup failed. Review the message above; no ticket data was changed.
pause
exit /b 1

:probe_python
set "ZEUS_CANDIDATE="
set "ZEUS_PROBE_FILE=%CD%\.zeus-python-%RANDOM%-%RANDOM%.tmp"
del /q "%ZEUS_PROBE_FILE%" >nul 2>nul

rem Success is exactly zero. The Python Install Manager may report a missing
rem runtime with an HRESULT that cmd.exe represents as a negative number;
rem `if not errorlevel 1` would incorrectly accept that failure.
%* -c "import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)" >"%ZEUS_PROBE_FILE%" 2>nul
if errorlevel 0 if not errorlevel 1 goto :probe_succeeded

del /q "%ZEUS_PROBE_FILE%" >nul 2>nul
exit /b 1

:probe_succeeded
set /p "ZEUS_CANDIDATE="<"%ZEUS_PROBE_FILE%"
del /q "%ZEUS_PROBE_FILE%" >nul 2>nul
if not defined ZEUS_CANDIDATE exit /b 1
if not exist "%ZEUS_CANDIDATE%" exit /b 1

set "ZEUS_PYTHON=%ZEUS_CANDIDATE%"
set "ZEUS_CANDIDATE="
exit /b 0
