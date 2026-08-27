"""Exploratory test of direction, timeframe, cooldown and scaled exits.

Important: these hypotheses were proposed after looking at the first holdout.
Therefore this run is exploratory and cannot turn the reused period into a new
independent validation sample.
"""

from __future__ import annotations

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
    TradeResult,
    simulate_event,
)
from trading_platform.backtesting.scaled_exit_backtest import simulate_scaled_exit
from trading_platform.run_mtf_strategy_research import (
    CRYPTO_ROLES,
    STOCK_ROLES,
    ResearchUnit,
    _events_for_profile,
    _load_market_data,
    _make_units,
)
from trading_platform.strategies.ema_corridor import CorridorConfig
from trading_platform.strategies.mtf_ema_setup import MtfProfile


PROJECT_DIR = Path(__file__).resolve().parent
STRATEGY_CONFIG = PROJECT_DIR / "ema_corridor_config.json"
BACKTEST_CONFIG = PROJECT_DIR / "ema_corridor_backtest_config.json"
PROFILES_FILE = PROJECT_DIR / "mtf_research_profiles.json"
JSON_REPORT = PROJECT_DIR / "logs" / "strategy_improvement_research.json"
NOTES_REPORT = PROJECT_DIR / "logs" / "strategy_improvement_research.md"


@dataclass(frozen=True)
class ImprovementVariant:
    market: str
    profile_id: str
    direction: str
    setup_scope: str
    cooldown_setup_bars: int
    holding_setup_bars: int
    exit_mode: str

    @property
    def variant_id(self) -> str:
        return (
            f"{self.profile_id}|{self.direction}|{self.setup_scope}|"
            f"CD{self.cooldown_setup_bars}|H{self.holding_setup_bars}|{self.exit_mode}"
        )


def _read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _selected_profiles() -> dict[str, MtfProfile]:
    raw = _read_json(PROFILES_FILE)
    if not isinstance(raw, list):
        raise ValueError("Профили должны быть списком")
    wanted = {
        "P08_MACD_AGGRESSIVE_VOLUME_PULLBACK50",
        "P10_CROSS_NISON_PULLBACK50",
        "P12_MACD_NISON_PULLBACK50_RR1",
        "P06_MACD_VOLUME_PULLBACK50",
    }
    result = {
        str(value.get("profile_id")): MtfProfile.from_mapping(value)
        for value in raw
        if str(value.get("profile_id")) in wanted
    }
    missing = wanted - set(result)
    if missing:
        raise ValueError(f"Нет профилей: {sorted(missing)}")
    return result


def _variants() -> list[ImprovementVariant]:
    result: list[ImprovementVariant] = []
    for profile in (
        "P08_MACD_AGGRESSIVE_VOLUME_PULLBACK50",
        "P10_CROSS_NISON_PULLBACK50",
    ):
        for direction in ("BOTH", "BUY", "SELL"):
            for cooldown in (0, 8):
                for holding in (12, 24):
                    for exit_mode in ("FAR_EMA", "PARTIAL50_BE"):
                        result.append(
                            ImprovementVariant(
                                "CRYPTO", profile, direction, "ALL", cooldown, holding, exit_mode
                            )
                        )
    for profile in (
        "P12_MACD_NISON_PULLBACK50_RR1",
        "P06_MACD_VOLUME_PULLBACK50",
    ):
        for scope in ("ALL", "1H_ONLY"):
            for direction in ("BOTH", "BUY", "SELL"):
                for cooldown in (0, 8):
                    for holding in (12, 24):
                        for exit_mode in ("FAR_EMA", "PARTIAL50_BE"):
                            result.append(
                                ImprovementVariant(
                                    "STOCK", profile, direction, scope, cooldown, holding, exit_mode
                                )
                            )
    return result


def _deduplicate(events: Sequence, unit: ResearchUnit, bars: int) -> list:
    ordered = sorted(events, key=lambda event: event.signal_time)
    if bars <= 0:
        return ordered
    kept = []
    last_by_direction: dict[str, int] = {}
    gap = bars * unit.setup_tf * 60_000
    for event in ordered:
        previous = last_by_direction.get(event.direction)
        if previous is not None and event.signal_time - previous < gap:
            continue
        kept.append(event)
        last_by_direction[event.direction] = event.signal_time
    return kept


def _simulate_stream(
    events: Sequence,
    unit: ResearchUnit,
    variant: ImprovementVariant,
    strategy_config: CorridorConfig,
    backtest_config: BacktestConfig,
) -> list[TradeResult]:
    max_bars = max(4, math.ceil(variant.holding_setup_bars * unit.setup_tf / unit.entry_tf))
    cfg = replace(backtest_config, max_holding_bars=max_bars, out_of_sample_pct=0.0)
    active_until = -1
    trades: list[TradeResult] = []
    candles = unit.candles_by_tf[unit.entry_tf]
    for event in _deduplicate(events, unit, variant.cooldown_setup_bars):
        if event.signal_time < active_until:
            continue
        trade = (
            simulate_scaled_exit(event, candles, strategy_config, cfg)
            if variant.exit_mode == "PARTIAL50_BE"
            else simulate_event(event, candles, strategy_config, cfg)
        )
        if trade is None:
            continue
        trades.append(trade)
        active_until = trade.exit_time
    return trades


def _metrics(items: Sequence[tuple[str, TradeResult]]) -> dict[str, object]:
    trades = [trade for _, trade in items]
    positive = sum(max(0.0, trade.r_multiple) for trade in trades)
    negative = -sum(min(0.0, trade.r_multiple) for trade in trades)
    by_symbol: dict[str, list[TradeResult]] = defaultdict(list)
    for symbol, trade in items:
        by_symbol[symbol].append(trade)
    wins = sum(trade.net_pnl_per_unit > 0 for trade in trades)
    return {
        "trades": len(trades),
        "win_rate_pct": wins / len(trades) * 100.0 if trades else 0.0,
        "profit_factor_r": positive / negative if negative > 0 else None,
        "expectancy_r": sum(t.r_multiple for t in trades) / len(trades) if trades else 0.0,
        "average_net_trade_pct": (
            sum(t.net_return_pct for t in trades) / len(trades) if trades else 0.0
        ),
        "profitable_symbols": sum(
            len(values) >= 3 and sum(trade.r_multiple for trade in values) > 0
            for values in by_symbol.values()
        ),
        "symbols_with_trades": len(by_symbol),
        "status_counts": {
            status: sum(trade.status == status for trade in trades)
            for status in sorted({trade.status for trade in trades})
        },
    }


def _rank(metrics: Mapping[str, object], market: str) -> float:
    minimum = 40 if market == "CRYPTO" else 30
    count = int(metrics["trades"])
    if count < minimum:
        return -1_000_000 + count
    pf_raw = metrics["profit_factor_r"]
    pf = 3.0 if pf_raw is None else min(float(pf_raw), 3.0)
    return float(metrics["expectancy_r"]) * 10 + (pf - 1.0) * 0.5 + min(count, 300) / 3000


def _fmt(value: object) -> str:
    return "н/д" if value is None else f"{float(value):.2f}"


def _evaluate(
    variant: ImprovementVariant,
    units: Sequence[ResearchUnit],
    event_cache: Mapping[tuple[str, str], Sequence],
    strategy_config: CorridorConfig,
    backtest_config: BacktestConfig,
) -> dict[str, object]:
    train_items: list[tuple[str, TradeResult]] = []
    test_items: list[tuple[str, TradeResult]] = []
    for unit in units:
        if unit.market != variant.market:
            continue
        if variant.setup_scope == "1H_ONLY" and unit.setup_tf != 60:
            continue
        events = list(event_cache[(variant.profile_id, unit.key)])
        if variant.direction != "BOTH":
            events = [event for event in events if event.direction == variant.direction]
        max_bars = max(4, math.ceil(variant.holding_setup_bars * unit.setup_tf / unit.entry_tf))
        train_cutoff = unit.split_time - max_bars * unit.entry_tf * 60_000
        train_events = [
            event for event in events
            if unit.evaluation_start <= event.signal_time < train_cutoff
        ]
        test_events = [event for event in events if event.signal_time >= unit.split_time]
        train_items.extend(
            (unit.symbol, trade)
            for trade in _simulate_stream(
                train_events, unit, variant, strategy_config, backtest_config
            )
        )
        test_items.extend(
            (unit.symbol, trade)
            for trade in _simulate_stream(
                test_events, unit, variant, strategy_config, backtest_config
            )
        )
    train = _metrics(train_items)
    test = _metrics(test_items)
    return {
        "variant_id": variant.variant_id,
        "parameters": asdict(variant),
        "train": train,
        "test": test,
        "rank_train_only": _rank(train, variant.market),
        "positive_both": float(train["expectancy_r"]) > 0 and float(test["expectancy_r"]) > 0,
    }


def _write_notes(path: Path, by_market: Mapping[str, Sequence[Mapping[str, object]]]) -> None:
    lines = [
        "# Проверка предложенных улучшений",
        "",
        f"Сформирован: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}.",
        "",
        "Статус: **exploratory reuse**. Эти идеи появились после просмотра первого контроля, "
        "поэтому повторное использование того же периода не является новой независимой проверкой.",
        "",
        "Проверено: LONG/SHORT отдельно, акции только с SETUP 1H, пауза 8 SETUP-свечей "
        "между однонаправленными входами, удержание 12/24 SETUP-свечи, полный TP у EMA "
        "против фиксации 50% на середине коридора с переносом остатка в безубыток.",
        "",
    ]
    for market, title in (("CRYPTO", "Криптовалюты"), ("STOCK", "Акции США")):
        results = list(by_market.get(market, ()))
        lines.extend(
            [
                f"## {title}",
                "",
                "| Вариант | Train n | WR | PF | E(R) | Test n | WR | PF | E(R) | + на обеих |",
                "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
            ]
        )
        for item in results[:15]:
            train, test = item["train"], item["test"]
            lines.append(
                f"| {item['variant_id']} | {train['trades']} | {_fmt(train['win_rate_pct'])}% | "
                f"{_fmt(train['profit_factor_r'])} | {_fmt(train['expectancy_r'])} | "
                f"{test['trades']} | {_fmt(test['win_rate_pct'])}% | "
                f"{_fmt(test['profit_factor_r'])} | {_fmt(test['expectancy_r'])} | "
                f"{'да' if item['positive_both'] else 'нет'} |"
            )
        if results:
            best = results[0]
            lines.extend(
                [
                    "",
                    f"Лучший по Train: `{best['variant_id']}`. Контроль: "
                    f"{best['test']['trades']} сделок, PF {_fmt(best['test']['profit_factor_r'])}, "
                    f"E {_fmt(best['test']['expectancy_r'])}R.",
                    "",
                ]
            )
    lines.extend(
        [
            "## Правило решения",
            "",
            "Даже положительный результат здесь считается только направлением разработки. "
            "Для допуска нужен новый, ещё не просмотренный период либо Paper/DEMO вперёд по времени.",
            "",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    strategy_raw = _read_json(STRATEGY_CONFIG)
    backtest_raw = _read_json(BACKTEST_CONFIG)
    if not isinstance(strategy_raw, Mapping) or not isinstance(backtest_raw, Mapping):
        raise ValueError("Неверные конфигурации")
    strategy_config = CorridorConfig.from_mapping(strategy_raw)
    backtest_config = BacktestConfig.from_mapping(backtest_raw)
    profiles = _selected_profiles()
    crypto, stocks, errors = _load_market_data(False)
    units = _make_units("CRYPTO", crypto, CRYPTO_ROLES, strategy_config)
    units += _make_units("STOCK", stocks, STOCK_ROLES, strategy_config)
    event_cache: dict[tuple[str, str], Sequence] = {}
    for profile_id, profile in profiles.items():
        for unit in units:
            events, _ = _events_for_profile(unit, profile, strategy_config)
            event_cache[(profile_id, unit.key)] = events
    results = [_evaluate(v, units, event_cache, strategy_config, backtest_config) for v in _variants()]
    by_market: dict[str, list[dict[str, object]]] = {"CRYPTO": [], "STOCK": []}
    for item in results:
        market = str(item["parameters"]["market"])
        by_market[market].append(item)
    for values in by_market.values():
        values.sort(key=lambda item: float(item["rank_train_only"]), reverse=True)
    payload = {
        "mode": "EXPLORATORY_REUSE_NOT_INDEPENDENT_VALIDATION",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_errors": errors,
        "results": by_market,
    }
    JSON_REPORT.parent.mkdir(parents=True, exist_ok=True)
    JSON_REPORT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_notes(NOTES_REPORT, by_market)
    for market, values in by_market.items():
        best = values[0]
        print(
            f"{market}: {best['variant_id']} | test n={best['test']['trades']} "
            f"PF={_fmt(best['test']['profit_factor_r'])} E={_fmt(best['test']['expectancy_r'])}R"
        )
    print(f"Отчёт: {NOTES_REPORT.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
