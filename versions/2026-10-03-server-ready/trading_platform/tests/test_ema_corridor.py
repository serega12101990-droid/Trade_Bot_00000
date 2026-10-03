from __future__ import annotations

import unittest
from dataclasses import replace

from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    IndicatorSnapshot,
    build_snapshot_series,
    build_target_ladder,
    detect_corridors,
    latest_snapshot_at,
    timeframe_strength,
    _structural_stop,
    _bars_since_macd_cross,
    _multi_timeframe_trend_aligned,
)


def snapshot(
    timeframe: int,
    close_time: int,
    close: float,
    atr: float,
    ema20: float,
    ema50: float,
    ema200: float,
) -> IndicatorSnapshot:
    return IndicatorSnapshot(
        timeframe=timeframe,
        open_time=close_time - timeframe * 60_000,
        close_time=close_time,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=1.0,
        atr=atr,
        emas={20: ema20, 50: ema50, 200: ema200},
        macd_line=-1.0,
        signal_line=-0.5,
        histogram=-0.5,
    )


class EmaCorridorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.loose_config = CorridorConfig(
            min_gap_pct=0.0,
            min_gap_atr=0.0,
            cluster_tolerance_pct=0.0,
            cluster_tolerance_atr=0.0,
            target_merge_pct=0.05,
            tp_buffer_pct=0.0,
            commission_rate=0.0,
            slippage_rate=0.0,
            min_net_reward_pct=0.0,
            min_net_rr=0.0,
            require_macd_alignment=False,
        )

    def test_detects_two_adjacent_30m_corridors(self) -> None:
        point = snapshot(
            timeframe=30,
            close_time=1_000_000,
            close=1018.0,
            atr=2.0,
            ema20=1025.8,
            ema50=1019.1,
            ema200=1003.1,
        )

        corridors = detect_corridors(point, self.loose_config)

        self.assertEqual(len(corridors), 2)
        self.assertEqual(corridors[0].lower_cluster.periods, (200,))
        self.assertEqual(corridors[0].upper_cluster.periods, (50,))
        self.assertAlmostEqual(corridors[0].lower_boundary, 1003.1)
        self.assertAlmostEqual(corridors[0].upper_boundary, 1019.1)
        self.assertEqual(corridors[1].lower_cluster.periods, (50,))
        self.assertEqual(corridors[1].upper_cluster.periods, (20,))

    def test_nearby_ema20_and_ema50_become_one_cluster(self) -> None:
        cfg = CorridorConfig(
            min_gap_pct=0.0,
            min_gap_atr=0.0,
            cluster_tolerance_pct=0.10,
            cluster_tolerance_atr=0.0,
        )
        point = snapshot(
            timeframe=30,
            close_time=1_000_000,
            close=1000.0,
            atr=2.0,
            ema20=1020.0,
            ema50=1019.5,
            ema200=1000.0,
        )

        corridors = detect_corridors(point, cfg)

        self.assertEqual(len(corridors), 1)
        self.assertEqual(corridors[0].upper_cluster.periods, (20, 50))
        self.assertEqual(corridors[0].lower_cluster.periods, (200,))

    def test_builds_nested_target_ladder_and_strengthens_higher_tf(self) -> None:
        base = snapshot(
            timeframe=240,
            close_time=2_000_000,
            close=1010.9,
            atr=4.0,
            ema20=1010.9,
            ema50=995.3,
            ema200=970.5,
        )
        corridor = detect_corridors(base, self.loose_config)[1]
        lower_tf = snapshot(
            timeframe=30,
            close_time=2_000_000,
            close=1005.0,
            atr=1.0,
            ema20=1018.0,
            ema50=1015.0,
            ema200=1003.4,
        )
        same_level_higher_tf = snapshot(
            timeframe=60,
            close_time=2_000_000,
            close=1005.0,
            atr=1.5,
            ema20=1017.0,
            ema50=1003.45,
            ema200=980.0,
        )

        targets = build_target_ladder(
            corridor,
            "SELL",
            [base, lower_tf, same_level_higher_tf],
            entry_price=1010.0,
            stop_price=1020.0,
            config=self.loose_config,
        )

        self.assertEqual(len(targets), 2)
        self.assertAlmostEqual(targets[0].raw_price, 1003.45)
        self.assertIn("30m:EMA200", targets[0].label)
        self.assertIn("1H:EMA50", targets[0].label)
        self.assertEqual(targets[0].strength, 2.0)
        self.assertEqual(targets[0].strength_label, "MEDIUM")
        self.assertAlmostEqual(targets[1].raw_price, 995.3)
        self.assertTrue(targets[1].is_far_boundary)
        self.assertEqual(targets[1].strength, 3.0)
        self.assertEqual(targets[1].strength_label, "STRONG")

    def test_near_target_with_bad_rr_is_not_adequate(self) -> None:
        cfg = CorridorConfig(
            min_gap_pct=0.0,
            min_gap_atr=0.0,
            cluster_tolerance_pct=0.0,
            cluster_tolerance_atr=0.0,
            target_merge_pct=0.01,
            tp_buffer_pct=0.0,
            commission_rate=0.00055,
            slippage_rate=0.00020,
            min_net_reward_pct=0.30,
            min_net_rr=1.20,
        )
        base = snapshot(240, 2_000_000, 1010.9, 4.0, 1010.9, 995.3, 970.5)
        corridor = detect_corridors(base, cfg)[1]
        blocker = snapshot(30, 2_000_000, 1008.0, 1.0, 1020.0, 1015.0, 1008.5)

        targets = build_target_ladder(
            corridor,
            "SELL",
            [base, blocker],
            entry_price=1010.0,
            stop_price=1020.0,
            config=cfg,
        )

        self.assertGreaterEqual(len(targets), 1)
        self.assertFalse(targets[0].adequate)
        self.assertLess(targets[0].net_rr, cfg.min_net_rr)

    def test_same_or_higher_mode_ignores_lower_timeframe_obstacle(self) -> None:
        cfg = CorridorConfig(
            min_gap_pct=0.0,
            min_gap_atr=0.0,
            cluster_tolerance_pct=0.0,
            cluster_tolerance_atr=0.0,
            target_merge_pct=0.01,
            tp_buffer_pct=0.0,
            commission_rate=0.0,
            slippage_rate=0.0,
            min_net_reward_pct=0.0,
            min_net_rr=0.0,
            require_macd_alignment=False,
            obstacle_timeframe_mode="SAME_OR_HIGHER",
        )
        base = snapshot(240, 2_000_000, 1010.0, 4.0, 1010.0, 995.0, 970.0)
        corridor = detect_corridors(base, cfg)[1]
        lower_tf = snapshot(30, 2_000_000, 1005.0, 1.0, 1020.0, 1015.0, 1005.0)
        higher_tf = snapshot(1440, 2_000_000, 1000.0, 8.0, 1002.0, 950.0, 900.0)

        targets = build_target_ladder(
            corridor,
            "SELL",
            [base, lower_tf, higher_tf],
            entry_price=1009.0,
            stop_price=1015.0,
            config=cfg,
        )

        self.assertEqual(len(targets), 2)
        self.assertIn("1D:EMA20", targets[0].label)
        self.assertNotIn("30m:EMA200", targets[0].label)
        self.assertAlmostEqual(targets[1].raw_price, 995.0)

    def test_latest_snapshot_never_uses_future_close(self) -> None:
        snapshots = [
            snapshot(240, 100, 1000.0, 2.0, 1010.0, 1000.0, 990.0),
            snapshot(240, 200, 1001.0, 2.0, 1011.0, 1001.0, 991.0),
            snapshot(240, 300, 1002.0, 2.0, 1012.0, 1002.0, 992.0),
        ]

        selected = latest_snapshot_at(snapshots, 250)

        self.assertIsNotNone(selected)
        self.assertEqual(selected.close_time, 200)

    def test_higher_timeframe_has_greater_strength(self) -> None:
        self.assertGreater(
            timeframe_strength(240, self.loose_config),
            timeframe_strength(30, self.loose_config),
        )
        self.assertGreater(
            timeframe_strength(1440, self.loose_config),
            timeframe_strength(240, self.loose_config),
        )

    def test_boundary_signal_stop_uses_signal_candle_and_start_boundary(self) -> None:
        cfg = CorridorConfig(
            stop_mode="BOUNDARY_SIGNAL",
            stop_atr_buffer=0.25,
            min_gap_pct=0.0,
            min_gap_atr=0.0,
            cluster_tolerance_pct=0.0,
            cluster_tolerance_atr=0.0,
        )
        point = snapshot(30, 1_000_000, 105.0, 2.0, 110.0, 100.0, 90.0)
        corridor = detect_corridors(point, cfg)[1]
        candles = [
            Candle(0, 108.0, 112.0, 104.0, 106.0, 1.0),
            Candle(1, 106.0, 109.0, 102.0, 104.0, 1.0),
        ]

        stop = _structural_stop(candles, 1, "SELL", 2.0, cfg, corridor)

        self.assertAlmostEqual(stop, 110.5)

    def test_boundary_only_stop_ignores_old_signal_wick(self) -> None:
        cfg = CorridorConfig(
            stop_mode="BOUNDARY_ONLY",
            stop_atr_buffer=0.25,
            min_gap_pct=0.0,
            min_gap_atr=0.0,
            cluster_tolerance_pct=0.0,
            cluster_tolerance_atr=0.0,
        )
        point = snapshot(30, 1_000_000, 105.0, 2.0, 110.0, 100.0, 90.0)
        corridor = detect_corridors(point, cfg)[1]
        candles = [Candle(0, 106.0, 115.0, 102.0, 104.0, 1.0)]

        stop = _structural_stop(candles, 0, "SELL", 2.0, cfg, corridor)

        self.assertAlmostEqual(stop, 110.5)

    def test_finds_macd_cross_several_bars_before_signal(self) -> None:
        base = snapshot(30, 1_000_000, 100.0, 2.0, 110.0, 100.0, 90.0)
        histograms = [0.4, 0.1, -0.2, -0.4, -0.6]
        snapshots = [
            replace(
                base,
                close_time=base.close_time + index,
                histogram=value,
                macd_line=value,
                signal_line=0.0,
            )
            for index, value in enumerate(histograms)
        ]

        bars_since = _bars_since_macd_cross(snapshots, 4, "SELL", 4)

        self.assertEqual(bars_since, 2)

    def test_requires_all_selected_senior_timeframes_to_align(self) -> None:
        bullish_4h = replace(
            snapshot(240, 1_000_000, 105.0, 2.0, 110.0, 100.0, 90.0),
            macd_line=2.0,
            signal_line=1.0,
            histogram=1.0,
        )
        bearish_1d = replace(
            snapshot(1440, 1_000_000, 95.0, 4.0, 90.0, 100.0, 110.0),
            macd_line=-2.0,
            signal_line=-1.0,
            histogram=-1.0,
        )

        only_4h = _multi_timeframe_trend_aligned(
            [bullish_4h, bearish_1d], "BUY", [240], "EMA20_50"
        )
        both = _multi_timeframe_trend_aligned(
            [bullish_4h, bearish_1d], "BUY", [240, 1440], "EMA20_50"
        )

        self.assertTrue(only_4h)
        self.assertFalse(both)

    def test_ema_is_calculated_from_close_not_high(self) -> None:
        candles = []
        for index in range(240):
            close = 100.0 + index * 0.1
            candles.append(
                Candle(
                    open_time=index * 15 * 60_000,
                    open=close,
                    high=close + 10_000.0,
                    low=close - 1.0,
                    close=close,
                    volume=1.0,
                )
            )

        snapshots = build_snapshot_series(candles, 15, self.loose_config)

        self.assertTrue(snapshots)
        latest = snapshots[-1]
        self.assertLess(latest.emas[20], 124.0)
        self.assertGreater(latest.emas[20], 120.0)
        self.assertLess(latest.emas[200], 120.0)


if __name__ == "__main__":
    unittest.main()
