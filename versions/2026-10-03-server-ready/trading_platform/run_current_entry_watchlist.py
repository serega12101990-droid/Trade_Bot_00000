"""Обновить 25 тикеров и построить текущий watchlist возможных входов."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trading_platform.run_mtf_strategy_research import (
    CRYPTO_ROLES,
    CRYPTO_SYMBOLS,
    STOCK_ROLES,
    STOCK_SYMBOLS,
    _load_market_data,
)
from trading_platform.strategies.current_entry_watchlist import (
    EntryIdea,
    scan_symbol_entry_ideas,
)
from trading_platform.strategies.ema_corridor import CorridorConfig, format_timeframe


PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = PROJECT_DIR / "ema_corridor_config.json"
DEFAULT_JSON = PROJECT_DIR / "logs" / "current_entry_watchlist.json"
DEFAULT_NOTES = PROJECT_DIR / "logs" / "current_entry_watchlist.md"


def _read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _fmt(value: float, digits: int = 4) -> str:
    return f"{value:.{digits}f}"


def _time(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")


def _stage_text(stage: str) -> str:
    return {
        "TRIGGERED": "пробойная свеча закрылась",
        "INSIDE_EARLY": "цена в начальной части коридора",
        "WATCH_BREAK": "ждать закрытие за стартовой EMA",
    }.get(stage, stage)


def _action_text(action: str) -> str:
    return {
        "WAIT_PULLBACK_ENTRY": "не догонять; ждать откат в зону",
        "WAIT_TRIGGER_OR_PULLBACK": "ждать пробой/подтверждение и откат",
        "WATCH_ONLY": "только наблюдение, вход ещё не подтверждён",
    }.get(action, action)


def _write_markdown(
    path: Path,
    ideas_by_symbol: Mapping[str, Sequence[EntryIdea]],
    errors: Sequence[str],
) -> None:
    all_ideas = [idea for ideas in ideas_by_symbol.values() for idea in ideas]
    actionable = [idea for idea in all_ideas if idea.grade in {"A", "B"}]
    actionable.sort(key=lambda item: (item.grade == "A", item.score), reverse=True)
    lines = [
        "# Текущий watchlist возможных входов",
        "",
        f"Сканирование: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}.",
        "",
        "Это карта сценариев по последним завершённым свечам, а не команда купить или продать. "
        "Ордеров скрипт не отправляет.",
        "",
        "## Наиболее подготовленные сценарии",
        "",
    ]
    if actionable:
        lines.extend(
            [
                "| Класс | Тикер | Сценарий | SETUP/CONTEXT/ENTRY | Состояние | Зона входа | Отмена | TP1 | TP2 | RR до TP1 |",
                "|---|---|---|---|---|---:|---:|---:|---:|---:|",
            ]
        )
        for idea in actionable:
            lines.append(
                f"| {idea.grade} | {idea.symbol} | {'LONG' if idea.direction == 'BUY' else 'SHORT'} | "
                f"{format_timeframe(idea.setup_timeframe)}/"
                f"{format_timeframe(idea.context_timeframe)}/"
                f"{format_timeframe(idea.entry_timeframe)} | {_stage_text(idea.stage)} | "
                f"{_fmt(idea.entry_zone_low)}–{_fmt(idea.entry_zone_high)} | "
                f"{_fmt(idea.invalidation)} | {_fmt(idea.target_1)} | {_fmt(idea.target_2)} | "
                f"{idea.estimated_rr_to_target_1:.2f} |"
            )
    else:
        lines.append("Сценариев класса A/B сейчас нет. Это нормальный результат: лучше отсутствие входа, чем слабый вход.")
    lines.extend(["", "## Разбор всех 25 тикеров", ""])
    for market, symbols in (("Крипто", CRYPTO_SYMBOLS), ("Акции США", STOCK_SYMBOLS)):
        lines.extend([f"### {market}", ""])
        for symbol in symbols:
            ideas = ideas_by_symbol.get(symbol, ())
            if not ideas:
                lines.append(f"- **{symbol}:** входа по текущим правилам нет.")
                continue
            lines.append(f"- **{symbol}:**")
            for idea in ideas:
                side = "LONG" if idea.direction == "BUY" else "SHORT"
                patterns = ", ".join(idea.nison_patterns) or "нет направленной модели"
                warnings = "; ".join(idea.warnings) or "существенных предупреждений нет"
                lines.append(
                    f"  - класс {idea.grade}, {side}, "
                    f"{format_timeframe(idea.setup_timeframe)}/"
                    f"{format_timeframe(idea.context_timeframe)}/"
                    f"{format_timeframe(idea.entry_timeframe)}; {_stage_text(idea.stage)}; "
                    f"Close {_fmt(idea.current_close)} на {_time(idea.asof_time)} UTC."
                )
                lines.append(
                    f"    Зона {_fmt(idea.entry_zone_low)}–{_fmt(idea.entry_zone_high)}, "
                    f"отмена {_fmt(idea.invalidation)}, TP1 {_fmt(idea.target_1)} "
                    f"({idea.target_1_label}), TP2 {_fmt(idea.target_2)}, "
                    f"расчётный RR {idea.estimated_rr_to_target_1:.2f}."
                )
                lines.append(
                    f"    MACD: {idea.context_phase}; Нисон: {patterns}; "
                    f"объём={'да' if idea.volume_confirmation else 'нет'}, "
                    f"агрессивная свеча={'да' if idea.aggressive_candle else 'нет'}, "
                    f"сжатие={'да' if idea.compression else 'нет'}."
                )
                lines.append(f"    Действие: {_action_text(idea.action)}. Риски: {warnings}.")
        lines.append("")
    lines.extend(
        [
            "## Как читать классы",
            "",
            "- **A** — несколько подтверждений уже есть, но вход всё равно только после проверки актуальной цены и отката.",
            "- **B** — сценарий близок к готовности; отсутствует часть подтверждений или ещё нужен пробой.",
            "- **C** — наблюдение. Открывать сделку по одному такому сценарию нельзя.",
            "",
            "## Ограничения",
            "",
            "- Используются только полностью завершённые свечи; текущая формирующаяся свеча намеренно исключена.",
            "- Криптовалюты: публичные Bybit/OKX perpetual. Акции: Yahoo Chart, только regular session.",
            "- Цена может уйти от указанной зоны после формирования отчёта; перед любым решением нужен повторный скан.",
            "- Классы A/B/C — техническая полнота сценария, а не вероятность прибыли.",
            "- Стратегия пока не прошла исторические критерии допуска, поэтому результаты предназначены для ручного разбора и DEMO.",
            "",
        ]
    )
    if errors:
        lines.extend(["## Ошибки загрузки", ""] + [f"- {item}" for item in errors] + [""])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Current 25-symbol entry watchlist")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--json-report", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--notes", type=Path, default=DEFAULT_NOTES)
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    raw_config = _read_json(args.config)
    if not isinstance(raw_config, Mapping):
        raise ValueError("Конфигурация должна быть JSON-объектом")
    config = CorridorConfig.from_mapping(raw_config)
    crypto, stocks, errors = _load_market_data(args.refresh)
    ideas_by_symbol: dict[str, tuple[EntryIdea, ...]] = {}
    for symbol, data in crypto.items():
        ideas_by_symbol[symbol] = scan_symbol_entry_ideas(
            "CRYPTO", symbol, data, CRYPTO_ROLES, config
        )
    for symbol, data in stocks.items():
        ideas_by_symbol[symbol] = scan_symbol_entry_ideas(
            "STOCK", symbol, data, STOCK_ROLES, config
        )
    payload = {
        "mode": "CURRENT_WATCHLIST_NO_ORDERS",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ideas": {
            symbol: [idea.to_dict() for idea in ideas]
            for symbol, ideas in ideas_by_symbol.items()
        },
        "data_errors": errors,
    }
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _write_markdown(args.notes, ideas_by_symbol, errors)
    counts = {grade: 0 for grade in ("A", "B", "C")}
    for ideas in ideas_by_symbol.values():
        for idea in ideas:
            counts[idea.grade] += 1
    print(f"Watchlist готов: A={counts['A']}, B={counts['B']}, C={counts['C']}")
    print(f"Отчёт: {args.notes.resolve()}")
    print(f"JSON: {args.json_report.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
