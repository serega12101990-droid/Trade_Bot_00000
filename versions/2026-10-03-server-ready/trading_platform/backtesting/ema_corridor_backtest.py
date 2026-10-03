"""Консервативный свечной бэктест стратегии EMA Corridor.

Симулятор не отправляет ордера. Если внутри одной свечи были задеты и Stop Loss,
и Take Profit, результат считается по Stop Loss: по OHLC невозможно достоверно
узнать, какое касание произошло первым.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, replace
from typing import Mapping, Sequence

from trading_platform.strategies.ema_corridor import (
    Candle,
    CorridorConfig,
    CorridorEvent,
)


@dataclass(frozen=True)
class BacktestConfig:
    starting_equity: float = 10_000.0
    risk_per_trade_pct: float = 1.0
    max_leverage: float = 1.0
    max_holding_bars: int = 48
    allow_overlapping_positions: bool = False
    out_of_sample_pct: float = 30.0

    @classmethod
    def from_mapping(cls, values: Mapping[str, object]) -> "BacktestConfig":
        allowed = set(cls.__dataclass_fields__)
        return cls(**{key: value for key, value in values.items() if key in allowed})


@dataclass(frozen=True)
class TradeResult:
    symbol: str
    signal_time: int
    entry_time: int
    exit_time: int
    base_timeframe: int
    direction: str
    corridor_label: str
    target_label: str
    status: str
    holding_bars: int
    entry_price: float
    exit_price: float
    stop_price: float
    target_price: float
    net_return_pct: float
    r_multiple: float
    mfe_pct: float
    mae_pct: float
    score: float
    macd_cross: bool
    macd_bars_since_cross: int | None
    histogram_expanding: bool
    senior_trend_aligned: bool | None
    nison_patterns: tuple[str, ...]
    risk_per_unit: float
    net_pnl_per_unit: float
    position_notional: float = 0.0
    risk_cash: float = 0.0
    pnl_cash: float = 0.0
    equity_before: float = 0.0
    equity_after: float = 0.0

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class BacktestReport:
    summary: Mapping[str, object]
    in_sample: Mapping[str, object]
    out_of_sample: Mapping[str, object]
    signal_counts: Mapping[str, int]
    rejection_reasons: Mapping[str, int]
    skipped_overlaps: int
    skipped_invalid: int
    trades: tuple[TradeResult, ...]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _entry_fill(price: float, direction: str, slippage_rate: float) -> float:
    return price * (1.0 + slippage_rate) if direction == "BUY" else price * (
        1.0 - slippage_rate
    )


def _normal_exit_fill(price: float, direction: str, slippage_rate: float) -> float:
    # BUY закрывается продажей, SELL — покупкой.
    return price * (1.0 - slippage_rate) if direction == "BUY" else price * (
        1.0 + slippage_rate
    )


def _stop_raw_fill(candle: Candle, stop_price: float, direction: str) -> float:
    # При гэпе стоп исполняется не лучше цены открытия свечи.
    if direction == "BUY":
        return min(stop_price, candle.open)
    return max(stop_price, candle.open)


def _pnl_per_unit(direction: str, entry: float, exit_price: float) -> float:
    return exit_price - entry if direction == "BUY" else entry - exit_price


def _risk_per_unit(
    direction: str,
    entry_fill: float,
    stop_price: float,
    commission_rate: float,
    slippage_rate: float,
) -> float:
    stop_fill = _normal_exit_fill(stop_price, direction, slippage_rate)
    gross_loss = -_pnl_per_unit(direction, entry_fill, stop_fill)
    commissions = commission_rate * (entry_fill + stop_fill)
    return gross_loss + commissions


def simulate_event(
    event: CorridorEvent,
    candles: Sequence[Candle],
    strategy_config: CorridorConfig,
    backtest_config: BacktestConfig | None = None,
) -> TradeResult | None:
    """Проследить одну разрешённую сделку от входа до выхода."""

    cfg = backtest_config or BacktestConfig()
    if not event.allowed or not event.targets or cfg.max_holding_bars <= 0:
        return None
    target = event.targets[0]
    if not target.adequate:
        return None

    ordered = sorted(candles, key=lambda candle: candle.open_time)
    entry_index = next(
        (index for index, candle in enumerate(ordered) if candle.open_time >= event.signal_time),
        None,
    )
    if entry_index is None:
        return None
    entry_candle = ordered[entry_index]
    direction = event.direction.upper()
    entry_fill = _entry_fill(event.entry_price, direction, strategy_config.slippage_rate)
    stop_price = event.stop_price
    target_price = target.executable_price
    if direction == "BUY":
        valid_geometry = stop_price < entry_fill < target_price
    else:
        valid_geometry = target_price < entry_fill < stop_price
    if not valid_geometry:
        return None

    risk_per_unit = _risk_per_unit(
        direction,
        entry_fill,
        stop_price,
        strategy_config.commission_rate,
        strategy_config.slippage_rate,
    )
    if risk_per_unit <= 0:
        return None

    observed = ordered[entry_index : entry_index + cfg.max_holding_bars]
    if not observed:
        return None
    best_price = entry_fill
    worst_price = entry_fill
    exit_fill = entry_fill
    exit_candle = observed[-1]
    status = "DATA_END" if len(observed) < cfg.max_holding_bars else "TIMEOUT"

    for candle in observed:
        if direction == "BUY":
            best_price = max(best_price, candle.high)
            worst_price = min(worst_price, candle.low)
            stop_hit = candle.low <= stop_price
            target_hit = candle.high >= target_price
        else:
            best_price = min(best_price, candle.low)
            worst_price = max(worst_price, candle.high)
            stop_hit = candle.high >= stop_price
            target_hit = candle.low <= target_price

        # Консервативное правило неоднозначной OHLC-свечи: сначала стоп.
        if stop_hit:
            raw_fill = _stop_raw_fill(candle, stop_price, direction)
            exit_fill = _normal_exit_fill(
                raw_fill, direction, strategy_config.slippage_rate
            )
            exit_candle = candle
            status = "STOP"
            break
        if target_hit:
            exit_fill = _normal_exit_fill(
                target_price, direction, strategy_config.slippage_rate
            )
            exit_candle = candle
            status = "TARGET"
            break
    else:
        exit_fill = _normal_exit_fill(
            exit_candle.close, direction, strategy_config.slippage_rate
        )

    gross_pnl = _pnl_per_unit(direction, entry_fill, exit_fill)
    commissions = strategy_config.commission_rate * (entry_fill + exit_fill)
    net_pnl = gross_pnl - commissions
    net_return_pct = net_pnl / entry_fill * 100.0
    r_multiple = net_pnl / risk_per_unit
    if direction == "BUY":
        mfe_pct = max(0.0, (best_price - entry_fill) / entry_fill * 100.0)
        mae_pct = max(0.0, (entry_fill - worst_price) / entry_fill * 100.0)
    else:
        mfe_pct = max(0.0, (entry_fill - best_price) / entry_fill * 100.0)
        mae_pct = max(0.0, (worst_price - entry_fill) / entry_fill * 100.0)

    return TradeResult(
        symbol=event.symbol,
        signal_time=event.signal_time,
        entry_time=entry_candle.open_time,
        exit_time=exit_candle.close_time(event.base_timeframe),
        base_timeframe=event.base_timeframe,
        direction=direction,
        corridor_label=event.corridor.label,
        target_label=target.label,
        status=status,
        holding_bars=ordered.index(exit_candle) - entry_index + 1,
        entry_price=entry_fill,
        exit_price=exit_fill,
        stop_price=stop_price,
        target_price=target_price,
        net_return_pct=net_return_pct,
        r_multiple=r_multiple,
        mfe_pct=mfe_pct,
        mae_pct=mae_pct,
        score=event.score,
        macd_cross=event.macd_cross,
        macd_bars_since_cross=event.macd_bars_since_cross,
        histogram_expanding=event.histogram_expanding,
        senior_trend_aligned=event.senior_trend_aligned,
        nison_patterns=event.nison_patterns,
        risk_per_unit=risk_per_unit,
        net_pnl_per_unit=net_pnl,
    )


def _apply_position_sizing(
    trade: TradeResult,
    equity: float,
    config: BacktestConfig,
) -> TradeResult:
    risk_budget = max(0.0, equity * config.risk_per_trade_pct / 100.0)
    risk_fraction = trade.risk_per_unit / trade.entry_price
    risk_based_notional = risk_budget / risk_fraction if risk_fraction > 0 else 0.0
    leverage_cap = max(0.0, equity * config.max_leverage)
    notional = min(risk_based_notional, leverage_cap)
    quantity = notional / trade.entry_price if trade.entry_price > 0 else 0.0
    risk_cash = trade.risk_per_unit * quantity
    pnl_cash = trade.net_pnl_per_unit * quantity
    return replace(
        trade,
        position_notional=notional,
        risk_cash=risk_cash,
        pnl_cash=pnl_cash,
        equity_before=equity,
        equity_after=max(0.0, equity + pnl_cash),
    )


def summarize_trades(
    trades: Sequence[TradeResult],
    starting_equity: float | None = None,
) -> dict[str, object]:
    if not trades:
        return {
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate_pct": 0.0,
            "target_hit_rate_pct": 0.0,
            "profit_factor": None,
            "expectancy_r": 0.0,
            "total_return_pct": 0.0,
            "max_drawdown_pct": 0.0,
            "max_consecutive_losses": 0,
        }

    wins = [trade for trade in trades if trade.pnl_cash > 0]
    losses = [trade for trade in trades if trade.pnl_cash < 0]
    gross_profit = sum(trade.pnl_cash for trade in wins)
    gross_loss = -sum(trade.pnl_cash for trade in losses)
    initial = (
        float(starting_equity)
        if starting_equity is not None
        else float(trades[0].equity_before)
    )
    final = float(trades[-1].equity_after)
    peak = initial
    max_drawdown = 0.0
    consecutive_losses = 0
    max_consecutive_losses = 0
    for trade in trades:
        peak = max(peak, trade.equity_after)
        if peak > 0:
            max_drawdown = max(
                max_drawdown, (peak - trade.equity_after) / peak * 100.0
            )
        if trade.pnl_cash < 0:
            consecutive_losses += 1
            max_consecutive_losses = max(max_consecutive_losses, consecutive_losses)
        else:
            consecutive_losses = 0

    return {
        "trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": len(wins) / len(trades) * 100.0,
        "target_hit_rate_pct": sum(t.status == "TARGET" for t in trades)
        / len(trades)
        * 100.0,
        "profit_factor": gross_profit / gross_loss if gross_loss > 0 else None,
        "expectancy_r": sum(trade.r_multiple for trade in trades) / len(trades),
        "average_net_trade_pct": sum(t.net_return_pct for t in trades) / len(trades),
        "average_mfe_pct": sum(t.mfe_pct for t in trades) / len(trades),
        "average_mae_pct": sum(t.mae_pct for t in trades) / len(trades),
        "total_return_pct": (final - initial) / initial * 100.0 if initial > 0 else 0.0,
        "max_drawdown_pct": max_drawdown,
        "max_consecutive_losses": max_consecutive_losses,
        "ending_equity": final,
        "status_counts": dict(Counter(trade.status for trade in trades)),
        "direction_counts": dict(Counter(trade.direction for trade in trades)),
    }


def run_backtest(
    events: Sequence[CorridorEvent],
    base_candles: Sequence[Candle],
    strategy_config: CorridorConfig,
    backtest_config: BacktestConfig | None = None,
) -> BacktestReport:
    """Смоделировать разрешённые события без одновременных позиций по умолчанию."""

    cfg = backtest_config or BacktestConfig()
    ordered_events = sorted(events, key=lambda event: event.signal_time)
    rejection_reasons: Counter[str] = Counter()
    for event in ordered_events:
        if not event.allowed:
            rejection_reasons.update(event.reasons or ("неизвестная причина",))

    equity = cfg.starting_equity
    active_until = -1
    skipped_overlaps = 0
    skipped_invalid = 0
    sized_trades: list[TradeResult] = []
    for event in ordered_events:
        if not event.allowed:
            continue
        if not cfg.allow_overlapping_positions and event.signal_time < active_until:
            skipped_overlaps += 1
            continue
        trade = simulate_event(event, base_candles, strategy_config, cfg)
        if trade is None:
            skipped_invalid += 1
            continue
        sized = _apply_position_sizing(trade, equity, cfg)
        sized_trades.append(sized)
        equity = sized.equity_after
        if not cfg.allow_overlapping_positions:
            active_until = sized.exit_time

    split_index = int(len(sized_trades) * (1.0 - cfg.out_of_sample_pct / 100.0))
    if len(sized_trades) > 1:
        split_index = min(max(split_index, 1), len(sized_trades) - 1)
    in_sample = sized_trades[:split_index]
    out_of_sample = sized_trades[split_index:]
    signal_counts = {
        "all": len(ordered_events),
        "allowed": sum(event.allowed for event in ordered_events),
        "rejected": sum(not event.allowed for event in ordered_events),
    }
    return BacktestReport(
        summary=summarize_trades(sized_trades, cfg.starting_equity),
        in_sample=summarize_trades(in_sample),
        out_of_sample=summarize_trades(out_of_sample),
        signal_counts=signal_counts,
        rejection_reasons=dict(rejection_reasons.most_common()),
        skipped_overlaps=skipped_overlaps,
        skipped_invalid=skipped_invalid,
        trades=tuple(sized_trades),
    )
