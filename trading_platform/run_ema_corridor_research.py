"""Сравнительное исследование профилей EMA Corridor на фиксированном holdout."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, Sequence


if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trading_platform.backtesting.ema_corridor_backtest import (
    BacktestConfig,
    BacktestReport,
    TradeResult,
    run_backtest,
)
from trading_platform.data.bybit_public import BybitPublicError
from trading_platform.data.history_cache import load_or_fetch_completed_klines
from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    format_timeframe,
    scan_corridor_events,
)


PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_STRATEGY_CONFIG = PROJECT_DIR / "ema_corridor_config.json"
DEFAULT_BACKTEST_CONFIG = PROJECT_DIR / "ema_corridor_backtest_config.json"
DEFAULT_PROFILES = PROJECT_DIR / "ema_corridor_research_profiles.json"
DEFAULT_JSON_REPORT = PROJECT_DIR / "logs" / "ema_corridor_research_report.json"
DEFAULT_MARKDOWN_REPORT = PROJECT_DIR / "logs" / "ema_corridor_research_notes.md"
DEFAULT_TRADE_LOG = PROJECT_DIR / "logs" / "ema_corridor_research_trades.csv"
INDICATOR_WARMUP = 220


def _parse_int_list(raw: str) -> list[int]:
    values = sorted({int(item.strip()) for item in raw.split(",") if item.strip()})
    if not values:
        raise argparse.ArgumentTypeError("Нужен хотя бы один таймфрейм")
    return values


def _parse_symbols(raw: str) -> list[str]:
    values = [item.strip().upper() for item in raw.split(",") if item.strip()]
    if not values:
        raise argparse.ArgumentTypeError("Нужен хотя бы один инструмент")
    return list(dict.fromkeys(values))


def _read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _required_history(base_tf: int, timeframe: int, base_bars: int) -> int:
    covered_bars = math.ceil(base_bars * base_tf / timeframe)
    return min(50_000, max(INDICATOR_WARMUP, covered_bars + INDICATOR_WARMUP))


def _profile_config(
    base: CorridorConfig, profile: Mapping[str, object]
) -> CorridorConfig:
    values = asdict(base)
    overrides = profile.get("overrides", {})
    if not isinstance(overrides, Mapping):
        raise ValueError(f"Профиль {profile.get('id')} содержит неверные overrides")
    values.update(overrides)
    return CorridorConfig.from_mapping(values)


def _pooled_metrics(reports: Sequence[BacktestReport]) -> dict[str, object]:
    trades = [trade for report in reports for trade in report.trades]
    positive_r = sum(max(0.0, trade.r_multiple) for trade in trades)
    negative_r = -sum(min(0.0, trade.r_multiple) for trade in trades)
    wins = sum(trade.net_pnl_per_unit > 0 for trade in trades)
    return {
        "trades": len(trades),
        "wins": wins,
        "losses": sum(trade.net_pnl_per_unit < 0 for trade in trades),
        "win_rate_pct": wins / len(trades) * 100.0 if trades else 0.0,
        "target_hit_rate_pct": sum(trade.status == "TARGET" for trade in trades)
        / len(trades)
        * 100.0
        if trades
        else 0.0,
        "profit_factor_r": positive_r / negative_r if negative_r > 0 else None,
        "expectancy_r": sum(trade.r_multiple for trade in trades) / len(trades)
        if trades
        else 0.0,
        "average_net_trade_pct": sum(trade.net_return_pct for trade in trades)
        / len(trades)
        if trades
        else 0.0,
        "max_drawdown_pct": max(
            (float(report.summary["max_drawdown_pct"]) for report in reports),
            default=0.0,
        ),
        "average_symbol_return_pct": sum(
            float(report.summary["total_return_pct"]) for report in reports
        )
        / len(reports)
        if reports
        else 0.0,
        "profitable_symbols": sum(
            int(report.summary["trades"]) >= 5
            and float(report.summary["expectancy_r"]) > 0
            for report in reports
        ),
        "symbols_with_trades": sum(int(report.summary["trades"]) > 0 for report in reports),
    }


def _ranking_score(metrics: Mapping[str, object]) -> float:
    trades = int(metrics["trades"])
    if trades < 30:
        return -1_000_000.0 + trades
    expectancy = float(metrics["expectancy_r"])
    pf_value = metrics["profit_factor_r"]
    profit_factor = 3.0 if pf_value is None else min(float(pf_value), 3.0)
    drawdown = float(metrics["max_drawdown_pct"])
    profitable = int(metrics["profitable_symbols"])
    return (
        expectancy * 10.0
        + (profit_factor - 1.0) * 0.50
        + profitable * 0.30
        - drawdown * 0.02
        + min(math.log10(trades), 3.0) * 0.05
    )


def _qualified(train: Mapping[str, object], test: Mapping[str, object]) -> bool:
    train_pf = train["profit_factor_r"]
    test_pf = test["profit_factor_r"]
    return bool(
        int(train["trades"]) >= 30
        and int(test["trades"]) >= 15
        and float(train["expectancy_r"]) > 0
        and float(test["expectancy_r"]) > 0
        and train_pf is not None
        and test_pf is not None
        and float(train_pf) > 1.0
        and float(test_pf) > 1.0
        and int(test["profitable_symbols"]) >= 2
    )


def _fmt(value: object, digits: int = 2) -> str:
    if value is None:
        return "н/д"
    return f"{float(value):.{digits}f}"


def _segment_metrics(trades: Iterable[TradeResult]) -> dict[str, dict[str, object]]:
    items = list(trades)
    groups = {
        "MACD cross = да": [trade for trade in items if trade.macd_cross],
        "MACD cross = нет": [trade for trade in items if not trade.macd_cross],
        "MACD cross не старше 6 свечей": [
            trade
            for trade in items
            if trade.macd_bars_since_cross is not None
            and trade.macd_bars_since_cross <= 6
        ],
        "Нет MACD cross за 6 свечей": [
            trade
            for trade in items
            if trade.macd_bars_since_cross is None
            or trade.macd_bars_since_cross > 6
        ],
        "Гистограмма расширяется": [trade for trade in items if trade.histogram_expanding],
        "Гистограмма не расширяется": [trade for trade in items if not trade.histogram_expanding],
        "Есть модель Нисона": [trade for trade in items if trade.nison_patterns],
        "Нет модели Нисона": [trade for trade in items if not trade.nison_patterns],
        "BUY": [trade for trade in items if trade.direction == "BUY"],
        "SELL": [trade for trade in items if trade.direction == "SELL"],
        "Старший тренд подтверждает": [
            trade for trade in items if trade.senior_trend_aligned is True
        ],
        "Старший тренд не подтверждает": [
            trade for trade in items if trade.senior_trend_aligned is False
        ],
    }
    result: dict[str, dict[str, object]] = {}
    for label, trades_in_group in groups.items():
        positive = sum(max(0.0, trade.r_multiple) for trade in trades_in_group)
        negative = -sum(min(0.0, trade.r_multiple) for trade in trades_in_group)
        result[label] = {
            "trades": len(trades_in_group),
            "win_rate_pct": sum(t.net_pnl_per_unit > 0 for t in trades_in_group)
            / len(trades_in_group)
            * 100.0
            if trades_in_group
            else 0.0,
            "expectancy_r": sum(t.r_multiple for t in trades_in_group)
            / len(trades_in_group)
            if trades_in_group
            else 0.0,
            "profit_factor_r": positive / negative if negative > 0 else None,
        }
    return result


def _write_trade_log(
    path: Path,
    profile_id: str,
    test_reports: Mapping[str, BacktestReport],
) -> None:
    rows = []
    for symbol, report in test_reports.items():
        for trade in report.trades:
            row = trade.to_dict()
            row["profile_id"] = profile_id
            row["sample"] = "OUT_OF_SAMPLE"
            row["nison_patterns"] = ",".join(trade.nison_patterns)
            rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["profile_id", "sample"] + [
        key for key in TradeResult.__dataclass_fields__
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _write_markdown(
    path: Path,
    args,
    ranked: Sequence[Mapping[str, object]],
    selected: Mapping[str, object],
    segment_metrics: Mapping[str, Mapping[str, object]],
    rejection_reasons: Mapping[str, int],
) -> None:
    lines = [
        "# EMA Corridor — сравнительное исследование",
        "",
        f"Дата: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        f"Инструменты: {', '.join(args.symbols)}; базовый ТФ: {format_timeframe(args.base_tf)}.",
        f"Период оценки: последние {args.history} базовых свечей; обучение 70%, контроль 30%.",
        "",
        "Профили ранжируются только по обучающей части. Контрольная часть не используется для выбора.",
        "",
        "## Главный результат",
        "",
    ]
    if any(bool(item["qualified"]) for item in ranked):
        lines.append("Есть профиль, прошедший предварительные критерии допуска; перед Paper требуется ручной разбор сделок.")
    else:
        lines.append(
            "Ни один профиль не прошёл критерии допуска: положительное ожидание и PF выше 1 не подтвердились одновременно на обучении и контроле."
        )
    by_id = {str(item["id"]): item for item in ranked}
    diagnostic = by_id.get("P16_DIAGNOSTIC_OPEN")
    if diagnostic is not None:
        lines.extend(
            [
                "",
                (
                    "Диагностический почти неограниченный профиль показал на контроле "
                    f"win rate {_fmt(diagnostic['test']['win_rate_pct'])}%, но PF(R) "
                    f"{_fmt(diagnostic['test']['profit_factor_r'])} и ожидание "
                    f"{_fmt(diagnostic['test']['expectancy_r'])}R. Это наглядная ловушка: "
                    "высокий win rate не компенсирует маленькие TP и полные стопы."
                ),
            ]
        )
    recent_cross = by_id.get("P23_RR05_CROSS6")
    if recent_cross is not None:
        lines.extend(
            [
                "",
                (
                    "Недавнее пересечение MACD улучшило контрольную выборку до "
                    f"{_fmt(recent_cross['test']['win_rate_pct'])}% win rate и "
                    f"{_fmt(recent_cross['test']['expectancy_r'])}R, но само по себе "
                    "ещё не сделало стратегию прибыльной."
                ),
            ]
        )
    nison = by_id.get("P27_RR05_NISON")
    if nison is not None:
        lines.extend(
            [
                "",
                (
                    "Базовые модели Нисона улучшили качество относительно широкого "
                    f"профиля (контроль: {_fmt(nison['test']['expectancy_r'])}R), "
                    "но текущий распознаватель пока не учитывает полноценный свечной контекст."
                ),
            ]
        )
    lines.extend(
        [
            "",
            "## Сравнение профилей",
            "",
            "| Профиль | Train сделки | Train WR | Train PF(R) | Train E(R) | Test сделки | Test WR | Test PF(R) | Test E(R) | Допуск |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
    )
    for item in ranked:
        train = item["train"]
        test = item["test"]
        lines.append(
            f"| {item['id']} | {train['trades']} | {_fmt(train['win_rate_pct'])}% | "
            f"{_fmt(train['profit_factor_r'])} | {_fmt(train['expectancy_r'])} | "
            f"{test['trades']} | {_fmt(test['win_rate_pct'])}% | "
            f"{_fmt(test['profit_factor_r'])} | {_fmt(test['expectancy_r'])} | "
            f"{'ДА' if item['qualified'] else 'нет'} |"
        )
    lines.extend(
        [
            "",
            "## Профиль для разбора",
            "",
            f"`{selected['id']}` — {selected['description']}",
            "",
            "Это лучший профиль по обучающему рейтингу, а не автоматически утверждённая торговая настройка.",
            "",
            "## Контрольные сегменты выбранного профиля",
            "",
            "| Сегмент | Сделки | Win rate | PF(R) | Expectancy R |",
            "|---|---:|---:|---:|---:|",
        ]
    )
    for label, metrics in segment_metrics.items():
        lines.append(
            f"| {label} | {metrics['trades']} | {_fmt(metrics['win_rate_pct'])}% | "
            f"{_fmt(metrics['profit_factor_r'])} | {_fmt(metrics['expectancy_r'])} |"
        )
    lines.extend(["", "## Основные причины отклонения", ""])
    for reason, count in list(rejection_reasons.items())[:10]:
        lines.append(f"- {count}: {reason}")
    lines.extend(
        [
            "",
            "## Ограничения текущего теста",
            "",
            "- Используются OHLC-свечи; при одновременном TP/SL первым считается стоп.",
            "- Учтены комиссии и заданное проскальзывание, но пока не включены funding и исторический bid/ask spread.",
            "- Свечные модели Нисона в этой версии распознаются только базовым набором; сложный контекст ещё не формализован.",
            "- Результат одного периода не является гарантией будущей доходности.",
            "",
            "## Что править следующим",
            "",
            "1. Не входить сразу после первого закрытия внутри коридора: проверить второе подтверждающее закрытие и/или ретест стартовой EMA.",
            "2. Согласовать на реальных примерах точное место Stop Loss; протестированные варианты стопа оказались либо слишком широкими, либо часто выбивались возвратом к границе.",
            "3. Формализовать контекст моделей Нисона, а не требовать только название одной свечи.",
            "4. Заменить упрощённый старший фильтр EMA20/50 на вашу структуру: недельная основа, дневной режим и 4H-канал.",
            "5. После изменения входа повторить тот же фиксированный holdout; не подбирать параметры по контрольным 30%.",
            "",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Сравнение профилей EMA Corridor")
    parser.add_argument(
        "--symbols", type=_parse_symbols, default=_parse_symbols("ETHUSDT,BTCUSDT,SOLUSDT")
    )
    parser.add_argument("--base-tf", type=int, default=30)
    parser.add_argument(
        "--timeframes",
        type=_parse_int_list,
        default=_parse_int_list("15,30,60,240,1440,10080"),
    )
    parser.add_argument("--history", type=int, default=6000)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--strategy-config", type=Path, default=DEFAULT_STRATEGY_CONFIG)
    parser.add_argument("--backtest-config", type=Path, default=DEFAULT_BACKTEST_CONFIG)
    parser.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
    parser.add_argument("--json-report", type=Path, default=DEFAULT_JSON_REPORT)
    parser.add_argument("--notes", type=Path, default=DEFAULT_MARKDOWN_REPORT)
    parser.add_argument("--trade-log", type=Path, default=DEFAULT_TRADE_LOG)
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    args.history = max(500, min(int(args.history), 49_000))
    if args.base_tf not in args.timeframes:
        args.timeframes.append(args.base_tf)
        args.timeframes.sort()
    strategy_values = _read_json(args.strategy_config)
    backtest_values = _read_json(args.backtest_config)
    profiles = _read_json(args.profiles)
    if not isinstance(strategy_values, Mapping) or not isinstance(backtest_values, Mapping):
        raise ValueError("Файлы конфигурации должны содержать JSON-объекты")
    if not isinstance(profiles, list) or not profiles:
        raise ValueError("Файл исследовательских профилей должен содержать список")
    base_strategy = CorridorConfig.from_mapping(strategy_values)
    backtest_config = BacktestConfig.from_mapping(backtest_values)

    print("EMA CORRIDOR — СРАВНИТЕЛЬНОЕ ИССЛЕДОВАНИЕ")
    print("Профили выбираются по первым 70%; последние 30% не участвуют в выборе.")
    candles_by_symbol: dict[str, dict[int, list[Candle]]] = {}
    split_times: dict[str, tuple[int, int]] = {}
    for symbol in args.symbols:
        print(f"\nИстория {symbol}:")
        by_tf: dict[int, list[Candle]] = {}
        for timeframe in args.timeframes:
            requested = _required_history(args.base_tf, timeframe, args.history)
            candles, source = load_or_fetch_completed_klines(
                symbol, timeframe, requested, refresh=args.refresh
            )
            by_tf[timeframe] = candles
            print(f"  {format_timeframe(timeframe)}: {len(candles)} ({source})")
        base_candles = by_tf[args.base_tf]
        evaluation_count = min(args.history, len(base_candles) - INDICATOR_WARMUP)
        if evaluation_count < 300:
            raise ValueError(f"Недостаточно истории {symbol} для честного разделения")
        start_index = len(base_candles) - evaluation_count
        split_index = start_index + int(evaluation_count * 0.70)
        evaluation_start = base_candles[start_index].open_time
        split_time = base_candles[split_index].open_time
        candles_by_symbol[symbol] = by_tf
        split_times[symbol] = (evaluation_start, split_time)

    profile_results: list[dict[str, object]] = []
    runtime_reports: dict[str, dict[str, dict[str, BacktestReport]]] = {}
    for number, raw_profile in enumerate(profiles, start=1):
        if not isinstance(raw_profile, Mapping):
            raise ValueError("Каждый профиль должен быть JSON-объектом")
        profile_id = str(raw_profile.get("id", f"P{number:02d}"))
        description = str(raw_profile.get("description", ""))
        config = _profile_config(base_strategy, raw_profile)
        print(f"\n[{number}/{len(profiles)}] {profile_id}")
        per_symbol_serialized: dict[str, object] = {}
        train_reports: list[BacktestReport] = []
        test_reports: list[BacktestReport] = []
        profile_runtime: dict[str, dict[str, BacktestReport]] = {}
        for symbol, by_tf in candles_by_symbol.items():
            events = scan_corridor_events(symbol, by_tf, args.base_tf, config)
            evaluation_start, split_time = split_times[symbol]
            train_cutoff = (
                split_time
                - backtest_config.max_holding_bars * args.base_tf * 60_000
            )
            full_events = [event for event in events if event.signal_time >= evaluation_start]
            train_events = [
                event
                for event in full_events
                if event.signal_time < train_cutoff
            ]
            test_events = [event for event in full_events if event.signal_time >= split_time]
            full_report = run_backtest(
                full_events, by_tf[args.base_tf], config, backtest_config
            )
            train_report = run_backtest(
                train_events, by_tf[args.base_tf], config, backtest_config
            )
            test_report = run_backtest(
                test_events, by_tf[args.base_tf], config, backtest_config
            )
            train_reports.append(train_report)
            test_reports.append(test_report)
            profile_runtime[symbol] = {
                "full": full_report,
                "train": train_report,
                "test": test_report,
            }
            per_symbol_serialized[symbol] = {
                "full": {
                    "summary": full_report.summary,
                    "signal_counts": full_report.signal_counts,
                    "rejection_reasons": full_report.rejection_reasons,
                },
                "train": {
                    "summary": train_report.summary,
                    "signal_counts": train_report.signal_counts,
                },
                "test": {
                    "summary": test_report.summary,
                    "signal_counts": test_report.signal_counts,
                },
            }
        train_metrics = _pooled_metrics(train_reports)
        test_metrics = _pooled_metrics(test_reports)
        test_trades = [
            trade for report in test_reports for trade in report.trades
        ]
        item = {
            "id": profile_id,
            "description": description,
            "diagnostic_only": bool(raw_profile.get("diagnostic_only", False)),
            "overrides": raw_profile.get("overrides", {}),
            "train": train_metrics,
            "test": test_metrics,
            "test_segments": _segment_metrics(test_trades),
            "ranking_score_train_only": _ranking_score(train_metrics),
            "qualified": (
                False
                if bool(raw_profile.get("diagnostic_only", False))
                else _qualified(train_metrics, test_metrics)
            ),
            "symbols": per_symbol_serialized,
        }
        profile_results.append(item)
        runtime_reports[profile_id] = profile_runtime
        print(
            f"  train: {train_metrics['trades']} сделок, WR {_fmt(train_metrics['win_rate_pct'])}%, "
            f"PF {_fmt(train_metrics['profit_factor_r'])}, E {_fmt(train_metrics['expectancy_r'])}R"
        )

    ranked = sorted(
        profile_results,
        key=lambda item: (
            not bool(item["diagnostic_only"]),
            float(item["ranking_score_train_only"]),
        ),
        reverse=True,
    )
    selected = ranked[0]
    selected_id = str(selected["id"])
    selected_runtime = runtime_reports[selected_id]
    selected_test_reports = {
        symbol: reports["test"] for symbol, reports in selected_runtime.items()
    }
    selected_test_trades = [
        trade for report in selected_test_reports.values() for trade in report.trades
    ]
    segment_metrics = _segment_metrics(selected_test_trades)
    rejection_counter: Counter[str] = Counter()
    for reports in selected_runtime.values():
        rejection_counter.update(reports["full"].rejection_reasons)

    payload = {
        "mode": "RESEARCH_BACKTEST_NO_ORDERS",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "symbols": args.symbols,
        "base_timeframe": args.base_tf,
        "timeframes": args.timeframes,
        "history": args.history,
        "selection_rule": "rank_train_only_then_reveal_fixed_30pct_holdout",
        "selected_for_review": selected_id,
        "any_profile_qualified": any(bool(item["qualified"]) for item in ranked),
        "profiles": ranked,
        "selected_test_segments": segment_metrics,
        "selected_rejection_reasons": dict(rejection_counter.most_common()),
        "selected_out_of_sample_trades": [
            trade.to_dict() for trade in selected_test_trades
        ],
    }
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _write_trade_log(args.trade_log, selected_id, selected_test_reports)
    _write_markdown(
        args.notes,
        args,
        ranked,
        selected,
        segment_metrics,
        dict(rejection_counter.most_common()),
    )

    print("\nИТОГ ПО ОБУЧАЮЩЕЙ ЧАСТИ")
    for position, item in enumerate(ranked[:5], start=1):
        print(
            f"  {position}. {item['id']}: train E={_fmt(item['train']['expectancy_r'])}R, "
            f"test E={_fmt(item['test']['expectancy_r'])}R, "
            f"допуск={'ДА' if item['qualified'] else 'нет'}"
        )
    print(f"\nПрофиль для разбора: {selected_id}")
    print(f"Отчёт: {args.notes.resolve()}")
    print(f"JSON: {args.json_report.resolve()}")
    print(f"Лог контрольных сделок: {args.trade_log.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BybitPublicError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Ошибка исследования: {exc}", file=sys.stderr)
        raise SystemExit(2)
