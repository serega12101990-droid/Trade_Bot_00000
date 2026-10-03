"""Текущий технический watchlist EMA/MACD без отправки ордеров.

Модуль не пытается предсказать рынок. Он формализует возможный сценарий:
где ждать закрытие пробойной свечи, где допустим откат, где сценарий отменён и
какие завершённые EMA могут стать препятствиями/целями.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Mapping, Sequence

from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    EmaCorridor,
    IndicatorSnapshot,
    build_snapshot_series,
    detect_corridors,
    latest_snapshot_at,
)
from trading_platform.strategies.mtf_ema_setup import (
    _compression_features,
    _context_phase,
    _recent_nison_patterns,
    _snapshot_position_at,
    _volume_features,
)


@dataclass(frozen=True)
class EntryIdea:
    market: str
    symbol: str
    asof_time: int
    setup_timeframe: int
    context_timeframe: int
    entry_timeframe: int
    direction: str
    stage: str
    corridor_label: str
    current_close: float
    start_boundary: float
    far_boundary: float
    entry_zone_low: float
    entry_zone_high: float
    invalidation: float
    target_1: float
    target_1_label: str
    target_2: float
    estimated_rr_to_target_1: float
    progress_pct: float
    context_phase: str
    context_bars_since_cross: int | None
    nison_patterns: tuple[str, ...]
    aggressive_candle: bool
    volume_confirmation: bool
    compression: bool
    senior_alignment: bool
    score: float
    grade: str
    action: str
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _matching_corridor(
    corridor: EmaCorridor, previous: Sequence[EmaCorridor]
) -> EmaCorridor | None:
    return next((item for item in previous if item.key == corridor.key), None)


def _senior_alignment(snapshot: IndicatorSnapshot | None, direction: str) -> bool:
    if snapshot is None:
        return False
    ema20 = snapshot.emas.get(20)
    ema50 = snapshot.emas.get(50)
    if ema20 is None or ema50 is None:
        return False
    if direction == "BUY":
        votes = (
            snapshot.close > ema50,
            ema20 > ema50,
            snapshot.histogram >= 0,
        )
    else:
        votes = (
            snapshot.close < ema50,
            ema20 < ema50,
            snapshot.histogram <= 0,
        )
    return sum(votes) >= 2


def _context_is_usable(phase: str, bars_since: int | None) -> bool:
    return phase in {"PRE_CROSS_CONTRACTION", "EXACT_CROSS", "RECENT_CROSS"} or (
        phase == "POST_CROSS" and bars_since is not None and bars_since <= 5
    )


def _buffered_target(
    price: float,
    direction: str,
    buffer_pct: float,
) -> float:
    if direction == "SELL":
        return price * (1.0 + buffer_pct / 100.0)
    return price * (1.0 - buffer_pct / 100.0)


def _senior_obstacle(
    snapshots_by_tf: Mapping[int, Sequence[IndicatorSnapshot]],
    cutoff: int,
    setup_timeframe: int,
    direction: str,
    entry: float,
    far_boundary: float,
) -> tuple[float, str, int] | None:
    obstacles: list[tuple[float, str, int]] = []
    for timeframe, snapshots in snapshots_by_tf.items():
        if timeframe < setup_timeframe:
            continue
        snapshot = latest_snapshot_at(snapshots, cutoff)
        if snapshot is None:
            continue
        for period, price in snapshot.emas.items():
            inside = (
                far_boundary < price < entry
                if direction == "SELL"
                else entry < price < far_boundary
            )
            if not inside:
                continue
            obstacles.append((price, f"{timeframe}m EMA{period}", period))
    if not obstacles:
        return None
    return min(obstacles, key=lambda item: abs(entry - item[0]))


def _estimated_rr(
    entry: float,
    stop: float,
    target: float,
    direction: str,
    config: CorridorConfig,
) -> float:
    if direction == "SELL" and not target < entry < stop:
        return 0.0
    if direction == "BUY" and not stop < entry < target:
        return 0.0
    round_trip = 2.0 * (config.commission_rate + config.slippage_rate) * entry
    reward = abs(entry - target) - round_trip
    risk = abs(entry - stop) + round_trip
    return reward / risk if risk > 0 else 0.0


def _direction_idea(
    market: str,
    symbol: str,
    setup_tf: int,
    context_tf: int,
    entry_tf: int,
    direction: str,
    corridor: EmaCorridor,
    previous_corridor: EmaCorridor | None,
    setup_candles: Sequence[Candle],
    setup_snapshots: Sequence[IndicatorSnapshot],
    context_candles: Sequence[Candle],
    context_snapshots: Sequence[IndicatorSnapshot],
    snapshots_by_tf: Mapping[int, Sequence[IndicatorSnapshot]],
    senior_snapshot: IndicatorSnapshot | None,
    config: CorridorConfig,
) -> EntryIdea | None:
    current = setup_snapshots[-1]
    previous = setup_snapshots[-2]
    candle = setup_candles[-1]
    previous_upper = previous_corridor.upper_boundary if previous_corridor else corridor.upper_boundary
    previous_lower = previous_corridor.lower_boundary if previous_corridor else corridor.lower_boundary
    start = corridor.upper_boundary if direction == "SELL" else corridor.lower_boundary
    far = corridor.lower_boundary if direction == "SELL" else corridor.upper_boundary
    tolerance = max(current.close * 0.03 / 100.0, current.atr * 0.10)
    proximity = max(current.close * 0.30 / 100.0, current.atr * 0.35)
    triggered = (
        previous.close >= previous_upper - tolerance
        and current.close < corridor.upper_boundary - tolerance
        and current.close > corridor.lower_boundary
        if direction == "SELL"
        else previous.close <= previous_lower + tolerance
        and current.close > corridor.lower_boundary + tolerance
        and current.close < corridor.upper_boundary
    )
    inside = corridor.lower_boundary < current.close < corridor.upper_boundary
    progress = (
        (corridor.upper_boundary - current.close) / corridor.width
        if direction == "SELL"
        else (current.close - corridor.lower_boundary) / corridor.width
    )
    progress = max(0.0, min(1.0, progress))
    on_start_side = (
        current.close >= corridor.upper_boundary
        if direction == "SELL"
        else current.close <= corridor.lower_boundary
    )
    near_start = abs(current.close - start) <= proximity
    if triggered:
        stage = "TRIGGERED"
    elif inside and progress <= 0.35:
        stage = "INSIDE_EARLY"
    elif on_start_side and near_start:
        stage = "WATCH_BREAK"
    else:
        return None

    context_position = _snapshot_position_at(context_snapshots, current.close_time)
    if context_position is None:
        return None
    phase, bars_since = _context_phase(context_snapshots, context_position, direction)
    context_usable = _context_is_usable(phase, bars_since)
    setup_patterns, setup_confirmed = _recent_nison_patterns(
        setup_candles, setup_tf, current.close_time, direction
    )
    context_patterns, context_confirmed = _recent_nison_patterns(
        context_candles, context_tf, current.close_time, direction
    )
    patterns = tuple(dict.fromkeys(setup_patterns + context_patterns))
    nison = setup_confirmed or context_confirmed

    candle_range = max(candle.high - candle.low, 1e-12)
    body = abs(candle.close - candle.open)
    crossed_start = candle.low <= start <= candle.high
    correct_color = candle.close < candle.open if direction == "SELL" else candle.close > candle.open
    aggressive = (
        current.atr > 0
        and body / current.atr >= 0.60
        and body / candle_range >= 0.60
        and crossed_start
        and correct_color
    )
    index = len(setup_candles) - 1
    _, breakout_ratio, _, pre_rising = _volume_features(setup_candles, index)
    volume = pre_rising or breakout_ratio >= 1.30
    touch_ratio, range_atr, compression = _compression_features(
        setup_candles, index, start, current.atr
    )
    senior = _senior_alignment(senior_snapshot, direction)

    if stage == "WATCH_BREAK":
        zone_half = max(current.atr * 0.10, current.close * 0.03 / 100.0)
        entry_low, entry_high = start - zone_half, start + zone_half
        planned_entry = start
    else:
        pullback = current.close + 0.50 * (start - current.close)
        entry_low, entry_high = sorted((current.close, pullback))
        planned_entry = pullback
    lookback = setup_candles[-7:]
    stop_buffer = current.atr * config.stop_atr_buffer
    invalidation = (
        max(start, max(item.high for item in lookback)) + stop_buffer
        if direction == "SELL"
        else min(start, min(item.low for item in lookback)) - stop_buffer
    )
    obstacle = _senior_obstacle(
        snapshots_by_tf,
        current.close_time,
        setup_tf,
        direction,
        planned_entry,
        far,
    )
    if obstacle is not None:
        raw_target, label, period = obstacle
    else:
        raw_target = far
        label = f"{setup_tf}m дальняя граница {corridor.label}"
        period = 200 if 200 in (
            corridor.lower_cluster.periods if direction == "SELL" else corridor.upper_cluster.periods
        ) else 0
    buffer_pct = 1.0 if period == 200 and setup_tf >= 240 else config.tp_buffer_pct
    target_1 = _buffered_target(raw_target, direction, buffer_pct)
    far_periods = (
        corridor.lower_cluster.periods if direction == "SELL" else corridor.upper_cluster.periods
    )
    far_buffer = 1.0 if 200 in far_periods and setup_tf >= 240 else config.tp_buffer_pct
    target_2 = _buffered_target(far, direction, far_buffer)
    rr = _estimated_rr(planned_entry, invalidation, target_1, direction, config)

    score = 0.0
    score += {"TRIGGERED": 2.0, "INSIDE_EARLY": 1.5, "WATCH_BREAK": 0.8}[stage]
    score += {
        "EXACT_CROSS": 2.0,
        "RECENT_CROSS": 1.8,
        "PRE_CROSS_CONTRACTION": 1.5,
        "POST_CROSS": 0.7 if bars_since is not None and bars_since <= 5 else 0.0,
    }.get(phase, 0.0)
    score += 1.0 if nison else 0.0
    score += 1.0 if aggressive else 0.0
    score += 0.7 if volume else 0.0
    score += 0.5 if compression else 0.0
    score += 0.7 if senior else 0.0
    score += min(max(rr, 0.0), 2.0) * 0.35
    if setup_tf == 15:
        score -= 0.4
    if progress > 0.35:
        score -= 2.0

    warnings: list[str] = []
    if not context_usable:
        warnings.append("MACD старшего ТФ пока не подтверждает сценарий")
    if not senior:
        warnings.append("дневная/недельная основа не совпадает с направлением")
    if rr < 0.8:
        warnings.append("до первой сильной EMA недостаточный расчётный R:R")
    if stage == "INSIDE_EARLY" and not triggered:
        warnings.append("первичное пересечение уже произошло раньше; нужен откат, не погоня за ценой")
    if setup_tf == 15:
        warnings.append("15m в историческом тесте был слабым и используется только как ранний триггер")

    if score >= 6.5 and context_usable and rr >= 0.8 and stage != "WATCH_BREAK":
        grade = "A"
        action = "WAIT_PULLBACK_ENTRY"
    elif score >= 5.0 and context_usable and senior and rr >= 0.8:
        grade = "B"
        action = "WAIT_TRIGGER_OR_PULLBACK"
    elif score >= 3.5:
        grade = "C"
        action = "WATCH_ONLY"
    else:
        return None
    return EntryIdea(
        market=market,
        symbol=symbol,
        asof_time=current.close_time,
        setup_timeframe=setup_tf,
        context_timeframe=context_tf,
        entry_timeframe=entry_tf,
        direction=direction,
        stage=stage,
        corridor_label=corridor.label,
        current_close=current.close,
        start_boundary=start,
        far_boundary=far,
        entry_zone_low=entry_low,
        entry_zone_high=entry_high,
        invalidation=invalidation,
        target_1=target_1,
        target_1_label=label,
        target_2=target_2,
        estimated_rr_to_target_1=rr,
        progress_pct=progress * 100.0,
        context_phase=phase,
        context_bars_since_cross=bars_since,
        nison_patterns=patterns,
        aggressive_candle=aggressive,
        volume_confirmation=volume,
        compression=compression,
        senior_alignment=senior,
        score=score,
        grade=grade,
        action=action,
        warnings=tuple(warnings),
    )


def scan_symbol_entry_ideas(
    market: str,
    symbol: str,
    candles_by_timeframe: Mapping[int, Sequence[Candle]],
    roles: Sequence[tuple[int, int, int]],
    config: CorridorConfig,
) -> tuple[EntryIdea, ...]:
    snapshots_by_tf = {
        timeframe: build_snapshot_series(candles, timeframe, config)
        for timeframe, candles in candles_by_timeframe.items()
    }
    ideas: list[EntryIdea] = []
    for setup_tf, context_tf, entry_tf in roles:
        setup_candles = sorted(candles_by_timeframe[setup_tf], key=lambda c: c.open_time)
        context_candles = sorted(candles_by_timeframe[context_tf], key=lambda c: c.open_time)
        setup_snapshots = snapshots_by_tf.get(setup_tf, [])
        context_snapshots = snapshots_by_tf.get(context_tf, [])
        if len(setup_snapshots) < 2 or not context_snapshots:
            continue
        current_corridors = detect_corridors(setup_snapshots[-1], config)
        previous_corridors = detect_corridors(setup_snapshots[-2], config)
        senior_tf = 10080 if market == "CRYPTO" and 10080 in snapshots_by_tf else 1440
        senior = latest_snapshot_at(
            snapshots_by_tf.get(senior_tf, []), setup_snapshots[-1].close_time
        )
        for corridor in current_corridors:
            previous_corridor = _matching_corridor(corridor, previous_corridors)
            for direction in ("BUY", "SELL"):
                idea = _direction_idea(
                    market,
                    symbol,
                    setup_tf,
                    context_tf,
                    entry_tf,
                    direction,
                    corridor,
                    previous_corridor,
                    setup_candles,
                    setup_snapshots,
                    context_candles,
                    context_snapshots,
                    snapshots_by_tf,
                    senior,
                    config,
                )
                if idea is not None:
                    ideas.append(idea)
    ideas.sort(
        key=lambda item: (
            item.grade == "A",
            item.grade == "B",
            item.score,
            item.setup_timeframe,
        ),
        reverse=True,
    )
    selected: list[EntryIdea] = []
    used: set[tuple[str, int]] = set()
    for idea in ideas:
        key = (idea.direction, idea.setup_timeframe)
        if key in used:
            continue
        selected.append(idea)
        used.add(key)
        if len(selected) >= 2:
            break
    return tuple(selected)
