"""Честное исследование SETUP → CONTEXT → ENTRY для криптовалют и акций.

Скрипт не отправляет ордера. Профили выбираются только на первых 70% истории,
после чего один раз оцениваются на последних 30%.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trading_platform.backtesting.ema_corridor_backtest import (
    BacktestConfig,
    BacktestReport,
    TradeResult,
    run_backtest,
)
from trading_platform.data.history_cache import load_or_fetch_completed_klines
from trading_platform.data.stock_history_cache import load_or_fetch_stock_klines
from trading_platform.strategies.ema_corridor import Candle, CorridorConfig, format_timeframe
from trading_platform.strategies.mtf_ema_setup import (
    MtfCandidate,
    MtfProfile,
    build_profile_event,
    generate_mtf_candidates,
)


PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_PROFILES = PROJECT_DIR / "mtf_research_profiles.json"
DEFAULT_STRATEGY_CONFIG = PROJECT_DIR / "ema_corridor_config.json"
DEFAULT_BACKTEST_CONFIG = PROJECT_DIR / "ema_corridor_backtest_config.json"
DEFAULT_JSON_REPORT = PROJECT_DIR / "logs" / "mtf_strategy_research_report.json"
DEFAULT_NOTES = PROJECT_DIR / "logs" / "mtf_strategy_research_notes.md"
DEFAULT_TRADES = PROJECT_DIR / "logs" / "mtf_strategy_research_trades.csv"

CRYPTO_SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "TRXUSDT", "XRPUSDT")
STOCK_SYMBOLS = (
    "AMZN", "TSLA", "NFLX", "AMD", "CVNA", "HOOD", "COIN", "SMCI", "PANW",
    "COHR", "BSX", "CMG", "LULU", "DASH", "LITE", "CRWD", "APP", "UBER",
    "NBIS", "SNDK",
)

CRYPTO_ROLES = (
    (15, 60, 15),
    (30, 60, 15),
    (60, 240, 30),
    (240, 1440, 60),
    (1440, 10080, 240),
)
STOCK_ROLES = (
    (15, 60, 15),
    (30, 60, 15),
    (60, 1440, 30),
)
CRYPTO_HISTORY_DAYS = 120
INDICATOR_WARMUP = 220


@dataclass
class ResearchUnit:
    market: str
    symbol: str
    setup_tf: int
    context_tf: int
    entry_tf: int
    candles_by_tf: Mapping[int, Sequence[Candle]]
    candidates: tuple[MtfCandidate, ...]
    evaluation_start: int
    split_time: int
    evaluation_end: int

    @property
    def key(self) -> str:
        return f"{self.market}:{self.symbol}:{self.setup_tf}:{self.context_tf}:{self.entry_tf}"


def _read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _crypto_required(timeframe: int) -> int:
    evaluation = math.ceil(CRYPTO_HISTORY_DAYS * 1440 / timeframe)
    return min(50_000, evaluation + INDICATOR_WARMUP)


def _profile_metrics(
    reports: Mapping[str, BacktestReport], units_by_key: Mapping[str, ResearchUnit]
) -> dict[str, object]:
    trades = [trade for report in reports.values() for trade in report.trades]
    positive_r = sum(max(0.0, trade.r_multiple) for trade in trades)
    negative_r = -sum(min(0.0, trade.r_multiple) for trade in trades)
    wins = sum(trade.net_pnl_per_unit > 0 for trade in trades)
    by_symbol: dict[str, list[TradeResult]] = defaultdict(list)
    for key, report in reports.items():
        by_symbol[units_by_key[key].symbol].extend(report.trades)
    profitable_symbols = 0
    for symbol_trades in by_symbol.values():
        if len(symbol_trades) >= 3 and sum(t.r_multiple for t in symbol_trades) > 0:
            profitable_symbols += 1
    return {
        "trades": len(trades),
        "wins": wins,
        "losses": sum(trade.net_pnl_per_unit < 0 for trade in trades),
        "win_rate_pct": wins / len(trades) * 100.0 if trades else 0.0,
        "target_hit_rate_pct": (
            sum(trade.status == "TARGET" for trade in trades) / len(trades) * 100.0
            if trades else 0.0
        ),
        "profit_factor_r": positive_r / negative_r if negative_r > 0 else None,
        "expectancy_r": (
            sum(trade.r_multiple for trade in trades) / len(trades) if trades else 0.0
        ),
        "average_net_trade_pct": (
            sum(trade.net_return_pct for trade in trades) / len(trades) if trades else 0.0
        ),
        "max_drawdown_pct_per_unit": max(
            (float(report.summary["max_drawdown_pct"]) for report in reports.values()),
            default=0.0,
        ),
        "profitable_symbols": profitable_symbols,
        "symbols_with_trades": len(by_symbol),
    }


def _trade_metrics(trades: Sequence[TradeResult]) -> dict[str, object]:
    positive = sum(max(0.0, trade.r_multiple) for trade in trades)
    negative = -sum(min(0.0, trade.r_multiple) for trade in trades)
    wins = sum(trade.net_pnl_per_unit > 0 for trade in trades)
    return {
        "trades": len(trades),
        "win_rate_pct": wins / len(trades) * 100.0 if trades else 0.0,
        "profit_factor_r": positive / negative if negative > 0 else None,
        "expectancy_r": sum(t.r_multiple for t in trades) / len(trades) if trades else 0.0,
        "average_net_trade_pct": (
            sum(t.net_return_pct for t in trades) / len(trades) if trades else 0.0
        ),
    }


def _ranking_score(metrics: Mapping[str, object], min_trades: int) -> float:
    count = int(metrics["trades"])
    if count < min_trades:
        return -1_000_000.0 + count
    pf_raw = metrics["profit_factor_r"]
    pf = 3.0 if pf_raw is None else min(3.0, float(pf_raw))
    return (
        float(metrics["expectancy_r"]) * 10.0
        + (pf - 1.0) * 0.5
        + int(metrics["profitable_symbols"]) * 0.12
        - float(metrics["max_drawdown_pct_per_unit"]) * 0.02
        + min(math.log10(count), 3.0) * 0.05
    )


def _qualified(
    market: str, train: Mapping[str, object], test: Mapping[str, object]
) -> bool:
    min_train, min_test, min_profitable = (
        (50, 20, 2) if market == "CRYPTO" else (100, 40, 6)
    )
    return bool(
        int(train["trades"]) >= min_train
        and int(test["trades"]) >= min_test
        and float(train["expectancy_r"]) > 0
        and float(test["expectancy_r"]) > 0
        and train["profit_factor_r"] is not None
        and test["profit_factor_r"] is not None
        and float(train["profit_factor_r"]) > 1.0
        and float(test["profit_factor_r"]) > 1.0
        and int(test["profitable_symbols"]) >= min_profitable
    )


def _fmt(value: object, digits: int = 2) -> str:
    return "н/д" if value is None else f"{float(value):.{digits}f}"


def _utc_date(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")


def _load_market_data(refresh: bool) -> tuple[
    dict[str, dict[int, list[Candle]]], dict[str, dict[int, list[Candle]]], list[str]
]:
    errors: list[str] = []
    crypto: dict[str, dict[int, list[Candle]]] = {}
    stock: dict[str, dict[int, list[Candle]]] = {}
    crypto_tfs = sorted({value for role in CRYPTO_ROLES for value in role})
    stock_tfs = sorted({value for role in STOCK_ROLES for value in role})

    print("\nКРИПТОВАЛЮТЫ")
    for symbol in CRYPTO_SYMBOLS:
        by_tf: dict[int, list[Candle]] = {}
        try:
            for timeframe in crypto_tfs:
                candles, source = load_or_fetch_completed_klines(
                    symbol, timeframe, _crypto_required(timeframe), refresh=refresh
                )
                by_tf[timeframe] = candles
                print(f"  {symbol} {format_timeframe(timeframe)}: {len(candles)} ({source})")
            crypto[symbol] = by_tf
        except Exception as exc:
            errors.append(f"{symbol}: {exc}")
            print(f"  {symbol}: ПРОПУЩЕН — {exc}")

    print("\nАКЦИИ США (только regular session)")
    for symbol in STOCK_SYMBOLS:
        by_tf = {}
        try:
            for timeframe in stock_tfs:
                candles, source = load_or_fetch_stock_klines(
                    symbol, timeframe, refresh=refresh
                )
                by_tf[timeframe] = candles
                print(f"  {symbol} {format_timeframe(timeframe)}: {len(candles)} ({source})")
            stock[symbol] = by_tf
        except Exception as exc:
            errors.append(f"{symbol}: {exc}")
            print(f"  {symbol}: ПРОПУЩЕН — {exc}")
    return crypto, stock, errors


def _make_units(
    market: str,
    data: Mapping[str, Mapping[int, Sequence[Candle]]],
    roles: Sequence[tuple[int, int, int]],
    config: CorridorConfig,
) -> list[ResearchUnit]:
    units: list[ResearchUnit] = []
    for symbol, candles_by_tf in data.items():
        anchor = sorted(candles_by_tf[15], key=lambda c: c.open_time)
        if market == "CRYPTO":
            evaluation_count = min(
                len(anchor) - INDICATOR_WARMUP,
                math.ceil(CRYPTO_HISTORY_DAYS * 1440 / 15),
            )
            start_index = len(anchor) - evaluation_count
        else:
            start_index = INDICATOR_WARMUP
            evaluation_count = len(anchor) - start_index
        if evaluation_count < 400:
            print(f"  {symbol}: недостаточно 15m истории после прогрева")
            continue
        split_index = start_index + int(evaluation_count * 0.70)
        evaluation_start = anchor[start_index].open_time
        split_time = anchor[split_index].open_time
        evaluation_end = anchor[-1].close_time(15)
        for setup_tf, context_tf, entry_tf in roles:
            candidates = generate_mtf_candidates(
                symbol,
                market,
                candles_by_tf,
                setup_tf,
                context_tf,
                entry_tf,
                config,
            )
            units.append(
                ResearchUnit(
                    market=market,
                    symbol=symbol,
                    setup_tf=setup_tf,
                    context_tf=context_tf,
                    entry_tf=entry_tf,
                    candles_by_tf=candles_by_tf,
                    candidates=candidates,
                    evaluation_start=evaluation_start,
                    split_time=split_time,
                    evaluation_end=evaluation_end,
                )
            )
    return units


def _events_for_profile(
    unit: ResearchUnit,
    profile: MtfProfile,
    strategy_config: CorridorConfig,
) -> tuple[list, dict[tuple[int, str, str], MtfCandidate]]:
    events = []
    metadata: dict[tuple[int, str, str], MtfCandidate] = {}
    for candidate in unit.candidates:
        event = build_profile_event(candidate, profile, unit.candles_by_tf, strategy_config)
        if event is None:
            continue
        events.append(event)
        metadata[(event.signal_time, event.corridor.label, event.direction)] = candidate
    return events, metadata


def _evaluate_profile(
    units: Sequence[ResearchUnit],
    profile: MtfProfile,
    strategy_config: CorridorConfig,
    backtest_config: BacktestConfig,
) -> tuple[
    dict[str, BacktestReport],
    dict[str, BacktestReport],
    dict[str, BacktestReport],
    dict[str, dict[tuple[int, str, str], MtfCandidate]],
    dict[str, list],
]:
    train_reports: dict[str, BacktestReport] = {}
    test_reports: dict[str, BacktestReport] = {}
    full_reports: dict[str, BacktestReport] = {}
    metadata_by_unit: dict[str, dict[tuple[int, str, str], MtfCandidate]] = {}
    events_by_unit: dict[str, list] = {}
    for unit in units:
        events, metadata = _events_for_profile(unit, profile, strategy_config)
        max_bars = max(24, math.ceil(24 * unit.setup_tf / unit.entry_tf))
        cfg = replace(backtest_config, max_holding_bars=max_bars, out_of_sample_pct=0.0)
        train_cutoff = unit.split_time - max_bars * unit.entry_tf * 60_000
        full_events = [e for e in events if e.signal_time >= unit.evaluation_start]
        train_events = [
            e for e in full_events if e.signal_time < train_cutoff
        ]
        test_events = [e for e in full_events if e.signal_time >= unit.split_time]
        candles = unit.candles_by_tf[unit.entry_tf]
        train_reports[unit.key] = run_backtest(train_events, candles, strategy_config, cfg)
        test_reports[unit.key] = run_backtest(test_events, candles, strategy_config, cfg)
        full_reports[unit.key] = run_backtest(full_events, candles, strategy_config, cfg)
        metadata_by_unit[unit.key] = metadata
        events_by_unit[unit.key] = full_events
    return train_reports, test_reports, full_reports, metadata_by_unit, events_by_unit


def _ticker_rows(
    market: str,
    units: Sequence[ResearchUnit],
    test_reports: Mapping[str, BacktestReport],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    symbols = CRYPTO_SYMBOLS if market == "CRYPTO" else STOCK_SYMBOLS
    for symbol in symbols:
        symbol_units = [unit for unit in units if unit.symbol == symbol]
        trades = [
            trade
            for unit in symbol_units
            for trade in test_reports.get(unit.key, BacktestReport({}, {}, {}, {}, {}, 0, 0, ())).trades
        ]
        metrics = _trade_metrics(trades)
        by_tf: dict[int, dict[str, object]] = {}
        for unit in symbol_units:
            report = test_reports.get(unit.key)
            by_tf[unit.setup_tf] = _trade_metrics(report.trades if report else ())
        eligible = [
            (timeframe, values)
            for timeframe, values in by_tf.items()
            if int(values["trades"]) >= 3
        ]
        best_tf = (
            max(eligible, key=lambda item: float(item[1]["expectancy_r"]))[0]
            if eligible else None
        )
        rows.append(
            {
                "symbol": symbol,
                "metrics": metrics,
                "by_setup_timeframe": {str(k): v for k, v in by_tf.items()},
                "descriptive_best_setup_timeframe": best_tf,
            }
        )
    return rows


def _recent_candidates(
    selected_market: Mapping[str, object],
    units_by_key: Mapping[str, ResearchUnit],
) -> list[dict[str, object]]:
    events_by_unit = selected_market["events_by_unit"]
    metadata_by_unit = selected_market["metadata_by_unit"]
    rows: list[dict[str, object]] = []
    for key, events in events_by_unit.items():
        unit = units_by_key[key]
        cutoff = unit.evaluation_end - 10 * 24 * 60 * 60_000
        for event in events:
            if event.signal_time < cutoff:
                continue
            candidate = metadata_by_unit[key].get(
                (event.signal_time, event.corridor.label, event.direction)
            )
            if candidate is None:
                continue
            rows.append(
                {
                    "market": unit.market,
                    "symbol": unit.symbol,
                    "signal_time_utc": _utc_date(event.signal_time),
                    "signal_time_ms": event.signal_time,
                    "setup_timeframe": unit.setup_tf,
                    "context_timeframe": unit.context_tf,
                    "entry_timeframe": unit.entry_tf,
                    "direction": event.direction,
                    "corridor": event.corridor.label,
                    "entry": event.entry_price,
                    "stop": event.stop_price,
                    "target": event.targets[0].executable_price,
                    "planned_rr": event.targets[0].net_rr,
                    "context_phase": candidate.context_phase,
                    "nison_patterns": list(candidate.setup_patterns + candidate.context_patterns),
                    "pre_volume_ratio": candidate.pre_volume_ratio,
                    "breakout_volume_ratio": candidate.breakout_volume_ratio,
                    "aggressive_candle": candidate.aggressive_candle,
                    "compression": candidate.compression_detected,
                }
            )
    rows.sort(key=lambda row: int(row["signal_time_ms"]), reverse=True)
    return rows[:20]


def _write_trade_log(
    path: Path,
    selected: Mapping[str, Mapping[str, object]],
    units_by_key: Mapping[str, ResearchUnit],
) -> None:
    rows: list[dict[str, object]] = []
    for market, result in selected.items():
        profile_id = str(result["profile_id"])
        reports = result["test_reports"]
        metadata_by_unit = result["metadata_by_unit"]
        for key, report in reports.items():
            unit = units_by_key[key]
            for trade in report.trades:
                row = trade.to_dict()
                candidate = metadata_by_unit[key].get(
                    (trade.signal_time, trade.corridor_label, trade.direction)
                )
                row.update(
                    {
                        "market": market,
                        "profile_id": profile_id,
                        "sample": "OUT_OF_SAMPLE",
                        "setup_timeframe": unit.setup_tf,
                        "context_timeframe": unit.context_tf,
                        "entry_timeframe": unit.entry_tf,
                        "context_phase": candidate.context_phase if candidate else "",
                        "body_atr": candidate.body_atr if candidate else "",
                        "body_share": candidate.body_share if candidate else "",
                        "pre_volume_ratio": candidate.pre_volume_ratio if candidate else "",
                        "breakout_volume_ratio": candidate.breakout_volume_ratio if candidate else "",
                        "compression": candidate.compression_detected if candidate else "",
                        "nison_patterns": ",".join(trade.nison_patterns),
                    }
                )
                rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    leading = [
        "market", "profile_id", "sample", "setup_timeframe", "context_timeframe",
        "entry_timeframe", "context_phase", "body_atr", "body_share",
        "pre_volume_ratio", "breakout_volume_ratio", "compression",
    ]
    fields = leading + list(TradeResult.__dataclass_fields__)
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _profile_table(lines: list[str], title: str, results: Sequence[Mapping[str, object]]) -> None:
    lines.extend(
        [
            f"## {title}",
            "",
            "| Профиль | Train n | WR | PF(R) | E(R) | Test n | WR | PF(R) | E(R) | Допуск |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
    )
    for item in results:
        train, test = item["train"], item["test"]
        lines.append(
            f"| {item['profile_id']} | {train['trades']} | {_fmt(train['win_rate_pct'])}% | "
            f"{_fmt(train['profit_factor_r'])} | {_fmt(train['expectancy_r'])} | "
            f"{test['trades']} | {_fmt(test['win_rate_pct'])}% | "
            f"{_fmt(test['profit_factor_r'])} | {_fmt(test['expectancy_r'])} | "
            f"{'ДА' if item['qualified'] else 'нет'} |"
        )
    lines.append("")


def _write_markdown(
    path: Path,
    profile_results: Mapping[str, Sequence[Mapping[str, object]]],
    selected: Mapping[str, Mapping[str, object]],
    ticker_rows: Mapping[str, Sequence[Mapping[str, object]]],
    recent: Sequence[Mapping[str, object]],
    coverage: Sequence[Mapping[str, object]],
    errors: Sequence[str],
) -> None:
    lines = [
        "# Мультитаймфреймовая EMA-стратегия — отчёт исследования",
        "",
        f"Сформирован: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}.",
        "",
        "Это историческое исследование без отправки ордеров. Оно не гарантирует будущую прибыль.",
        "",
        "## Как проводился тест",
        "",
        "- Логика: SETUP (EMA-коридор) → CONTEXT (MACD 12/26/9 и свечи) → ENTRY (сразу либо откат).",
        "- EMA20/50/200 считаются по Close. Проверены коридоры 20↔50, 20↔200 и 50↔200/кластеры.",
        "- Для 4H и 1D коридора к EMA200 TP ставится на 1% раньше EMA200.",
        "- Учитываются комиссия 0.055% и проскальзывание 0.02% на каждую сторону.",
        "- Первые 70% истории используются для выбора профиля; последние 30% — фиксированный контроль.",
        "- Если TP и Stop затронуты одной OHLC-свечой, засчитывается Stop — консервативное правило.",
        "",
    ]
    _profile_table(lines, "Криптовалюты — сравнение профилей", profile_results.get("CRYPTO", ()))
    _profile_table(lines, "Акции США — сравнение профилей", profile_results.get("STOCK", ()))

    for market, title in (("CRYPTO", "Криптовалюты"), ("STOCK", "Акции США")):
        result = selected.get(market)
        if not result:
            continue
        lines.extend(
            [
                f"## Выбранный по Train профиль: {title}",
                "",
                f"`{result['profile_id']}` — {result['description']}",
                "",
                f"Контроль: {result['test']['trades']} сделок, WR {_fmt(result['test']['win_rate_pct'])}%, "
                f"PF(R) {_fmt(result['test']['profit_factor_r'])}, ожидание {_fmt(result['test']['expectancy_r'])}R.",
                "",
                (
                    "Профиль прошёл предварительные критерии устойчивости. Это ещё не разрешение на реальные сделки."
                    if result["qualified"]
                    else "Профиль не прошёл все предварительные критерии устойчивости; использовать его для реальных денег рано."
                ),
                "",
            ]
        )

    lines.extend(
        [
            "## Контроль по каждому тикеру",
            "",
            "Лучший ТФ в таблице — только описание контрольного участка, он не использовался для выбора профиля.",
            "",
            "| Рынок | Тикер | Сделки | WR | PF(R) | E(R) | Средняя сделка | Описательно лучший SETUP-ТФ |",
            "|---|---|---:|---:|---:|---:|---:|---|",
        ]
    )
    for market in ("CRYPTO", "STOCK"):
        for row in ticker_rows.get(market, ()):
            metrics = row["metrics"]
            best = row["descriptive_best_setup_timeframe"]
            lines.append(
                f"| {market} | {row['symbol']} | {metrics['trades']} | "
                f"{_fmt(metrics['win_rate_pct'])}% | {_fmt(metrics['profit_factor_r'])} | "
                f"{_fmt(metrics['expectancy_r'])} | {_fmt(metrics['average_net_trade_pct'])}% | "
                f"{format_timeframe(int(best)) if best is not None else 'недостаточно сделок'} |"
            )
    lines.extend(["", "## Последние найденные исторические кандидаты", ""])
    if recent:
        lines.extend(
            [
                "Это не текущие рекомендации на вход: список нужен для ручной проверки логики на графике.",
                "",
                "| UTC | Тикер | Направление | SETUP/CONTEXT/ENTRY | Коридор | Вход | Stop | TP | RR | MACD-фаза |",
                "|---|---|---|---|---|---:|---:|---:|---:|---|",
            ]
        )
        for row in recent:
            lines.append(
                f"| {row['signal_time_utc']} | {row['symbol']} | {row['direction']} | "
                f"{format_timeframe(int(row['setup_timeframe']))}/"
                f"{format_timeframe(int(row['context_timeframe']))}/"
                f"{format_timeframe(int(row['entry_timeframe']))} | {row['corridor']} | "
                f"{_fmt(row['entry'], 4)} | {_fmt(row['stop'], 4)} | {_fmt(row['target'], 4)} | "
                f"{_fmt(row['planned_rr'])} | {row['context_phase']} |"
            )
    else:
        lines.append("У выбранных профилей за последние 10 календарных дней кандидатов не найдено.")
    lines.extend(
        [
            "",
            "## Покрытие данных",
            "",
            "| Рынок | Тикер | Начало оценки UTC | Раздел 70/30 UTC | Конец UTC |",
            "|---|---|---|---|---|",
        ]
    )
    for row in coverage:
        lines.append(
            f"| {row['market']} | {row['symbol']} | {row['start']} | {row['split']} | {row['end']} |"
        )
    lines.extend(
        [
            "",
            "## Ограничения",
            "",
            "- Крипто: perpetual-котировки Bybit, при недоступности — OKX; круглосуточный рынок.",
            "- Акции: публичные Yahoo Chart; только regular session, без премаркета и постмаркета. 15m/30m ограничены примерно 60 днями.",
            "- Для акций не моделируются шорт-локейт, доступность займа и дивиденды; для крипто не моделируется funding.",
            "- Спред исторически неизвестен и приближён фиксированным проскальзыванием.",
            "- Сделки разных SETUP-ТФ оценены раздельно; единый портфельный конфликт между ТФ пока не моделируется.",
            "- Набор свечных моделей Нисона пока базовый: поглощение, харами, молот/повешенный и звёзды требуют дальнейшей формализации контекста.",
            "- Один период, особенно короткий для акций, недостаточен для вывода о долгосрочной прибыльности.",
            "",
        ]
    )
    if errors:
        lines.extend(["## Ошибки загрузки", ""] + [f"- {value}" for value in errors] + [""])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MTF EMA/MACD research, no orders")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
    parser.add_argument("--strategy-config", type=Path, default=DEFAULT_STRATEGY_CONFIG)
    parser.add_argument("--backtest-config", type=Path, default=DEFAULT_BACKTEST_CONFIG)
    parser.add_argument("--json-report", type=Path, default=DEFAULT_JSON_REPORT)
    parser.add_argument("--notes", type=Path, default=DEFAULT_NOTES)
    parser.add_argument("--trade-log", type=Path, default=DEFAULT_TRADES)
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    raw_profiles = _read_json(args.profiles)
    strategy_values = _read_json(args.strategy_config)
    backtest_values = _read_json(args.backtest_config)
    if not isinstance(raw_profiles, list) or not raw_profiles:
        raise ValueError("Профили должны быть непустым JSON-списком")
    if not isinstance(strategy_values, Mapping) or not isinstance(backtest_values, Mapping):
        raise ValueError("Конфигурации должны быть JSON-объектами")
    profiles = [MtfProfile.from_mapping(value) for value in raw_profiles]
    profile_flags = {
        str(value.get("profile_id")): bool(value.get("diagnostic_only", False))
        for value in raw_profiles
    }
    strategy_config = CorridorConfig.from_mapping(strategy_values)
    backtest_config = BacktestConfig.from_mapping(backtest_values)

    print("MTF EMA/MACD — ИССЛЕДОВАНИЕ БЕЗ ОРДЕРОВ")
    crypto_data, stock_data, errors = _load_market_data(args.refresh)
    print("\nПостроение кандидатов...")
    units = _make_units("CRYPTO", crypto_data, CRYPTO_ROLES, strategy_config)
    units += _make_units("STOCK", stock_data, STOCK_ROLES, strategy_config)
    units_by_key = {unit.key: unit for unit in units}
    if not units:
        raise ValueError("Нет данных для исследования")

    runtime: dict[str, dict[str, object]] = {}
    serialized: dict[str, list[dict[str, object]]] = {"CRYPTO": [], "STOCK": []}
    for market in ("CRYPTO", "STOCK"):
        market_units = [unit for unit in units if unit.market == market]
        if not market_units:
            continue
        min_train = 50 if market == "CRYPTO" else 100
        for number, profile in enumerate(profiles, start=1):
            print(f"[{market} {number}/{len(profiles)}] {profile.profile_id}")
            train, test, full, metadata, events = _evaluate_profile(
                market_units, profile, strategy_config, backtest_config
            )
            train_metrics = _profile_metrics(train, units_by_key)
            test_metrics = _profile_metrics(test, units_by_key)
            item = {
                "market": market,
                "profile_id": profile.profile_id,
                "description": profile.description,
                "parameters": asdict(profile),
                "diagnostic_only": profile_flags.get(profile.profile_id, False),
                "train": train_metrics,
                "test": test_metrics,
                "ranking_score_train_only": _ranking_score(train_metrics, min_train),
                "qualified": (
                    False if profile_flags.get(profile.profile_id, False)
                    else _qualified(market, train_metrics, test_metrics)
                ),
            }
            serialized[market].append(item)
            runtime[f"{market}:{profile.profile_id}"] = {
                **item,
                "profile": profile,
                "train_reports": train,
                "test_reports": test,
                "full_reports": full,
                "metadata_by_unit": metadata,
                "events_by_unit": events,
            }

    selected: dict[str, dict[str, object]] = {}
    for market, items in serialized.items():
        if not items:
            continue
        items.sort(key=lambda x: float(x["ranking_score_train_only"]), reverse=True)
        candidates = [item for item in items if not item["diagnostic_only"]]
        choice = candidates[0] if candidates else items[0]
        selected[market] = runtime[f"{market}:{choice['profile_id']}"]

    ticker_rows = {
        market: _ticker_rows(
            market,
            [unit for unit in units if unit.market == market],
            result["test_reports"],
        )
        for market, result in selected.items()
    }
    recent = []
    for result in selected.values():
        recent.extend(_recent_candidates(result, units_by_key))
    recent.sort(key=lambda row: int(row["signal_time_ms"]), reverse=True)
    recent = recent[:20]

    coverage = []
    seen = set()
    for unit in units:
        key = (unit.market, unit.symbol)
        if key in seen:
            continue
        seen.add(key)
        coverage.append(
            {
                "market": unit.market,
                "symbol": unit.symbol,
                "start": _utc_date(unit.evaluation_start),
                "split": _utc_date(unit.split_time),
                "end": _utc_date(unit.evaluation_end),
            }
        )

    payload = {
        "mode": "RESEARCH_BACKTEST_NO_ORDERS",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "selection_rule": "rank_first_70pct_only_then_reveal_fixed_last_30pct",
        "strategy": "SETUP_CONTEXT_ENTRY_EMA_MACD_NISON_VOLUME_COMPRESSION",
        "profiles_by_market": serialized,
        "selected_for_review": {
            market: {
                key: value
                for key, value in result.items()
                if key in {"profile_id", "description", "parameters", "train", "test", "qualified"}
            }
            for market, result in selected.items()
        },
        "ticker_out_of_sample": ticker_rows,
        "recent_historical_candidates": recent,
        "coverage": coverage,
        "data_errors": errors,
    }
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _write_trade_log(args.trade_log, selected, units_by_key)
    _write_markdown(
        args.notes, serialized, selected, ticker_rows, recent, coverage, errors
    )

    print("\nИТОГ")
    for market, result in selected.items():
        print(
            f"  {market}: {result['profile_id']}; test n={result['test']['trades']}, "
            f"WR={_fmt(result['test']['win_rate_pct'])}%, "
            f"PF={_fmt(result['test']['profit_factor_r'])}, "
            f"E={_fmt(result['test']['expectancy_r'])}R"
        )
    print(f"Отчёт: {args.notes.resolve()}")
    print(f"JSON: {args.json_report.resolve()}")
    print(f"Лог контрольных сделок: {args.trade_log.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ОШИБКА ИССЛЕДОВАНИЯ: {exc}", file=sys.stderr)
        raise SystemExit(2)
