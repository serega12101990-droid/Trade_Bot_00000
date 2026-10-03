"""Локальный кэш публичных свечей для повторяемых исследований."""

from __future__ import annotations

import gzip
import json
import time
from dataclasses import asdict
from pathlib import Path

from trading_platform.data.bybit_public import fetch_completed_klines
from trading_platform.strategies.ema_corridor import Candle


DEFAULT_CACHE_DIR = Path(__file__).resolve().parent / "cache"


def _cache_path(cache_dir: Path, symbol: str, timeframe: int) -> Path:
    safe_symbol = "".join(char for char in symbol.upper() if char.isalnum() or char in "-_")
    return cache_dir / f"{safe_symbol}_{timeframe}m.json.gz"


def _read_cache(path: Path) -> tuple[int, list[Candle]]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        payload = json.load(stream)
    candles = [Candle(**item) for item in payload.get("candles", [])]
    candles.sort(key=lambda candle: candle.open_time)
    return int(payload.get("saved_at_ms", 0)), candles


def _write_cache(path: Path, symbol: str, timeframe: int, candles: list[Candle]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "symbol": symbol.upper(),
        "timeframe": timeframe,
        "saved_at_ms": int(time.time() * 1000),
        "candles": [asdict(candle) for candle in candles],
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(path)


def load_or_fetch_completed_klines(
    symbol: str,
    timeframe: int,
    limit: int,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    max_age_hours: float = 12.0,
    refresh: bool = False,
) -> tuple[list[Candle], str]:
    """Вернуть свечи и источник результата: ``cache`` или ``network``."""

    requested = max(1, int(limit))
    path = _cache_path(cache_dir, symbol, timeframe)
    if path.exists() and not refresh:
        try:
            saved_at_ms, candles = _read_cache(path)
            age_ms = int(time.time() * 1000) - saved_at_ms
            fresh = age_ms <= max_age_hours * 3_600_000
            if fresh and len(candles) >= requested:
                return candles[-requested:], "cache"
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass

    candles = fetch_completed_klines(symbol, timeframe, limit=requested)
    _write_cache(path, symbol, timeframe, candles)
    return candles, "network"
