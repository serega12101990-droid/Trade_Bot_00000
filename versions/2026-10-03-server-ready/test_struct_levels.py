"""Тест СТРУКТУРНЫХ уровней TP/SL (вариант 2) на реальных OKX-данных.
Проверяем: TP = ближайший локальный экстремум ТФ сигнала (достижимый),
а не "ближайшая EMA" (часто слишком далеко). Запуск: .venv/Scripts/python test_struct_levels.py
"""
import trade_bot_macd as B
import datetime

def fetch_okx(symbol, interval_min, limit=300):
    bar = B._OKX_BAR.get(interval_min)
    if not bar: return []
    import requests
    inst = f"{symbol[:-4]}-USDT-SWAP"
    url = f"https://www.okx.com/api/v5/market/candles?instId={inst}&bar={bar}&limit={limit+1}"
    r = requests.get(url, timeout=15).json()['data']
    r = sorted(r, key=lambda x: int(x[0]))
    out = [[x[0], x[1], x[2], x[3], x[4], x[5]] for x in r]
    return out[:-1] if len(out) > 1 else out

def test_struct(symbol, tf):
    rows = fetch_okx(symbol, tf, 250)
    if not rows:
        print(f"  {symbol} {tf}m: нет данных"); return
    # заполним histories[tf][symbol]
    B.histories.setdefault(tf, {})
    B.histories[tf][symbol] = {
        'open':[float(r[1]) for r in rows], 'high':[float(r[2]) for r in rows],
        'low':[float(r[3]) for r in rows], 'close':[float(r[4]) for r in rows],
        'volume':[float(r[5]) for r in rows],
    }
    price = float(rows[-1][4])
    for direction in ("BUY","SELL"):
        tp, sl = B.calc_struct_levels(symbol, tf, price, direction, B.CONFIG["STRUCT_LOOKBACK"], B.CONFIG["SL_ATR_MULTIPLIER"])
        if tp is None or sl is None:
            print(f"  {symbol} {tf}m {direction}: tp/sl=None (fallback EMA)"); continue
        if direction=="BUY":
            tp_dist=(tp-price)/price*100; sl_dist=(price-sl)/price*100
        else:
            tp_dist=(price-tp)/price*100; sl_dist=(sl-price)/price*100
        assert tp_dist > 0 and sl_dist > 0, (
            f"{symbol} {tf}m {direction}: уровни стоят с неверной стороны"
        )
        assert tp_dist / sl_dist + 1e-9 >= B.CONFIG["MIN_RISK_REWARD_RATIO"], (
            f"{symbol} {tf}m {direction}: RR ниже минимального"
        )
        print(f"  {symbol} {tf}m {direction}: цена={price:.4f} TP={tp:.4f}(+{tp_dist:.2f}%) SL={sl:.4f}(-{sl_dist:.2f}%) RR={tp_dist/sl_dist:.2f}")

if __name__ == "__main__":
    print("СТРУКТУРНЫЕ уровни (Max/Min свечей ТФ сигнала):")
    for sym in ("NEARUSDT","BTCUSDT","ETHUSDT","SOLUSDT"):
        test_struct(sym, 240)   # 4h
        test_struct(sym, 15)    # 15m
    print("\nЕсли TP_DIST на 4h ~1-3%, а на 15m ~0.3-1% -> достижимо. Если >5% -> фильтр отсечёт.")
