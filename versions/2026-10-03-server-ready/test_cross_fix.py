"""Тест детекта MACD-креста на РЕАЛЬНЫХ свечах OKX.
Проверяем, что analyze_timeframe НЕ выдаёт ложный крест там, где его нет,
и выдаёт там, где есть. Запуск: .venv/Scripts/python test_cross_fix.py
"""
import trade_bot_macd as B
import datetime

def fetch_okx(symbol, interval_min, limit=300):
    bar = B._OKX_BAR.get(interval_min)
    if not bar:
        return []
    import requests
    inst = f"{symbol[:-4]}-USDT-SWAP"
    url = f"https://www.okx.com/api/v5/market/candles?instId={inst}&bar={bar}&limit={limit+1}"
    r = requests.get(url, timeout=15).json()['data']
    r = sorted(r, key=lambda x: int(x[0]))
    out = [[x[0], x[1], x[2], x[3], x[4], x[5]] for x in r]
    return out[:-1] if len(out) > 1 else out

def scan(symbol, tf):
    rows = fetch_okx(symbol, tf, 300)
    if not rows:
        print(f"  {symbol} {tf}m: нет данных OKX")
        return
    # восстановим histories[tf][symbol] для analyze_timeframe
    B.histories.setdefault(tf, {})
    B.histories[tf][symbol] = {
        'open': [float(r[1]) for r in rows],
        'high': [float(r[2]) for r in rows],
        'low':  [float(r[3]) for r in rows],
        'close':[float(r[4]) for r in rows],
        'volume':[float(r[5]) for r in rows],
    }
    # сканируем по последним 60 свечам: детектим крест через analyze_timeframe
    # (функция смотрит на последнюю свечу массива, поэтому рубим хвост и двигаем окно)
    crosses = []
    closes = B.histories[tf][symbol]['close']
    for end in range(30, len(closes)+1):
        for k in ('open','high','low','close','volume'):
            B.histories[tf][symbol][k] = [float(r[i]) for i,r in enumerate(rows[:end]) for _ in []]
        # проще: временно обрежем весь массив до end
        B.histories[tf][symbol] = {
            'open': [float(r[1]) for r in rows[:end]],
            'high': [float(r[2]) for r in rows[:end]],
            'low':  [float(r[3]) for r in rows[:end]],
            'close':[float(r[4]) for r in rows[:end]],
            'volume':[float(r[5]) for r in rows[:end]],
        }
        res = B.analyze_timeframe(symbol, tf, B.current_params if hasattr(B,'current_params') else {}, use_5m=False)
        macd, signal, _ = B.calculate_macd(
            B.histories[tf][symbol]["close"],
            B.MACD_FAST, B.MACD_SLOW, B.MACD_SIGNAL,
            return_arrays=True,
        )
        expected = None
        if len(macd) >= 2 and len(signal) >= 2:
            if macd[-2] <= signal[-2] and macd[-1] > signal[-1]:
                expected = "bullish"
            elif macd[-2] >= signal[-2] and macd[-1] < signal[-1]:
                expected = "bearish"
        if res:
            assert res["cross"] == expected, (
                f"{symbol} {tf}m: cross={res['cross']}, expected={expected}"
            )
        if res and res['cross']:
            t = datetime.datetime.utcfromtimestamp(int(rows[end-1][0])/1000) + datetime.timedelta(hours=3)
            crosses.append((t, res['cross'], res['macd_line'], res['signal_line']))
    print(f"  {symbol} {tf}m: найдено крестов за последние {len(closes)} свечей = {len(crosses)}")
    for t, c, m, s in crosses[-8:]:
        print(f"    {t}  {c}  macd={m:.5f} sig={s:.5f}")

if __name__ == "__main__":
    print("Проверка детекта креста (OKX-данные, как у бота):")
    scan("NEARUSDT", 240)   # 4h — здесь баг давал ложный SELL
    scan("BTCUSDT", 60)     # 1h — должен находить реальные кресты
    print("\nВсе найденные кресты совпали с прямым сравнением двух последних значений MACD.")
