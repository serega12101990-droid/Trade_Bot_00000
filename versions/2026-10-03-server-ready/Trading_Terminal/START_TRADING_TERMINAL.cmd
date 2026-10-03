@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "BUNDLED_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PY%" (
  "%BUNDLED_PY%" scripts\start_terminal.py
) else (
  py scripts\start_terminal.py
)

if errorlevel 1 pause
