import type {
  Candle,
  ForecastDirection,
  Market,
  Timeframe,
  VpaAlignment,
  VpaEventId,
  VpaSnapshot,
} from "./terminal-types";

const INTRADAY_MINUTES: Partial<Record<Timeframe, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
};

const MARKET_TIMEZONE: Partial<Record<Market, string>> = {
  stocks: "America/New_York",
  moex: "Europe/Moscow",
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

function trueRange(candle: Candle, previous?: Candle) {
  const previousClose = previous?.close ?? candle.open;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}

function minuteOfSession(time: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(time));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function volumeBaseline(
  history: Candle[],
  latest: Candle,
  market: Market,
  timeframe: Timeframe,
): { value: number; mode: VpaSnapshot["baselineMode"] } {
  const timezone = MARKET_TIMEZONE[market];
  const interval = INTRADAY_MINUTES[timeframe];
  if (timezone && interval) {
    const slot = minuteOfSession(latest.time, timezone);
    const sameSession = history
      .slice(-320)
      .filter((candle) => candle.volume > 0 && Math.abs(minuteOfSession(candle.time, timezone) - slot) <= Math.max(1, interval * 0.16))
      .map((candle) => candle.volume);
    if (sameSession.length >= 4) return { value: median(sameSession), mode: "SAME_SESSION" };
  }
  const rolling = history.slice(-30).map((candle) => candle.volume).filter((volume) => volume > 0);
  return { value: median(rolling), mode: "ROLLING" };
}

function dataQuality(market: Market, volumeAvailable: boolean): VpaSnapshot["volumeQuality"] {
  if (!volumeAvailable) return "UNAVAILABLE";
  return market === "forex" ? "TICK_PROXY" : "REPORTED";
}

function eventLabel(event: VpaEventId, direction: ForecastDirection) {
  if (event === "CONFIRMED_IMPULSE") return direction === "BULL" ? "Подтверждённый импульс вверх" : "Подтверждённый импульс вниз";
  if (event === "WEAK_PULLBACK") return direction === "BULL" ? "Слабый откат вниз" : "Слабый откат вверх";
  if (event === "ABSORPTION") return direction === "BULL" ? "Поглощение продаж" : direction === "BEAR" ? "Поглощение покупок" : "Взаимное поглощение";
  if (event === "STOPPING_VOLUME") return direction === "BULL" ? "Останавливающий объём снижения" : "Кульминация покупок";
  if (event === "CONFIRMED_BREAKOUT") return direction === "BULL" ? "Подтверждённый пробой вверх" : "Подтверждённый пробой вниз";
  if (event === "FALSE_BREAKOUT") return direction === "BULL" ? "Ложный пробой вниз" : "Ложный пробой вверх";
  return "Явной аномалии объёма и цены нет";
}

function alignmentFor(direction: ForecastDirection, forecastDirection: ForecastDirection): VpaAlignment {
  if (direction === "SIDEWAYS" || forecastDirection === "SIDEWAYS") return "NEUTRAL";
  return direction === forecastDirection ? "CONFIRMS" : "CONFLICTS";
}

export function analyzeVolumePrice(
  source: Candle[],
  market: Market,
  timeframe: Timeframe,
  forecastDirection: ForecastDirection,
): VpaSnapshot | null {
  const candles = source
    .filter((candle) => candle.closed !== false)
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .sort((left, right) => left.time - right.time);
  if (candles.length < 25) return null;

  const latest = candles.at(-1)!;
  const history = candles.slice(0, -1);
  const range = Math.max(latest.high - latest.low, Number.EPSILON);
  const body = Math.abs(latest.close - latest.open);
  const upperWick = Math.max(0, latest.high - Math.max(latest.open, latest.close));
  const lowerWick = Math.max(0, Math.min(latest.open, latest.close) - latest.low);
  const closeLocation = clamp((latest.close - latest.low) / range, 0, 1);
  const bodyShare = clamp(body / range, 0, 1);
  const upperWickShare = clamp(upperWick / range, 0, 1);
  const lowerWickShare = clamp(lowerWick / range, 0, 1);
  const atrSample = history.slice(-14).map((candle, index, sample) => trueRange(candle, sample[index - 1]));
  const atr = Math.max(median(atrSample), Math.abs(latest.close) * 0.0001, Number.EPSILON);
  const rangeAtr = range / atr;
  const baseline = volumeBaseline(history, latest, market, timeframe);
  const volumeAvailable = baseline.value > 0 && latest.volume > 0;
  const relativeVolume = volumeAvailable ? latest.volume / baseline.value : null;
  const previousRange = history.slice(-20);
  const previousHigh = Math.max(...previousRange.map((candle) => candle.high));
  const previousLow = Math.min(...previousRange.map((candle) => candle.low));
  const contextStart = history.at(-7)?.close ?? history.at(0)?.close ?? latest.open;
  const contextEnd = history.at(-1)?.close ?? latest.open;
  const contextMoveAtr = (contextEnd - contextStart) / atr;
  const priorRising = contextMoveAtr >= 0.7;
  const priorFalling = contextMoveAtr <= -0.7;
  const highVolume = relativeVolume != null && relativeVolume >= 1.25;
  const extremeVolume = relativeVolume != null && relativeVolume >= 1.6;
  const lowVolume = relativeVolume != null && relativeVolume <= 0.85;
  const brokeHigh = latest.high > previousHigh + atr * 0.03;
  const brokeLow = latest.low < previousLow - atr * 0.03;

  let event: VpaEventId = "NEUTRAL";
  let direction: ForecastDirection = "SIDEWAYS";
  let confidence = 28;

  if (highVolume && brokeHigh && latest.close <= previousHigh && upperWickShare >= 0.22 && !brokeLow) {
    event = "FALSE_BREAKOUT";
    direction = "BEAR";
    confidence = 66 + Math.min(16, (relativeVolume! - 1.25) * 18) + upperWickShare * 16;
  } else if (highVolume && brokeLow && latest.close >= previousLow && lowerWickShare >= 0.22 && !brokeHigh) {
    event = "FALSE_BREAKOUT";
    direction = "BULL";
    confidence = 66 + Math.min(16, (relativeVolume! - 1.25) * 18) + lowerWickShare * 16;
  } else if (highVolume && latest.close > previousHigh && rangeAtr >= 0.9 && closeLocation >= 0.68) {
    event = "CONFIRMED_BREAKOUT";
    direction = "BULL";
    confidence = 64 + Math.min(17, (relativeVolume! - 1.25) * 18) + Math.min(11, (rangeAtr - 0.9) * 10);
  } else if (highVolume && latest.close < previousLow && rangeAtr >= 0.9 && closeLocation <= 0.32) {
    event = "CONFIRMED_BREAKOUT";
    direction = "BEAR";
    confidence = 64 + Math.min(17, (relativeVolume! - 1.25) * 18) + Math.min(11, (rangeAtr - 0.9) * 10);
  } else if (extremeVolume && priorFalling && rangeAtr >= 0.78 && (lowerWickShare >= 0.24 || closeLocation >= 0.56)) {
    event = "STOPPING_VOLUME";
    direction = "BULL";
    confidence = 65 + Math.min(16, (relativeVolume! - 1.6) * 14) + Math.max(lowerWickShare, closeLocation - 0.45) * 18;
  } else if (extremeVolume && priorRising && rangeAtr >= 0.78 && (upperWickShare >= 0.24 || closeLocation <= 0.44)) {
    event = "STOPPING_VOLUME";
    direction = "BEAR";
    confidence = 65 + Math.min(16, (relativeVolume! - 1.6) * 14) + Math.max(upperWickShare, 0.55 - closeLocation) * 18;
  } else if (extremeVolume && (rangeAtr <= 0.9 || bodyShare <= 0.34)) {
    event = "ABSORPTION";
    direction = lowerWickShare > upperWickShare * 1.2 || closeLocation >= 0.62
      ? "BULL"
      : upperWickShare > lowerWickShare * 1.2 || closeLocation <= 0.38
        ? "BEAR"
        : "SIDEWAYS";
    confidence = 60 + Math.min(18, (relativeVolume! - 1.6) * 14) + Math.max(upperWickShare, lowerWickShare) * 16;
  } else if (highVolume && rangeAtr >= 1.05 && bodyShare >= 0.55 && closeLocation >= 0.7) {
    event = "CONFIRMED_IMPULSE";
    direction = "BULL";
    confidence = 62 + Math.min(16, (relativeVolume! - 1.25) * 16) + Math.min(12, (rangeAtr - 1.05) * 10);
  } else if (highVolume && rangeAtr >= 1.05 && bodyShare >= 0.55 && closeLocation <= 0.3) {
    event = "CONFIRMED_IMPULSE";
    direction = "BEAR";
    confidence = 62 + Math.min(16, (relativeVolume! - 1.25) * 16) + Math.min(12, (rangeAtr - 1.05) * 10);
  } else if (lowVolume && rangeAtr <= 0.92 && priorRising && latest.close < latest.open) {
    event = "WEAK_PULLBACK";
    direction = "BULL";
    confidence = 55 + Math.min(16, (0.85 - relativeVolume!) * 24) + Math.min(10, (0.92 - rangeAtr) * 14);
  } else if (lowVolume && rangeAtr <= 0.92 && priorFalling && latest.close > latest.open) {
    event = "WEAK_PULLBACK";
    direction = "BEAR";
    confidence = 55 + Math.min(16, (0.85 - relativeVolume!) * 24) + Math.min(10, (0.92 - rangeAtr) * 14);
  }

  confidence = Math.round(clamp(confidence, 20, 94));
  const alignment = alignmentFor(direction, forecastDirection);
  const volumeText = relativeVolume == null ? "объём недоступен" : `относительный объём ${relativeVolume.toFixed(2)}×`;
  const reasons = [
    `${volumeText}; база ${baseline.mode === "SAME_SESSION" ? "по тому же времени сессии" : "медиана 30 свечей"}`,
    `диапазон ${rangeAtr.toFixed(2)} ATR; тело ${(bodyShare * 100).toFixed(0)}% диапазона`,
    `закрытие на ${(closeLocation * 100).toFixed(0)}% диапазона; тени ↑${(upperWickShare * 100).toFixed(0)}% / ↓${(lowerWickShare * 100).toFixed(0)}%`,
  ];
  if (event === "FALSE_BREAKOUT") reasons.push("выход за прошлый экстремум не удержан закрытием");
  if (event === "CONFIRMED_BREAKOUT") reasons.push("закрытие удержалось за экстремумом 20 свечей");
  if (event === "WEAK_PULLBACK") reasons.push("контртрендовая свеча прошла на сниженном объёме");
  if (event === "ABSORPTION" || event === "STOPPING_VOLUME") reasons.push("усилие объёма выше полученного ценового результата");
  if (event === "CONFIRMED_IMPULSE") reasons.push("объём, диапазон и положение закрытия согласованы");

  return {
    version: "vpa-v1",
    asofTime: latest.time,
    timeframe,
    event,
    label: eventLabel(event, direction),
    direction,
    alignment,
    confidence,
    volumeQuality: dataQuality(market, volumeAvailable),
    baselineMode: baseline.mode,
    relativeVolume: relativeVolume == null ? null : round(relativeVolume),
    rangeAtr: round(rangeAtr),
    bodyShare: round(bodyShare, 3),
    closeLocation: round(closeLocation, 3),
    upperWickShare: round(upperWickShare, 3),
    lowerWickShare: round(lowerWickShare, 3),
    reasons,
  };
}
