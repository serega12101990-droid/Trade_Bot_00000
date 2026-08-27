from __future__ import annotations

import unittest

from trading_platform.backtesting.ema_corridor_backtest import (
    BacktestConfig,
    run_backtest,
    simulate_event,
)
from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    CorridorEvent,
    EmaCluster,
    EmaCorridor,
    EmaReference,
    TargetLevel,
)


MINUTE = 60_000


def candle(index: int, open_: float, high: float, low: float, close: float) -> Candle:
    return Candle(index * MINUTE, open_, high, low, close, 1.0)


def buy_event(signal_index: int = 1, target: float = 110.0) -> CorridorEvent:
    lower_ref = EmaReference(1, 50, 100.0)
    upper_ref = EmaReference(1, 20, 110.0)
    corridor = EmaCorridor(
        timeframe=1,
        lower_cluster=EmaCluster((lower_ref,)),
        upper_cluster=EmaCluster((upper_ref,)),
        lower_boundary=100.0,
        upper_boundary=110.0,
        width=10.0,
        width_pct=10.0,
        width_atr=5.0,
    )
    level = TargetLevel(
        raw_price=target,
        executable_price=target,
        references=(upper_ref,),
        strength=1.0,
        strength_label="MINOR",
        gross_reward_pct=7.8,
        net_reward_pct=7.8,
        net_rr=2.0,
        adequate=True,
        is_far_boundary=True,
    )
    return CorridorEvent(
        symbol="TESTUSDT",
        signal_time=signal_index * MINUTE,
        base_timeframe=1,
        direction="BUY",
        corridor=corridor,
        entry_price=102.0,
        stop_price=98.0,
        macd_aligned=True,
        macd_cross=True,
        histogram_expanding=True,
        nison_patterns=("HAMMER",),
        targets=(level,),
        allowed=True,
        score=5.0,
        reasons=(),
    )


class EmaCorridorBacktestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.strategy = CorridorConfig(
            commission_rate=0.0,
            slippage_rate=0.0,
            require_macd_alignment=False,
        )
        self.backtest = BacktestConfig(max_holding_bars=3)

    def test_target_hit_produces_positive_two_r_trade(self) -> None:
        candles = [
            candle(0, 101.0, 102.0, 100.0, 101.0),
            candle(1, 102.0, 111.0, 101.0, 110.0),
        ]

        trade = simulate_event(buy_event(), candles, self.strategy, self.backtest)

        self.assertIsNotNone(trade)
        self.assertEqual(trade.status, "TARGET")
        self.assertAlmostEqual(trade.net_return_pct, 8.0 / 102.0 * 100.0)
        self.assertAlmostEqual(trade.r_multiple, 2.0)

    def test_same_candle_target_and_stop_is_counted_as_stop(self) -> None:
        candles = [
            candle(0, 101.0, 102.0, 100.0, 101.0),
            candle(1, 102.0, 111.0, 97.0, 105.0),
        ]

        trade = simulate_event(buy_event(), candles, self.strategy, self.backtest)

        self.assertIsNotNone(trade)
        self.assertEqual(trade.status, "STOP")
        self.assertAlmostEqual(trade.r_multiple, -1.0)

    def test_costs_are_applied_on_entry_and_exit(self) -> None:
        strategy = CorridorConfig(
            commission_rate=0.001,
            slippage_rate=0.001,
            require_macd_alignment=False,
        )
        candles = [
            candle(0, 101.0, 102.0, 100.0, 101.0),
            candle(1, 102.0, 111.0, 101.0, 110.0),
        ]

        trade = simulate_event(buy_event(), candles, strategy, self.backtest)

        self.assertIsNotNone(trade)
        self.assertEqual(trade.status, "TARGET")
        self.assertLess(trade.net_return_pct, 8.0 / 102.0 * 100.0)

    def test_portfolio_skips_overlapping_signal_and_sizes_by_risk(self) -> None:
        candles = [
            candle(0, 101.0, 102.0, 100.0, 101.0),
            candle(1, 102.0, 105.0, 100.0, 104.0),
            candle(2, 104.0, 106.0, 101.0, 105.0),
            candle(3, 105.0, 111.0, 104.0, 110.0),
            candle(4, 110.0, 111.0, 109.0, 110.0),
        ]
        events = [buy_event(1), buy_event(2)]

        report = run_backtest(events, candles, self.strategy, self.backtest)

        self.assertEqual(report.signal_counts["allowed"], 2)
        self.assertEqual(report.skipped_overlaps, 1)
        self.assertEqual(report.summary["trades"], 1)
        self.assertGreater(report.trades[0].pnl_cash, 0.0)
        self.assertLessEqual(report.trades[0].risk_cash, 100.0 + 1e-9)


if __name__ == "__main__":
    unittest.main()
