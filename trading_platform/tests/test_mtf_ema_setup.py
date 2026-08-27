from __future__ import annotations

import unittest

from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    CorridorEvent,
    EmaCluster,
    EmaCorridor,
    EmaReference,
    IndicatorSnapshot,
    TargetLevel,
    _nison_patterns,
)
from trading_platform.strategies.mtf_ema_setup import (
    MtfCandidate,
    MtfProfile,
    _context_phase,
    _target_for_entry,
    build_profile_event,
    profile_accepts,
)


def corridor(timeframe: int = 240) -> EmaCorridor:
    lower_ref = EmaReference(timeframe, 200, 90.0)
    upper_ref = EmaReference(timeframe, 50, 100.0)
    return EmaCorridor(
        timeframe=timeframe,
        lower_cluster=EmaCluster((lower_ref,)),
        upper_cluster=EmaCluster((upper_ref,)),
        lower_boundary=90.0,
        upper_boundary=100.0,
        width=10.0,
        width_pct=10.0,
        width_atr=5.0,
    )


def candidate(timeframe: int = 240) -> MtfCandidate:
    gap = corridor(timeframe)
    dummy_target = TargetLevel(90.0, 90.0, gap.lower_cluster.references, 1.0, "", 0, 0, 0, True)
    event = CorridorEvent(
        symbol="TEST",
        signal_time=60_000,
        base_timeframe=timeframe,
        direction="SELL",
        corridor=gap,
        entry_price=98.0,
        stop_price=101.0,
        macd_aligned=True,
        macd_cross=True,
        histogram_expanding=False,
        nison_patterns=(),
        targets=(dummy_target,),
        allowed=True,
        score=1.0,
        reasons=(),
    )
    signal = Candle(0, 101.0, 101.0, 97.0, 98.0, 200.0)
    return MtfCandidate(
        symbol="TEST",
        market="CRYPTO",
        setup_timeframe=timeframe,
        context_timeframe=1440,
        entry_timeframe=60,
        signal_time=60_000,
        direction="SELL",
        corridor=gap,
        setup_event=event,
        setup_atr=2.0,
        signal_candle=signal,
        context_phase="RECENT_CROSS",
        context_histogram=-1.0,
        context_bars_since_cross=1,
        setup_patterns=("BEARISH_HARAMI",),
        context_patterns=(),
        nison_confirmed=True,
        body_atr=1.5,
        body_share=0.75,
        crossed_ema_periods=(50,),
        aggressive_candle=True,
        pre_volume_ratio=1.25,
        breakout_volume_ratio=1.5,
        pre_volume_monotonic=True,
        volume_pre_rising=True,
        compression_touch_ratio=0.66,
        compression_range_atr=0.8,
        compression_detected=True,
    )


def snapshot(histogram: float, close_time: int) -> IndicatorSnapshot:
    return IndicatorSnapshot(
        timeframe=60,
        open_time=close_time - 60_000,
        close_time=close_time,
        open=100.0,
        high=101.0,
        low=99.0,
        close=100.0,
        volume=1.0,
        atr=1.0,
        emas={20: 100.0, 50: 99.0, 200: 98.0},
        macd_line=histogram,
        signal_line=0.0,
        histogram=histogram,
    )


class MtfEmaSetupTests(unittest.TestCase):
    def test_recognizes_bearish_harami(self) -> None:
        previous = Candle(0, 100.0, 111.0, 99.0, 110.0, 1.0)
        current = Candle(1, 108.0, 109.0, 104.0, 105.0, 1.0)
        self.assertIn("BEARISH_HARAMI", _nison_patterns(previous, current))

    def test_context_detects_histogram_contracting_toward_zero(self) -> None:
        values = [4.0, 3.0, 2.0, 1.0]
        snapshots = [snapshot(value, index + 1) for index, value in enumerate(values)]
        phase, bars_since = _context_phase(snapshots, 3, "SELL")
        self.assertEqual(phase, "PRE_CROSS_CONTRACTION")
        self.assertIsNone(bars_since)

    def test_profile_combines_macd_nison_volume_and_compression(self) -> None:
        profile = MtfProfile(
            profile_id="STRICT",
            description="",
            context_mode="RECENT_CROSS",
            require_nison=True,
            require_aggressive_candle=True,
            volume_mode="PRE_OR_BREAKOUT",
            require_compression=True,
        )
        self.assertTrue(profile_accepts(candidate(), profile))

    def test_4h_ema200_target_is_one_percent_before_line(self) -> None:
        value = _target_for_entry(
            candidate(240),
            entry_price=99.0,
            stop_price=102.0,
            profile=MtfProfile("T", "", min_net_rr=0.0, min_net_reward_pct=0.0),
            config=CorridorConfig(commission_rate=0.0, slippage_rate=0.0),
        )
        self.assertIsNotNone(value)
        self.assertAlmostEqual(value.executable_price, 90.9)

    def test_pullback_entry_is_filled_before_target(self) -> None:
        item = candidate(240)
        candles = {
            60: [
                Candle(60_000, 98.0, 99.2, 97.0, 98.5, 1.0),
                Candle(3_660_000, 98.5, 99.0, 95.0, 96.0, 1.0),
            ]
        }
        profile = MtfProfile(
            "PB",
            "",
            entry_mode="PULLBACK_50",
            context_mode="RECENT_CROSS",
            min_net_rr=0.0,
            min_net_reward_pct=0.0,
        )
        event = build_profile_event(
            item,
            profile,
            candles,
            CorridorConfig(commission_rate=0.0, slippage_rate=0.0),
        )
        self.assertIsNotNone(event)
        self.assertAlmostEqual(event.entry_price, 99.0)
        self.assertEqual(event.signal_time, 60_000)


if __name__ == "__main__":
    unittest.main()
