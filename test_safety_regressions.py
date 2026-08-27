import csv
import os
import tempfile
import unittest
from collections import deque

import trade_bot_macd as B


def empty_history():
    return {
        "timestamp": deque(maxlen=300),
        "open": deque(maxlen=300),
        "high": deque(maxlen=300),
        "low": deque(maxlen=300),
        "close": deque(maxlen=300),
        "volume": deque(maxlen=300),
    }


class SafetyRegressionTests(unittest.TestCase):
    def setUp(self):
        self.original_dry_run = B.DRY_RUN

    def tearDown(self):
        B.DRY_RUN = self.original_dry_run

    def test_completed_candles_are_deduplicated(self):
        history = empty_history()
        self.assertTrue(B.upsert_completed_candle(history, [1000, 1, 2, 0.5, 1.5, 10]))
        self.assertFalse(B.upsert_completed_candle(history, [1000, 1, 3, 0.4, 2.0, 11]))
        self.assertEqual(list(history["timestamp"]), [1000])
        self.assertEqual(list(history["close"]), [2.0])
        self.assertFalse(B.upsert_completed_candle(history, [900, 1, 2, 0.5, 1.0, 9]))
        self.assertEqual(len(history["close"]), 1)

    def test_websocket_ignores_unfinished_candle_for_indicators(self):
        symbol = B.SYMBOLS[0]
        original = B.histories[15][symbol]
        B.histories[15][symbol] = empty_history()
        try:
            handler = B.make_ws_candle_handler(15)
            handler({
                "topic": f"kline.15.{symbol}",
                "data": [{
                    "start": 1000, "open": "1", "high": "2", "low": "0.5",
                    "close": "1.5", "volume": "10", "confirm": False,
                }],
            })
            self.assertEqual(len(B.histories[15][symbol]["close"]), 0)
            self.assertEqual(B.live_prices[symbol], 1.5)
            handler({
                "topic": f"kline.15.{symbol}",
                "data": [{
                    "start": 1000, "open": "1", "high": "2", "low": "0.5",
                    "close": "1.6", "volume": "11", "confirm": True,
                }],
            })
            self.assertEqual(list(B.histories[15][symbol]["close"]), [1.6])
        finally:
            B.histories[15][symbol] = original

    def test_fvg_directions_are_not_reversed(self):
        bullish = B._find_fvg(
            highs=[10.0, 10.5, 12.0, 12.0],
            lows=[9.0, 9.5, 11.0, 11.0],
            window=50,
        )
        bearish = B._find_fvg(
            highs=[10.0, 9.5, 8.0, 8.0],
            lows=[9.0, 8.5, 7.0, 7.0],
            window=50,
        )
        self.assertIn(("BUY", 11.0, 10.0), bullish)
        self.assertIn(("SELL", 9.0, 8.0), bearish)

    def test_ote_zone_is_measured_as_a_retracement(self):
        self.assertEqual(B._calculate_ote_zone(100.0, 200.0, "BUY"), (121.0, 138.0))
        self.assertEqual(B._calculate_ote_zone(100.0, 200.0, "SELL"), (162.0, 179.0))

    def test_nison_engulfing_uses_real_open_prices(self):
        pattern = B.detect_nison_pattern(
            opens=[10.0, 10.8, 9.7],
            highs=[10.2, 11.0, 11.2],
            lows=[9.8, 9.5, 9.6],
            closes=[10.1, 9.7, 11.0],
            direction="BUY",
        )
        self.assertEqual(pattern, "БычьеПоглощение")

    def test_ict_setup_still_passes_common_strength_filter(self):
        original_analyze = B.analyze_timeframe
        original_ict = B.calc_ict_setup
        original_atr = B.calculate_atr_for_tf
        original_live = B.live_prices.get("TESTUSDT")
        saved = {
            key: B.CONFIG.get(key)
            for key in ("USE_ICT_MODEL", "MIN_CONFIRM_STRENGTH", "MIN_TP_PERCENT",
                        "MAX_TP_PERCENT", "MIN_ATR_PERCENT")
        }

        def fake_analyze(symbol, tf, params, use_5m=False):
            if tf == 15:
                return {
                    "macd_line": 2.0, "signal_line": 1.0, "cross": "bullish",
                    "close": 100.0, "ema20": 99.0, "ema50": 98.0, "ema200": 97.0,
                }
            return {
                "macd_line": -2.0, "signal_line": -1.0, "cross": None,
                "close": 100.0, "ema20": 99.0, "ema50": 98.0, "ema200": 97.0,
            }

        try:
            B.CONFIG.update({
                "USE_ICT_MODEL": True,
                "MIN_CONFIRM_STRENGTH": 2.0,
                "MIN_TP_PERCENT": 0.1,
                "MAX_TP_PERCENT": 5.0,
                "MIN_ATR_PERCENT": 0.0,
            })
            B.live_prices["TESTUSDT"] = 100.0
            B.analyze_timeframe = fake_analyze
            B.calc_ict_setup = lambda *args, **kwargs: (True, 102.0, 99.0, "Молот")
            B.calculate_atr_for_tf = lambda *args, **kwargs: 1.0
            result = B.generate_signal("TESTUSDT", B.current_params, trigger_tf=15)
            self.assertEqual(result[0], "NONE")
        finally:
            B.analyze_timeframe = original_analyze
            B.calc_ict_setup = original_ict
            B.calculate_atr_for_tf = original_atr
            for key, value in saved.items():
                B.CONFIG[key] = value
            if original_live is None:
                B.live_prices.pop("TESTUSDT", None)
            else:
                B.live_prices["TESTUSDT"] = original_live

    def test_trading_stop_uses_bybit_position_index_and_tick(self):
        original_session = B.session
        B.DRY_RUN = False
        B._instrument_lot_cache["TESTUSDT"] = {
            "ts": float("inf"),
            "info": {"min": 0.01, "max": 1000, "step": 0.01, "tick": 0.1},
        }

        class FakeSession:
            params = None

            def set_trading_stop(self, **kwargs):
                self.params = kwargs
                return {"retCode": 0, "retMsg": "OK"}

        fake = FakeSession()
        B.session = fake
        try:
            self.assertTrue(B.set_stop_loss_take_profit("TESTUSDT", "Buy", 99.97, 101.07))
            self.assertNotIn("side", fake.params)
            self.assertEqual(fake.params["positionIdx"], B.CONFIG.get("POSITION_IDX", 0))
            self.assertEqual(fake.params["stopLoss"], "99.9")
            self.assertEqual(fake.params["takeProfit"], "101.0")
        finally:
            B.session = original_session
            B._instrument_lot_cache.pop("TESTUSDT", None)

    def test_spread_is_measured_from_best_bid_and_ask(self):
        original_session = B.session

        class FakeSession:
            def get_tickers(self, **kwargs):
                return {
                    "retCode": 0,
                    "result": {"list": [{"bid1Price": "99.95", "ask1Price": "100.05"}]},
                }

        B.session = FakeSession()
        try:
            self.assertAlmostEqual(B.get_spread_pct("TESTUSDT"), 0.1, places=8)
        finally:
            B.session = original_session

    def test_close_trade_writes_a_complete_net_result_row(self):
        original_csv = B.STATS_CSV
        B.DRY_RUN = True
        symbol = "TESTUSDT"
        with tempfile.TemporaryDirectory() as temp_dir:
            B.STATS_CSV = os.path.join(temp_dir, "trades.csv")
            with open(B.STATS_CSV, "w", newline="", encoding="utf-8") as handle:
                csv.writer(handle, delimiter=";").writerow(B.STATS_HEADERS)
            B.open_trades[symbol] = {
                "timestamp_open": "2026-07-30 12:00:00",
                "symbol": symbol,
                "side": "Buy",
                "entry_price": 100.0,
                "qty": 1.0,
                "original_qty": 1.0,
                "sl": 99.0,
                "tp": 102.0,
                "expected_gain_pct": 2.0,
                "expected_loss_pct": 1.0,
                "score": 3.0,
                "confirmation_tf": 60,
                "trigger_tf": 15,
                "setup": "MACD_STRUCTURE",
                "pattern": "",
                "planned_rr": 2.0,
                "counter_trend": False,
                "scaled": False,
                "ema20": 99.0,
                "ema50": 98.0,
                "ema200": 97.0,
                "macd_entry": 2.0,
                "signal_entry": 1.0,
                "entry_order_id": "dry_open",
                "entry_fee": None,
                "partial_gross_pnl": 0.0,
                "partial_commission": 0.0,
                "partial_exit_notional": 0.0,
            }
            try:
                self.assertTrue(
                    B.close_trade(
                        symbol, exit_price=102.0, score=3.0,
                        reason="dry_run_tp", execute_order=True,
                    )
                )
                with open(B.STATS_CSV, newline="", encoding="utf-8") as handle:
                    rows = list(csv.DictReader(handle, delimiter=";"))
                self.assertEqual(len(rows), 1)
                self.assertEqual(set(rows[0]), set(B.STATS_HEADERS))
                self.assertEqual(rows[0]["exit_reason"], "dry_run_tp")
                self.assertGreater(float(rows[0]["net_pnl_usdt"]), 0)
                self.assertTrue(rows[0]["entry_order_id"])
                self.assertTrue(rows[0]["exit_order_id"])
            finally:
                B.open_trades.pop(symbol, None)
                B.STATS_CSV = original_csv


if __name__ == "__main__":
    unittest.main()
