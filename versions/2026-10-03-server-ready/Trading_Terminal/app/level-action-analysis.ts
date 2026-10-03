import type {
  Candle,
  ForecastDirection,
  LevelActionAlignment,
  LevelActionScenario,
  LevelActionSnapshot,
  PriceLevel,
  PriceLevelSource,
  Timeframe,
} from "./terminal-types";

type Candidate = {
  price: number;
  zoneLow: number;
  zoneHigh: number;
  role: PriceLevel["role"];
  source: PriceLevelSource;
  timeframe: Timeframe;
  strength: number;
  reasons: string[];
};

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
const TIMEFRAME_STRENGTH: Record<Timeframe, number> = {
  "1m": 16,
  "5m": 22,
  "15m": 30,
  "30m": 36,
  "1h": 45,
  "4h": 58,
  "1d": 72,
  "1w": 84,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function closedCandles(source: Candle[]) {
  return source
    .filter((candle) => candle.closed !== false)
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((left, right) => left.time - right.time);
}

function trueRange(candle: Candle, previous?: Candle) {
  const previousClose = previous?.close ?? candle.open;
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

function recentAtr(candles: Candle[]) {
  const sample = candles.slice(-20);
  const ranges = sample.map((candle, index) => trueRange(candle, sample[index - 1]));
  return Math.max(median(ranges.slice(-14)), Math.abs(candles.at(-1)?.close ?? 0) * 0.0005, Number.EPSILON);
}

function reactionAfter(candles: Candle[], index: number, role: PriceLevel["role"], atr: number) {
  const after = candles.slice(index + 1, index + 7);
  if (!after.length) return 0;
  const pivot = role === "RESISTANCE" ? candles[index].high : candles[index].low;
  const move = role === "RESISTANCE"
    ? pivot - Math.min(...after.map((candle) => candle.low))
    : Math.max(...after.map((candle) => candle.high)) - pivot;
  return Math.max(0, move / Math.max(atr, Number.EPSILON));
}

function extractCandidates(candles: Candle[], timeframe: Timeframe): Candidate[] {
  if (candles.length < 20) return [];
  const atr = recentAtr(candles);
  const base = TIMEFRAME_STRENGTH[timeframe];
  const candidates: Candidate[] = [];
  const pivotWindow = TIMEFRAMES.indexOf(timeframe) >= TIMEFRAMES.indexOf("1h") ? 3 : 2;
  const first = Math.max(pivotWindow, candles.length - 190);

  for (let index = first; index < candles.length - pivotWindow; index += 1) {
    const candle = candles[index];
    const neighborhood = candles.slice(index - pivotWindow, index + pivotWindow + 1);
    const isHigh = neighborhood.every((item) => candle.high >= item.high);
    const isLow = neighborhood.every((item) => candle.low <= item.low);
    const recency = 1 - (candles.length - index) / Math.max(1, candles.length - first);
    const zoneHalf = atr * 0.075;
    if (isHigh) {
      const reaction = reactionAfter(candles, index, "RESISTANCE", atr);
      candidates.push({
        price: candle.high,
        zoneLow: candle.high - zoneHalf,
        zoneHigh: candle.high + zoneHalf,
        role: "RESISTANCE",
        source: "SWING",
        timeframe,
        strength: base + Math.min(17, reaction * 5) + Math.max(0, recency * 7),
        reasons: [`экстремум ${timeframe}`, `реакция после уровня ${reaction.toFixed(1)} ATR`],
      });
    }
    if (isLow) {
      const reaction = reactionAfter(candles, index, "SUPPORT", atr);
      candidates.push({
        price: candle.low,
        zoneLow: candle.low - zoneHalf,
        zoneHigh: candle.low + zoneHalf,
        role: "SUPPORT",
        source: "SWING",
        timeframe,
        strength: base + Math.min(17, reaction * 5) + Math.max(0, recency * 7),
        reasons: [`экстремум ${timeframe}`, `реакция после уровня ${reaction.toFixed(1)} ATR`],
      });
    }
  }

  const eventStart = Math.max(1, candles.length - 130);
  // The newest closed candle is the reaction being classified, so it must not
  // create its own level and then immediately "confirm" that same level.
  for (let index = eventStart; index < candles.length - 1; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const localAtr = Math.max(atr, trueRange(previous, candles[index - 2]));
    const gapUp = candle.low - previous.high;
    const gapDown = previous.low - candle.high;
    if (gapUp >= localAtr * 0.18) {
      candidates.push({
        price: (previous.high + candle.low) / 2,
        zoneLow: previous.high,
        zoneHigh: candle.low,
        role: "SUPPORT",
        source: "PRICE_GAP",
        timeframe,
        strength: base + 18 + Math.min(12, gapUp / localAtr * 8),
        reasons: [`ценовой гэп вверх ${timeframe}`, `разрыв ${(gapUp / localAtr).toFixed(2)} ATR`],
      });
    } else if (gapDown >= localAtr * 0.18) {
      candidates.push({
        price: (previous.low + candle.high) / 2,
        zoneLow: candle.high,
        zoneHigh: previous.low,
        role: "RESISTANCE",
        source: "PRICE_GAP",
        timeframe,
        strength: base + 18 + Math.min(12, gapDown / localAtr * 8),
        reasons: [`ценовой гэп вниз ${timeframe}`, `разрыв ${(gapDown / localAtr).toFixed(2)} ATR`],
      });
    }

    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    const bodyShare = Math.abs(candle.close - candle.open) / range;
    if (range >= localAtr * 1.7 && bodyShare >= 0.58) {
      const midpoint = (candle.high + candle.low) / 2;
      candidates.push({
        price: midpoint,
        zoneLow: midpoint - localAtr * 0.07,
        zoneHigh: midpoint + localAtr * 0.07,
        role: candle.close >= candle.open ? "SUPPORT" : "RESISTANCE",
        source: "IMPULSE_MIDPOINT",
        timeframe,
        strength: base + 13 + Math.min(12, (range / localAtr - 1.7) * 8),
        reasons: [`50% полного диапазона импульсной свечи ${timeframe}`, `свеча ${(range / localAtr).toFixed(2)} ATR`],
      });
    }
  }
  return candidates;
}

function countTouchEpisodes(candles: Candle[], low: number, high: number) {
  let touches = 0;
  let inside = false;
  candles.slice(-100).forEach((candle) => {
    const intersects = candle.low <= high && candle.high >= low;
    if (intersects && !inside) touches += 1;
    inside = intersects;
  });
  return touches;
}

function sourceLabel(source: PriceLevelSource) {
  if (source === "MIRROR") return "Зеркальный уровень";
  if (source === "PRICE_GAP") return "Граница ценового гэпа";
  if (source === "IMPULSE_MIDPOINT") return "50% импульсной свечи";
  return "Уровень экстремума";
}

function mergeCandidates(candidates: Candidate[], current: number, currentAtr: number, currentCandles: Candle[]) {
  const groups: Candidate[][] = [];
  [...candidates].sort((left, right) => left.price - right.price).forEach((candidate) => {
    const group = groups.at(-1);
    if (!group) {
      groups.push([candidate]);
      return;
    }
    const center = group.reduce((sum, item) => sum + item.price, 0) / group.length;
    const tolerance = Math.max(currentAtr * 0.16, candidate.zoneHigh - candidate.zoneLow, ...group.map((item) => item.zoneHigh - item.zoneLow));
    if (Math.abs(candidate.price - center) <= tolerance) group.push(candidate);
    else groups.push([candidate]);
  });

  return groups.map((group): PriceLevel => {
    const totalWeight = group.reduce((sum, item) => sum + Math.max(1, item.strength), 0);
    const price = group.reduce((sum, item) => sum + item.price * Math.max(1, item.strength), 0) / totalWeight;
    const zoneLow = Math.min(...group.map((item) => item.zoneLow));
    const zoneHigh = Math.max(...group.map((item) => item.zoneHigh));
    const roles = new Set(group.map((item) => item.role));
    const mirrored = roles.size > 1;
    const strongest = [...group].sort((left, right) => right.strength - left.strength)[0];
    const source: PriceLevelSource = mirrored ? "MIRROR" : strongest.source;
    const timeframe = [...group].sort((left, right) => TIMEFRAMES.indexOf(right.timeframe) - TIMEFRAMES.indexOf(left.timeframe))[0].timeframe;
    const touches = countTouchEpisodes(currentCandles, zoneLow, zoneHigh);
    const confluenceBonus = Math.min(14, (group.length - 1) * 3.5);
    const touchBonus = Math.min(10, touches * 2.5);
    const overtestPenalty = Math.max(0, touches - 4) * 4;
    const strength = Math.round(clamp(Math.max(...group.map((item) => item.strength)) + confluenceBonus + touchBonus - overtestPenalty, 15, 98));
    const fresh = touches <= 2;
    const role: PriceLevel["role"] = price <= current ? "SUPPORT" : "RESISTANCE";
    const reasons = [...new Set(group.flatMap((item) => item.reasons))].slice(0, 3);
    if (group.length > 1) reasons.push(`совпали ${group.length} независимых построения`);
    if (mirrored) reasons.push("уровень менял роль поддержки и сопротивления");
    reasons.push(fresh ? "уровень свежий" : touches > 4 ? "уровень многократно тестировался" : `${touches} реакции цены`);
    return {
      price: round(price, 6),
      zoneLow: round(zoneLow, 6),
      zoneHigh: round(zoneHigh, 6),
      role,
      source,
      label: `${sourceLabel(source)} · ${timeframe}`,
      timeframe,
      strength,
      touches,
      fresh,
      reasons,
    };
  });
}

function alignmentFor(direction: ForecastDirection, forecastDirection: ForecastDirection): LevelActionAlignment {
  if (direction === "SIDEWAYS" || forecastDirection === "SIDEWAYS") return "NEUTRAL";
  return direction === forecastDirection ? "CONFIRMS" : "CONFLICTS";
}

function scenarioLabel(scenario: LevelActionScenario, direction: ForecastDirection) {
  if (scenario === "FALSE_BREAKOUT") return direction === "BULL" ? "Ложный пробой вниз с возвратом" : "Ложный пробой вверх с возвратом";
  if (scenario === "BREAKOUT") return direction === "BULL" ? "Подтверждённый пробой вверх" : "Подтверждённый пробой вниз";
  if (scenario === "REBOUND") return direction === "BULL" ? "Отбой от поддержки" : "Отбой от сопротивления";
  if (scenario === "APPROACH") return "Цена приблизилась к уровню";
  return "Активного сценария у уровня нет";
}

export function analyzeLevelAction(
  source: Candle[],
  timeframe: Timeframe,
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
  forecastDirection: ForecastDirection,
): LevelActionSnapshot | null {
  const candles = closedCandles(source);
  if (candles.length < 35) return null;
  const latest = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const atr = recentAtr(candles);
  const currentIndex = TIMEFRAMES.indexOf(timeframe);
  const candidateTimeframes = TIMEFRAMES.slice(Math.max(0, currentIndex), currentIndex + 4);
  const candidates = candidateTimeframes.flatMap((candidateTimeframe) => {
    const data = candidateTimeframe === timeframe ? candles : closedCandles(allTimeframes[candidateTimeframe] ?? []);
    return extractCandidates(data, candidateTimeframe);
  });
  if (!candidates.length) return null;

  const levels = mergeCandidates(candidates, latest.close, atr, candles);
  const recent = candles.slice(-3);
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  const range = Math.max(latest.high - latest.low, Number.EPSILON);
  const bodyShare = Math.abs(latest.close - latest.open) / range;
  const closeLocation = (latest.close - latest.low) / range;
  const evaluations = levels.map((level) => {
    const distanceAtr = Math.abs(latest.close - level.price) / atr;
    let scenario: LevelActionScenario = "NO_SETUP";
    let direction: ForecastDirection = "SIDEWAYS";
    let priority = 0;
    let confidence = Math.round(level.strength * 0.48);
    const failedAbove = distanceAtr <= 1.35
      && latest.high > level.zoneHigh + atr * 0.07
      && latest.close < level.zoneLow
      && latest.close < latest.open
      && previous.close <= level.zoneHigh + atr * 0.15;
    const failedBelow = distanceAtr <= 1.35
      && latest.low < level.zoneLow - atr * 0.07
      && latest.close > level.zoneHigh
      && latest.close > latest.open
      && previous.close >= level.zoneLow - atr * 0.15;
    const brokeUp = previous.close <= level.zoneHigh && latest.close > level.zoneHigh + atr * 0.045 && bodyShare >= 0.42 && closeLocation >= 0.62;
    const brokeDown = previous.close >= level.zoneLow && latest.close < level.zoneLow - atr * 0.045 && bodyShare >= 0.42 && closeLocation <= 0.38;
    const bouncedUp = level.price <= latest.close && latest.low <= level.zoneHigh + atr * 0.1 && latest.close > level.price && latest.close > latest.open;
    const bouncedDown = level.price >= latest.close && latest.high >= level.zoneLow - atr * 0.1 && latest.close < level.price && latest.close < latest.open;
    if (failedAbove || failedBelow) {
      scenario = "FALSE_BREAKOUT";
      direction = failedAbove ? "BEAR" : "BULL";
      priority = 4;
      confidence = 58 + level.strength * 0.25 + Math.min(12, bodyShare * 12);
    } else if (brokeUp || brokeDown) {
      scenario = "BREAKOUT";
      direction = brokeUp ? "BULL" : "BEAR";
      priority = 3;
      confidence = 54 + level.strength * 0.24 + Math.min(14, bodyShare * 14);
    } else if (bouncedUp || bouncedDown) {
      scenario = "REBOUND";
      direction = bouncedUp ? "BULL" : "BEAR";
      priority = 2;
      confidence = 50 + level.strength * 0.25 + Math.min(12, bodyShare * 12);
    } else if (distanceAtr <= 0.72) {
      scenario = "APPROACH";
      direction = forecastDirection;
      priority = 1;
      confidence = 36 + level.strength * 0.28;
    }
    return { level, scenario, direction, priority, confidence: Math.round(clamp(confidence, 20, 94)), distanceAtr };
  });
  evaluations.sort((left, right) => (right.priority * 100 + right.confidence - right.distanceAtr * 9) - (left.priority * 100 + left.confidence - left.distanceAtr * 9));
  const selected = evaluations[0];
  if (!selected) return null;

  const direction = selected.direction;
  const entryPrice = latest.close;
  const obstacle = direction === "BULL"
    ? levels.filter((level) => level.price > entryPrice + atr * 0.18 && level !== selected.level).sort((left, right) => left.price - right.price)[0]
    : direction === "BEAR"
      ? levels.filter((level) => level.price < entryPrice - atr * 0.18 && level !== selected.level).sort((left, right) => right.price - left.price)[0]
      : undefined;
  const stopPrice = direction === "BULL"
    ? Math.min(selected.level.zoneLow, recentLow) - atr * 0.12
    : direction === "BEAR"
      ? Math.max(selected.level.zoneHigh, recentHigh) + atr * 0.12
      : null;
  const targetPrice = direction === "BULL"
    ? obstacle ? obstacle.zoneLow - atr * 0.08 : entryPrice + atr * 1.7
    : direction === "BEAR"
      ? obstacle ? obstacle.zoneHigh + atr * 0.08 : entryPrice - atr * 1.7
      : null;
  const risk = stopPrice == null ? 0 : Math.abs(entryPrice - stopPrice);
  const reward = targetPrice == null ? 0 : Math.max(0, Math.abs(targetPrice - entryPrice));
  const riskReward = risk > 0 && reward > 0 ? reward / risk : null;
  const freeSpaceAtr = reward > 0 ? reward / atr : null;
  const activeScenario = selected.scenario === "REBOUND" || selected.scenario === "BREAKOUT" || selected.scenario === "FALSE_BREAKOUT";
  const quality: LevelActionSnapshot["quality"] = activeScenario
    && selected.level.strength >= 52
    && selected.confidence >= 60
    && riskReward != null && riskReward >= 1.8
    && freeSpaceAtr != null && freeSpaceAtr >= 0.75
      ? "TRADEABLE"
      : activeScenario ? "TIGHT_SPACE" : "OBSERVE";
  const alignment = alignmentFor(direction, forecastDirection);
  const reasons = [
    `${selected.level.label}; сила ${selected.level.strength}/100`,
    `до уровня ${selected.distanceAtr.toFixed(2)} ATR; касаний ${selected.level.touches}`,
    obstacle
      ? `следующее препятствие ${obstacle.label} через ${freeSpaceAtr?.toFixed(2) ?? "—"} ATR`
      : `в направлении сценария близкий статический уровень не найден`,
    riskReward == null ? "R:R пока не рассчитывается" : `расчётное отношение прибыль/риск 1:${riskReward.toFixed(2)}`,
  ];
  if (quality === "TIGHT_SPACE") reasons.push("сценарий найден, но запас хода или R:R недостаточны");
  if (selected.level.touches > 4) reasons.push("частые тесты могли ослабить уровень");
  if (selected.scenario === "FALSE_BREAKOUT") reasons.push("цена вышла за границу и вернулась закрытием обратно");
  if (selected.scenario === "BREAKOUT") reasons.push("закрытие и тело свечи удержались за границей уровня");
  if (selected.scenario === "REBOUND") reasons.push("свеча коснулась зоны и закрылась в сторону отбоя");

  const nearbyLevels = [...levels]
    .sort((left, right) => Math.abs(left.price - latest.close) - Math.abs(right.price - latest.close) || right.strength - left.strength)
    .slice(0, 10);
  if (!nearbyLevels.includes(selected.level)) nearbyLevels.unshift(selected.level);

  return {
    version: "level-action-v1",
    asofTime: latest.time,
    timeframe,
    scenario: selected.scenario,
    label: scenarioLabel(selected.scenario, direction),
    direction,
    alignment,
    confidence: selected.confidence,
    quality,
    primaryLevel: selected.level,
    nextObstacle: obstacle,
    entryPrice: round(entryPrice, 6),
    stopPrice: stopPrice == null ? null : round(stopPrice, 6),
    targetPrice: targetPrice == null ? null : round(targetPrice, 6),
    riskReward: riskReward == null ? null : round(riskReward),
    freeSpaceAtr: freeSpaceAtr == null ? null : round(freeSpaceAtr),
    distanceToLevelAtr: round(selected.distanceAtr),
    levels: nearbyLevels,
    reasons,
  };
}
