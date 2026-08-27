from __future__ import annotations

import csv
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


TERMINAL_ROOT = Path(__file__).resolve().parents[1]
BOT_ROOT = TERMINAL_ROOT.parent
PLATFORM_ROOT = BOT_ROOT / "trading_platform"
WIDGET_ROOT = Path.home() / "OneDrive" / "Desktop" / "VIdjet"
OUTPUT_PATH = TERMINAL_ROOT / "public" / "data" / "terminal_snapshot.json"

CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "TRXUSDT", "XRPUSDT"]
STOCKS = [
    "AMZN",
    "TSLA",
    "NFLX",
    "AMD",
    "CVNA",
    "HOOD",
    "COIN",
    "SMCI",
    "PANW",
    "COHR",
    "BSX",
    "CMG",
    "LULU",
    "DASH",
    "LITE",
    "CRWD",
    "APP",
    "UBER",
    "NBIS",
    "SNDK",
]
MOEX = [
    "LKOH", "SNGS", "SNGSP", "GAZP", "ROSN", "NVTK", "TATN", "TATNP", "SIBN", "BANEP",
    "SBER", "SBERP", "T", "MOEX", "VTBR", "GMKN", "CHMF", "NLMK", "MAGN", "PLZL",
    "ALRS", "RUAL", "YDEX", "MGNT", "OZON", "MTSS", "AFLT", "PHOR", "FLOT", "AFKS", "RAGR",
    "SOFL", "POSI", "DIAS", "WUSH", "HHEAD", "MTLR", "MTLRP", "RASP", "UGLD", "SELG",
    "VSMO", "TRMK", "SVAV", "KMAZ", "PIKK", "SMLT", "LSRG", "ETLN", "HNFG", "AQUA", "APTK",
    "IRAO", "HYDR", "FEES", "MSNG", "OGKB", "TGKN", "FESH", "NMTP",
]
TIMEFRAMES = {
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "4h": 240,
    "1d": 1440,
    "1w": 10080,
}

DEFAULT_NAMES = {
    "BTCUSDT": "Bitcoin",
    "ETHUSDT": "Ethereum",
    "SOLUSDT": "Solana",
    "TRXUSDT": "TRON",
    "XRPUSDT": "XRP",
    "AMZN": "Amazon",
    "TSLA": "Tesla",
    "NFLX": "Netflix",
    "AMD": "Advanced Micro Devices",
    "CVNA": "Carvana",
    "HOOD": "Robinhood",
    "COIN": "Coinbase",
    "SMCI": "Super Micro Computer",
    "PANW": "Palo Alto Networks",
    "COHR": "Coherent",
    "BSX": "Boston Scientific",
    "CMG": "Chipotle Mexican Grill",
    "LULU": "lululemon",
    "DASH": "DoorDash",
    "LITE": "Lumentum",
    "CRWD": "CrowdStrike",
    "APP": "AppLovin",
    "UBER": "Uber",
    "NBIS": "Nebius Group",
    "SNDK": "SanDisk",
    "LKOH": "Лукойл",
    "SNGS": "Сургутнефтегаз",
    "SNGSP": "Сургутнефтегаз, привилегированные",
    "GAZP": "Газпром",
    "ROSN": "Роснефть",
    "NVTK": "НОВАТЭК",
    "TATN": "Татнефть",
    "TATNP": "Татнефть, привилегированные",
    "SIBN": "Газпром нефть",
    "BANEP": "Башнефть, привилегированные",
    "SBER": "Сбербанк",
    "SBERP": "Сбербанк, привилегированные",
    "T": "Т-Технологии",
    "MOEX": "Московская биржа",
    "VTBR": "ВТБ",
    "GMKN": "Норникель",
    "CHMF": "Северсталь",
    "NLMK": "НЛМК",
    "MAGN": "ММК",
    "PLZL": "Полюс",
    "ALRS": "Алроса",
    "RUAL": "РУСАЛ",
    "YDEX": "Яндекс",
    "MGNT": "Магнит",
    "OZON": "Озон",
    "MTSS": "МТС",
    "AFLT": "Аэрофлот",
    "PHOR": "Фосагро",
    "FLOT": "Совкомфлот",
    "AFKS": "АФК Система",
    "RAGR": "Русагро",
    "SOFL": "Софтлайн",
    "POSI": "Группа Позитив",
    "DIAS": "Диасофт",
    "WUSH": "ВУШ Холдинг",
    "HHEAD": "Хэдхантер",
    "MTLR": "Мечел",
    "MTLRP": "Мечел, привилегированные",
    "RASP": "Распадская",
    "UGLD": "Южуралзолото",
    "SELG": "Селигдар",
    "VSMO": "ВСМПО-АВИСМА",
    "TRMK": "ТМК",
    "SVAV": "Соллерс",
    "KMAZ": "КАМАЗ",
    "PIKK": "ПИК",
    "SMLT": "Самолет",
    "LSRG": "Группа ЛСР",
    "ETLN": "Эталон",
    "HNFG": "Хэндерсон",
    "AQUA": "Инарктика",
    "APTK": "Аптечная сеть 36,6",
    "IRAO": "Интер РАО",
    "HYDR": "РусГидро",
    "FEES": "Россети",
    "MSNG": "Мосэнерго",
    "OGKB": "ОГК-2",
    "TGKN": "ТГК-14",
    "FESH": "ДВМП",
    "NMTP": "НМТП",
}


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def read_gzip_json(path: Path) -> dict[str, Any] | None:
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def clean_candle(raw: dict[str, Any]) -> dict[str, float | int]:
    return {
        "time": int(raw.get("open_time", raw.get("time", 0))),
        "open": round(float(raw.get("open", 0)), 8),
        "high": round(float(raw.get("high", 0)), 8),
        "low": round(float(raw.get("low", 0)), 8),
        "close": round(float(raw.get("close", 0)), 8),
        "volume": round(float(raw.get("volume", 0)), 4),
    }


def normalize_candles(raw: Iterable[dict[str, Any]], limit: int = 420) -> list[dict[str, float | int]]:
    candles = [clean_candle(item) for item in raw if isinstance(item, dict)]
    candles = [item for item in candles if item["time"] and item["close"]]
    candles.sort(key=lambda item: int(item["time"]))
    return candles[-limit:]


def resample(candles: list[dict[str, float | int]], minutes: int) -> list[dict[str, float | int]]:
    if not candles:
        return []
    bucket_ms = minutes * 60 * 1000
    grouped: dict[int, list[dict[str, float | int]]] = {}
    for candle in candles:
        bucket = int(candle["time"]) // bucket_ms * bucket_ms
        grouped.setdefault(bucket, []).append(candle)

    result: list[dict[str, float | int]] = []
    for timestamp, group in sorted(grouped.items()):
        result.append(
            {
                "time": timestamp,
                "open": group[0]["open"],
                "high": round(max(float(item["high"]) for item in group), 8),
                "low": round(min(float(item["low"]) for item in group), 8),
                "close": group[-1]["close"],
                "volume": round(sum(float(item["volume"]) for item in group), 4),
            }
        )
    return result[-420:]


def load_cached(symbol: str, market: str, minutes: int) -> tuple[list[dict[str, float | int]], int | None]:
    folder_name = "cache" if market == "crypto" else "stock_cache" if market == "stocks" else "moex_cache"
    folder = PLATFORM_ROOT / "data" / folder_name
    path = folder / f"{symbol}_{minutes}m.json.gz"
    payload = read_gzip_json(path)
    if not payload:
        return [], None
    candles = normalize_candles(payload.get("candles", []))
    saved_at = payload.get("saved_at_ms")
    return candles, int(saved_at) if saved_at else None


def load_asset_data(symbol: str, market: str) -> tuple[dict[str, list[dict[str, float | int]]], int | None]:
    data: dict[str, list[dict[str, float | int]]] = {}
    latest_saved: int | None = None
    for label, minutes in TIMEFRAMES.items():
        candles, saved_at = load_cached(symbol, market, minutes)
        if candles:
            data[label] = candles
            latest_saved = max(latest_saved or 0, saved_at or 0) or latest_saved

    if market == "stocks":
        if not data.get("4h"):
            source, saved_at = load_cached(symbol, market, 60)
            data["4h"] = resample(source, 240)
            latest_saved = max(latest_saved or 0, saved_at or 0) or latest_saved
        if not data.get("1w"):
            source, saved_at = load_cached(symbol, market, 1440)
            data["1w"] = resample(source, 10080)
            latest_saved = max(latest_saved or 0, saved_at or 0) or latest_saved
    return data, latest_saved


def summarize_quote(data: dict[str, list[dict[str, float | int]]]) -> dict[str, float | None]:
    preferred = data.get("15m") or data.get("1h") or data.get("1d") or []
    if not preferred:
        return {"price": None, "changePct": None, "high": None, "low": None}
    last = preferred[-1]
    previous = preferred[-2] if len(preferred) > 1 else last
    prior_close = float(previous["close"])
    change = ((float(last["close"]) / prior_close) - 1) * 100 if prior_close else 0
    day = (data.get("1d") or preferred)[-1]
    return {
        "price": float(last["close"]),
        "changePct": round(change, 3),
        "high": float(day["high"]),
        "low": float(day["low"]),
    }


def load_widget_names() -> dict[str, str]:
    settings = read_json(WIDGET_ROOT / "widget_settings.json", {})
    names = dict(DEFAULT_NAMES)
    for key, value in settings.get("asset_names", {}).items():
        if isinstance(key, str) and isinstance(value, str):
            names[key.split(":")[-1].upper()] = value
    return names


def configured_universe() -> tuple[list[str], list[str], list[str]]:
    config = read_json(TERMINAL_ROOT / "config" / "watchlist.json", {})
    crypto = [str(item).upper().replace("/", "") for item in config.get("crypto", CRYPTO)]
    stocks = [str(item).upper() for item in config.get("stocks", STOCKS)]
    moex = [str(item).upper() for item in config.get("moex", MOEX)]
    return crypto or CRYPTO, stocks or STOCKS, moex or MOEX


def load_current_ideas() -> dict[str, dict[str, Any]]:
    report = read_json(PLATFORM_ROOT / "logs" / "current_entry_watchlist.json", {})
    result: dict[str, dict[str, Any]] = {}
    for symbol, raw_ideas in report.get("ideas", {}).items():
        if not isinstance(raw_ideas, list) or not raw_ideas:
            continue
        ideas = [item for item in raw_ideas if isinstance(item, dict)]
        if not ideas:
            continue
        ideas.sort(key=lambda item: (float(item.get("score", 0)), item.get("stage") == "TRIGGERED"), reverse=True)
        idea = ideas[0]
        result[symbol.upper()] = {
            "asofTime": idea.get("asof_time"),
            "direction": idea.get("direction"),
            "stage": idea.get("stage"),
            "setupTimeframe": idea.get("setup_timeframe"),
            "contextTimeframe": idea.get("context_timeframe"),
            "entryTimeframe": idea.get("entry_timeframe"),
            "corridor": idea.get("corridor_label"),
            "entryLow": idea.get("entry_zone_low"),
            "entryHigh": idea.get("entry_zone_high"),
            "invalidation": idea.get("invalidation"),
            "target1": idea.get("target_1"),
            "target1Label": idea.get("target_1_label"),
            "target2": idea.get("target_2"),
            "rr": idea.get("estimated_rr_to_target_1"),
            "score": idea.get("score"),
            "grade": idea.get("grade"),
            "action": idea.get("action"),
            "patterns": idea.get("nison_patterns", []),
            "aggressiveCandle": bool(idea.get("aggressive_candle")),
            "volumeConfirmation": bool(idea.get("volume_confirmation")),
            "compression": bool(idea.get("compression")),
            "seniorAlignment": bool(idea.get("senior_alignment")),
            "warnings": idea.get("warnings", []),
        }
    return result


def metric(report: dict[str, Any], path: list[str], default: Any = None) -> Any:
    value: Any = report
    for key in path:
        if not isinstance(value, dict):
            return default
        value = value.get(key)
    return default if value is None else value


def load_strategy_registry() -> list[dict[str, Any]]:
    corridor = read_json(PLATFORM_ROOT / "logs" / "ema_corridor_research_report.json", {})
    mtf = read_json(PLATFORM_ROOT / "logs" / "mtf_strategy_research_report.json", {})
    corridor_profiles = corridor.get("profiles", [])
    corridor_selected = next(
        (item for item in corridor_profiles if item.get("id") == corridor.get("selected_for_review")),
        corridor_profiles[0] if corridor_profiles else {},
    )
    mtf_profiles = [
        item
        for values in mtf.get("profiles_by_market", {}).values()
        for item in (values if isinstance(values, list) else [])
        if isinstance(item, dict) and not item.get("diagnostic_only")
    ]
    mtf_best = max(mtf_profiles, key=lambda item: float(metric(item, ["test", "expectancy_r"], -99)), default={})

    return [
        {
            "id": "legacy-macd",
            "name": "MACD + EMA",
            "shortName": "MACD",
            "status": "active",
            "statusLabel": "Рабочая логика",
            "description": "Пересечения MACD 12/26/9, гистограмма и EMA 20/50/200.",
            "winRate": None,
            "expectancy": None,
            "enabled": True,
        },
        {
            "id": "ema-corridor",
            "name": "EMA‑окно · удержание границы",
            "shortName": "EMA ОКНО",
            "status": "research",
            "statusLabel": "Отдельный сигнал",
            "description": "Пробой или отбой от EMA50, удержание цены за границей и свободный маршрут к следующей EMA без MTF‑препятствий.",
            "winRate": metric(corridor_selected, ["test", "win_rate_pct"]),
            "expectancy": metric(corridor_selected, ["test", "expectancy_r"]),
            "enabled": True,
        },
        {
            "id": "mtf-entry",
            "name": "SETUP → CONTEXT → ENTRY",
            "shortName": "MTF",
            "status": "research",
            "statusLabel": "Не прошла отбор",
            "description": "Старший сигнал, контекст MACD и точка входа на младшем ТФ.",
            "winRate": metric(mtf_best, ["test", "win_rate_pct"]),
            "expectancy": metric(mtf_best, ["test", "expectancy_r"]),
            "enabled": True,
        },
        {
            "id": "nison",
            "name": "Свечные модели Нисона",
            "shortName": "НИСОН",
            "status": "draft",
            "statusLabel": "Подтверждение",
            "description": "Поглощение, харами, молот, падающая звезда и доджи.",
            "winRate": None,
            "expectancy": None,
            "enabled": True,
        },
        {
            "id": "nison-beyond",
            "name": "Нисон · За гранью японских свечей",
            "shortName": "НИСОН+",
            "status": "research",
            "statusLabel": "Теневой анализ",
            "description": "Контекст свечей и EMA; далее — индекс расхождения, трёхлинейный прорыв, ренко и каги. Не разрешает сделку до накопления статистики.",
            "winRate": None,
            "expectancy": None,
            "enabled": True,
        },
        {
            "id": "impulse-zone",
            "name": "Импульс и 50% свечи",
            "shortName": "50%",
            "status": "draft",
            "statusLabel": "В разработке",
            "description": "Зона проторговки полного диапазона длинной импульсной свечи.",
            "winRate": None,
            "expectancy": None,
            "enabled": False,
        },
        {
            "id": "vpa",
            "name": "Объём и цена · VPA",
            "shortName": "VPA",
            "status": "research",
            "statusLabel": "Теневое наблюдение",
            "description": "Усилие объёма против результата свечи: импульс, слабый откат, поглощение, останавливающий объём и пробои. Пока не влияет на вход.",
            "winRate": None,
            "expectancy": None,
            "enabled": True,
        },
        {
            "id": "level-action",
            "name": "Уровни и сценарии Герчика",
            "shortName": "УРОВЕНЬ",
            "status": "research",
            "statusLabel": "Теневой анализ",
            "description": "Статические уровни, отбой, пробой и ложный пробой, свободный путь по ATR и расчёт R:R. Не смешивается с EMA‑коридором и пока не влияет на вход.",
            "winRate": None,
            "expectancy": None,
            "enabled": True,
        },
        {
            "id": "scenario-forecast",
            "name": "Сценарный прогноз",
            "shortName": "ПРОГНОЗ",
            "status": "research",
            "statusLabel": "Историческая калибровка",
            "description": "Три маршрута движения по EMA, MACD, объёму, свечам и старшим таймфреймам.",
            "winRate": None,
            "expectancy": None,
            "enabled": True,
        },
    ]


def load_trade_summary() -> dict[str, Any]:
    path = BOT_ROOT / "logs" / "trades_stats_v7.csv"
    if not path.exists():
        return {"count": 0, "wins": 0, "losses": 0, "netPnlPct": 0, "recent": []}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter=";"))
    closed = [row for row in rows if row.get("timestamp_close")]
    wins = sum(1 for row in closed if str(row.get("result", "")).upper() in {"WIN", "TP", "PROFIT"})
    losses = sum(1 for row in closed if str(row.get("result", "")).upper() in {"LOSS", "SL", "STOP"})
    total = sum(float(row.get("net_pnl_pct") or 0) for row in closed)
    recent = [
        {
            "symbol": row.get("symbol"),
            "side": row.get("side"),
            "openTime": row.get("timestamp_open"),
            "closeTime": row.get("timestamp_close"),
            "entry": row.get("entry_price"),
            "exit": row.get("exit_price"),
            "netPnlPct": row.get("net_pnl_pct"),
            "result": row.get("result"),
            "setup": row.get("setup"),
        }
        for row in closed[-20:]
    ]
    return {"count": len(closed), "wins": wins, "losses": losses, "netPnlPct": round(total, 4), "recent": recent}


def main() -> None:
    names = load_widget_names()
    ideas = load_current_ideas()
    crypto_symbols, stock_symbols, moex_symbols = configured_universe()
    assets: list[dict[str, Any]] = []
    latest_saved = 0
    for market, symbols in (("crypto", crypto_symbols), ("stocks", stock_symbols), ("moex", moex_symbols)):
        for symbol in symbols:
            data, saved_at = load_asset_data(symbol, market)
            latest_saved = max(latest_saved, saved_at or 0)
            assets.append(
                {
                    "symbol": symbol,
                    "displaySymbol": symbol.replace("USDT", "/USDT"),
                    "name": names.get(symbol, symbol),
                    "market": market,
                    "quote": summarize_quote(data),
                    "data": data,
                    "signal": ideas.get(symbol),
                }
            )

    snapshot = {
        "version": 1,
        "mode": "LOCAL_READ_ONLY",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "marketDataSavedAt": datetime.fromtimestamp(latest_saved / 1000, timezone.utc).isoformat() if latest_saved else None,
        "assetCount": len(assets),
        "assets": assets,
        "strategies": load_strategy_registry(),
        "tradeSummary": load_trade_summary(),
        "sources": {
            "tradingProject": str(BOT_ROOT),
            "widget": str(WIDGET_ROOT),
            "ordersEnabled": False,
        },
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Trading Terminal snapshot: {len(assets)} assets -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
