"""Исследовательская частичная фиксация: 50% на середине, остаток к EMA.

После TP1 стоп остатка переносится к цене входа. На неоднозначной OHLC-свече
используется консервативная последовательность: сначала защитный стоп.
"""

from __future__ import annotations

from trading_platform.backtesting.ema_corridor_backtest import (
    BacktestConfig,
    TradeResult,
    _entry_fill,
    _normal_exit_fill,
    _pnl_per_unit,
    _risk_per_unit,
    _stop_raw_fill,
)
from trading_platform.strategies.ema_corridor import Candle, CorridorConfig, CorridorEvent


def _midpoint_target(event: CorridorEvent) -> float:
    start = (
        event.corridor.lower_boundary
        if event.direction == "BUY"
        else event.corridor.upper_boundary
    )
    far = event.targets[0].executable_price
    return start + 0.50 * (far - start)


def simulate_scaled_exit(
    event: CorridorEvent,
    candles: list[Candle] | tuple[Candle, ...],
    strategy_config: CorridorConfig,
    backtest_config: BacktestConfig,
) -> TradeResult | None:
    if not event.allowed or not event.targets or not event.targets[0].adequate:
        return None
    ordered = sorted(candles, key=lambda candle: candle.open_time)
    entry_index = next(
        (index for index, candle in enumerate(ordered) if candle.open_time >= event.signal_time),
        None,
    )
    if entry_index is None:
        return None
    direction = event.direction.upper()
    entry_fill = _entry_fill(event.entry_price, direction, strategy_config.slippage_rate)
    stop = event.stop_price
    far_target = event.targets[0].executable_price
    tp1 = _midpoint_target(event)
    if direction == "BUY":
        geometry = stop < entry_fill < tp1 < far_target
    else:
        geometry = far_target < tp1 < entry_fill < stop
    if not geometry:
        return None
    risk = _risk_per_unit(
        direction,
        entry_fill,
        stop,
        strategy_config.commission_rate,
        strategy_config.slippage_rate,
    )
    if risk <= 0:
        return None

    observed = ordered[entry_index : entry_index + backtest_config.max_holding_bars]
    if not observed:
        return None
    best = entry_fill
    worst = entry_fill
    tp1_hit = False
    realized_gross = 0.0
    exit_commission = 0.0
    exit_candle = observed[-1]
    final_exit = _normal_exit_fill(exit_candle.close, direction, strategy_config.slippage_rate)
    status = "DATA_END" if len(observed) < backtest_config.max_holding_bars else "TIMEOUT"

    for candle in observed:
        if direction == "BUY":
            best = max(best, candle.high)
            worst = min(worst, candle.low)
            original_stop_hit = candle.low <= stop
            tp1_touched = candle.high >= tp1
            far_touched = candle.high >= far_target
        else:
            best = min(best, candle.low)
            worst = max(worst, candle.high)
            original_stop_hit = candle.high >= stop
            tp1_touched = candle.low <= tp1
            far_touched = candle.low <= far_target

        if not tp1_hit:
            if original_stop_hit:
                raw = _stop_raw_fill(candle, stop, direction)
                final_exit = _normal_exit_fill(raw, direction, strategy_config.slippage_rate)
                realized_gross = _pnl_per_unit(direction, entry_fill, final_exit)
                exit_commission = strategy_config.commission_rate * final_exit
                exit_candle = candle
                status = "STOP_BEFORE_TP1"
                break
            if not tp1_touched:
                continue
            tp1_fill = _normal_exit_fill(tp1, direction, strategy_config.slippage_rate)
            realized_gross += 0.50 * _pnl_per_unit(direction, entry_fill, tp1_fill)
            exit_commission += 0.50 * strategy_config.commission_rate * tp1_fill
            tp1_hit = True
            exit_candle = candle
            # После частичной фиксации остаток защищён у цены входа. Если эта же
            # OHLC-свеча касается обоих уровней, сначала считается breakeven-stop.
            breakeven_hit = candle.low <= event.entry_price if direction == "BUY" else candle.high >= event.entry_price
            if breakeven_hit:
                final_exit = _normal_exit_fill(
                    event.entry_price, direction, strategy_config.slippage_rate
                )
                realized_gross += 0.50 * _pnl_per_unit(direction, entry_fill, final_exit)
                exit_commission += 0.50 * strategy_config.commission_rate * final_exit
                status = "TP1_THEN_BREAKEVEN"
                break
            if far_touched:
                final_exit = _normal_exit_fill(
                    far_target, direction, strategy_config.slippage_rate
                )
                realized_gross += 0.50 * _pnl_per_unit(direction, entry_fill, final_exit)
                exit_commission += 0.50 * strategy_config.commission_rate * final_exit
                status = "TP1_THEN_TARGET"
                break
            continue

        breakeven_hit = candle.low <= event.entry_price if direction == "BUY" else candle.high >= event.entry_price
        if breakeven_hit:
            final_exit = _normal_exit_fill(
                event.entry_price, direction, strategy_config.slippage_rate
            )
            realized_gross += 0.50 * _pnl_per_unit(direction, entry_fill, final_exit)
            exit_commission += 0.50 * strategy_config.commission_rate * final_exit
            exit_candle = candle
            status = "TP1_THEN_BREAKEVEN"
            break
        if far_touched:
            final_exit = _normal_exit_fill(
                far_target, direction, strategy_config.slippage_rate
            )
            realized_gross += 0.50 * _pnl_per_unit(direction, entry_fill, final_exit)
            exit_commission += 0.50 * strategy_config.commission_rate * final_exit
            exit_candle = candle
            status = "TP1_THEN_TARGET"
            break
    else:
        final_exit = _normal_exit_fill(
            exit_candle.close, direction, strategy_config.slippage_rate
        )
        remaining_fraction = 0.50 if tp1_hit else 1.0
        realized_gross += remaining_fraction * _pnl_per_unit(
            direction, entry_fill, final_exit
        )
        exit_commission += remaining_fraction * strategy_config.commission_rate * final_exit
        if tp1_hit:
            status = "TP1_THEN_" + status

    entry_commission = strategy_config.commission_rate * entry_fill
    net_pnl = realized_gross - entry_commission - exit_commission
    net_return_pct = net_pnl / entry_fill * 100.0
    if direction == "BUY":
        mfe = max(0.0, (best - entry_fill) / entry_fill * 100.0)
        mae = max(0.0, (entry_fill - worst) / entry_fill * 100.0)
    else:
        mfe = max(0.0, (entry_fill - best) / entry_fill * 100.0)
        mae = max(0.0, (worst - entry_fill) / entry_fill * 100.0)
    return TradeResult(
        symbol=event.symbol,
        signal_time=event.signal_time,
        entry_time=ordered[entry_index].open_time,
        exit_time=exit_candle.close_time(event.base_timeframe),
        base_timeframe=event.base_timeframe,
        direction=direction,
        corridor_label=event.corridor.label,
        target_label="50% corridor then " + event.targets[0].label,
        status=status,
        holding_bars=ordered.index(exit_candle) - entry_index + 1,
        entry_price=entry_fill,
        exit_price=final_exit,
        stop_price=stop,
        target_price=far_target,
        net_return_pct=net_return_pct,
        r_multiple=net_pnl / risk,
        mfe_pct=mfe,
        mae_pct=mae,
        score=event.score,
        macd_cross=event.macd_cross,
        macd_bars_since_cross=event.macd_bars_since_cross,
        histogram_expanding=event.histogram_expanding,
        senior_trend_aligned=event.senior_trend_aligned,
        nison_patterns=event.nison_patterns,
        risk_per_unit=risk,
        net_pnl_per_unit=net_pnl,
    )
