"""Стратегия свободных EMA-коридоров.

Модуль намеренно не знает об API-ключах и не умеет отправлять ордера. Он:

* рассчитывает EMA20/50/200 исключительно по Close;
* находит свободные интервалы между EMA или EMA-кластерами;
* проецирует EMA других таймфреймов внутрь интервала;
* строит лестницу потенциальных Take Profit;
* усиливает значимость уровня вместе со старшинством таймфрейма;
* сканирует только завершённые свечи без look-ahead.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import asdict, dataclass, field
from math import log2
from typing import Iterable, Mapping, Sequence


EMA_PERIODS = (20, 50, 200)
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIGNAL = 9


@dataclass(frozen=True)
class Candle:
    """Одна полностью завершённая OHLCV-свеча."""

    open_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    def close_time(self, timeframe_minutes: int) -> int:
        return self.open_time + timeframe_minutes * 60_000


@dataclass(frozen=True)
class CorridorConfig:
    """Регулируемые параметры стратегии.

    Процентные величины записываются как проценты: 0.15 означает 0.15%.
    Комиссия и проскальзывание записываются долями: 0.00055 означает 0.055%.
    """

    ema_periods: tuple[int, ...] = EMA_PERIODS
    atr_period: int = 14
    min_gap_pct: float = 0.15
    min_gap_atr: float = 0.50
    cluster_tolerance_pct: float = 0.05
    cluster_tolerance_atr: float = 0.15
    target_merge_pct: float = 0.05
    tp_buffer_pct: float = 0.05
    entry_tolerance_pct: float = 0.03
    entry_tolerance_atr: float = 0.10
    stop_mode: str = "LOOKBACK"
    stop_lookback: int = 8
    stop_atr_buffer: float = 0.25
    commission_rate: float = 0.00055
    slippage_rate: float = 0.00020
    min_net_reward_pct: float = 0.30
    min_net_rr: float = 1.20
    require_macd_alignment: bool = True
    require_recent_macd_cross: bool = False
    macd_cross_lookback: int = 6
    require_histogram_expansion: bool = False
    require_nison_pattern: bool = False
    require_trend_alignment: bool = False
    trend_filter_timeframes: tuple[int, ...] = ()
    trend_filter_mode: str = "EMA20_50"
    obstacle_timeframe_mode: str = "ALL"
    timeframe_weights: Mapping[int, float] = field(
        default_factory=lambda: {
            5: 0.75,
            15: 1.00,
            30: 1.50,
            60: 2.00,
            240: 3.00,
            1440: 5.00,
            10080: 8.00,
        }
    )

    @classmethod
    def from_mapping(cls, values: Mapping[str, object]) -> "CorridorConfig":
        allowed = set(cls.__dataclass_fields__)
        cleaned = {key: value for key, value in values.items() if key in allowed}
        if "ema_periods" in cleaned:
            cleaned["ema_periods"] = tuple(int(v) for v in cleaned["ema_periods"])
        if "trend_filter_timeframes" in cleaned:
            cleaned["trend_filter_timeframes"] = tuple(
                int(v) for v in cleaned["trend_filter_timeframes"]
            )
        if "timeframe_weights" in cleaned:
            raw = cleaned["timeframe_weights"]
            if isinstance(raw, Mapping):
                cleaned["timeframe_weights"] = {
                    int(key): float(value) for key, value in raw.items()
                }
        return cls(**cleaned)


@dataclass(frozen=True)
class EmaReference:
    timeframe: int
    period: int
    price: float

    @property
    def name(self) -> str:
        return f"{self.timeframe_label}:EMA{self.period}"

    @property
    def timeframe_label(self) -> str:
        return format_timeframe(self.timeframe)


@dataclass(frozen=True)
class EmaCluster:
    references: tuple[EmaReference, ...]

    @property
    def lower_price(self) -> float:
        return min(ref.price for ref in self.references)

    @property
    def upper_price(self) -> float:
        return max(ref.price for ref in self.references)

    @property
    def periods(self) -> tuple[int, ...]:
        return tuple(sorted({ref.period for ref in self.references}))

    @property
    def label(self) -> str:
        return "+".join(f"EMA{period}" for period in self.periods)


@dataclass(frozen=True)
class IndicatorSnapshot:
    timeframe: int
    open_time: int
    close_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    atr: float
    emas: Mapping[int, float]
    macd_line: float
    signal_line: float
    histogram: float


@dataclass(frozen=True)
class EmaCorridor:
    timeframe: int
    lower_cluster: EmaCluster
    upper_cluster: EmaCluster
    lower_boundary: float
    upper_boundary: float
    width: float
    width_pct: float
    width_atr: float

    @property
    def key(self) -> tuple[tuple[int, ...], tuple[int, ...]]:
        return self.lower_cluster.periods, self.upper_cluster.periods

    @property
    def label(self) -> str:
        return f"{self.lower_cluster.label}↔{self.upper_cluster.label}"


@dataclass(frozen=True)
class TargetLevel:
    raw_price: float
    executable_price: float
    references: tuple[EmaReference, ...]
    strength: float
    strength_label: str
    gross_reward_pct: float
    net_reward_pct: float
    net_rr: float
    adequate: bool
    is_far_boundary: bool = False

    @property
    def label(self) -> str:
        return " + ".join(ref.name for ref in self.references)


@dataclass(frozen=True)
class CorridorEvent:
    symbol: str
    signal_time: int
    base_timeframe: int
    direction: str
    corridor: EmaCorridor
    entry_price: float
    stop_price: float
    macd_aligned: bool
    macd_cross: bool
    histogram_expanding: bool
    nison_patterns: tuple[str, ...]
    targets: tuple[TargetLevel, ...]
    allowed: bool
    score: float
    reasons: tuple[str, ...]
    crossed_entire_gap: bool = False
    macd_bars_since_cross: int | None = None
    senior_trend_aligned: bool | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def format_timeframe(minutes: int) -> str:
    if minutes % 10080 == 0:
        return f"{minutes // 10080}W"
    if minutes % 1440 == 0:
        return f"{minutes // 1440}D"
    if minutes % 60 == 0:
        return f"{minutes // 60}H"
    return f"{minutes}m"


def _ema_series(values: Sequence[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return result
    seed = sum(values[:period]) / period
    result[period - 1] = seed
    multiplier = 2.0 / (period + 1.0)
    previous = seed
    for index in range(period, len(values)):
        previous = (values[index] - previous) * multiplier + previous
        result[index] = previous
    return result


def _atr_series(candles: Sequence[Candle], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(candles)
    if period <= 0 or len(candles) < period:
        return result
    true_ranges: list[float] = []
    for index, candle in enumerate(candles):
        if index == 0:
            true_range = candle.high - candle.low
        else:
            previous_close = candles[index - 1].close
            true_range = max(
                candle.high - candle.low,
                abs(candle.high - previous_close),
                abs(candle.low - previous_close),
            )
        true_ranges.append(true_range)
    seed = sum(true_ranges[:period]) / period
    result[period - 1] = seed
    previous = seed
    for index in range(period, len(true_ranges)):
        previous = ((period - 1) * previous + true_ranges[index]) / period
        result[index] = previous
    return result


def _macd_series(
    closes: Sequence[float],
    fast: int = MACD_FAST,
    slow: int = MACD_SLOW,
    signal: int = MACD_SIGNAL,
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    fast_values = _ema_series(closes, fast)
    slow_values = _ema_series(closes, slow)
    macd: list[float | None] = [None] * len(closes)
    valid_macd: list[float] = []
    valid_indices: list[int] = []
    for index, (fast_value, slow_value) in enumerate(zip(fast_values, slow_values)):
        if fast_value is None or slow_value is None:
            continue
        value = fast_value - slow_value
        macd[index] = value
        valid_macd.append(value)
        valid_indices.append(index)
    compact_signal = _ema_series(valid_macd, signal)
    signal_values: list[float | None] = [None] * len(closes)
    histogram: list[float | None] = [None] * len(closes)
    for compact_index, candle_index in enumerate(valid_indices):
        signal_value = compact_signal[compact_index]
        if signal_value is None:
            continue
        signal_values[candle_index] = signal_value
        histogram[candle_index] = valid_macd[compact_index] - signal_value
    return macd, signal_values, histogram


def build_snapshot_series(
    candles: Sequence[Candle],
    timeframe: int,
    config: CorridorConfig | None = None,
) -> list[IndicatorSnapshot]:
    """Рассчитать индикаторы для каждой доступной завершённой свечи."""

    cfg = config or CorridorConfig()
    ordered = sorted(candles, key=lambda candle: candle.open_time)
    closes = [candle.close for candle in ordered]
    ema_values = {period: _ema_series(closes, period) for period in cfg.ema_periods}
    atr_values = _atr_series(ordered, cfg.atr_period)
    macd_values, signal_values, histogram_values = _macd_series(closes)
    snapshots: list[IndicatorSnapshot] = []
    for index, candle in enumerate(ordered):
        current_emas = {
            period: values[index]
            for period, values in ema_values.items()
            if values[index] is not None
        }
        atr = atr_values[index]
        macd = macd_values[index]
        signal = signal_values[index]
        histogram = histogram_values[index]
        if (
            len(current_emas) != len(cfg.ema_periods)
            or atr is None
            or macd is None
            or signal is None
            or histogram is None
        ):
            continue
        snapshots.append(
            IndicatorSnapshot(
                timeframe=timeframe,
                open_time=candle.open_time,
                close_time=candle.close_time(timeframe),
                open=candle.open,
                high=candle.high,
                low=candle.low,
                close=candle.close,
                volume=candle.volume,
                atr=atr,
                emas={period: float(value) for period, value in current_emas.items()},
                macd_line=macd,
                signal_line=signal,
                histogram=histogram,
            )
        )
    return snapshots


def _cluster_tolerance(snapshot: IndicatorSnapshot, config: CorridorConfig) -> float:
    return max(
        snapshot.close * config.cluster_tolerance_pct / 100.0,
        snapshot.atr * config.cluster_tolerance_atr,
    )


def cluster_emas(
    snapshot: IndicatorSnapshot,
    config: CorridorConfig | None = None,
) -> tuple[EmaCluster, ...]:
    cfg = config or CorridorConfig()
    references = sorted(
        (
            EmaReference(snapshot.timeframe, int(period), float(price))
            for period, price in snapshot.emas.items()
            if period in cfg.ema_periods
        ),
        key=lambda ref: ref.price,
    )
    if not references:
        return ()
    tolerance = _cluster_tolerance(snapshot, cfg)
    groups: list[list[EmaReference]] = [[references[0]]]
    for reference in references[1:]:
        current_upper = max(item.price for item in groups[-1])
        if reference.price - current_upper <= tolerance:
            groups[-1].append(reference)
        else:
            groups.append([reference])
    return tuple(EmaCluster(tuple(group)) for group in groups)


def detect_corridors(
    snapshot: IndicatorSnapshot,
    config: CorridorConfig | None = None,
) -> tuple[EmaCorridor, ...]:
    """Найти свободные интервалы между соседними EMA-кластерами."""

    cfg = config or CorridorConfig()
    clusters = cluster_emas(snapshot, cfg)
    corridors: list[EmaCorridor] = []
    minimum_width = max(
        snapshot.close * cfg.min_gap_pct / 100.0,
        snapshot.atr * cfg.min_gap_atr,
    )
    for lower_cluster, upper_cluster in zip(clusters, clusters[1:]):
        lower_boundary = lower_cluster.upper_price
        upper_boundary = upper_cluster.lower_price
        width = upper_boundary - lower_boundary
        if width < minimum_width:
            continue
        corridors.append(
            EmaCorridor(
                timeframe=snapshot.timeframe,
                lower_cluster=lower_cluster,
                upper_cluster=upper_cluster,
                lower_boundary=lower_boundary,
                upper_boundary=upper_boundary,
                width=width,
                width_pct=width / snapshot.close * 100.0,
                width_atr=width / snapshot.atr if snapshot.atr > 0 else 0.0,
            )
        )
    return tuple(corridors)


def timeframe_strength(timeframe: int, config: CorridorConfig | None = None) -> float:
    cfg = config or CorridorConfig()
    if timeframe in cfg.timeframe_weights:
        return float(cfg.timeframe_weights[timeframe])
    return max(0.5, log2(max(timeframe, 1) / 5.0 + 1.0))


def _strength_label(strength: float) -> str:
    if strength >= 5.0:
        return "MAJOR"
    if strength >= 3.0:
        return "STRONG"
    if strength >= 1.5:
        return "MEDIUM"
    return "MINOR"


def _merge_target_groups(
    references: Sequence[EmaReference],
    direction: str,
    tolerance: float,
) -> list[list[EmaReference]]:
    reverse = direction == "SELL"
    ordered = sorted(references, key=lambda ref: ref.price, reverse=reverse)
    groups: list[list[EmaReference]] = []
    for reference in ordered:
        if not groups:
            groups.append([reference])
            continue
        representative = (
            max(item.price for item in groups[-1])
            if direction == "SELL"
            else min(item.price for item in groups[-1])
        )
        if abs(reference.price - representative) <= tolerance:
            groups[-1].append(reference)
        else:
            groups.append([reference])
    return groups


def build_target_ladder(
    corridor: EmaCorridor,
    direction: str,
    snapshots: Iterable[IndicatorSnapshot],
    entry_price: float,
    stop_price: float,
    config: CorridorConfig | None = None,
) -> tuple[TargetLevel, ...]:
    """Построить TP-лестницу из EMA всех переданных таймфреймов."""

    cfg = config or CorridorConfig()
    direction = direction.upper()
    if direction not in {"BUY", "SELL"}:
        raise ValueError("direction должен быть BUY или SELL")
    obstacle_mode = cfg.obstacle_timeframe_mode.upper()
    if obstacle_mode not in {"ALL", "SAME_OR_HIGHER"}:
        raise ValueError(
            "obstacle_timeframe_mode должен быть ALL или SAME_OR_HIGHER"
        )
    tolerance = entry_price * cfg.target_merge_pct / 100.0
    references: list[EmaReference] = []
    for snapshot in snapshots:
        if (
            obstacle_mode == "SAME_OR_HIGHER"
            and snapshot.timeframe < corridor.timeframe
        ):
            continue
        for period, price in snapshot.emas.items():
            if period not in cfg.ema_periods:
                continue
            if corridor.lower_boundary + tolerance < price < corridor.upper_boundary - tolerance:
                references.append(EmaReference(snapshot.timeframe, int(period), float(price)))

    far_cluster = corridor.upper_cluster if direction == "BUY" else corridor.lower_cluster
    far_price = corridor.upper_boundary if direction == "BUY" else corridor.lower_boundary
    far_refs = tuple(far_cluster.references)
    references.extend(far_refs)
    groups = _merge_target_groups(references, direction, tolerance)

    round_trip_cost_pct = 2.0 * (cfg.commission_rate + cfg.slippage_rate) * 100.0
    gross_risk_pct = (
        abs(entry_price - stop_price) / entry_price * 100.0 if entry_price > 0 else 0.0
    )
    risk_with_costs = gross_risk_pct + round_trip_cost_pct
    levels: list[TargetLevel] = []
    for group in groups:
        raw_price = max(ref.price for ref in group) if direction == "SELL" else min(
            ref.price for ref in group
        )
        if direction == "SELL":
            executable_price = raw_price * (1.0 + cfg.tp_buffer_pct / 100.0)
            if executable_price >= entry_price:
                continue
            gross_reward_pct = (entry_price - executable_price) / entry_price * 100.0
        else:
            executable_price = raw_price * (1.0 - cfg.tp_buffer_pct / 100.0)
            if executable_price <= entry_price:
                continue
            gross_reward_pct = (executable_price - entry_price) / entry_price * 100.0
        net_reward_pct = gross_reward_pct - round_trip_cost_pct
        net_rr = net_reward_pct / risk_with_costs if risk_with_costs > 0 else 0.0
        strength = max(timeframe_strength(ref.timeframe, cfg) for ref in group)
        is_far = any(
            ref.timeframe == corridor.timeframe
            and ref.period in far_cluster.periods
            and abs(ref.price - far_price) <= tolerance
            for ref in group
        )
        adequate = (
            net_reward_pct >= cfg.min_net_reward_pct and net_rr >= cfg.min_net_rr
        )
        levels.append(
            TargetLevel(
                raw_price=raw_price,
                executable_price=executable_price,
                references=tuple(sorted(group, key=lambda ref: (ref.timeframe, ref.period))),
                strength=strength,
                strength_label=_strength_label(strength),
                gross_reward_pct=gross_reward_pct,
                net_reward_pct=net_reward_pct,
                net_rr=net_rr,
                adequate=adequate,
                is_far_boundary=is_far,
            )
        )
    return tuple(levels)


def latest_snapshot_at(
    snapshots: Sequence[IndicatorSnapshot],
    close_time: int,
) -> IndicatorSnapshot | None:
    """Последний снимок, который уже был полностью известен к close_time."""

    if not snapshots:
        return None
    times = [snapshot.close_time for snapshot in snapshots]
    index = bisect_right(times, close_time) - 1
    return snapshots[index] if index >= 0 else None


def _nison_patterns(previous: Candle, current: Candle) -> tuple[str, ...]:
    patterns: list[str] = []
    body = abs(current.close - current.open)
    candle_range = max(current.high - current.low, 1e-12)
    lower_shadow = min(current.open, current.close) - current.low
    upper_shadow = current.high - max(current.open, current.close)
    if body / candle_range <= 0.10:
        patterns.append("DOJI")
    if body > 0 and lower_shadow >= 2.0 * body and upper_shadow <= body:
        patterns.append("HAMMER")
    if body > 0 and upper_shadow >= 2.0 * body and lower_shadow <= body:
        patterns.append("SHOOTING_STAR")
    if (
        previous.close < previous.open
        and current.close > current.open
        and current.open <= previous.close
        and current.close >= previous.open
    ):
        patterns.append("BULLISH_ENGULFING")
    if (
        previous.close > previous.open
        and current.close < current.open
        and current.open >= previous.close
        and current.close <= previous.open
    ):
        patterns.append("BEARISH_ENGULFING")
    previous_body_low = min(previous.open, previous.close)
    previous_body_high = max(previous.open, previous.close)
    current_body_low = min(current.open, current.close)
    current_body_high = max(current.open, current.close)
    previous_body = previous_body_high - previous_body_low
    current_body = current_body_high - current_body_low
    inside_previous_body = (
        current_body_low >= previous_body_low
        and current_body_high <= previous_body_high
    )
    if (
        previous.close > previous.open
        and current.close < current.open
        and inside_previous_body
        and previous_body > 0
        and current_body <= previous_body * 0.65
    ):
        patterns.append("BEARISH_HARAMI")
    if (
        previous.close < previous.open
        and current.close > current.open
        and inside_previous_body
        and previous_body > 0
        and current_body <= previous_body * 0.65
    ):
        patterns.append("BULLISH_HARAMI")
    return tuple(patterns)


def _pattern_confirms(patterns: Sequence[str], direction: str) -> bool:
    if direction == "BUY":
        return any(
            pattern in {"HAMMER", "BULLISH_ENGULFING", "BULLISH_HARAMI"}
            for pattern in patterns
        )
    return any(
        pattern in {"SHOOTING_STAR", "BEARISH_ENGULFING", "BEARISH_HARAMI"}
        for pattern in patterns
    )


def _structural_stop(
    candles: Sequence[Candle],
    index: int,
    direction: str,
    atr: float,
    config: CorridorConfig,
    corridor: EmaCorridor,
) -> float:
    buffer_value = atr * config.stop_atr_buffer
    stop_mode = config.stop_mode.upper()
    if stop_mode == "BOUNDARY_ONLY":
        if direction == "SELL":
            return corridor.upper_boundary + buffer_value
        return corridor.lower_boundary - buffer_value
    if stop_mode == "BOUNDARY_SIGNAL":
        signal_candle = candles[index]
        if direction == "SELL":
            return max(signal_candle.high, corridor.upper_boundary) + buffer_value
        return min(signal_candle.low, corridor.lower_boundary) - buffer_value
    if stop_mode != "LOOKBACK":
        raise ValueError(
            "stop_mode должен быть LOOKBACK, BOUNDARY_SIGNAL или BOUNDARY_ONLY"
        )
    start = max(0, index - config.stop_lookback + 1)
    window = candles[start : index + 1]
    if direction == "SELL":
        return max(candle.high for candle in window) + buffer_value
    return min(candle.low for candle in window) - buffer_value


def _find_matching_corridor(
    corridor: EmaCorridor,
    previous: Sequence[EmaCorridor],
) -> EmaCorridor | None:
    for candidate in previous:
        if candidate.key == corridor.key:
            return candidate
    return None


def _bars_since_macd_cross(
    snapshots: Sequence[IndicatorSnapshot],
    position: int,
    direction: str,
    lookback: int,
) -> int | None:
    for offset in range(0, max(0, lookback) + 1):
        current_index = position - offset
        previous_index = current_index - 1
        if previous_index < 0:
            break
        previous = snapshots[previous_index]
        current = snapshots[current_index]
        if direction == "SELL":
            crossed = previous.histogram >= 0 > current.histogram
        else:
            crossed = previous.histogram <= 0 < current.histogram
        if crossed:
            return offset
    return None


def _snapshot_trend_aligned(
    snapshot: IndicatorSnapshot,
    direction: str,
    mode: str,
) -> bool:
    normalized_mode = mode.upper()
    if normalized_mode not in {"EMA20_50", "FULL_STACK", "MACD", "EMA_MACD"}:
        raise ValueError(
            "trend_filter_mode должен быть EMA20_50, FULL_STACK, MACD или EMA_MACD"
        )
    if direction == "BUY":
        ema_fast = snapshot.emas[20] > snapshot.emas[50]
        full_stack = snapshot.emas[20] > snapshot.emas[50] > snapshot.emas[200]
        macd = snapshot.macd_line > snapshot.signal_line and snapshot.histogram > 0
    else:
        ema_fast = snapshot.emas[20] < snapshot.emas[50]
        full_stack = snapshot.emas[20] < snapshot.emas[50] < snapshot.emas[200]
        macd = snapshot.macd_line < snapshot.signal_line and snapshot.histogram < 0
    if normalized_mode == "EMA20_50":
        return ema_fast
    if normalized_mode == "FULL_STACK":
        return full_stack
    if normalized_mode == "MACD":
        return macd
    return ema_fast and macd


def _multi_timeframe_trend_aligned(
    snapshots: Sequence[IndicatorSnapshot],
    direction: str,
    timeframes: Sequence[int],
    mode: str,
) -> bool:
    by_timeframe = {snapshot.timeframe: snapshot for snapshot in snapshots}
    if not timeframes:
        return True
    for timeframe in timeframes:
        snapshot = by_timeframe.get(timeframe)
        if snapshot is None or not _snapshot_trend_aligned(snapshot, direction, mode):
            return False
    return True


def scan_corridor_events(
    symbol: str,
    candles_by_timeframe: Mapping[int, Sequence[Candle]],
    base_timeframe: int,
    config: CorridorConfig | None = None,
) -> tuple[CorridorEvent, ...]:
    """Найти исторические входы в EMA-коридор без подглядывания в будущее.

    Сигнал формируется после закрытия базовой свечи. Цена условного исполнения —
    открытие следующей базовой свечи. EMA другого ТФ берётся только из снимка,
    закрывшегося не позднее сигнальной свечи.
    """

    cfg = config or CorridorConfig()
    if base_timeframe not in candles_by_timeframe:
        raise ValueError(f"Нет свечей базового ТФ {base_timeframe}")
    ordered_by_tf = {
        timeframe: sorted(candles, key=lambda candle: candle.open_time)
        for timeframe, candles in candles_by_timeframe.items()
    }
    snapshot_series = {
        timeframe: build_snapshot_series(candles, timeframe, cfg)
        for timeframe, candles in ordered_by_tf.items()
    }
    base_snapshots = snapshot_series.get(base_timeframe, [])
    base_candles = ordered_by_tf[base_timeframe]
    candle_index = {candle.open_time: index for index, candle in enumerate(base_candles)}
    events: list[CorridorEvent] = []
    for snapshot_position in range(1, len(base_snapshots)):
        previous_snapshot = base_snapshots[snapshot_position - 1]
        current_snapshot = base_snapshots[snapshot_position]
        index = candle_index.get(current_snapshot.open_time)
        if index is None or index < 1 or index + 1 >= len(base_candles):
            continue
        previous_candle = base_candles[index - 1]
        current_candle = base_candles[index]
        next_candle = base_candles[index + 1]
        previous_corridors = detect_corridors(previous_snapshot, cfg)
        current_corridors = detect_corridors(current_snapshot, cfg)
        for corridor in current_corridors:
            previous_corridor = _find_matching_corridor(corridor, previous_corridors)
            previous_upper = (
                previous_corridor.upper_boundary
                if previous_corridor is not None
                else corridor.upper_boundary
            )
            previous_lower = (
                previous_corridor.lower_boundary
                if previous_corridor is not None
                else corridor.lower_boundary
            )
            tolerance = max(
                current_snapshot.close * cfg.entry_tolerance_pct / 100.0,
                current_snapshot.atr * cfg.entry_tolerance_atr,
            )
            sell_entered = (
                previous_snapshot.close >= previous_upper - tolerance
                and current_snapshot.close < corridor.upper_boundary - tolerance
            )
            buy_entered = (
                previous_snapshot.close <= previous_lower + tolerance
                and current_snapshot.close > corridor.lower_boundary + tolerance
            )
            if not sell_entered and not buy_entered:
                continue
            direction = "SELL" if sell_entered else "BUY"
            crossed_entire_gap = (
                current_snapshot.close <= corridor.lower_boundary
                if direction == "SELL"
                else current_snapshot.close >= corridor.upper_boundary
            )
            entry_price = next_candle.open
            stop_price = _structural_stop(
                base_candles,
                index,
                direction,
                current_snapshot.atr,
                cfg,
                corridor,
            )
            aligned_snapshots = []
            for timeframe, snapshots in snapshot_series.items():
                aligned = latest_snapshot_at(snapshots, current_snapshot.close_time)
                if aligned is not None:
                    aligned_snapshots.append(aligned)
            targets = build_target_ladder(
                corridor,
                direction,
                aligned_snapshots,
                entry_price,
                stop_price,
                cfg,
            )
            senior_trend_aligned = (
                _multi_timeframe_trend_aligned(
                    aligned_snapshots,
                    direction,
                    cfg.trend_filter_timeframes,
                    cfg.trend_filter_mode,
                )
                if cfg.trend_filter_timeframes
                else None
            )
            if direction == "SELL":
                macd_aligned = (
                    current_snapshot.macd_line < current_snapshot.signal_line
                    and current_snapshot.histogram < 0
                )
                macd_cross = (
                    previous_snapshot.histogram >= 0 > current_snapshot.histogram
                )
            else:
                macd_aligned = (
                    current_snapshot.macd_line > current_snapshot.signal_line
                    and current_snapshot.histogram > 0
                )
                macd_cross = (
                    previous_snapshot.histogram <= 0 < current_snapshot.histogram
                )
            macd_bars_since_cross = _bars_since_macd_cross(
                base_snapshots,
                snapshot_position,
                direction,
                cfg.macd_cross_lookback,
            )
            histogram_expanding = (
                current_snapshot.histogram * previous_snapshot.histogram > 0
                and abs(current_snapshot.histogram) > abs(previous_snapshot.histogram)
            )
            patterns = _nison_patterns(previous_candle, current_candle)
            nison_confirmed = _pattern_confirms(patterns, direction)
            reasons: list[str] = []
            if crossed_entire_gap:
                reasons.append("сигнальная свеча уже прошла весь коридор")
            if cfg.require_macd_alignment and not macd_aligned:
                reasons.append("MACD 12/26/9 не подтверждает направление")
            if cfg.require_recent_macd_cross and macd_bars_since_cross is None:
                reasons.append(
                    f"нет пересечения MACD по направлению за {cfg.macd_cross_lookback} свечей"
                )
            if cfg.require_histogram_expansion and not histogram_expanding:
                reasons.append("гистограмма MACD не расширяется по направлению")
            if cfg.require_nison_pattern and not nison_confirmed:
                reasons.append("нет подтверждающей модели Нисона")
            if cfg.require_trend_alignment and not senior_trend_aligned:
                labels = ",".join(format_timeframe(tf) for tf in cfg.trend_filter_timeframes)
                reasons.append(
                    f"направление не подтверждено старшим трендом {labels} ({cfg.trend_filter_mode})"
                )
            if not targets:
                reasons.append("нет достижимой EMA-цели после исполнимого входа")
            elif not targets[0].adequate:
                reasons.append(
                    "до ближайшей EMA недостаточны чистая прибыль или R:R"
                )
            score = timeframe_strength(base_timeframe, cfg)
            if macd_aligned:
                score += 2.0
            if macd_cross:
                score += 1.0
            elif macd_bars_since_cross is not None:
                score += 0.5
            if histogram_expanding:
                score += 0.5
            if nison_confirmed:
                score += 1.0
            if cfg.trend_filter_timeframes and senior_trend_aligned:
                score += 1.0
            if targets:
                score += min(targets[0].strength, 5.0) * 0.25
            allowed = not reasons
            events.append(
                CorridorEvent(
                    symbol=symbol,
                    signal_time=current_snapshot.close_time,
                    base_timeframe=base_timeframe,
                    direction=direction,
                    corridor=corridor,
                    entry_price=entry_price,
                    stop_price=stop_price,
                    macd_aligned=macd_aligned,
                    macd_cross=macd_cross,
                    histogram_expanding=histogram_expanding,
                    nison_patterns=patterns,
                    targets=targets,
                    allowed=allowed,
                    score=score,
                    reasons=tuple(reasons),
                    crossed_entire_gap=crossed_entire_gap,
                    macd_bars_since_cross=macd_bars_since_cross,
                    senior_trend_aligned=senior_trend_aligned,
                )
            )
    return tuple(events)
