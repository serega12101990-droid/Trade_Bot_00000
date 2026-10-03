import { indicators, latestPattern } from "./terminal-math";
import type {
  Candle,
  ForecastDirection,
  ForecastStrategyMatch,
  Timeframe,
  TopDownMacdEmaTimeframeState,
} from "./terminal-types";

export const TOP_DOWN_MACD_EMA_TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h", "1d"] as const;
const TOP_DOWN_CONTEXT_TIMEFRAMES = ["15m", "30m", "1h", "4h", "1d"] as const;

const TIMEFRAME_MINUTES: Record<Timeframe, 1 | 5 | 15 | 30 | 60 | 240 | 1440 | 10080> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "1w": 10080,
};

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function averageTrueRange(candles: Candle[], period = 14) {
  const sample = candles.slice(-period);
  if (!sample.length) return 0;
  return sample.reduce((sum, candle, index) => {
    const previousClose = candles[candles.length - sample.length + index - 1]?.close ?? candle.open;
    return sum + Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  }, 0) / sample.length;
}

type DirectionalEvidence = Omit<TopDownMacdEmaTimeframeState, "direction" | "summary"> & {
  direction: Exclude<ForecastDirection, "SIDEWAYS">;
  strict: boolean;
  score: number;
};

type TopDownTimeframeEvidence = {
  timeframe: (typeof TOP_DOWN_MACD_EMA_TIMEFRAMES)[number];
  bullish: DirectionalEvidence;
  bearish: DirectionalEvidence;
  resolvedDirection: ForecastDirection;
};

function directionalEvidence(
  candles: Candle[],
  timeframe: TopDownTimeframeEvidence["timeframe"],
  direction: Exclude<ForecastDirection, "SIDEWAYS">,
): DirectionalEvidence | null {
  const closed = candles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (closed.length < 55) return null;
  const pack = indicators(closed);
  const index = closed.length - 1;
  const latest = closed[index];
  const previous = closed[index - 1];
  const macd = pack.macd[index];
  const previousMacd = pack.macd[index - 1];
  const signal = pack.signal[index];
  const previousSignal = pack.signal[index - 1];
  const histogram = pack.histogram[index];
  const previousHistogram = pack.histogram[index - 1];
  const ema20 = pack.ema20[index];
  const ema50 = pack.ema50[index];
  if (!latest || !previous || ![macd, previousMacd, signal, previousSignal, histogram, previousHistogram, ema20, ema50].every(finite)) return null;

  const bullish = direction === "BULL";
  const macdOnSignalSide = bullish ? Number(macd) > Number(signal) : Number(macd) < Number(signal);
  const macdSlopeAligned = bullish ? Number(macd) > Number(previousMacd) : Number(macd) < Number(previousMacd);
  const signalSlopeAligned = bullish ? Number(signal) >= Number(previousSignal) : Number(signal) <= Number(previousSignal);
  const histogramAligned = bullish ? Number(histogram) > 0 : Number(histogram) < 0;
  const histogramExpanding = bullish ? Number(histogram) > Number(previousHistogram) : Number(histogram) < Number(previousHistogram);
  const priceOnEmaSide = bullish ? latest.close > Number(ema20) : latest.close < Number(ema20);
  const emaStructureAligned = bullish ? Number(ema20) >= Number(ema50) : Number(ema20) <= Number(ema50);
  const score = [macdOnSignalSide, macdSlopeAligned, signalSlopeAligned, histogramAligned, priceOnEmaSide, emaStructureAligned]
    .filter(Boolean).length;
  return {
    timeframe,
    direction,
    macdOnSignalSide,
    macdSlopeAligned,
    signalSlopeAligned,
    histogramAligned,
    histogramExpanding,
    priceOnEmaSide,
    emaStructureAligned,
    score,
    strict: score === 6,
  };
}

function analyzeTopDownTimeframe(
  candles: Candle[] | undefined,
  timeframe: TopDownTimeframeEvidence["timeframe"],
): TopDownTimeframeEvidence | null {
  if (!candles?.length) return null;
  const bullish = directionalEvidence(candles, timeframe, "BULL");
  const bearish = directionalEvidence(candles, timeframe, "BEAR");
  if (!bullish || !bearish) return null;
  const resolvedDirection: ForecastDirection = bullish.score >= 5 && bullish.score > bearish.score
    ? "BULL"
    : bearish.score >= 5 && bearish.score > bullish.score
      ? "BEAR"
      : "SIDEWAYS";
  return { timeframe, bullish, bearish, resolvedDirection };
}

function fiveMinuteTrigger(
  source: Candle[],
  direction: Exclude<ForecastDirection, "SIDEWAYS">,
): "FRESH_CROSS" | "PULLBACK_RESUME" | "NONE" {
  const candles = source.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (candles.length < 55) return "NONE";
  const pack = indicators(candles);
  const index = candles.length - 1;
  const latest = candles[index];
  const previous = candles[index - 1];
  const macd = pack.macd[index];
  const signal = pack.signal[index];
  const previousMacd = pack.macd[index - 1];
  const previousSignal = pack.signal[index - 1];
  const histogram = pack.histogram[index];
  const previousHistogram = pack.histogram[index - 1];
  const olderHistogram = pack.histogram[index - 2];
  const ema20 = pack.ema20[index];
  const ema50 = pack.ema50[index];
  if (!latest || !previous || ![macd, signal, previousMacd, previousSignal, histogram, previousHistogram, olderHistogram, ema20, ema50].every(finite)) return "NONE";

  const bullish = direction === "BULL";
  const priceAligned = bullish
    ? latest.close > Number(ema20) && Number(ema20) >= Number(ema50)
    : latest.close < Number(ema20) && Number(ema20) <= Number(ema50);
  if (!priceAligned) return "NONE";
  const freshCross = bullish
    ? Number(previousMacd) <= Number(previousSignal) && Number(macd) > Number(signal) && Number(histogram) > 0
    : Number(previousMacd) >= Number(previousSignal) && Number(macd) < Number(signal) && Number(histogram) < 0;
  if (freshCross) return "FRESH_CROSS";

  const histogramResumed = bullish
    ? Number(previousHistogram) <= Number(olderHistogram) && Number(histogram) > Number(previousHistogram)
    : Number(previousHistogram) >= Number(olderHistogram) && Number(histogram) < Number(previousHistogram);
  const candleBreak = bullish ? latest.close > previous.high : latest.close < previous.low;
  const recentRetest = candles.slice(-4).some((candle, offset) => {
    const candleIndex = index - 3 + offset;
    const localEma20 = pack.ema20[candleIndex];
    if (!finite(localEma20)) return false;
    const tolerance = Math.max(averageTrueRange(candles.slice(0, candleIndex + 1)) * 0.12, latest.close * 0.0004);
    return bullish ? candle.low <= localEma20 + tolerance : candle.high >= localEma20 - tolerance;
  });
  return histogramResumed && candleBreak && recentRetest ? "PULLBACK_RESUME" : "NONE";
}

/**
 * Shadow-only top-down hypothesis: D1/4h/1h/30m/15m establish one closed-candle
 * MACD+EMA direction and 5m supplies a fresh execution trigger.
 */
export function detectTopDownMacdEmaShadow(
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
): ForecastStrategyMatch | null {
  const evidence = TOP_DOWN_MACD_EMA_TIMEFRAMES.map((timeframe) => analyzeTopDownTimeframe(allTimeframes[timeframe], timeframe));
  if (evidence.some((item) => item == null)) return null;
  const complete = evidence as TopDownTimeframeEvidence[];
  const context = complete.filter((item) => item.timeframe !== "5m");
  const bullishStrict = context.every((item) => item.bullish.strict);
  const bearishStrict = context.every((item) => item.bearish.strict);
  const weightedDirection = TOP_DOWN_CONTEXT_TIMEFRAMES.reduce((score, timeframe) => {
    const state = context.find((item) => item.timeframe === timeframe)?.resolvedDirection;
    const weight = timeframe === "4h" || timeframe === "1h" ? 3 : timeframe === "1d" || timeframe === "30m" ? 2 : 1;
    return score + (state === "BULL" ? weight : state === "BEAR" ? -weight : 0);
  }, 0);
  const direction: Exclude<ForecastDirection, "SIDEWAYS"> = bullishStrict
    ? "BULL"
    : bearishStrict
      ? "BEAR"
      : weightedDirection >= 0 ? "BULL" : "BEAR";
  const strictHigherTimeframesAligned = direction === "BULL" ? bullishStrict : bearishStrict;
  const trigger = fiveMinuteTrigger(allTimeframes["5m"] ?? [], direction);
  const state: ForecastStrategyMatch["state"] = strictHigherTimeframesAligned && trigger !== "NONE"
    ? "CONFIRMED"
    : strictHigherTimeframesAligned ? "SUPPORTING" : "WATCH";
  const directionalStates: TopDownMacdEmaTimeframeState[] = complete.map((item) => {
    const selected = direction === "BULL" ? item.bullish : item.bearish;
    return {
      timeframe: item.timeframe,
      direction: selected.score >= 5 ? direction : item.resolvedDirection,
      macdOnSignalSide: selected.macdOnSignalSide,
      macdSlopeAligned: selected.macdSlopeAligned,
      signalSlopeAligned: selected.signalSlopeAligned,
      histogramAligned: selected.histogramAligned,
      histogramExpanding: selected.histogramExpanding,
      priceOnEmaSide: selected.priceOnEmaSide,
      emaStructureAligned: selected.emaStructureAligned,
      summary: `${item.timeframe}: ${selected.score}/6${selected.histogramExpanding ? ", гистограмма расширяется" : ", гистограмма затухает"}`,
    };
  });
  const blockers = context
    .filter((item) => !(direction === "BULL" ? item.bullish.strict : item.bearish.strict))
    .map((item) => {
      const selected = direction === "BULL" ? item.bullish : item.bearish;
      return `${item.timeframe}: согласовано ${selected.score}/6`;
    });
  if (trigger === "NONE") blockers.push("5м: нет свежего креста или возобновления после ретеста EMA20");

  const fiveMinuteCandles = (allTimeframes["5m"] ?? []).filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  const latest = fiveMinuteCandles.at(-1);
  const atr = averageTrueRange(fiveMinuteCandles);
  const recent = fiveMinuteCandles.slice(-8);
  const stopPrice = latest && recent.length
    ? direction === "BULL"
      ? Math.min(...recent.map((candle) => candle.low)) - atr * 0.08
      : Math.max(...recent.map((candle) => candle.high)) + atr * 0.08
    : null;
  const risk = latest && stopPrice != null ? Math.abs(latest.close - stopPrice) : 0;
  const targetPrice = latest && stopPrice != null
    ? direction === "BULL" ? latest.close + risk * 2 : latest.close - risk * 2
    : null;
  const triggerLabel = trigger === "FRESH_CROSS" ? "свежий крест" : trigger === "PULLBACK_RESUME" ? "возобновление после ретеста" : "триггер не сформирован";

  return {
    id: "macd-ema-topdown",
    label: "MACD+EMA · сверху вниз",
    shortLabel: "MACD MTF",
    tone: "cyan",
    state,
    direction,
    sourceTimeframe: "5m",
    experimental: true,
    summary: strictHigherTimeframesAligned
      ? `1д/4ч/1ч/30м/15м согласованы ${direction === "BULL" ? "вверх" : "вниз"}; 5м: ${triggerLabel}`
      : `Иерархия ещё не полная для ${direction === "BULL" ? "LONG" : "SHORT"}: ${blockers.slice(0, 3).join("; ")}`,
    blockers,
    topDownMacdEma: {
      version: "macd-ema-topdown-v1",
      mode: "STRICT_CLOSED_TF",
      direction,
      strictHigherTimeframesAligned,
      fiveMinuteTrigger: trigger,
      timeframes: directionalStates,
    },
    ...(state === "CONFIRMED" && latest && stopPrice != null && targetPrice != null && risk > latest.close * 0.0002 ? {
      trial: {
        mode: "STATISTICAL" as const,
        side: direction === "BULL" ? "LONG" as const : "SHORT" as const,
        signalTime: latest.time,
        availableAt: latest.time + 5 * 60_000,
        entryPrice: latest.close,
        targetPrice,
        stopPrice,
        expiresAt: latest.time + 36 * 5 * 60_000,
        riskReward: 2,
        executionResolutionMinutes: 5 as const,
      },
    } : {}),
  };
}

export function detectMacdImpulseExhaustion(candles: Candle[], timeframe: Timeframe): ForecastStrategyMatch | null {
  const closed = candles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (closed.length < 35) return null;
  const pack = indicators(closed);
  const index = closed.length - 1;
  const histogram = [index - 3, index - 2, index - 1, index].map((position) => pack.histogram[position]);
  const macd = [index - 3, index - 2, index - 1, index].map((position) => pack.macd[position]);
  const signal = [index - 3, index - 2, index - 1, index].map((position) => pack.signal[position]);
  if (![...histogram, ...macd, ...signal].every(finite)) return null;

  const [histogramOld, histogramMiddle, histogramPrevious, histogramNow] = histogram as number[];
  const [macdOld, , macdPrevious, macdNow] = macd as number[];
  const [signalOld, , signalPrevious, signalNow] = signal as number[];
  const bullishApproach = histogramOld < histogramMiddle && histogramMiddle < histogramPrevious && histogramPrevious < 0
    && macdPrevious < macdOld && signalPrevious < signalOld;
  const bearishApproach = histogramOld > histogramMiddle && histogramMiddle > histogramPrevious && histogramPrevious > 0
    && macdPrevious > macdOld && signalPrevious > signalOld;
  const bullishExhaustion = bullishApproach && histogramNow >= histogramPrevious;
  const bearishExhaustion = bearishApproach && histogramNow <= histogramPrevious;
  if (!bullishExhaustion && !bearishExhaustion) return null;

  const direction = bullishExhaustion ? "BULL" : "BEAR";
  const latest = closed[index];
  const previous = closed[index - 1];
  const crossed = direction === "BULL"
    ? macdPrevious < signalPrevious && macdNow >= signalNow
    : macdPrevious > signalPrevious && macdNow <= signalNow;
  const patterns = latestPattern(closed);
  const candleConfirmed = direction === "BULL"
    ? latest.close > previous.high || patterns.some((pattern) => pattern === "Бычье поглощение" || pattern === "Молот")
    : latest.close < previous.low || patterns.some((pattern) => pattern === "Медвежье поглощение" || pattern === "Падающая звезда");
  const state: ForecastStrategyMatch["state"] = crossed && candleConfirmed ? "CONFIRMED" : crossed || candleConfirmed ? "SUPPORTING" : "WATCH";
  const atr = Math.max(averageTrueRange(closed), latest.close * 0.001);
  const recent = closed.slice(-7);
  const stopPrice = direction === "BULL"
    ? Math.min(...recent.map((candle) => candle.low)) - atr * 0.08
    : Math.max(...recent.map((candle) => candle.high)) + atr * 0.08;
  const risk = Math.abs(latest.close - stopPrice);
  const targetPrice = direction === "BULL" ? latest.close + risk * 2 : latest.close - risk * 2;
  const minutes = TIMEFRAME_MINUTES[timeframe];

  return {
    id: "macd-exhaustion",
    label: "Угасание импульса MACD",
    shortLabel: "MACD Δ",
    tone: "cyan",
    state,
    direction,
    sourceTimeframe: timeframe,
    experimental: true,
    summary: state === "CONFIRMED"
      ? `${direction === "BULL" ? "Бычий" : "Медвежий"} разворот: гистограмма сжалась, перекрестие и свеча подтвердили сигнал`
      : state === "SUPPORTING"
        ? `Гистограмма идёт к нулю отдельно от линий; получено одно подтверждение из двух`
        : `Гистограмма идёт к нулю, линии сохраняют прежнее движение — ждём перекрестие и подтверждающую свечу`,
    ...(state === "CONFIRMED" && risk > latest.close * 0.0002 ? {
      trial: {
        mode: "STATISTICAL" as const,
        side: direction === "BULL" ? "LONG" as const : "SHORT" as const,
        signalTime: latest.time,
        availableAt: latest.time + minutes * 60_000,
        entryPrice: latest.close,
        targetPrice,
        stopPrice,
        expiresAt: latest.time + minutes * 60_000 * 8,
        riskReward: 2,
        executionResolutionMinutes: minutes,
      },
    } : {}),
  };
}

const NEW_YORK_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function newYorkParts(time: number) {
  const parts = Object.fromEntries(NEW_YORK_FORMATTER.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function bodyBeyond(candle: Candle, level: number, side: "LONG" | "SHORT") {
  return side === "LONG" ? Math.min(candle.open, candle.close) > level : Math.max(candle.open, candle.close) < level;
}

export function detectOpeningRangeThreeCandle(source: Candle[], visibleThroughTime: number): ForecastStrategyMatch | null {
  const candles = source.filter((candle) => candle.closed !== false && candle.time <= visibleThroughTime)
    .sort((left, right) => left.time - right.time);
  if (candles.length < 5) return null;
  const sessionDates = [...new Set(candles.map((candle) => newYorkParts(candle.time).date))].reverse();
  for (const sessionDate of sessionDates) {
    const session = candles.filter((candle) => {
      const local = newYorkParts(candle.time);
      return local.date === sessionDate && local.minuteOfDay >= 570 && local.minuteOfDay < 960;
    });
    const openingIndex = session.findIndex((candle) => newYorkParts(candle.time).minuteOfDay === 570);
    if (openingIndex < 0 || session.length - openingIndex < 4) continue;
    const regular = session.slice(openingIndex);
    const opening = regular[0];
    const expiry = opening.time + 390 * 60_000;
    const candidates: ForecastStrategyMatch[] = [];

    for (const side of ["LONG", "SHORT"] as const) {
      const level = side === "LONG" ? opening.high : opening.low;
      for (let index = 3; index < regular.length; index += 1) {
        const trio = regular.slice(index - 2, index + 1);
        if (!trio.every((candle) => bodyBeyond(candle, level, side))) continue;
        const third = trio[2];
        const trigger = side === "LONG" ? third.high : third.low;
        const stop = side === "LONG" ? third.low : third.high;
        const risk = Math.abs(trigger - stop);
        if (risk <= Math.max(trigger * 0.00005, Number.EPSILON)) continue;
        const triggeredBy = regular.slice(index + 1).find((candle) => side === "LONG" ? candle.high >= trigger : candle.low <= trigger);
        const state: ForecastStrategyMatch["state"] = triggeredBy ? "CONFIRMED" : "SUPPORTING";
        const target = side === "LONG" ? trigger + risk * 3 : trigger - risk * 3;
        const match: ForecastStrategyMatch = {
          id: "opening-range-3",
          label: "Диапазон открытия NY · 3 свечи",
          shortLabel: "NY OR3",
          tone: "rose",
          state,
          direction: side === "LONG" ? "BULL" : "BEAR",
          sourceTimeframe: "15m",
          experimental: true,
          summary: triggeredBy
            ? `${side}: три минутных тела закрепились за первой свечой 09:30 NY, экстремум третьей пробит`
            : `${side}: три минутных тела закрепились; ждём пробой ${side === "LONG" ? "максимума" : "минимума"} третьей свечи`,
          ...(triggeredBy ? {
            trial: {
              mode: "STATISTICAL" as const,
              side,
              signalTime: triggeredBy.time,
              availableAt: triggeredBy.time + 60_000,
              entryPrice: trigger,
              targetPrice: target,
              stopPrice: stop,
              expiresAt: expiry,
              riskReward: 3,
              executionResolutionMinutes: 1 as const,
            },
          } : {}),
        };
        candidates.push(match);
        break;
      }
    }
    return candidates.sort((left, right) => {
      const leftTime = left.trial?.signalTime ?? 0;
      const rightTime = right.trial?.signalTime ?? 0;
      if (Boolean(left.trial) !== Boolean(right.trial)) return left.trial ? -1 : 1;
      return rightTime - leftTime;
    })[0] ?? null;
  }
  return null;
}
