"""Локальный кэш свечей акций США."""

from __future__ import annotations

import gzip
import json
import time
from dataclasses import asdict
from pathlib import Path

from trading_platform.data.yahoo_public import fetch_completed_stock_klines
from trading_platform.strategies.ema_corridor import Candle


DEFAULT_CACHE_DIR = Path(__file__).resolve().parent / "stock_cache"


def load_or_fetch_stock_klines(
    symbol: str,
    timeframe: int,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    max_age_hours: float = 12.0,
    refresh: bool = False,
) -> tuple[list[Candle], str]:
    path = cache_dir / f"{symbol.upper()}_{timeframe}m.json.gz"
    if path.exists() and not refresh:
        try:
            with gzip.open(path, "rt", encoding="utf-8") as stream:
                payload = json.load(stream)
            age_ms = int(time.time() * 1000) - int(payload.get("saved_at_ms", 0))
            candles = [Candle(**item) for item in payload.get("candles", [])]
            if timeframe < 1440:
                candles = [candle for candle in candles if candle.volume > 0]
            candles.sort(key=lambda candle: candle.open_time)
            if age_ms <= max_age_hours * 3_600_000 and candles:
                return candles, "cache"
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    candles = fetch_completed_stock_klines(symbol, timeframe)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    payload = {
        "symbol": symbol.upper(),
        "timeframe": timeframe,
        "saved_at_ms": int(time.time() * 1000),
        "candles": [asdict(candle) for candle in candles],
    }
    with gzip.open(temporary, "wt", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(path)
    return candles, "network"
