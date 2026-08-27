"""Публичные регулярные свечи акций США через Yahoo Chart без API-ключей."""

from __future__ import annotations

import json
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from trading_platform.strategies.ema_corridor import Candle


YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"
INTERVALS: dict[int, tuple[str, str]] = {
    15: ("15m", "60d"),
    30: ("30m", "60d"),
    60: ("60m", "730d"),
    1440: ("1d", "5y"),
}


class YahooPublicError(RuntimeError):
    pass


def fetch_completed_stock_klines(
    symbol: str,
    timeframe_minutes: int,
    timeout: float = 20.0,
    attempts: int = 3,
) -> list[Candle]:
    """Загрузить доступную историю регулярной сессии для акции США."""

    if timeframe_minutes not in INTERVALS:
        raise ValueError(
            f"Для акций без ключа поддерживаются ТФ 15/30/60/1440, получен {timeframe_minutes}"
        )
    interval, history_range = INTERVALS[timeframe_minutes]
    params = urlencode(
        {
            "interval": interval,
            "range": history_range,
            "includePrePost": "false",
            "events": "div,splits",
        }
    )
    url = f"{YAHOO_CHART_URL}/{symbol.upper()}?{params}"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 EMA-Research/0.3"})
    last_error: Exception | None = None
    payload = None
    for attempt in range(max(1, attempts)):
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except Exception as exc:  # pragma: no cover - зависит от сети
            last_error = exc
            if attempt + 1 < max(1, attempts):
                time.sleep(0.5 * (attempt + 1))
    if payload is None:
        raise YahooPublicError(f"Yahoo недоступен для {symbol}: {last_error}") from last_error
    chart = payload.get("chart", {})
    if chart.get("error"):
        raise YahooPublicError(f"Yahoo {symbol}: {chart['error']}")
    results = chart.get("result") or []
    if not results:
        raise YahooPublicError(f"Yahoo не вернул данные {symbol}")
    result = results[0]
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators", {}).get("quote") or []
    if not indicators:
        raise YahooPublicError(f"Yahoo не вернул OHLCV {symbol}")
    quote = indicators[0]
    now_ms = int(time.time() * 1000)
    duration_ms = timeframe_minutes * 60_000
    candles: list[Candle] = []
    for index, timestamp in enumerate(timestamps):
        try:
            values = (
                quote["open"][index],
                quote["high"][index],
                quote["low"][index],
                quote["close"][index],
                quote["volume"][index],
            )
        except (KeyError, IndexError, TypeError):
            continue
        if any(value is None for value in values):
            continue
        # Yahoo иногда добавляет в конец внутридневного ряда техническую строку
        # официального Close: O=H=L=C и volume=0. Это не торговая свеча и она
        # не должна создавать новое пересечение MACD/EMA.
        if timeframe_minutes < 1440 and float(values[4]) <= 0:
            continue
        open_time = int(timestamp) * 1000
        if timeframe_minutes < 1440 and open_time + duration_ms > now_ms:
            continue
        candles.append(
            Candle(
                open_time=open_time,
                open=float(values[0]),
                high=float(values[1]),
                low=float(values[2]),
                close=float(values[3]),
                volume=float(values[4]),
            )
        )
    by_time = {candle.open_time: candle for candle in candles}
    ordered = sorted(by_time.values(), key=lambda candle: candle.open_time)
    if not ordered:
        raise YahooPublicError(f"Yahoo не вернул завершённые свечи {symbol}")
    return ordered
