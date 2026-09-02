import { indicators } from "./terminal-math";
import type { Candle, ForecastStrategyMatch, PriceChannelPhase, PriceChannelSnapshot } from "./terminal-types";

const CHANNEL_TIMEFRAME_MS = 15 * 60_000;
const CHANNEL_WINDOWS = [28, 32, 36, 40, 48, 56, 64];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values: number[], quantile: number) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function recentAtr(candles: Candle[], period = 14) {
  const ranges = candles.map((candle, index) => {
    const previous = candles[index - 1]?.close ?? candle.open;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
  });
  const sample = ranges.slice(-period);
  return sample.reduce((sum, value) => sum + value, 0) / Math.max(1, sample.length);
}

function regression(values: number[]) {
  const count = values.length;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / Math.max(1, count);
  let covariance = 0;
  let varianceX = 0;
  let totalVariance = 0;
  values.forEach((value, index) => {
    covariance += (index - meanX) * (value - meanY);
    varianceX += (index - meanX) ** 2;
    totalVariance += (value - meanY) ** 2;
  });
  const slope = varianceX > 0 ? covariance / varianceX : 0;
  const intercept = meanY - slope * meanX;
  const residualVariance = values.reduce((sum, value, index) => sum + (value - (intercept + slope * index)) ** 2, 0);
  const rSquared = totalVariance > 0 ? clamp(1 - residualVariance / totalVariance, 0, 1) : 0;
  return { slope, intercept, rSquared };
}

function touchEpisodes(candles: Candle[], predicate: (candle: Candle, index: number) => boolean) {
  let episodes = 0;
  let active = false;
  candles.forEach((candle, index) => {
    const hit = predicate(candle, index);
    if (hit && !active) episodes += 1;
    active = hit;
  });
  return episodes;
}

type ChannelFit = {
  training: Candle[];
  slope: number;
  intercept: number;
  upperOffset: number;
  lowerOffset: number;
  atr: number;
  rSquared: number;
  coverage: number;
  width: number;
  widthAtr: number;
  priorImpulseAtr: number;
  upperTouches: number;
  lowerTouches: number;
  qualityScore: number;
};

function fitDescendingChannel(candles: Candle[]): ChannelFit | null {
  const candidates: ChannelFit[] = [];
  for (const window of CHANNEL_WINDOWS) {
    if (candles.length < window + 14) continue;
    const trainingEnd = candles.length - 2;
    const trainingStart = trainingEnd - window;
    if (trainingStart < 10) continue;
    const training = candles.slice(trainingStart, trainingEnd);
    const atr = Math.max(recentAtr(candles.slice(Math.max(0, trainingStart - 14))), candles.at(-1)!.close * 0.0005);
    const line = regression(training.map((candle) => candle.close));
    if (line.slope >= 0) continue;
    const totalSlopeAtr = Math.abs(line.slope) * (training.length - 1) / atr;
    if (totalSlopeAtr < 0.9 || totalSlopeAtr > 9) continue;

    const centers = training.map((_, index) => line.intercept + line.slope * index);
    const upperOffset = percentile(training.map((candle, index) => candle.high - centers[index]), 0.84);
    const lowerOffset = percentile(training.map((candle, index) => candle.low - centers[index]), 0.16);
    const width = upperOffset - lowerOffset;
    const widthAtr = width / atr;
    if (!Number.isFinite(widthAtr) || widthAtr < 1.15 || widthAtr > 6.5) continue;

    const tolerance = atr * 0.18;
    const inside = training.filter((candle, index) => {
      const upper = centers[index] + upperOffset;
      const lower = centers[index] + lowerOffset;
      return candle.close <= upper + tolerance && candle.close >= lower - tolerance;
    }).length;
    const coverage = inside / training.length;
    if (coverage < 0.76 || line.rSquared < 0.24) continue;

    const upperTouches = touchEpisodes(training, (candle, index) => candle.high >= centers[index] + upperOffset - atr * 0.24);
    const lowerTouches = touchEpisodes(training, (candle, index) => candle.low <= centers[index] + lowerOffset + atr * 0.24);
    if (upperTouches < 2 || lowerTouches < 2) continue;

    const prior = candles.slice(Math.max(0, trainingStart - 24), trainingStart + Math.min(6, training.length));
    const earlyPeak = Math.max(...training.slice(0, Math.max(4, Math.floor(training.length * 0.22))).map((candle) => candle.high));
    const priorLow = Math.min(...prior.map((candle) => candle.low));
    const priorImpulseAtr = (earlyPeak - priorLow) / atr;
    if (priorImpulseAtr < 1.6) continue;

    const qualityScore = Math.round(clamp(
      line.rSquared * 31
      + coverage * 27
      + Math.min(upperTouches, 4) * 4
      + Math.min(lowerTouches, 4) * 4
      + Math.min(priorImpulseAtr, 6) * 2,
      0,
      100,
    ));
    candidates.push({
      training,
      slope: line.slope,
      intercept: line.intercept,
      upperOffset,
      lowerOffset,
      atr,
      rSquared: line.rSquared,
      coverage,
      width,
      widthAtr,
      priorImpulseAtr,
      upperTouches,
      lowerTouches,
      qualityScore,
    });
  }
  return candidates.sort((left, right) => right.qualityScore - left.qualityScore || right.training.length - left.training.length)[0] ?? null;
}

function phaseLabel(phase: PriceChannelPhase) {
  if (phase === "UPPER_TEST") return "тест верхней границы";
  if (phase === "LOWER_TEST") return "тест нижней границы";
  if (phase === "FALSE_BREAK_UP") return "ложный выход вверх";
  if (phase === "BREAKOUT_DOWN") return "подтверждённый выход вниз";
  if (phase === "INVALIDATED_UP") return "канал сломан вверх";
  return "цена внутри канала";
}

export function detectEmaWindowChannelShadow(source: Candle[]): ForecastStrategyMatch | null {
  const candles = source.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (candles.length < 46) return null;
  const fit = fitDescendingChannel(candles);
  if (!fit) return null;

  const latest = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const trainingLast = fit.training.at(-1)!;
  const currentX = fit.training.length + 1;
  const previousX = fit.training.length;
  const trainingLastX = fit.training.length - 1;
  const boundary = (x: number) => {
    const middle = fit.intercept + fit.slope * x;
    return { upper: middle + fit.upperOffset, middle, lower: middle + fit.lowerOffset };
  };
  const current = boundary(currentX);
  const previousBoundary = boundary(previousX);
  const trainingLastBoundary = boundary(trainingLastX);
  const tolerance = fit.atr * 0.08;
  const previousBelow = previous.close < previousBoundary.lower - tolerance;
  const latestBelow = latest.close < current.lower - tolerance;
  const trainingLastBelow = trainingLast.close < trainingLastBoundary.lower - tolerance;
  const latestAbove = latest.close > current.upper + tolerance;
  const previousAbove = previous.close > previousBoundary.upper + tolerance;
  const volumes = candles.slice(-22, -2).map((candle) => candle.volume).filter((volume) => Number.isFinite(volume) && volume > 0);
  const averageVolume = volumes.reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.length);
  const volumeRatio = averageVolume > 0 ? latest.volume / averageVolume : null;
  const strongFirstBreak = latestBelow
    && !previousBelow
    && (current.lower - latest.close) / fit.atr >= 0.12
    && Number(volumeRatio ?? 0) >= 1.15;
  const confirmedBreak = latestBelow && (previousBelow || strongFirstBreak) && !(previousBelow && trainingLastBelow);

  let phase: PriceChannelPhase = "INSIDE";
  if (confirmedBreak) phase = "BREAKOUT_DOWN";
  else if (latestAbove && previousAbove) phase = "INVALIDATED_UP";
  else if (latest.high > current.upper + fit.atr * 0.1 && latest.close <= current.upper + tolerance) phase = "FALSE_BREAK_UP";
  else if (latest.high >= current.upper - fit.atr * 0.25) phase = "UPPER_TEST";
  else if (latest.low <= current.lower + fit.atr * 0.25) phase = "LOWER_TEST";

  const pack = indicators(candles);
  const index = candles.length - 1;
  const ema20 = pack.ema20[index];
  const ema50 = pack.ema50[index];
  const histogram = pack.histogram[index];
  const emaAligned = ema20 != null && ema50 != null && latest.close < ema20 && ema20 <= ema50;
  const macdAligned = histogram != null && histogram < 0;
  const qualityScore = Math.round(clamp(fit.qualityScore + (emaAligned ? 4 : 0) + (macdAligned ? 3 : 0), 0, 100));
  const snapshot: PriceChannelSnapshot = {
    version: "ema-window-channel-v1",
    asofTime: latest.time,
    startTime: fit.training[0].time,
    timeframe: "15m",
    phase,
    qualityScore,
    rSquared: fit.rSquared,
    coveragePct: fit.coverage * 100,
    slopePctPerBar: fit.slope / latest.close * 100,
    widthAtr: fit.widthAtr,
    upperTouches: fit.upperTouches,
    lowerTouches: fit.lowerTouches,
    upperPrice: current.upper,
    middlePrice: current.middle,
    lowerPrice: current.lower,
    priorImpulseAtr: fit.priorImpulseAtr,
    volumeRatio,
    emaAligned,
    macdAligned,
  };

  const entryPrice = latest.close;
  const stopPrice = Math.max(current.lower + fit.atr * 0.24, latest.high + fit.atr * 0.05);
  const risk = stopPrice - entryPrice;
  const measuredMove = Math.max(fit.width * 0.75, risk * 1.5);
  const targetPrice = Math.max(entryPrice * 0.01, entryPrice - measuredMove);
  const trial = confirmedBreak && risk > entryPrice * 0.0002 && targetPrice < entryPrice
    ? {
      mode: "STATISTICAL" as const,
      side: "SHORT" as const,
      signalTime: latest.time,
      entryPrice,
      targetPrice,
      stopPrice,
      expiresAt: latest.time + CHANNEL_TIMEFRAME_MS * 24,
      riskReward: (entryPrice - targetPrice) / risk,
      executionResolutionMinutes: 1 as const,
    }
    : undefined;
  const state: ForecastStrategyMatch["state"] = confirmedBreak
    ? "CONFIRMED"
    : phase === "UPPER_TEST" || phase === "LOWER_TEST" || phase === "FALSE_BREAK_UP" || qualityScore >= 78
      ? "SUPPORTING"
      : "WATCH";

  return {
    id: "ema-window-channel",
    label: "EMA‑окно · нисходящий канал",
    shortLabel: "КАНАЛ",
    tone: "rose",
    state,
    direction: phase === "INVALIDATED_UP" ? "SIDEWAYS" : "BEAR",
    summary: `${phaseLabel(phase)}; границы ${current.upper.toFixed(2)}–${current.lower.toFixed(2)}; качество ${qualityScore}/100; касания ${fit.upperTouches}/${fit.lowerTouches}`,
    sourceTimeframe: "15m",
    sourcePrice: current.upper,
    targetTimeframe: "15m",
    targetPrice: trial?.targetPrice ?? current.lower,
    suggestedTarget: trial?.targetPrice ?? current.lower,
    blockers: [
      "Теневой режим: канал не разрешает и не блокирует реальные или виртуальные сделки",
      ...(!emaAligned ? ["EMA20/50 пока не полностью подтверждают снижение"] : []),
      ...(!macdAligned ? ["MACD пока не подтверждает давление вниз"] : []),
    ],
    priceChannel: snapshot,
    experimental: true,
    ...(trial ? { trial } : {}),
  };
}
