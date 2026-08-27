from __future__ import annotations

import unittest

from trading_platform.backtesting.ema_corridor_backtest import BacktestConfig
from trading_platform.backtesting.scaled_exit_backtest import simulate_scaled_exit
from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    CorridorEvent,
    EmaCluster,
    EmaCorridor,
    EmaReference,
    TargetLevel,
)


def buy_event() -> CorridorEvent:
    lower = EmaCluster((EmaReference(60, 20, 100.0),))
    upper = EmaCluster((EmaReference(60, 50, 110.0),))
    corridor = EmaCorridor(60, lower, upper, 100.0, 110.0, 10.0, 10.0, 5.0)
    target = TargetLevel(110.0, 110.0, upper.references, 2.0, "", 9.0, 9.0, 4.5, True, True)
    return CorridorEvent(
        symbol="TEST",
        signal_time=0,
        base_timeframe=60,
        direction="BUY",
        corridor=corridor,
        entry_price=101.0,
        stop_price=99.0,
        macd_aligned=True,
        macd_cross=True,
        histogram_expanding=False,
        nison_patterns=(),
        targets=(target,),
        allowed=True,
        score=1.0,
        reasons=(),
    )


class ScaledExitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.strategy = CorridorConfig(commission_rate=0.0, slippage_rate=0.0)
        self.backtest = BacktestConfig(max_holding_bars=10)

    def test_half_exits_midpoint_and_half_at_far_target(self) -> None:
        candles = [
            Candle(0, 101.0, 105.5, 101.2, 105.0, 1.0),
            Candle(60_000, 105.0, 110.2, 104.0, 110.0, 1.0),
        ]
        trade = simulate_scaled_exit(buy_event(), candles, self.strategy, self.backtest)
        self.assertIsNotNone(trade)
        self.assertEqual(trade.status, "TP1_THEN_TARGET")
        self.assertAlmostEqual(trade.r_multiple, 3.25)

    def test_stop_before_midpoint_is_full_loss(self) -> None:
        candles = [Candle(0, 101.0, 103.0, 98.5, 99.0, 1.0)]
        trade = simulate_scaled_exit(buy_event(), candles, self.strategy, self.backtest)
        self.assertIsNotNone(trade)
        self.assertEqual(trade.status, "STOP_BEFORE_TP1")
        self.assertAlmostEqual(trade.r_multiple, -1.0)

    def test_ambiguous_tp1_candle_moves_remainder_to_breakeven(self) -> None:
        candles = [Candle(0, 101.0, 105.5, 100.5, 105.0, 1.0)]
        trade = simulate_scaled_exit(buy_event(), candles, self.strategy, self.backtest)
        self.assertIsNotNone(trade)
        self.assertEqual(trade.status, "TP1_THEN_BREAKEVEN")
        self.assertAlmostEqual(trade.r_multiple, 1.0)


if __name__ == "__main__":
    unittest.main()
