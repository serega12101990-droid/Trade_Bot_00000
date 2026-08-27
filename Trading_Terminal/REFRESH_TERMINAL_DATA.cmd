@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "BUNDLED_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PY%" (
  "%BUNDLED_PY%" scripts\build_snapshot.py
) else (
  py scripts\build_snapshot.py
)

pause
