"""Публичная загрузка завершённых свечей без API-ключей.

Основной источник — Bybit. Если Bybit недоступен из текущей сети, используется
публичная история OKX perpetual swaps. Загрузчик умеет получать несколько страниц
истории и никогда не возвращает незавершённую свечу.
"""

from __future__ import annotations

import json
import time
from typing import Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from trading_platform.strategies.ema_corridor import Candle


PUBLIC_KLINE_URL = "https://api.bybit.com/v5/market/kline"
OKX_HISTORY_KLINE_URL = "https://www.okx.com/api/v5/market/history-candles"
OKX_BARS = {
    5: "5m",
    15: "15m",
    30: "30m",
    60: "1H",
    240: "4H",
    1440: "1Dutc",
    10080: "1Wutc",
}
MAX_HISTORY_CANDLES = 50_000


class BybitPublicError(RuntimeError):
    pass


def _interval_value(timeframe_minutes: int) -> str:
    if timeframe_minutes == 10080:
        return "W"
    if timeframe_minutes == 1440:
        return "D"
    if timeframe_minutes in {1, 3, 5, 15, 30, 60, 120, 240, 360, 720}:
        return str(timeframe_minutes)
    raise ValueError(f"Bybit не поддерживает ТФ {timeframe_minutes} минут")


def _completed_candles(
    rows: Iterable[object],
    timeframe_minutes: int,
    now_ms: int,
    require_confirm: bool = False,
) -> list[Candle]:
    duration_ms = timeframe_minutes * 60_000
    candles: list[Candle] = []
    for value in rows:
        if not isinstance(value, (list, tuple)) or len(value) < 6:
            continue
        if require_confirm and len(value) >= 9 and str(value[8]) != "1":
            continue
        open_time = int(value[0])
        if open_time + duration_ms > now_ms:
            continue
        candles.append(
            Candle(
                open_time=open_time,
                open=float(value[1]),
                high=float(value[2]),
                low=float(value[3]),
                close=float(value[4]),
                volume=float(value[5]),
            )
        )
    return candles


def _fetch_json(url: str, timeout: float) -> dict[str, object]:
    request = Request(url, headers={"User-Agent": "EMA-Corridor-Analyzer/0.2"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _fetch_bybit_history(
    symbol: str,
    timeframe_minutes: int,
    limit: int,
    category: str,
    timeout: float,
) -> list[Candle]:
    interval = _interval_value(timeframe_minutes)
    now_ms = int(time.time() * 1000)
    by_open_time: dict[int, Candle] = {}
    end_ms: int | None = None

    while len(by_open_time) < limit:
        page_size = min(1000, limit - len(by_open_time))
        params: dict[str, object] = {
            "category": category,
            "symbol": symbol.upper(),
            "interval": interval,
            "limit": page_size,
        }
        if end_ms is not None:
            params["end"] = end_ms
        payload = _fetch_json(f"{PUBLIC_KLINE_URL}?{urlencode(params)}", timeout)
        if payload.get("retCode") != 0:
            raise BybitPublicError(
                f"Bybit {payload.get('retCode')}: {payload.get('retMsg')}"
            )
        rows = payload.get("result", {}).get("list", [])  # type: ignore[union-attr]
        page = _completed_candles(rows, timeframe_minutes, now_ms)
        if not page:
            break
        previous_count = len(by_open_time)
        for candle in page:
            by_open_time[candle.open_time] = candle
        oldest = min(candle.open_time for candle in page)
        if len(by_open_time) == previous_count or (end_ms is not None and oldest >= end_ms):
            break
        end_ms = oldest - 1

    return sorted(by_open_time.values(), key=lambda candle: candle.open_time)[-limit:]


def _okx_instrument(symbol: str) -> str:
    normalized = symbol.upper()
    base = normalized[:-4] if normalized.endswith("USDT") else normalized
    return f"{base}-USDT-SWAP"


def _fetch_okx_history(
    symbol: str,
    timeframe_minutes: int,
    limit: int,
    timeout: float,
) -> list[Candle]:
    if timeframe_minutes not in OKX_BARS:
        raise ValueError(f"OKX не поддерживает ТФ {timeframe_minutes} минут")
    instrument = _okx_instrument(symbol)
    now_ms = int(time.time() * 1000)
    by_open_time: dict[int, Candle] = {}
    after_ms: int | None = None

    while len(by_open_time) < limit:
        page_size = min(300, limit - len(by_open_time))
        params: dict[str, object] = {
            "instId": instrument,
            "bar": OKX_BARS[timeframe_minutes],
            "limit": page_size,
        }
        if after_ms is not None:
            params["after"] = after_ms
        payload = _fetch_json(f"{OKX_HISTORY_KLINE_URL}?{urlencode(params)}", timeout)
        if payload.get("code") != "0":
            raise BybitPublicError(f"OKX {payload.get('code')}: {payload.get('msg')}")
        page = _completed_candles(
            payload.get("data", []), timeframe_minutes, now_ms, require_confirm=True
        )
        if not page:
            break
        previous_count = len(by_open_time)
        for candle in page:
            by_open_time[candle.open_time] = candle
        oldest = min(candle.open_time for candle in page)
        if len(by_open_time) == previous_count or (
            after_ms is not None and oldest >= after_ms
        ):
            break
        after_ms = oldest
        # Публичный лимит OKX — 20 запросов за 2 секунды.
        if len(by_open_time) < limit:
            time.sleep(0.11)

    candles = sorted(by_open_time.values(), key=lambda candle: candle.open_time)[-limit:]
    if not candles:
        raise BybitPublicError(f"OKX не вернул закрытые свечи {instrument}")
    return candles


def fetch_completed_klines(
    symbol: str,
    timeframe_minutes: int,
    limit: int = 500,
    category: str = "linear",
    timeout: float = 15.0,
) -> list[Candle]:
    """Получить последние ``limit`` полностью завершённых свечей.

    Метод публичный: API-ключи не читаются и не требуются. Значения больше одной
    страницы автоматически загружаются порциями. При недоступности Bybit весь
    набор берётся с OKX, чтобы не смешивать котировки двух бирж в одном ТФ.
    """

    requested = max(1, min(int(limit), MAX_HISTORY_CANDLES))
    bybit_error: Exception | None = None
    try:
        candles = _fetch_bybit_history(
            symbol, timeframe_minutes, requested, category, timeout
        )
        if candles:
            return candles
        bybit_error = BybitPublicError("Bybit не вернул завершённые свечи")
    except Exception as exc:  # pragma: no cover - зависит от сети
        bybit_error = exc

    try:
        return _fetch_okx_history(symbol, timeframe_minutes, requested, timeout)
    except Exception as okx_error:  # pragma: no cover - зависит от сети
        raise BybitPublicError(
            f"Bybit недоступен ({bybit_error}); OKX fallback недоступен ({okx_error})"
        ) from okx_error
