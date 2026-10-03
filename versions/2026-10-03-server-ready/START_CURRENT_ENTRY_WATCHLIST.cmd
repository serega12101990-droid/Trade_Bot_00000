@echo off
chcp 65001 >nul
setlocal
set "PROJECT_DIR=%~dp0"
set "SCANNER=%PROJECT_DIR%trading_platform\run_current_entry_watchlist.py"

where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%SCANNER%" --refresh %*
    goto finished
)

where python >nul 2>nul
if not errorlevel 1 (
    python "%SCANNER%" --refresh %*
    goto finished
)

set "BUNDLED_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PY%" (
    "%BUNDLED_PY%" "%SCANNER%" --refresh %*
    goto finished
)

echo Python не найден. Установите Python 3.11+ или запускайте сканирование через Codex.

:finished
echo.
pause
endlocal
