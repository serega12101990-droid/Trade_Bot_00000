export type ScalpSide = "LONG" | "SHORT";
export type ScalpSignalStatus = "READY" | "WAIT" | "NO_TRADE";

export type ScalpStrategyId = "DENSITY_BOUNCE" | "IMPULSE_BREAKOUT" | "MTF_SHADOW" | "MANUAL";

export const SCALP_STRATEGY_VERSION = "scalp-micro-v4.1";
export const SCALP_MTF_SHADOW_VERSION = "scalp-v3.0";

export type ScalpBookLevel = {
  price: number;
  size: number;
};

export type ScalpTapeTrade = {
  id: string;
  time: number;
  price: number;
  size: number;
  side: "Buy" | "Sell";
};

export type ScalpTradeValidity = "VALID" | "INVALID_LEGACY";

export type ScalpDensity = {
  side: "BID" | "ASK";
  price: number;
  size: number;
  notional: number;
  ratio: number;
  distanceBps: number;
  ageMs: number;
  observations: number;
  firstSeen?: number;
  baselineNotional: number;
  depthNotional: number;
  depthShare: number;
  initialSize: number;
  minSize: number;
  retention: number;
  reloads: number;
};

export type ScalpBreakout = {
  side: ScalpSide;
  level: number;
  distanceBps: number;
  touches: number;
  compressed: boolean;
  broken: boolean;
  volumeRatio: number;
};

export type ScalpSignalSnapshot = {
  version: 2;
  strategyVersion?: string;
  strategyId?: ScalpStrategyId;
  capturedAt: number;
  signalKey: string;
  status: ScalpSignalStatus;
  direction: ScalpSide | null;
  score: number;
  reasons: string[];
  price: number;
  spreadBps: number;
  imbalance: number;
  deltaPct: number;
  tradesPerSecond: number;
  ema20_1m: number | null;
  histogram1m: number | null;
  previousHistogram1m: number | null;
  ema20_5m: number | null;
  ema50_5m: number | null;
  histogram5m: number | null;
  previousHistogram5m: number | null;
  ema20_15m: number | null;
  ema50_15m: number | null;
  histogram15m: number | null;
  pattern1m: string | null;
  patternDirection1m: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  patternStatus1m: "PENDING" | "CONFIRMED" | "INVALIDATED" | null;
  patternAligned: boolean | null;
  context15mAligned: boolean | null;
  riskPct: number;
  stopPct: number;
  requestedTargetPct: number;
  effectiveTargetPct: number;
  feeBps: number;
  maxNotionalPct: number;
  maxDurationMinutes: number;
  netRewardRisk: number;
  referencePrice?: number | null;
  densityRatio?: number | null;
  densityAgeMs?: number | null;
  breakoutTouches?: number | null;
  breakoutVolumeRatio?: number | null;
  shadowMtfScore?: number | null;
  turnover24h?: number | null;
  price24hPct?: number | null;
};

export type ScalpPaperTrade = {
  id: string;
  symbol: string;
  side: ScalpSide;
  status: "OPEN" | "CLOSED";
  entryPrice: number;
  quantity: number;
  notional: number;
  stopPrice: number;
  targetPrice: number;
  openedAt: number;
  entryFee: number;
  entryMode: "AUTO" | "MANUAL";
  validity?: ScalpTradeValidity;
  invalidReason?: string;
  signalKey?: string;
  signalSnapshot?: ScalpSignalSnapshot;
  updatedAt?: number;
  closedAt?: number;
  exitPrice?: number;
  pnl?: number;
  pnlPct?: number;
  fees?: number;
  maxFavorablePct?: number;
  maxAdversePct?: number;
  exitReason?: "TP" | "SL" | "TIME" | "MANUAL" | "LIQUIDITY_GONE";
};

export type ScalpContext = {
  price: number;
  bid: number;
  ask: number;
  spreadBps: number;
  imbalance: number;
  deltaPct: number;
  tradesPerSecond: number;
  turnover24h?: number | null;
  price24hPct?: number | null;
  ema20_5m: number | null;
  ema50_5m: number | null;
  histogram5m: number | null;
  previousHistogram5m: number | null;
  ema20_15m: number | null;
  ema50_15m: number | null;
  histogram15m: number | null;
  ema20_1m: number | null;
  histogram1m: number | null;
  previousHistogram1m: number | null;
};

export type ScalpSignal = {
  status: ScalpSignalStatus;
  direction: ScalpSide | null;
  score: number;
  reasons: string[];
  strategyId?: ScalpStrategyId;
  referencePrice?: number | null;
  density?: ScalpDensity | null;
  breakout?: ScalpBreakout | null;
};

export type ScalpMicrostructureContext = Pick<ScalpContext,
  "price" | "bid" | "ask" | "spreadBps" | "imbalance" | "deltaPct" | "tradesPerSecond"
> & {
  turnover24h?: number | null;
  price24hPct?: number | null;
  densityBid?: ScalpDensity | null;
  densityAsk?: ScalpDensity | null;
  breakoutLong?: ScalpBreakout | null;
  breakoutShort?: ScalpBreakout | null;
  ema20_15m?: number | null;
  ema50_15m?: number | null;
  histogram15m?: number | null;
  patternDirection1m?: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  patternStatus1m?: "PENDING" | "CONFIRMED" | "INVALIDATED" | null;
  enableImpulseBreakout?: boolean;
};

export type ScalpEntry = {
  entryPrice: number;
  quantity: number;
  notional: number;
  stopPrice: number;
  targetPrice: number;
  entryFee: number;
  effectiveTargetPct: number;
  netRewardRisk: number;
};

export function buildScalpSignalKey(
  symbol: string,
  strategyId: ScalpStrategyId | undefined,
  side: ScalpSide,
  closedOneMinuteBarTime: number,
) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const stableBarTime = Math.max(0, Math.trunc(closedOneMinuteBarTime));
  return `${normalizedSymbol}:${strategyId ?? "UNKNOWN"}:${side}:${stableBarTime}`;
}

export function bookImbalance(bids: ScalpBookLevel[], asks: ScalpBookLevel[], depth = 10): number {
  const bidSize = bids.slice(0, depth).reduce((sum, level) => sum + Math.max(0, level.size), 0);
  const askSize = asks.slice(0, depth).reduce((sum, level) => sum + Math.max(0, level.size), 0);
  const total = bidSize + askSize;
  return total > 0 ? (bidSize - askSize) / total : 0;
}

export function tapeStats(trades: ScalpTapeTrade[], now = Date.now(), windowMs = 60_000) {
  const recent = trades.filter((trade) => now - trade.time >= 0 && now - trade.time <= windowMs);
  const buyVolume = recent.filter((trade) => trade.side === "Buy").reduce((sum, trade) => sum + trade.size, 0);
  const sellVolume = recent.filter((trade) => trade.side === "Sell").reduce((sum, trade) => sum + trade.size, 0);
  const totalVolume = buyVolume + sellVolume;
  return {
    buyVolume,
    sellVolume,
    totalVolume,
    deltaPct: totalVolume > 0 ? (buyVolume - sellVolume) / totalVolume : 0,
    tradeCount: recent.length,
    tradesPerSecond: recent.length / Math.max(windowMs / 1000, 1),
  };
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Finds a relative order-book wall. Persistence is supplied by the live lifecycle tracker. */
export function findBookDensity(
  levels: ScalpBookLevel[],
  midPrice: number,
  side: "BID" | "ASK",
  lifecycle: { price?: number; size?: number; firstSeen?: number; observations?: number; initialSize?: number; minSize?: number; reloads?: number } = {},
  now = Date.now(),
  depth = 25,
): ScalpDensity | null {
  if (!finitePositive(midPrice)) return null;
  const visible = levels.slice(0, depth).filter((level) => finitePositive(level.price) && finitePositive(level.size));
  if (visible.length < 5) return null;
  const notionals = visible.map((level) => level.price * level.size);
  const baseline = median(notionals);
  const depthNotional = notionals.reduce((sum, value) => sum + value, 0);
  if (!finitePositive(baseline)) return null;
  const candidate = visible
    .map((level) => ({ level, notional: level.price * level.size, ratio: level.price * level.size / baseline }))
    .filter((item) => item.ratio >= 3)
    .sort((left, right) => right.ratio - left.ratio)[0];
  if (!candidate) return null;
  const sameLevel = lifecycle.price === candidate.level.price;
  const firstSeen = sameLevel && Number.isFinite(lifecycle.firstSeen) ? Number(lifecycle.firstSeen) : now;
  const initialSize = sameLevel && finitePositive(Number(lifecycle.initialSize)) ? Number(lifecycle.initialSize) : candidate.level.size;
  const minSize = sameLevel && finitePositive(Number(lifecycle.minSize))
    ? Math.min(Number(lifecycle.minSize), candidate.level.size)
    : candidate.level.size;
  const reloads = sameLevel
    ? Math.max(0, Number(lifecycle.reloads ?? 0)) + (finitePositive(Number(lifecycle.size)) && candidate.level.size >= Number(lifecycle.size) * 1.1 ? 1 : 0)
    : 0;
  return {
    side,
    price: candidate.level.price,
    size: candidate.level.size,
    notional: candidate.notional,
    ratio: candidate.ratio,
    distanceBps: Math.abs(candidate.level.price / midPrice - 1) * 10_000,
    ageMs: Math.max(0, now - firstSeen),
    observations: sameLevel ? Math.max(1, Number(lifecycle.observations ?? 0) + 1) : 1,
    firstSeen,
    baselineNotional: baseline,
    depthNotional,
    depthShare: depthNotional > 0 ? candidate.notional / depthNotional : 0,
    initialSize,
    minSize,
    retention: initialSize > 0 ? Math.min(2, minSize / initialSize) : 0,
    reloads,
  };
}

/**
 * Detects a repeatedly tested local 1m boundary. It deliberately does not use EMA/MACD:
 * microstructure, compression, volume and tape confirm the actual scalp entry.
 */
export function analyzeBreakoutLevel(candles: Array<{ high: number; low: number; close: number; volume: number }>, price: number, side: ScalpSide): ScalpBreakout | null {
  const sample = candles.slice(-30).filter((candle) => [candle.high, candle.low, candle.close].every(finitePositive));
  if (sample.length < 12 || !finitePositive(price)) return null;
  const recent = sample.slice(-20);
  const candidates = side === "LONG" ? recent.map((candle) => candle.high) : recent.map((candle) => candle.low);
  const toleranceBps = 10;
  let best: { level: number; touches: number } | null = null;
  for (const level of candidates) {
    const touches = candidates.filter((value) => Math.abs(value / level - 1) * 10_000 <= toleranceBps).length;
    const relevant = side === "LONG" ? level <= price * 1.003 : level >= price * 0.997;
    if (relevant && touches >= 2 && (!best || touches > best.touches || touches === best.touches && Math.abs(price - level) < Math.abs(price - best.level))) {
      best = { level, touches };
    }
  }
  if (!best) return null;
  const tail = recent.slice(-6);
  const thirds = [tail.slice(0, 2), tail.slice(2, 4), tail.slice(4, 6)];
  const anchors = thirds.map((part) => side === "LONG" ? Math.min(...part.map((candle) => candle.low)) : Math.max(...part.map((candle) => candle.high)));
  const compressed = side === "LONG"
    ? anchors[0] <= anchors[1] && anchors[1] <= anchors[2]
    : anchors[0] >= anchors[1] && anchors[1] >= anchors[2];
  const baselineVolume = median(recent.slice(0, -1).map((candle) => Math.max(0, candle.volume)));
  const volumeRatio = baselineVolume > 0 ? Math.max(0, recent.at(-1)?.volume ?? 0) / baselineVolume : 0;
  const distanceBps = (price / best.level - 1) * 10_000;
  const broken = side === "LONG" ? distanceBps >= 2 : distanceBps <= -2;
  return { side, level: best.level, distanceBps, touches: best.touches, compressed, broken, volumeRatio };
}

export function assessMicrostructureSignal(context: ScalpMicrostructureContext): ScalpSignal {
  if (![context.price, context.bid, context.ask].every(finitePositive) || context.ask < context.bid) {
    return { status: "NO_TRADE", direction: null, score: 0, reasons: ["Стакан ещё не синхронизирован"] };
  }
  if (context.spreadBps > 6) {
    return { status: "NO_TRADE", direction: null, score: 10, reasons: [`Спред ${context.spreadBps.toFixed(2)} б.п. слишком широк`] };
  }

  const densityCandidates = [context.densityBid, context.densityAsk].filter((value): value is ScalpDensity => Boolean(value));
  const activityKnown = Number.isFinite(context.turnover24h) && Number.isFinite(context.price24hPct);
  const inPlay = activityKnown && Number(context.turnover24h) >= 100_000_000 && Math.abs(Number(context.price24hPct)) >= 5;
  const density = densityCandidates
    .filter((wall) => wall.distanceBps <= 8)
    .sort((left, right) => right.depthShare - left.depthShare || right.notional - left.notional)[0] ?? null;
  const densityDirection: ScalpSide | null = density?.side === "BID" ? "LONG" : density?.side === "ASK" ? "SHORT" : null;
  const contextKnown = [context.ema20_15m, context.ema50_15m, context.histogram15m].every((value) => Number.isFinite(value));
  const contextAligned = densityDirection === "LONG"
    ? contextKnown && context.price >= Number(context.ema20_15m) && Number(context.ema20_15m) >= Number(context.ema50_15m) && Number(context.histogram15m) >= 0
    : densityDirection === "SHORT"
      ? contextKnown && context.price <= Number(context.ema20_15m) && Number(context.ema20_15m) <= Number(context.ema50_15m) && Number(context.histogram15m) <= 0
      : false;
  const oppositePattern = context.patternStatus1m === "CONFIRMED" && (
    densityDirection === "LONG" && context.patternDirection1m === "BEARISH"
    || densityDirection === "SHORT" && context.patternDirection1m === "BULLISH"
  );
  const densityPersistent = Boolean(density && density.ageMs >= 10_000 && density.observations >= 12 && (density.reloads >= 1 || density.ageMs >= 20_000));
  const densityQuality = Boolean(density
    && density.notional >= 25_000
    && density.depthShare >= 0.08
    && density.retention >= 0.65
    && density.ratio >= 3
    && density.ratio <= 25);
  const densityFlow = densityDirection === "LONG"
    ? context.imbalance >= 0.12 && context.deltaPct >= 0.1
    : densityDirection === "SHORT" ? context.imbalance <= -0.12 && context.deltaPct <= -0.1 : false;
  const densityReady = Boolean(inPlay && density && densityDirection && densityPersistent && densityQuality && densityFlow
    && contextAligned && !oppositePattern && context.tradesPerSecond >= 0.75);

  const breakouts = [context.breakoutLong, context.breakoutShort].filter((value): value is ScalpBreakout => Boolean(value));
  const breakout = breakouts
    .filter((setup) => setup.broken && Math.abs(setup.distanceBps) <= 25)
    .sort((left, right) => right.touches - left.touches)[0] ?? null;
  const breakoutFlow = breakout?.side === "LONG"
    ? context.deltaPct >= 0.12 && context.imbalance >= 0.03
    : breakout?.side === "SHORT" ? context.deltaPct <= -0.12 && context.imbalance <= -0.03 : false;
  const breakoutContextAligned = breakout?.side === "LONG"
    ? contextKnown && context.price >= Number(context.ema20_15m) && Number(context.ema20_15m) >= Number(context.ema50_15m) && Number(context.histogram15m) >= 0
    : breakout?.side === "SHORT"
      ? contextKnown && context.price <= Number(context.ema20_15m) && Number(context.ema20_15m) <= Number(context.ema50_15m) && Number(context.histogram15m) <= 0
      : false;
  const breakoutOppositePattern = context.patternStatus1m === "CONFIRMED" && (
    breakout?.side === "LONG" && context.patternDirection1m === "BEARISH"
    || breakout?.side === "SHORT" && context.patternDirection1m === "BULLISH"
  );
  const breakoutReady = Boolean(context.enableImpulseBreakout === true && inPlay && breakout && breakout.compressed
    && breakout.touches >= 3 && breakout.volumeRatio >= 1.5 && breakoutFlow && breakoutContextAligned
    && !breakoutOppositePattern && context.tradesPerSecond >= 0.75);

  if (densityReady && breakoutReady && densityDirection !== breakout?.side) {
    return { status: "NO_TRADE", direction: null, score: 30, reasons: ["Плотность и пробой направлены в разные стороны", "Ждём разрешения конфликта микроструктуры"] };
  }
  if (densityReady && density && densityDirection) {
    const score = Math.min(98, Math.round(62 + Math.min(10, density.depthShare * 50) + Math.min(10, density.ageMs / 2_000) + Math.min(8, Math.abs(context.deltaPct) * 20)));
    return {
      status: "READY", direction: densityDirection, score, strategyId: "DENSITY_BOUNCE", referencePrice: density.price, density,
      reasons: [
        `${density.side === "BID" ? "Покупательская" : "Продавецкая"} плотность удерживается ${(density.ageMs / 1000).toFixed(1)}с · доля ${(density.depthShare * 100).toFixed(1)}%`,
        `Цена в ${density.distanceBps.toFixed(1)} б.п. · удержание ${(density.retention * 100).toFixed(0)}% · пополнений ${density.reloads}`,
        "Стакан, лента и тренд 15м подтверждают отскок",
      ],
    };
  }
  if (breakoutReady && breakout) {
    const score = Math.min(98, Math.round(60 + breakout.touches * 4 + Math.min(12, breakout.volumeRatio * 3) + Math.min(8, Math.abs(context.deltaPct) * 20)));
    return {
      status: "READY", direction: breakout.side, score, strategyId: "IMPULSE_BREAKOUT", referencePrice: breakout.level, breakout,
      reasons: [
        `Пробой уровня после ${breakout.touches} касаний и сжатия`,
        `Объём ×${breakout.volumeRatio.toFixed(1)}, лента подтверждает импульс`,
        `Уровень ${breakout.level}`,
      ],
    };
  }

  const waiting: string[] = [];
  if (!inPlay) waiting.push(activityKnown
    ? `Не InPlay: оборот ${Math.round(Number(context.turnover24h) / 1_000_000)} млн, движение ${Math.abs(Number(context.price24hPct)).toFixed(1)}%`
    : "Ждём показатели активности инструмента");
  if (density) {
    if (!densityPersistent) waiting.push(`Плотность ×${density.ratio.toFixed(1)} наблюдаем: ${(density.ageMs / 1000).toFixed(1)}с / ${density.observations} снимка`);
    else if (!densityQuality) waiting.push(`Плотность не прошла качество: ${Math.round(density.notional)} USDT · доля ${(density.depthShare * 100).toFixed(1)}% · удержание ${(density.retention * 100).toFixed(0)}%`);
    else if (!densityFlow) waiting.push("Плотность есть, но лента ещё не подтвердила отскок");
    else if (!contextAligned) waiting.push("Плотность есть, но EMA/MACD 15м направлены против входа");
    else if (oppositePattern) waiting.push("Подтверждённая свечная модель 1м направлена против входа");
  }
  const pendingBreakout = breakouts.sort((left, right) => right.touches - left.touches)[0];
  if (pendingBreakout) waiting.push(context.enableImpulseBreakout === true
    ? pendingBreakout.broken ? "Пробой есть, ждём объём, контекст и направленную ленту" : `Уровень тестировался ${pendingBreakout.touches} раза — ждём пробой`
    : "Импульсный пробой переведён в теневой режим до отдельного аудита");
  if (!waiting.length) waiting.push("Нет устойчивой плотности или подготовленного импульсного уровня");
  return {
    status: "WAIT",
    direction: densityDirection ?? pendingBreakout?.side ?? null,
    score: density || pendingBreakout ? 45 : 20,
    strategyId: density ? "DENSITY_BOUNCE" : pendingBreakout ? "IMPULSE_BREAKOUT" : undefined,
    referencePrice: density?.price ?? pendingBreakout?.level ?? null,
    density,
    breakout: pendingBreakout ?? null,
    reasons: waiting.slice(0, 3),
  };
}

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

export function minimumTargetPctForNetRewardRisk(stopPct: number, feeBps: number, desiredRatio = 1.5) {
  if (![stopPct, desiredRatio].every(finitePositive) || !Number.isFinite(feeBps) || feeBps < 0) return Number.NaN;
  const stop = stopPct / 100;
  const fee = feeBps / 10_000;
  const conservativeLoss = stop + fee * (2 + stop);
  const target = (desiredRatio * conservativeLoss + 2 * fee) / Math.max(1 - fee, Number.EPSILON);
  return target * 100;
}

export function scalpNetRewardRisk(stopPct: number, targetPct: number, feeBps: number) {
  if (![stopPct, targetPct].every(finitePositive) || !Number.isFinite(feeBps) || feeBps < 0) {
    return { netRewardPct: 0, netLossPct: 0, ratio: 0, breakEvenWinRate: 100 };
  }
  const stop = stopPct / 100;
  const target = targetPct / 100;
  const fee = feeBps / 10_000;
  const netReward = Math.max(0, target - fee * (2 + target));
  const netLoss = stop + fee * (2 + stop);
  const ratio = netLoss > 0 ? netReward / netLoss : 0;
  return {
    netRewardPct: netReward * 100,
    netLossPct: netLoss * 100,
    ratio,
    breakEvenWinRate: netReward + netLoss > 0 ? netLoss / (netReward + netLoss) * 100 : 100,
  };
}

export function assessScalpSignal(context: ScalpContext): ScalpSignal {
  if (![context.price, context.bid, context.ask].every(finitePositive) || context.ask < context.bid) {
    return { status: "NO_TRADE", direction: null, score: 0, reasons: ["Стакан ещё не синхронизирован"] };
  }
  if (context.spreadBps > 6) {
    return { status: "NO_TRADE", direction: null, score: 12, reasons: [`Спред ${context.spreadBps.toFixed(2)} б.п. слишком широк`] };
  }
  if (context.ema20_5m == null || context.ema50_5m == null || context.histogram5m == null || context.previousHistogram5m == null) {
    return { status: "WAIT", direction: null, score: 15, reasons: ["Ждём историю 5‑минутных свечей"] };
  }
  if (context.ema20_15m == null || context.ema50_15m == null || context.histogram15m == null) {
    return { status: "WAIT", direction: null, score: 18, reasons: ["Ждём подтверждение контекста 15м"] };
  }

  const trendLong = context.price > context.ema20_5m && context.ema20_5m > context.ema50_5m;
  const trendShort = context.price < context.ema20_5m && context.ema20_5m < context.ema50_5m;
  const context15Long = context.price >= context.ema20_15m && context.ema20_15m >= context.ema50_15m && context.histogram15m > 0;
  const context15Short = context.price <= context.ema20_15m && context.ema20_15m <= context.ema50_15m && context.histogram15m < 0;
  const macd5Long = context.histogram5m > 0 && context.histogram5m >= context.previousHistogram5m;
  const macd5Short = context.histogram5m < 0 && context.histogram5m <= context.previousHistogram5m;
  const macd1Long = context.histogram1m != null && context.previousHistogram1m != null && context.histogram1m >= context.previousHistogram1m;
  const macd1Short = context.histogram1m != null && context.previousHistogram1m != null && context.histogram1m <= context.previousHistogram1m;
  const entry1Long = context.ema20_1m == null || context.price >= context.ema20_1m;
  const entry1Short = context.ema20_1m == null || context.price <= context.ema20_1m;
  const flowLong = context.imbalance >= 0.08 && context.deltaPct >= 0.08;
  const flowShort = context.imbalance <= -0.08 && context.deltaPct <= -0.08;
  const speedReady = context.tradesPerSecond >= 0.5;

  const longVotes = Number(context15Long) + Number(trendLong) + Number(macd5Long) + Number(macd1Long && entry1Long) + Number(flowLong) + Number(speedReady);
  const shortVotes = Number(context15Short) + Number(trendShort) + Number(macd5Short) + Number(macd1Short && entry1Short) + Number(flowShort) + Number(speedReady);
  const direction: ScalpSide | null = longVotes > shortVotes ? "LONG" : shortVotes > longVotes ? "SHORT" : null;
  const votes = Math.max(longVotes, shortVotes);
  const score = Math.min(100, Math.round(16 + votes * 14 - Math.min(context.spreadBps, 6) * 2));
  const readyLong = context15Long && trendLong && macd5Long && macd1Long && entry1Long && flowLong && speedReady;
  const readyShort = context15Short && trendShort && macd5Short && macd1Short && entry1Short && flowShort && speedReady;

  if (readyLong || readyShort) {
    const side = readyLong ? "LONG" : "SHORT";
    return {
      status: "READY",
      direction: side,
      score: Math.max(82, score),
      reasons: [
        `EMA и MACD 15м подтверждают ${side === "LONG" ? "рост" : "снижение"}`,
        `Тренд 5м и MACD направлены ${side === "LONG" ? "вверх" : "вниз"}`,
        `Стакан и лента подтверждают ${side === "LONG" ? "покупателей" : "продавцов"}`,
        "1м подтверждает точку входа",
      ],
    };
  }

  const reasons: string[] = [];
  if (direction === "LONG" && !context15Long || direction === "SHORT" && !context15Short || !direction && !context15Long && !context15Short) {
    reasons.push("Контекст EMA/MACD 15м не подтверждает выбранное направление");
  }
  if (!trendLong && !trendShort) reasons.push("На 5м нет чистого порядка EMA20/EMA50");
  if (direction === "LONG" && !flowLong) reasons.push("Для LONG нет совместного перевеса стакана и ленты");
  if (direction === "SHORT" && !flowShort) reasons.push("Для SHORT нет совместного перевеса стакана и ленты");
  if (!speedReady) reasons.push("Низкая скорость сделок — импульс не подтверждён");
  if (!macd1Long && !macd1Short) reasons.push("MACD 1м не ускоряется");
  return { status: "WAIT", direction, score, reasons: reasons.slice(0, 3) };
}

export function calculateScalpEntry(input: {
  side: ScalpSide;
  bid: number;
  ask: number;
  balance: number;
  riskPct: number;
  stopPct: number;
  targetPct: number;
  feeBps: number;
  maxNotionalPct: number;
}): ScalpEntry | null {
  const { side, bid, ask, balance, riskPct, stopPct, targetPct, feeBps, maxNotionalPct } = input;
  if (![bid, ask, balance, riskPct, stopPct, targetPct, maxNotionalPct].every(finitePositive) || ask < bid || feeBps < 0) return null;
  const entryPrice = side === "LONG" ? ask : bid;
  const minimumTargetPct = minimumTargetPctForNetRewardRisk(stopPct, feeBps, 1.5);
  const effectiveTargetPct = Math.max(targetPct, minimumTargetPct);
  const economics = scalpNetRewardRisk(stopPct, effectiveTargetPct, feeBps);
  const stopPrice = side === "LONG" ? entryPrice * (1 - stopPct / 100) : entryPrice * (1 + stopPct / 100);
  const targetPrice = side === "LONG" ? entryPrice * (1 + effectiveTargetPct / 100) : entryPrice * (1 - effectiveTargetPct / 100);
  const riskBudget = balance * (riskPct / 100);
  const estimatedRoundTripFeePerUnit = entryPrice * (feeBps * 2 / 10_000);
  const lossPerUnit = Math.abs(entryPrice - stopPrice) + estimatedRoundTripFeePerUnit;
  const riskQuantity = riskBudget / Math.max(lossPerUnit, Number.EPSILON);
  const notionalQuantity = balance * (maxNotionalPct / 100) / entryPrice;
  const quantity = Math.min(riskQuantity, notionalQuantity);
  if (!finitePositive(quantity)) return null;
  const notional = quantity * entryPrice;
  return {
    entryPrice,
    quantity,
    notional,
    stopPrice,
    targetPrice,
    entryFee: notional * feeBps / 10_000,
    effectiveTargetPct,
    netRewardRisk: economics.ratio,
  };
}

export function calculateMicrostructureScalpEntry(input: {
  side: ScalpSide;
  bid: number;
  ask: number;
  referencePrice: number;
  balance: number;
  riskPct: number;
  targetPct: number;
  feeBps: number;
  maxNotionalPct: number;
  bufferBps?: number;
}): ScalpEntry | null {
  const entryPrice = input.side === "LONG" ? input.ask : input.bid;
  const buffer = Math.max(Number(input.bufferBps ?? 2), 1) / 10_000 * entryPrice;
  const stopPrice = input.side === "LONG" ? input.referencePrice - buffer : input.referencePrice + buffer;
  const stopPct = Math.abs(entryPrice - stopPrice) / entryPrice * 100;
  const correctlyOrdered = input.side === "LONG" ? stopPrice < entryPrice : stopPrice > entryPrice;
  // An entry far away from its level is no longer a scalp; a sub-tick stop is not executable.
  if (!correctlyOrdered || stopPct < 0.03 || stopPct > 1) return null;
  return calculateScalpEntry({ ...input, stopPct });
}

export function markScalpTrade(trade: ScalpPaperTrade, bid: number, ask: number, feeBps: number) {
  if (!finitePositive(bid) || !finitePositive(ask) || ask < bid || feeBps < 0) return null;
  const markPrice = trade.side === "LONG" ? bid : ask;
  const gross = trade.side === "LONG"
    ? (markPrice - trade.entryPrice) * trade.quantity
    : (trade.entryPrice - markPrice) * trade.quantity;
  const estimatedExitFee = markPrice * trade.quantity * feeBps / 10_000;
  const fees = trade.entryFee + estimatedExitFee;
  const pnl = gross - fees;
  return {
    markPrice,
    gross,
    fees,
    pnl,
    pnlPct: trade.notional > 0 ? pnl / trade.notional * 100 : 0,
  };
}

export function scalpTradeDurationMinutes(trade: ScalpPaperTrade, now = Date.now()) {
  return Math.max(0, Math.round(((trade.closedAt ?? now) - trade.openedAt) / 60_000));
}

export function estimatedMissingScalpFees(trade: ScalpPaperTrade, fallbackFeeBps: number) {
  if (trade.status !== "CLOSED" || trade.exitPrice == null || !finitePositive(trade.quantity) || fallbackFeeBps <= 0) return 0;
  if (Number(trade.fees ?? 0) > 0) return 0;
  const exitNotional = trade.exitPrice * trade.quantity;
  return (trade.notional + exitNotional) * fallbackFeeBps / 10_000;
}

export function feeAdjustedScalpPnl(trade: ScalpPaperTrade, fallbackFeeBps: number) {
  return Number(trade.pnl ?? 0) - estimatedMissingScalpFees(trade, fallbackFeeBps);
}

export type ScalpPerformanceSlice = {
  total: number;
  wins: number;
  losses: number;
  flat: number;
  winRatePct: number | null;
  pnl: number;
  profitFactor: number | null;
};

function scalpPerformanceSlice(trades: ScalpPaperTrade[], fallbackFeeBps: number): ScalpPerformanceSlice {
  const outcomes = trades.map((trade) => feeAdjustedScalpPnl(trade, fallbackFeeBps));
  const wins = outcomes.filter((pnl) => pnl > 0);
  const losses = outcomes.filter((pnl) => pnl < 0);
  const flat = outcomes.length - wins.length - losses.length;
  const grossWin = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
  return {
    total: outcomes.length,
    wins: wins.length,
    losses: losses.length,
    flat,
    winRatePct: outcomes.length ? wins.length / outcomes.length * 100 : null,
    pnl: outcomes.reduce((sum, pnl) => sum + pnl, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
  };
}

export function scalpPerformanceStats(
  trades: ScalpPaperTrade[],
  fallbackFeeBps: number,
  now = Date.now(),
  recentLimit = 20,
  strategyVersion = SCALP_STRATEGY_VERSION,
) {
  const validAutoClosed = trades
    .filter((trade) => trade.status === "CLOSED" && trade.validity !== "INVALID_LEGACY" && trade.entryMode === "AUTO")
    .sort((left, right) => (right.closedAt ?? 0) - (left.closedAt ?? 0));
  const validManualClosed = trades
    .filter((trade) => trade.status === "CLOSED" && trade.validity !== "INVALID_LEGACY" && trade.entryMode === "MANUAL");
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  return {
    currentVersion: scalpPerformanceSlice(
      validAutoClosed.filter((trade) => trade.signalSnapshot?.strategyVersion === strategyVersion),
      fallbackFeeBps,
    ),
    recent: scalpPerformanceSlice(validAutoClosed.slice(0, Math.max(1, Math.trunc(recentLimit))), fallbackFeeBps),
    today: scalpPerformanceSlice(validAutoClosed.filter((trade) => (trade.closedAt ?? 0) >= startOfDay.getTime()), fallbackFeeBps),
    allTime: scalpPerformanceSlice(validAutoClosed, fallbackFeeBps),
    manual: scalpPerformanceSlice(validManualClosed, fallbackFeeBps),
    byStrategy: {
      densityBounce: scalpPerformanceSlice(validAutoClosed.filter((trade) => trade.signalSnapshot?.strategyId === "DENSITY_BOUNCE"), fallbackFeeBps),
      impulseBreakout: scalpPerformanceSlice(validAutoClosed.filter((trade) => trade.signalSnapshot?.strategyId === "IMPULSE_BREAKOUT"), fallbackFeeBps),
      mtfShadow: scalpPerformanceSlice(validAutoClosed.filter((trade) => trade.signalSnapshot?.strategyId === "MTF_SHADOW" || !trade.signalSnapshot?.strategyId && trade.signalSnapshot?.strategyVersion === SCALP_MTF_SHADOW_VERSION), fallbackFeeBps),
    },
  };
}

export function evaluateScalpTrade(
  trade: ScalpPaperTrade,
  bid: number,
  ask: number,
  now: number,
  feeBps: number,
  control: boolean | { manual?: boolean; maxDurationMinutes?: number; liquidityLost?: boolean } = false,
): ScalpPaperTrade {
  if (trade.status !== "OPEN" || !finitePositive(bid) || !finitePositive(ask)) return trade;
  const manual = typeof control === "boolean" ? control : control.manual === true;
  const maxDurationMinutes = typeof control === "boolean" ? 0 : Number(control.maxDurationMinutes ?? 0);
  const liquidityLost = typeof control === "boolean" ? false : control.liquidityLost === true;
  const marked = markScalpTrade(trade, bid, ask, feeBps);
  if (!marked) return trade;
  const mark = marked.markPrice;
  const grossMovePct = trade.side === "LONG"
    ? (mark / trade.entryPrice - 1) * 100
    : (trade.entryPrice - mark) / trade.entryPrice * 100;
  const maxFavorablePct = Math.max(Number(trade.maxFavorablePct ?? 0), grossMovePct);
  const maxAdversePct = Math.min(Number(trade.maxAdversePct ?? 0), grossMovePct);
  const hitTarget = trade.side === "LONG" ? mark >= trade.targetPrice : mark <= trade.targetPrice;
  const hitStop = trade.side === "LONG" ? mark <= trade.stopPrice : mark >= trade.stopPrice;
  const timedOut = finitePositive(maxDurationMinutes) && now - trade.openedAt >= maxDurationMinutes * 60_000;
  if (!manual && !hitTarget && !hitStop && !timedOut && !liquidityLost) {
    const favorableChanged = maxFavorablePct - Number(trade.maxFavorablePct ?? 0) >= 0.01;
    const adverseChanged = Number(trade.maxAdversePct ?? 0) - maxAdversePct >= 0.01;
    return favorableChanged || adverseChanged ? { ...trade, maxFavorablePct, maxAdversePct, updatedAt: now } : trade;
  }
  const exitReason: ScalpPaperTrade["exitReason"] = manual ? "MANUAL" : hitTarget ? "TP" : hitStop ? "SL" : liquidityLost ? "LIQUIDITY_GONE" : "TIME";
  return {
    ...trade,
    status: "CLOSED",
    closedAt: now,
    exitPrice: mark,
    exitReason,
    pnl: marked.pnl,
    fees: marked.fees,
    pnlPct: marked.pnlPct,
    maxFavorablePct,
    maxAdversePct,
    updatedAt: now,
  };
}

export function scalpReentryAllowed(
  trades: ScalpPaperTrade[],
  symbol: string,
  side: ScalpSide,
  referencePrice: number,
  now = Date.now(),
) {
  const recent = trades
    .filter((trade) => trade.symbol === symbol && trade.status === "CLOSED" && trade.entryMode === "AUTO")
    .sort((left, right) => Number(right.closedAt ?? 0) - Number(left.closedAt ?? 0))[0];
  if (!recent?.closedAt) return true;
  if (now - recent.closedAt < 5 * 60_000) return false;
  const previousReference = Number(recent.signalSnapshot?.referencePrice ?? recent.entryPrice);
  const sameLevel = finitePositive(previousReference) && finitePositive(referencePrice)
    && Math.abs(referencePrice / previousReference - 1) * 10_000 <= 10;
  if (recent.exitReason === "SL" && recent.side === side && sameLevel && now - recent.closedAt < 30 * 60_000) return false;
  return true;
}

export function isScalpTradeQuoteCompatible(trade: ScalpPaperTrade, quoteSymbol: string | null | undefined) {
  return trade.status === "OPEN" && Boolean(quoteSymbol) && trade.symbol === quoteSymbol;
}

export function sanitizeScalpTrades(trades: ScalpPaperTrade[]) {
  const audit = auditScalpTrades(trades);
  return {
    cleaned: audit.audited.filter((trade) => trade.validity !== "INVALID_LEGACY"),
    removed: audit.invalid,
  };
}

export function auditScalpTrades(trades: ScalpPaperTrade[]) {
  let invalid = 0;
  const duplicateIds = new Set<string>();
  const chronological = [...trades]
    .filter((trade) => trade.entryMode === "AUTO")
    .sort((left, right) => left.openedAt - right.openedAt);
  const previousBySetup = new Map<string, ScalpPaperTrade>();
  for (const current of chronological) {
    const setupKey = [
      current.symbol,
      current.side,
      current.signalSnapshot?.strategyVersion ?? "UNKNOWN",
      current.signalSnapshot?.strategyId ?? "UNKNOWN",
    ].join(":");
    const previous = previousBySetup.get(setupKey);
    if (!previous) {
      previousBySetup.set(setupKey, current);
      continue;
    }
    const nearSimultaneous = current.openedAt - previous.openedAt <= 2_000;
    const samePrice = previous.entryPrice > 0
      && Math.abs(current.entryPrice / previous.entryPrice - 1) * 10_000 <= 2;
    if (nearSimultaneous && samePrice) duplicateIds.add(current.id);
    else previousBySetup.set(setupKey, current);
  }
  const audited = trades.map((trade) => {
    const targetOrderValid = trade.side === "LONG"
      ? trade.targetPrice > trade.entryPrice && trade.stopPrice < trade.entryPrice
      : trade.targetPrice < trade.entryPrice && trade.stopPrice > trade.entryPrice;
    const priceDislocationPct = trade.status === "CLOSED" && trade.exitPrice != null && trade.entryPrice > 0
      ? Math.abs(trade.exitPrice / trade.entryPrice - 1) * 100
      : 0;
    const reportedReturn = Math.abs(Number(trade.pnlPct ?? 0));
    const impossibleCrossSymbolExit = priceDislocationPct > 10 || reportedReturn > 10;
    const numericValues = [trade.entryPrice, trade.quantity, trade.notional, trade.stopPrice, trade.targetPrice, trade.openedAt];
    const invalidNumeric = !numericValues.every((value) => Number.isFinite(value) && value > 0);
    const invalidReason = duplicateIds.has(trade.id)
      ? "Технический дубль одного автоматического сигнала"
      : impossibleCrossSymbolExit
      ? "Старая ошибка: выход рассчитан по цене другого инструмента"
      : !targetOrderValid
        ? "Неверное расположение TP/SL относительно входа"
        : invalidNumeric
          ? "Повреждены обязательные числовые данные сделки"
          : undefined;
    if (invalidReason) invalid += 1;
    return {
      ...trade,
      validity: invalidReason ? "INVALID_LEGACY" as const : "VALID" as const,
      invalidReason,
      updatedAt: trade.updatedAt ?? trade.closedAt ?? trade.openedAt,
    };
  });
  return { audited, invalid };
}

export function scalpRiskState(trades: ScalpPaperTrade[], initialBalance: number, maxDailyLossPct = 1, fallbackFeeBps = 0) {
  const closed = trades
    .filter((trade) => trade.status === "CLOSED" && trade.pnl != null && trade.validity !== "INVALID_LEGACY")
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const dailyPnl = closed
    .filter((trade) => (trade.closedAt ?? 0) >= startOfDay)
    .reduce((sum, trade) => sum + feeAdjustedScalpPnl(trade, fallbackFeeBps), 0);
  const consecutiveLosses = closed.slice(0, 3).filter((trade) => feeAdjustedScalpPnl(trade, fallbackFeeBps) < 0).length;
  const dailyLimit = initialBalance * maxDailyLossPct / 100;
  const locked = dailyPnl <= -dailyLimit || consecutiveLosses >= 3;
  return {
    locked,
    dailyPnl,
    consecutiveLosses,
    reason: dailyPnl <= -dailyLimit
      ? `Дневной лимит убытка ${maxDailyLossPct.toFixed(1)}% исчерпан`
      : consecutiveLosses >= 3
        ? "Три убыточные сделки подряд — обязательная пауза"
        : null,
  };
}
