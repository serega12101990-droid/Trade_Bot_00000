import { indicators, latestPattern } from "./terminal-math";
import type { Candle, ForecastStrategyMatch, Timeframe } from "./terminal-types";

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
