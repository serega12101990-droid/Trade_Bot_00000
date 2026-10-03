"""Проверяет ОДИН И ТОТ ЖЕ ключ против 3 сред Bybit.
Запуск:  .venv/Scripts/python check_env.py
Если какая-то среда вернёт retCode 0 -> в неё и нужно переключить бота.
"""
from dotenv import load_dotenv
import os, time, hmac, hashlib, requests
try:
    load_dotenv()
except Exception:
    pass
import trade_bot_macd as B

key = B.CONFIG["API_KEY"].strip()
secret = B.CONFIG["API_SECRET"].strip()
print(f"KEY len={len(key)}  SECRET len={len(secret)}")

def probe(host, demo, testnet):
    t = str(int(time.time()*1000))
    recv = "5000"
    param = "accountType=UNIFIED&coin=USDT"
    sign_str = t + key + recv + param
    sig = hmac.new(secret.encode(), sign_str.encode(), hashlib.sha256).hexdigest()
    hdr = {"X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": t,
           "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": sig,
           "Content-Type": "application/json"}
    url = f"https://{host}/v5/account/wallet-balance?{param}"
    try:
        r = requests.get(url, headers=hdr, timeout=12)
        body = r.text[:200]
        print(f"[{host}] HTTP {r.status_code} | {body}")
    except Exception as e:
        print(f"[{host}] EXC: {str(e)[:150]}")

print("\n--- MAINNET (api.bybit.com) ---")
probe("api.bybit.com", demo=False, testnet=False)
print("\n--- DEMO (api-demo.bybit.com) ---")
probe("api-demo.bybit.com", demo=True, testnet=False)
print("\n--- TESTNET (api-testnet.bybit.com) ---")
probe("api-testnet.bybit.com", demo=False, testnet=True)
