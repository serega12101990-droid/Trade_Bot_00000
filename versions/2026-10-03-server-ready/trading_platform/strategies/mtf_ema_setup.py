"""Многоуровневый исследовательский SETUP → CONTEXT → ENTRY для EMA-коридоров."""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import asdict, dataclass
from statistics import mean
from typing import Mapping, Sequence

from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    CorridorEvent,
    EmaCorridor,
    IndicatorSnapshot,
    TargetLevel,
    _bars_since_macd_cross,
    _nison_patterns,
    _pattern_confirms,
    build_snapshot_series,
    scan_corridor_events,
    timeframe_strength,
)


@dataclass(frozen=True)
class MtfProfile:
    profile_id: str
    description: str
    entry_mode: str = "IMMEDIATE"
    context_mode: str = "ANY"
    require_nison: bool = False
    require_aggressive_candle: bool = False
    volume_mode: str = "ANY"
    require_compression: bool = False
    min_net_rr: float = 0.5
    min_net_reward_pct: float = 0.10
    pullback_wait_setup_bars: int = 2

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "MtfProfile":
        allowed = set(cls.__dataclass_fields__)
        return cls(**{key: item for key, item in value.items() if key in allowed})


@dataclass(frozen=True)
class MtfCandidate:
    symbol: str
    market: str
    setup_timeframe: int
    context_timeframe: int
    entry_timeframe: int
    signal_time: int
    direction: str
    corridor: EmaCorridor
    setup_event: CorridorEvent
    setup_atr: float
    signal_candle: Candle
    context_phase: str
    context_histogram: float
    context_bars_since_cross: int | None
    setup_patterns: tuple[str, ...]
    context_patterns: tuple[str, ...]
    nison_confirmed: bool
    body_atr: float
    body_share: float
    crossed_ema_periods: tuple[int, ...]
    aggressive_candle: bool
    pre_volume_ratio: float
    breakout_volume_ratio: float
    pre_volume_monotonic: bool
    volume_pre_rising: bool
    compression_touch_ratio: float
    compression_range_atr: float
    compression_detected: bool

    def to_dict(self) -> dict[str, object]:
        result = asdict(self)
        result.pop("setup_event", None)
        return result


def _snapshot_position_at(
    snapshots: Sequence[IndicatorSnapshot], cutoff_time: int
) -> int | None:
    if not snapshots:
        return None
    times = [snapshot.close_time for snapshot in snapshots]
    position = bisect_right(times, cutoff_time) - 1
    return position if position >= 0 else None


def _context_phase(
    snapshots: Sequence[IndicatorSnapshot], position: int, direction: str
) -> tuple[str, int | None]:
    if position < 1:
        return "NO_CONTEXT", None
    current = snapshots[position]
    previous = snapshots[position - 1]
    bars_since = _bars_since_macd_cross(snapshots, position, direction, 12)
    if bars_since == 0:
        return "EXACT_CROSS", 0
    if bars_since is not None and bars_since <= 2:
        return "RECENT_CROSS", bars_since
    recent_histograms = [
        snapshot.histogram for snapshot in snapshots[max(0, position - 5) : position + 1]
    ]
    if direction == "SELL":
        pre_cross = (
            current.histogram > 0
            and current.histogram < previous.histogram
            and current.histogram < max(recent_histograms)
        )
        post_cross = current.histogram < 0
    else:
        pre_cross = (
            current.histogram < 0
            and current.histogram > previous.histogram
            and current.histogram > min(recent_histograms)
        )
        post_cross = current.histogram > 0
    if pre_cross:
        return "PRE_CROSS_CONTRACTION", bars_since
    if post_cross:
        return "POST_CROSS", bars_since
    return "NO_CONFIRMATION", bars_since


def _recent_nison_patterns(
    candles: Sequence[Candle],
    timeframe: int,
    cutoff_time: int,
    direction: str,
    lookback: int = 6,
) -> tuple[tuple[str, ...], bool]:
    eligible = [
        candle for candle in candles if candle.open_time + timeframe * 60_000 <= cutoff_time
    ]
    if len(eligible) < 2:
        return (), False
    found: list[str] = []
    for index in range(max(1, len(eligible) - lookback), len(eligible)):
        patterns = _nison_patterns(eligible[index - 1], eligible[index])
        for pattern in patterns:
            if pattern not in found:
                found.append(pattern)
    return tuple(found), _pattern_confirms(found, direction)


def _volume_features(candles: Sequence[Candle], index: int) -> tuple[float, float, bool, bool]:
    if index < 20:
        return 0.0, 0.0, False, False
    prior20 = [max(0.0, candle.volume) for candle in candles[index - 20 : index]]
    baseline = mean(prior20) if prior20 else 0.0
    recent3 = [max(0.0, candle.volume) for candle in candles[index - 3 : index]]
    preceding5 = [max(0.0, candle.volume) for candle in candles[index - 8 : index - 3]]
    pre_ratio = mean(recent3) / baseline if baseline > 0 else 0.0
    breakout_ratio = candles[index].volume / baseline if baseline > 0 else 0.0
    monotonic = recent3[0] < recent3[1] < recent3[2]
    rising = mean(recent3) >= mean(preceding5) * 1.20 if preceding5 and mean(preceding5) > 0 else False
    return pre_ratio, breakout_ratio, monotonic, rising


def _compression_features(
    candles: Sequence[Candle],
    index: int,
    boundary: float,
    atr: float,
    lookback: int = 6,
) -> tuple[float, float, bool]:
    window = candles[max(0, index - lookback) : index]
    if len(window) < max(3, lookback // 2) or atr <= 0:
        return 0.0, 0.0, False
    touches = sum(
        candle.low <= boundary <= candle.high
        or abs(candle.close - boundary) <= atr * 0.20
        for candle in window
    )
    touch_ratio = touches / len(window)
    range_atr = mean(candle.high - candle.low for candle in window) / atr
    return touch_ratio, range_atr, touch_ratio >= 0.50 and range_atr <= 1.00


def generate_mtf_candidates(
    symbol: str,
    market: str,
    candles_by_timeframe: Mapping[int, Sequence[Candle]],
    setup_timeframe: int,
    context_timeframe: int,
    entry_timeframe: int,
    config: CorridorConfig,
) -> tuple[MtfCandidate, ...]:
    values = asdict(config)
    values.update(
        {
            "min_net_reward_pct": -10.0,
            "min_net_rr": 0.0,
            "require_macd_alignment": False,
            "require_recent_macd_cross": False,
            "require_histogram_expansion": False,
            "require_nison_pattern": False,
            "require_trend_alignment": False,
            "obstacle_timeframe_mode": "SAME_OR_HIGHER",
            "stop_mode": "BOUNDARY_SIGNAL",
        }
    )
    scan_config = CorridorConfig.from_mapping(values)
    events = scan_corridor_events(
        symbol, candles_by_timeframe, setup_timeframe, scan_config
    )
    setup_candles = sorted(candles_by_timeframe[setup_timeframe], key=lambda c: c.open_time)
    setup_index = {candle.open_time: index for index, candle in enumerate(setup_candles)}
    snapshots_by_tf = {
        timeframe: build_snapshot_series(candles, timeframe, scan_config)
        for timeframe, candles in candles_by_timeframe.items()
    }
    setup_snapshots = snapshots_by_tf[setup_timeframe]
    setup_snapshot_by_open = {snapshot.open_time: snapshot for snapshot in setup_snapshots}
    context_snapshots = snapshots_by_tf.get(context_timeframe, [])
    candidates: list[MtfCandidate] = []
    for event in events:
        if event.crossed_entire_gap or not event.targets:
            continue
        signal_open = event.signal_time - setup_timeframe * 60_000
        index = setup_index.get(signal_open)
        snapshot = setup_snapshot_by_open.get(signal_open)
        if index is None or snapshot is None or index < 20:
            continue
        signal_candle = setup_candles[index]
        context_position = _snapshot_position_at(context_snapshots, event.signal_time)
        if context_position is None:
            continue
        context_snapshot = context_snapshots[context_position]
        phase, bars_since = _context_phase(
            context_snapshots, context_position, event.direction
        )
        setup_patterns, setup_confirmed = _recent_nison_patterns(
            setup_candles,
            setup_timeframe,
            event.signal_time,
            event.direction,
        )
        context_patterns, context_confirmed = _recent_nison_patterns(
            sorted(candles_by_timeframe[context_timeframe], key=lambda c: c.open_time),
            context_timeframe,
            event.signal_time,
            event.direction,
        )
        candle_range = max(signal_candle.high - signal_candle.low, 1e-12)
        body = abs(signal_candle.close - signal_candle.open)
        crossed_periods = tuple(
            sorted(
                period
                for period, price in snapshot.emas.items()
                if signal_candle.low <= price <= signal_candle.high
                and (
                    (event.direction == "SELL" and signal_candle.close < price)
                    or (event.direction == "BUY" and signal_candle.close > price)
                )
            )
        )
        aggressive = (
            body / snapshot.atr >= 0.60
            and body / candle_range >= 0.60
            and bool(crossed_periods)
            and (
                (event.direction == "SELL" and signal_candle.close < signal_candle.open)
                or (event.direction == "BUY" and signal_candle.close > signal_candle.open)
            )
        )
        pre_ratio, breakout_ratio, monotonic, rising = _volume_features(
            setup_candles, index
        )
        boundary = (
            event.corridor.upper_boundary
            if event.direction == "SELL"
            else event.corridor.lower_boundary
        )
        touch_ratio, range_atr, compression = _compression_features(
            setup_candles, index, boundary, snapshot.atr
        )
        candidates.append(
            MtfCandidate(
                symbol=symbol,
                market=market,
                setup_timeframe=setup_timeframe,
                context_timeframe=context_timeframe,
                entry_timeframe=entry_timeframe,
                signal_time=event.signal_time,
                direction=event.direction,
                corridor=event.corridor,
                setup_event=event,
                setup_atr=snapshot.atr,
                signal_candle=signal_candle,
                context_phase=phase,
                context_histogram=context_snapshot.histogram,
                context_bars_since_cross=bars_since,
                setup_patterns=setup_patterns,
                context_patterns=context_patterns,
                nison_confirmed=setup_confirmed or context_confirmed,
                body_atr=body / snapshot.atr,
                body_share=body / candle_range,
                crossed_ema_periods=crossed_periods,
                aggressive_candle=aggressive,
                pre_volume_ratio=pre_ratio,
                breakout_volume_ratio=breakout_ratio,
                pre_volume_monotonic=monotonic,
                volume_pre_rising=rising,
                compression_touch_ratio=touch_ratio,
                compression_range_atr=range_atr,
                compression_detected=compression,
            )
        )
    return tuple(candidates)


def profile_accepts(candidate: MtfCandidate, profile: MtfProfile) -> bool:
    context_mode = profile.context_mode.upper()
    if context_mode == "CONTRACTION_OR_CROSS" and candidate.context_phase not in {
        "PRE_CROSS_CONTRACTION",
        "EXACT_CROSS",
        "RECENT_CROSS",
    }:
        return False
    if context_mode == "RECENT_CROSS" and candidate.context_phase not in {
        "EXACT_CROSS",
        "RECENT_CROSS",
    }:
        return False
    if context_mode == "PRE_CROSS" and candidate.context_phase != "PRE_CROSS_CONTRACTION":
        return False
    if context_mode not in {"ANY", "CONTRACTION_OR_CROSS", "RECENT_CROSS", "PRE_CROSS"}:
        raise ValueError(f"Неизвестный context_mode {profile.context_mode}")
    if profile.require_nison and not candidate.nison_confirmed:
        return False
    if profile.require_aggressive_candle and not candidate.aggressive_candle:
        return False
    volume_mode = profile.volume_mode.upper()
    if volume_mode == "PRE_RISING" and not candidate.volume_pre_rising:
        return False
    if volume_mode == "BREAKOUT" and candidate.breakout_volume_ratio < 1.30:
        return False
    if volume_mode == "PRE_OR_BREAKOUT" and not (
        candidate.volume_pre_rising or candidate.breakout_volume_ratio >= 1.30
    ):
        return False
    if volume_mode not in {"ANY", "PRE_RISING", "BREAKOUT", "PRE_OR_BREAKOUT"}:
        raise ValueError(f"Неизвестный volume_mode {profile.volume_mode}")
    if profile.require_compression and not candidate.compression_detected:
        return False
    return True


def _target_for_entry(
    candidate: MtfCandidate,
    entry_price: float,
    stop_price: float,
    profile: MtfProfile,
    config: CorridorConfig,
) -> TargetLevel | None:
    direction = candidate.direction
    far_cluster = (
        candidate.corridor.lower_cluster
        if direction == "SELL"
        else candidate.corridor.upper_cluster
    )
    raw_price = (
        candidate.corridor.lower_boundary
        if direction == "SELL"
        else candidate.corridor.upper_boundary
    )
    buffer_pct = (
        1.0
        if 200 in far_cluster.periods and candidate.setup_timeframe >= 240
        else config.tp_buffer_pct
    )
    executable = (
        raw_price * (1.0 + buffer_pct / 100.0)
        if direction == "SELL"
        else raw_price * (1.0 - buffer_pct / 100.0)
    )
    if (direction == "SELL" and executable >= entry_price) or (
        direction == "BUY" and executable <= entry_price
    ):
        return None
    gross_reward = abs(entry_price - executable) / entry_price * 100.0
    round_trip = 2.0 * (config.commission_rate + config.slippage_rate) * 100.0
    net_reward = gross_reward - round_trip
    risk_pct = abs(entry_price - stop_price) / entry_price * 100.0 + round_trip
    net_rr = net_reward / risk_pct if risk_pct > 0 else 0.0
    adequate = (
        net_reward >= profile.min_net_reward_pct and net_rr >= profile.min_net_rr
    )
    return TargetLevel(
        raw_price=raw_price,
        executable_price=executable,
        references=far_cluster.references,
        strength=timeframe_strength(candidate.setup_timeframe, config),
        strength_label="SETUP_TF",
        gross_reward_pct=gross_reward,
        net_reward_pct=net_reward,
        net_rr=net_rr,
        adequate=adequate,
        is_far_boundary=True,
    )


def build_profile_event(
    candidate: MtfCandidate,
    profile: MtfProfile,
    candles_by_timeframe: Mapping[int, Sequence[Candle]],
    config: CorridorConfig,
) -> CorridorEvent | None:
    if not profile_accepts(candidate, profile):
        return None
    entry_candles = sorted(
        candles_by_timeframe[candidate.entry_timeframe], key=lambda candle: candle.open_time
    )
    first_index = next(
        (
            index
            for index, candle in enumerate(entry_candles)
            if candle.open_time >= candidate.signal_time
        ),
        None,
    )
    if first_index is None:
        return None
    direction = candidate.direction
    start_boundary = (
        candidate.corridor.upper_boundary
        if direction == "SELL"
        else candidate.corridor.lower_boundary
    )
    buffer_value = candidate.setup_atr * config.stop_atr_buffer
    stop_price = (
        max(candidate.signal_candle.high, start_boundary) + buffer_value
        if direction == "SELL"
        else min(candidate.signal_candle.low, start_boundary) - buffer_value
    )
    immediate_price = entry_candles[first_index].open
    entry_mode = profile.entry_mode.upper()
    if entry_mode == "IMMEDIATE":
        entry_index = first_index
        entry_price = immediate_price
    elif entry_mode in {"PULLBACK_50", "PULLBACK_75"}:
        fraction = 0.50 if entry_mode == "PULLBACK_50" else 0.75
        entry_price = immediate_price + fraction * (start_boundary - immediate_price)
        end_time = candidate.signal_time + (
            profile.pullback_wait_setup_bars * candidate.setup_timeframe * 60_000
        )
        entry_index = -1
        provisional_target = _target_for_entry(
            candidate, entry_price, stop_price, profile, config
        )
        if provisional_target is None:
            return None
        for index in range(first_index, len(entry_candles)):
            candle = entry_candles[index]
            if candle.open_time >= end_time:
                break
            if direction == "SELL":
                if candle.high >= stop_price or candle.low <= provisional_target.executable_price:
                    break
                if candle.high >= entry_price:
                    entry_index = index
                    break
            else:
                if candle.low <= stop_price or candle.high >= provisional_target.executable_price:
                    break
                if candle.low <= entry_price:
                    entry_index = index
                    break
        if entry_index < 0:
            return None
    else:
        raise ValueError(f"Неизвестный entry_mode {profile.entry_mode}")
    target = _target_for_entry(candidate, entry_price, stop_price, profile, config)
    if target is None or not target.adequate:
        return None
    entry_time = entry_candles[entry_index].open_time
    patterns = tuple(dict.fromkeys(candidate.setup_patterns + candidate.context_patterns))
    exact_cross = candidate.context_phase == "EXACT_CROSS"
    bars_since = candidate.context_bars_since_cross
    macd_aligned = candidate.context_phase in {
        "EXACT_CROSS",
        "RECENT_CROSS",
        "POST_CROSS",
    }
    return CorridorEvent(
        symbol=candidate.symbol,
        signal_time=entry_time,
        base_timeframe=candidate.entry_timeframe,
        direction=direction,
        corridor=candidate.corridor,
        entry_price=entry_price,
        stop_price=stop_price,
        macd_aligned=macd_aligned,
        macd_cross=exact_cross,
        histogram_expanding=False,
        nison_patterns=patterns,
        targets=(target,),
        allowed=True,
        score=timeframe_strength(candidate.setup_timeframe, config),
        reasons=(),
        crossed_entire_gap=False,
        macd_bars_since_cross=bars_since,
        senior_trend_aligned=True,
    )
