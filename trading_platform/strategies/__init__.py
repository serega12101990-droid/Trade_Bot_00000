"""Подключаемые торговые стратегии без отправки ордеров."""

from .ema_corridor import (
    Candle,
    CorridorConfig,
    CorridorEvent,
    EmaCorridor,
    IndicatorSnapshot,
    TargetLevel,
    build_snapshot_series,
    build_target_ladder,
    detect_corridors,
    scan_corridor_events,
)

__all__ = [
    "Candle",
    "CorridorConfig",
    "CorridorEvent",
    "EmaCorridor",
    "IndicatorSnapshot",
    "TargetLevel",
    "build_snapshot_series",
    "build_target_ladder",
    "detect_corridors",
    "scan_corridor_events",
]

