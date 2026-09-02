from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIRST_PORT = 3000
LAST_PORT = 3010
MOEX_BRIDGE_PORT = 3021


def port_is_open(port: int) -> bool:
    for host in ("localhost", "127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            continue
    return False


def terminal_is_ready(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/", timeout=1.5) as response:
            html = response.read(80_000).decode("utf-8", errors="ignore")
        return response.status == 200 and "Northstar Trading Terminal" in html
    except (OSError, urllib.error.URLError):
        return False


def moex_bridge_is_ready() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{MOEX_BRIDGE_PORT}/health", timeout=1.5) as response:
            return response.status == 200 and "northstar-moex-history" in response.read(2_000).decode("utf-8", errors="ignore")
    except (OSError, urllib.error.URLError):
        return False


def choose_port() -> int | None:
    for port in range(FIRST_PORT, LAST_PORT + 1):
        if terminal_is_ready(port):
            return -port
    for port in range(FIRST_PORT, LAST_PORT + 1):
        if not port_is_open(port):
            return port
    return None


def bundled_paths() -> tuple[Path, Path]:
    base = Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies"
    return base / "node" / "bin" / "node.exe", base / "bin" / "fallback" / "pnpm.cmd"


def load_local_secrets(environment: dict[str, str]) -> None:
    secret_path = ROOT / ".dev.vars"
    if not secret_path.exists():
        return
    for raw_line in secret_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value:
            environment[key] = value


def open_terminal(url: str) -> None:
    if os.environ.get("TRADING_TERMINAL_NO_BROWSER") != "1":
        webbrowser.open(url)


def run_paper_evaluator(url: str, process: subprocess.Popen[bytes] | None, port: int) -> None:
    """Keep virtual entries and exits moving even when the browser tab is closed."""
    evaluation_url = f"{url.rstrip('/')}/api/paper-trades?evaluate=1"
    while process is None or process.poll() is None:
        try:
            request = urllib.request.Request(
                evaluation_url,
                headers={"User-Agent": "Northstar-Paper-Evaluator/1.0"},
            )
            with urllib.request.urlopen(request, timeout=55) as response:
                response.read(2_000)
        except (OSError, urllib.error.URLError, TimeoutError):
            pass
        for _ in range(60):
            if process is not None and process.poll() is not None:
                return
            if process is None and not terminal_is_ready(port):
                return
            time.sleep(1)


def automation_enabled(environment: dict[str, str]) -> bool:
    value = environment.get("NORTHSTAR_AUTOMATION_ENABLED", "1").strip().lower()
    return value not in {"0", "false", "off", "no"}


def start_automation_daemon(node: str, url: str, environment: dict[str, str]) -> subprocess.Popen[bytes] | None:
    if not automation_enabled(environment):
        return None
    log = (ROOT / "terminal_automation.log").open("a", encoding="utf-8")
    process = subprocess.Popen(
        [node, str(ROOT / "scripts" / "automation_daemon.mjs"), f"--base-url={url}"],
        cwd=ROOT,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    process._northstar_log = log  # type: ignore[attr-defined]
    return process


def stop_automation_daemon(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    stop_process_tree(process)
    log = getattr(process, "_northstar_log", None)
    if log is not None:
        log.close()


def stop_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        process.terminate()


def start_moex_bridge(node: str, environment: dict[str, str]) -> subprocess.Popen[bytes] | None:
    if moex_bridge_is_ready():
        return None
    bridge_environment = environment.copy()
    bridge_environment["NORTHSTAR_MOEX_BRIDGE_PORT"] = str(MOEX_BRIDGE_PORT)
    log_path = ROOT / "terminal_moex_bridge.log"
    log = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        [node, str(ROOT / "scripts" / "moex_history_bridge.mjs")],
        cwd=ROOT,
        env=bridge_environment,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    for _ in range(40):
        if moex_bridge_is_ready():
            return process
        if process.poll() is not None:
            return None
        time.sleep(0.1)
    stop_process_tree(process)
    return None


def main() -> int:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_snapshot.py")], cwd=ROOT, check=True)
    selected_port = choose_port()
    if selected_port is None:
        print(f"Все порты {FIRST_PORT}–{LAST_PORT} заняты. Закройте лишние локальные серверы и повторите запуск.")
        return 4
    bundled_node, bundled_pnpm = bundled_paths()
    node = shutil.which("node") or (str(bundled_node) if bundled_node.exists() else None)
    if not node:
        print("Не найден Node.js. Установите Node.js 22+ или запустите терминал через Codex.")
        return 2
    environment = os.environ.copy()
    load_local_secrets(environment)
    environment["PATH"] = str(Path(node).parent) + os.pathsep + environment.get("PATH", "")
    bridge_process = start_moex_bridge(node, environment)
    if selected_port < 0:
        active_port = abs(selected_port)
        url = f"http://localhost:{active_port}/"
        open_terminal(url)
        automation_process = start_automation_daemon(node, url, environment)
        print(f"Trading Terminal уже запущен: {url}")
        print("Фоновая проверка виртуальных сделок включена: раз в минуту, независимо от открытой страницы.")
        print("Автоматический поиск прогнозов включён: локальный сканер работает без открытой вкладки.")
        print("Для остановки фоновой проверки закройте это окно или нажмите Ctrl+C.")
        try:
            run_paper_evaluator(url, None, active_port)
        except KeyboardInterrupt:
            return 0
        finally:
            stop_automation_daemon(automation_process)
            if bridge_process is not None:
                stop_process_tree(bridge_process)
        return 0

    port = selected_port
    url = f"http://localhost:{port}/"

    pnpm = shutil.which("pnpm") or (str(bundled_pnpm) if bundled_pnpm.exists() else None)
    if not pnpm:
        if bridge_process is not None:
            stop_process_tree(bridge_process)
        print("Не найден Node.js/pnpm. Установите Node.js 22+ или запустите терминал через Codex.")
        return 2

    log_path = ROOT / "terminal_server.log"
    try:
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [pnpm, "exec", "vinext", "dev", "--hostname", "127.0.0.1", "--port", str(port)],
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            for _ in range(180):
                if terminal_is_ready(port):
                    threading.Thread(target=run_paper_evaluator, args=(url, process, port), daemon=True).start()
                    open_terminal(url)
                    automation_process = start_automation_daemon(node, url, environment)
                    print(f"Trading Terminal открыт: {url}")
                    print("Фоновая проверка виртуальных сделок включена: раз в минуту, независимо от открытой страницы.")
                    print("Автоматический поиск прогнозов включён: локальный сканер работает без открытой вкладки.")
                    print("Для остановки закройте это окно или нажмите Ctrl+C.")
                    try:
                        return process.wait()
                    except KeyboardInterrupt:
                        stop_process_tree(process)
                        return 0
                    finally:
                        stop_automation_daemon(automation_process)
                if process.poll() is not None:
                    print(f"Сервер не запустился. Подробности: {log_path}")
                    return process.returncode or 1
                time.sleep(0.25)
            stop_process_tree(process)
            print(f"Сервер не ответил за 45 секунд. Подробности: {log_path}")
            return 3
    finally:
        if bridge_process is not None:
            stop_process_tree(bridge_process)


if __name__ == "__main__":
    raise SystemExit(main())
