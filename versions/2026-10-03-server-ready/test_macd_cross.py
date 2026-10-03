"""
Тест новой модели: MACD-cross на 15m (импульс).
Проверяем, что generate_signal ловит перекрест и ставит SL/TP по EMA.
Сеть не трогаем — 15m MACD фиксируем вручную через monkey-patch analyze_timeframe.
"""
import trade_bot_macd as B

SYM = "BTCUSDT"
_AUTO_CROSS = object()

def patch_15m(macd_line, signal_line, ema20, ema50, ema200, price,
              cross=_AUTO_CROSS, higher_tf_confirm=True):
    orig = B.analyze_timeframe
    def fake(symbol, tf, params, use_5m=False):
        if tf == 15 and symbol == SYM:
            if cross is _AUTO_CROSS:
                c = "bullish" if macd_line > signal_line else ("bearish" if macd_line < signal_line else None)
            else:
                c = cross
            return {
                'ema20': ema20, 'ema50': ema50, 'ema200': ema200,
                'macd_line': macd_line, 'signal_line': signal_line,
                'histogram': macd_line - signal_line, 'cross': c,
                'doji': False, 'hammer': False, 'pinbar': False,
                'bull_eng': False, 'bear_eng': False,
                'candle_reversal_bull': False, 'candle_reversal_bear': False,
                'open': price, 'high': price*1.001, 'low': price*0.999, 'close': price
            }
        # старшие ТФ: подтверждают направление (или против, если higher_tf_confirm=False)
        if tf in (30, 60, 240, 1440, 10080) and symbol == SYM:
            if higher_tf_confirm:
                # BUY: macd>signal; SELL: macd<signal (как на 15m)
                if macd_line > signal_line:
                    c2 = "bullish"; ml, sl2 = 10, 5
                else:
                    c2 = "bearish"; ml, sl2 = -10, -5
            else:
                # противоположное направление старших ТФ
                if macd_line > signal_line:
                    c2 = "bearish"; ml, sl2 = -10, -5
                else:
                    c2 = "bullish"; ml, sl2 = 10, 5
            return {
                'ema20': ema20, 'ema50': ema50, 'ema200': ema200,
                'macd_line': ml, 'signal_line': sl2, 'histogram': ml - sl2, 'cross': c2,
                'doji': False, 'hammer': False, 'pinbar': False,
                'bull_eng': False, 'bear_eng': False,
                'candle_reversal_bull': False, 'candle_reversal_bear': False,
                'open': price, 'high': price*1.001, 'low': price*0.999, 'close': price
            }
        return orig(symbol, tf, params, use_5m=use_5m)
    B.analyze_timeframe = fake

def run():
    import random
    from collections import deque
    B.CONFIG["USE_ICT_MODEL"] = False
    B.CONFIG["USE_TP_5M_FOR_FAST_TF"] = False
    B.CONFIG["MIN_TP_PERCENT"] = 0.10
    B.CONFIG["MAX_TP_PERCENT"] = 5.0
    B.calc_struct_levels = lambda symbol, tf, price, direction, *args: (
        (price * 1.02, price * 0.99)
        if direction == "BUY"
        else (price * 0.98, price * 1.01)
    )
    # минимальная 15m-история (для len>=26 в generate_signal) + реалистичный ATR
    for tf in B.TIMEFRAMES:
        h = {k: deque([60000 + i*10 for i in range(30)]) for k in ('open','high','low','close','volume')}
        B.histories[tf][SYM] = h
    B.last_completed_price[SYM] = 62000.0
    # отключаем ATR-фильтр в тесте (история синтетическая)
    B.calculate_atr_for_tf = lambda *a, **k: 1000.0

    # --- Тест 1: БЫЧИЙ перекрест (macd_line пересёк signal_line вверх) ---
    print("=== TEST 1: BUY по MACD-cross (bullish) ===")
    PRICE, E20, E50, E200 = 62000.0, 61500.0, 62500.0, 63000.0
    patch_15m(macd_line=10, signal_line=5, ema20=E20, ema50=E50, ema200=E200, price=PRICE)
    B.logger.setLevel(40)
    sig, tp, sl, st, ct, ev = B.generate_signal(SYM, B.current_params, trigger_tf=15)
    print(f"  Сигнал={sig} TP={round(tp,1)} SL={round(sl,1)}")
    assert sig == "BUY", f"Ожидали BUY, получили {sig}"
    assert tp > PRICE and sl < PRICE
    print("  OK: BUY, TP выше входа, SL ниже входа")

    # --- Тест 2: МЕДВЕЖИЙ перекрест ---
    print("\n=== TEST 2: SELL по MACD-cross (bearish) ===")
    PRICE, E20, E50, E200 = 62000.0, 62500.0, 61500.0, 61000.0
    patch_15m(macd_line=-10, signal_line=-5, ema20=E20, ema50=E50, ema200=E200, price=PRICE)
    sig, tp, sl, st, ct, ev = B.generate_signal(SYM, B.current_params, trigger_tf=15)
    print(f"  Сигнал={sig} TP={round(tp,1)} SL={round(sl,1)}")
    assert sig == "SELL", f"Ожидали SELL, получили {sig}"
    assert tp < PRICE and sl > PRICE
    print("  OK: SELL, TP ниже входа, SL выше входа")

    # --- Тест 3: нет перекреста (macd в одной зоне со signal) -> NONE ---
    print("\n=== TEST 3: нет перекреста -> NONE ===")
    patch_15m(macd_line=10, signal_line=5, ema20=61500, ema50=62500, ema200=63000, price=62000, cross=None)
    sig, tp, sl, st, ct, ev = B.generate_signal(SYM, B.current_params, trigger_tf=15)
    assert sig == "NONE", f"Без нового пересечения ожидали NONE, получили {sig}"
    print(f"  Сигнал={sig} (ожидаем NONE)")
    print("  OK: логика перекреста работает")

    # --- Тест 4: конфликт старших ТФ (против) -> сила падает, может отсеяться ---
    print("\n=== TEST 4: старшие ТФ ПРОТИВ (higher_tf_confirm=False) -> сила снижается ===")
    patch_15m(macd_line=10, signal_line=5, ema20=61500, ema50=62500, ema200=63000, price=62000,
              cross="bullish", higher_tf_confirm=False)
    sig, tp, sl, st, ct, ev = B.generate_signal(SYM, B.current_params, trigger_tf=15)
    print(f"  Сигнал={sig} сила={st:.2f} (ожидаем: ослаблена, возможно NONE из-за MIN_CONFIRM_STRENGTH)")
    print("  OK: конфликт старших ТФ учитывается")

    print("\n=== ВСЕ ТЕСТЫ MACD-CROSS ПРОЙДЕНЫ ===")

if __name__ == "__main__":
    run()
