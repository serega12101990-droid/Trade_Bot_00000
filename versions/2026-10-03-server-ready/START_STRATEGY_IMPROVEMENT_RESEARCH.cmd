@echo off
chcp 65001 >nul
setlocal
set "PROJECT_DIR=%~dp0"
set "RESEARCH=%PROJECT_DIR%trading_platform\run_strategy_improvement_research.py"

where py >nul 2>nul
if not errorlevel 1 (py -3 "%RESEARCH%" %* & goto finished)
where python >nul 2>nul
if not errorlevel 1 (python "%RESEARCH%" %* & goto finished)
set "BUNDLED_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PY%" ("%BUNDLED_PY%" "%RESEARCH%" %* & goto finished)
echo Python не найден. Установите Python 3.11+ или запускайте исследование через Codex.

:finished
echo.
pause
endlocal
