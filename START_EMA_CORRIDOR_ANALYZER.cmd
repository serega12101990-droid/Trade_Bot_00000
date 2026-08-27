@echo off
chcp 65001 >nul
setlocal
set "PROJECT_DIR=%~dp0"
set "ANALYZER=%PROJECT_DIR%trading_platform\run_ema_corridor.py"

where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%ANALYZER%" %*
    goto finished
)

where python >nul 2>nul
if not errorlevel 1 (
    python "%ANALYZER%" %*
    goto finished
)

set "BUNDLED_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PY%" (
    "%BUNDLED_PY%" "%ANALYZER%" %*
    goto finished
)

echo Python не найден. Установите Python 3.11+ или запускайте анализатор через Codex.

:finished
echo.
pause
endlocal

