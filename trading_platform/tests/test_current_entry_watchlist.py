from __future__ import annotations

import unittest

from trading_platform.strategies.current_entry_watchlist import (
    _buffered_target,
    _context_is_usable,
    _estimated_rr,
    _senior_alignment,
)
from trading_platform.strategies.ema_corridor import CorridorConfig, IndicatorSnapshot


def snapshot(close: float, ema20: float, ema50: float, histogram: float) -> IndicatorSnapshot:
    return IndicatorSnapshot(
        timeframe=1440,
        open_time=0,
        close_time=1,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=1.0,
        atr=1.0,
        emas={20: ema20, 50: ema50, 200: ema50 - 10.0},
        macd_line=histogram,
        signal_line=0.0,
        histogram=histogram,
    )


class CurrentEntryWatchlistTests(unittest.TestCase):
    def test_one_percent_buffer_is_mirrored_for_long_and_short(self) -> None:
        self.assertAlmostEqual(_buffered_target(100.0, "SELL", 1.0), 101.0)
        self.assertAlmostEqual(_buffered_target(100.0, "BUY", 1.0), 99.0)

    def test_context_accepts_fresh_post_cross_but_not_old_cross(self) -> None:
        self.assertTrue(_context_is_usable("POST_CROSS", 5))
        self.assertFalse(_context_is_usable("POST_CROSS", 6))
        self.assertTrue(_context_is_usable("PRE_CROSS_CONTRACTION", None))

    def test_senior_alignment_needs_two_of_three_votes(self) -> None:
        bullish = snapshot(110.0, 105.0, 100.0, -1.0)
        bearish = snapshot(90.0, 95.0, 100.0, 1.0)
        self.assertTrue(_senior_alignment(bullish, "BUY"))
        self.assertTrue(_senior_alignment(bearish, "SELL"))

    def test_rr_includes_round_trip_costs(self) -> None:
        free = _estimated_rr(
            100.0,
            102.0,
            96.0,
            "SELL",
            CorridorConfig(commission_rate=0.0, slippage_rate=0.0),
        )
        with_costs = _estimated_rr(
            100.0,
            102.0,
            96.0,
            "SELL",
            CorridorConfig(commission_rate=0.00055, slippage_rate=0.0002),
        )
        self.assertAlmostEqual(free, 2.0)
        self.assertLess(with_costs, free)


if __name__ == "__main__":
    unittest.main()
