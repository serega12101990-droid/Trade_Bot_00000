"""Запуск исторической проверки EMA Corridor без API-ключей и ордеров."""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path


if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trading_platform.backtesting.ema_corridor_backtest import (
    BacktestConfig,
    run_backtest,
)
from trading_platform.data.bybit_public import BybitPublicError, fetch_completed_klines
from trading_platform.strategies.ema_corridor import (
    CorridorConfig,
    format_timeframe,
    scan_corridor_events,
)


PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_STRATEGY_CONFIG = PROJECT_DIR / "ema_corridor_config.json"
DEFAULT_BACKTEST_CONFIG = PROJECT_DIR / "ema_corridor_backtest_config.json"
DEFAULT_REPORT = PROJECT_DIR / "logs" / "ema_corridor_backtest_last_report.json"
INDICATOR_WARMUP = 220


def _parse_int_list(raw: str) -> list[int]:
    values = sorted({int(item.strip()) for item in raw.split(",") if item.strip()})
    if not values:
        raise argparse.ArgumentTypeError("Нужно указать хотя бы один таймфрейм")
    return values


def _parse_symbols(raw: str) -> list[str]:
    values = [item.strip().upper() for item in raw.split(",") if item.strip()]
    if not values:
        raise argparse.ArgumentTypeError("Нужно указать хотя бы один инструмент")
    return list(dict.fromkeys(values))


def _load_json(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _required_history(base_tf: int, timeframe: int, base_bars: int) -> int:
    # Одинаковый календарный участок плюс отдельный запас для прогрева EMA200.
    covered_bars = math.ceil(base_bars * base_tf / timeframe)
    return min(50_000, max(INDICATOR_WARMUP, covered_bars + INDICATOR_WARMUP))


def _number(value: object, digits: int = 2) -> str:
    return f"{float(value):.{digits}f}"


def _profit_factor(value: object) -> str:
    return "нет убытков / н.д." if value is None else _number(value)


def _print_summary(symbol: str, report) -> None:
    summary = report.summary
    signals = report.signal_counts
    print(f"\n{symbol} — РЕЗУЛЬТАТ")
    print(
        f"  Сигналы: {signals['all']} | разрешено: {signals['allowed']} | "
        f"отклонено: {signals['rejected']}"
    )
    print(
        f"  Сделки: {summary['trades']} | винрейт: {_number(summary['win_rate_pct'])}% | "
        f"TP: {_number(summary['target_hit_rate_pct'])}%"
    )
    print(
        f"  Profit Factor: {_profit_factor(summary['profit_factor'])} | "
        f"ожидание: {_number(summary['expectancy_r'])} R"
    )
    print(
        f"  Доходность: {_number(summary['total_return_pct'])}% | "
        f"макс. просадка: {_number(summary['max_drawdown_pct'])}% | "
        f"серия убытков: {summary['max_consecutive_losses']}"
    )
    out_sample = report.out_of_sample
    print(
        f"  Контрольные последние 30%: {out_sample['trades']} сделок | "
        f"винрейт {_number(out_sample['win_rate_pct'])}% | "
        f"PF {_profit_factor(out_sample['profit_factor'])} | "
        f"ожидание {_number(out_sample['expectancy_r'])} R"
    )
    if report.skipped_overlaps:
        print(f"  Пропущено пересекающихся сигналов: {report.skipped_overlaps}")
    if report.skipped_invalid:
        print(f"  Пропущено событий с некорректной геометрией риска: {report.skipped_invalid}")
    if report.rejection_reasons:
        print("  Главные причины отказа:")
        for reason, count in list(report.rejection_reasons.items())[:5]:
            print(f"    {count:>5} — {reason}")
    if int(summary["trades"]) < 30:
        print("  ВНИМАНИЕ: меньше 30 сделок — данных пока недостаточно для вывода.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Исторический тест EMA Corridor без API-ключей и ордеров"
    )
    parser.add_argument("--symbols", type=_parse_symbols, default=_parse_symbols("ETHUSDT"))
    parser.add_argument("--base-tf", type=int, default=30)
    parser.add_argument(
        "--timeframes",
        type=_parse_int_list,
        default=_parse_int_list("15,30,60,240,1440,10080"),
        help="ТФ в минутах через запятую",
    )
    parser.add_argument(
        "--history",
        type=int,
        default=3000,
        help="Количество свечей базового ТФ без учёта прогрева EMA",
    )
    parser.add_argument("--strategy-config", type=Path, default=DEFAULT_STRATEGY_CONFIG)
    parser.add_argument("--backtest-config", type=Path, default=DEFAULT_BACKTEST_CONFIG)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    args.history = max(300, min(args.history, 49_000))
    if args.base_tf not in args.timeframes:
        args.timeframes.append(args.base_tf)
        args.timeframes.sort()
    strategy_config = CorridorConfig.from_mapping(_load_json(args.strategy_config))
    backtest_config = BacktestConfig.from_mapping(_load_json(args.backtest_config))

    print("EMA CORRIDOR — ИСТОРИЧЕСКИЙ ТЕСТ")
    print("API-ключи не используются. Ордера не отправляются.")
    print(
        f"Базовый ТФ: {format_timeframe(args.base_tf)} | "
        f"EMA: 20/50/200 Close | MACD: 12/26/9 | "
        f"риск: {backtest_config.risk_per_trade_pct:.2f}%"
    )
    all_reports: dict[str, object] = {}
    failed = False
    for symbol in args.symbols:
        print(f"\nЗагрузка {symbol}:")
        candles_by_tf = {}
        try:
            for timeframe in args.timeframes:
                requested = _required_history(args.base_tf, timeframe, args.history)
                candles = fetch_completed_klines(symbol, timeframe, limit=requested)
                candles_by_tf[timeframe] = candles
                print(
                    f"  {format_timeframe(timeframe)}: {len(candles)} "
                    f"завершённых свечей"
                )
        except (BybitPublicError, ValueError) as exc:
            print(f"  Ошибка данных: {exc}", file=sys.stderr)
            failed = True
            continue

        events = scan_corridor_events(
            symbol, candles_by_tf, args.base_tf, strategy_config
        )
        report = run_backtest(
            events,
            candles_by_tf[args.base_tf],
            strategy_config,
            backtest_config,
        )
        all_reports[symbol] = report.to_dict()
        _print_summary(symbol, report)

    payload = {
        "mode": "HISTORICAL_BACKTEST_ONLY",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "base_timeframe": args.base_tf,
        "timeframes": args.timeframes,
        "requested_base_history": args.history,
        "strategy_config": asdict(strategy_config),
        "backtest_config": asdict(backtest_config),
        "symbols": all_reports,
        "methodology": {
            "entry": "next_base_candle_open",
            "intrabar_ambiguity": "stop_first_conservative",
            "costs": "commission_and_slippage_both_sides",
            "overlap": "single_position_per_symbol_by_default",
            "look_ahead": False,
            "funding_included": False,
        },
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nПолный отчёт сохранён: {args.report.resolve()}")
    if not all_reports:
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
