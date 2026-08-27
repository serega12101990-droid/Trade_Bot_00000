"""Безопасный запуск анализатора EMA Corridor без отправки ордеров."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path


if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trading_platform.data.bybit_public import BybitPublicError, fetch_completed_klines
from trading_platform.strategies.ema_corridor import (
    CorridorConfig,
    build_snapshot_series,
    detect_corridors,
    format_timeframe,
    scan_corridor_events,
)


DEFAULT_CONFIG = Path(__file__).with_name("ema_corridor_config.json")
DEFAULT_REPORT = Path(__file__).with_name("logs") / "ema_corridor_last_report.json"


def _parse_timeframes(raw: str) -> list[int]:
    values = sorted({int(item.strip()) for item in raw.split(",") if item.strip()})
    if not values:
        raise argparse.ArgumentTypeError("Нужно указать хотя бы один таймфрейм")
    return values


def _load_config(path: Path) -> CorridorConfig:
    if not path.exists():
        return CorridorConfig()
    return CorridorConfig.from_mapping(json.loads(path.read_text(encoding="utf-8")))


def _time_label(timestamp_ms: int) -> str:
    value = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
    return value.strftime("%Y-%m-%d %H:%M UTC")


def _print_current_corridors(symbol: str, snapshots_by_tf, config: CorridorConfig) -> None:
    print("\nТЕКУЩАЯ КАРТА EMA-КОРИДОРОВ (последние завершённые свечи)")
    found = False
    for timeframe in sorted(snapshots_by_tf):
        snapshots = snapshots_by_tf[timeframe]
        if not snapshots:
            print(f"  {format_timeframe(timeframe)}: недостаточно истории для EMA200")
            continue
        snapshot = snapshots[-1]
        corridors = detect_corridors(snapshot, config)
        if not corridors:
            print(f"  {format_timeframe(timeframe)}: свободных коридоров нет")
            continue
        found = True
        for corridor in corridors:
            print(
                f"  {format_timeframe(timeframe)} {corridor.label}: "
                f"{corridor.lower_boundary:.6g} — {corridor.upper_boundary:.6g} | "
                f"{corridor.width_pct:.2f}% | {corridor.width_atr:.2f} ATR"
            )
    if not found:
        print("  Подходящих коридоров по текущим порогам не найдено.")


def _print_event(event, number: int) -> None:
    status = "РАЗРЕШЁН ДЛЯ PAPER" if event.allowed else "ОТКЛОНЁН"
    print(
        f"\n#{number} {status} | {_time_label(event.signal_time)} | "
        f"{format_timeframe(event.base_timeframe)} {event.direction}"
    )
    print(
        f"  Коридор {event.corridor.label}: "
        f"{event.corridor.lower_boundary:.6g} — {event.corridor.upper_boundary:.6g} "
        f"({event.corridor.width_pct:.2f}%, {event.corridor.width_atr:.2f} ATR)"
    )
    print(
        f"  Вход следующей свечи: {event.entry_price:.6g} | "
        f"структурный стоп: {event.stop_price:.6g} | score={event.score:.2f}"
    )
    print(
        "  MACD: "
        f"направление={'да' if event.macd_aligned else 'нет'}, "
        f"пересечение={'да' if event.macd_cross else 'нет'}, "
        f"гистограмма усиливается={'да' if event.histogram_expanding else 'нет'}"
    )
    print(f"  Свечи Нисона: {', '.join(event.nison_patterns) or 'нет модели'}")
    if event.targets:
        print("  Лестница целей:")
        for index, target in enumerate(event.targets, start=1):
            adequate = "подходит" if target.adequate else "недостаточная прибыль/R:R"
            print(
                f"    TP{index}: {target.executable_price:.6g} перед {target.label} | "
                f"сила={target.strength_label}({target.strength:.1f}) | "
                f"net={target.net_reward_pct:.2f}% | R:R={target.net_rr:.2f} | {adequate}"
            )
    if event.reasons:
        print("  Причины отказа: " + "; ".join(event.reasons))


def _write_report(path: Path, args, config, snapshots_by_tf, events) -> None:
    current_corridors = {}
    for timeframe, snapshots in snapshots_by_tf.items():
        current_corridors[str(timeframe)] = (
            [asdict(item) for item in detect_corridors(snapshots[-1], config)]
            if snapshots
            else []
        )
    payload = {
        "mode": "ANALYSIS_PAPER_ONLY",
        "symbol": args.symbol.upper(),
        "base_timeframe": args.base_tf,
        "timeframes": args.timeframes,
        "config": asdict(config),
        "current_corridors": current_corridors,
        "events": [asdict(event) for event in events],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="EMA Corridor: анализ без API-ключей и без отправки ордеров"
    )
    parser.add_argument("--symbol", default="ETHUSDT")
    parser.add_argument("--base-tf", type=int, default=30)
    parser.add_argument(
        "--timeframes",
        type=_parse_timeframes,
        default=_parse_timeframes("15,30,60,240,1440,10080"),
        help="ТФ в минутах через запятую",
    )
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--events", type=int, default=10)
    parser.add_argument("--only-allowed", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.base_tf not in args.timeframes:
        args.timeframes.append(args.base_tf)
        args.timeframes.sort()
    config = _load_config(args.config)
    print("EMA CORRIDOR ANALYZER — ANALYSIS/PAPER ONLY, ОРДЕРА НЕ ОТПРАВЛЯЮТСЯ")
    print(
        f"Инструмент: {args.symbol.upper()} | базовый ТФ: "
        f"{format_timeframe(args.base_tf)} | MACD: 12/26/9 | EMA: Close"
    )
    candles_by_tf = {}
    try:
        for timeframe in args.timeframes:
            candles = fetch_completed_klines(
                args.symbol, timeframe, limit=args.limit
            )
            candles_by_tf[timeframe] = candles
            print(
                f"  Загружено {len(candles)} закрытых свечей {format_timeframe(timeframe)}"
            )
    except (BybitPublicError, ValueError) as exc:
        print(f"Ошибка данных: {exc}", file=sys.stderr)
        return 2

    snapshots_by_tf = {
        timeframe: build_snapshot_series(candles, timeframe, config)
        for timeframe, candles in candles_by_tf.items()
    }
    events = list(
        scan_corridor_events(
            args.symbol.upper(), candles_by_tf, args.base_tf, config
        )
    )
    if args.only_allowed:
        events = [event for event in events if event.allowed]
    events = events[-max(1, args.events) :]
    _write_report(args.report, args, config, snapshots_by_tf, events)
    if args.json_output:
        print(json.dumps([asdict(event) for event in events], ensure_ascii=False, indent=2))
        return 0
    _print_current_corridors(args.symbol.upper(), snapshots_by_tf, config)
    print(f"\nПОСЛЕДНИЕ СОБЫТИЯ: {len(events)}")
    for number, event in enumerate(events, start=1):
        _print_event(event, number)
    if not events:
        print("  За доступный период событий по текущим фильтрам не найдено.")
    print(f"\nОтчёт сохранён: {args.report.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
