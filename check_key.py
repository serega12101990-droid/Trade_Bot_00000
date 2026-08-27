"""Прямая проверка ключей Bybit в среде, выбранной в CONFIG.
Запустите у себя:  .venv/Scripts/python check_key.py
Скрипт покажет точный retCode / retMsg от Bybit — без логики бота.

Ключи берутся только из локального файла .env.
"""
from pybit.unified_trading import HTTP

import trade_bot_macd as B

key = B.CONFIG["API_KEY"].strip()
secret = B.CONFIG["API_SECRET"].strip()

print(f"KEY len={len(key)}  SECRET len={len(secret)}")
if not key or not secret:
    print("КЛЮЧИ ПУСТЫ — заполните BYBIT_API_KEY и BYBIT_API_SECRET в локальном .env")
    raise SystemExit(1)

print(f"KEY ends with CR: {key.endswith(chr(13))}  ends with space: {key != key.rstrip()}")

try:
    demo_mode = bool(B.CONFIG.get("DEMO_MODE", True))
    print(f"Проверяем среду: {'DEMO' if demo_mode else 'MAINNET'}")
    s = HTTP(testnet=False, demo=demo_mode, api_key=key, api_secret=secret)
    r = s.get_wallet_balance(accountType="UNIFIED", coin="USDT")
    print("get_wallet_balance ->", r.get("retCode"), r.get("retMsg"))
    if r.get("retCode") == 0:
        print("OK: ключ валиден для выбранной среды")
    else:
        print("ОШИБКА Bybit:", r.get("retMsg"), "(retCode", r.get("retCode"), ")")
except Exception as e:
    msg = str(e)
    safe_msg = msg[:300].encode("ascii", errors="backslashreplace").decode("ascii")
    print("EXCEPTION:", safe_msg)
    if "401" in msg:
        print("-> 401: ключ отвергнут выбранной средой")
    elif "403" in msg:
        print("-> 403: IP/гео-блок. Проверьте VPN/прокси и доступность Bybit из вашей сети")
    elif "10003" in msg:
        print("-> 10003: сам ключ неверен/отозван. Пересоздайте и ВСТАВЬТЕ ЗАНОВО")
    elif "10005" in msg:
        print("-> 10005: нет права Trade у ключа (включите в кабинете)")
    raise SystemExit(2)
