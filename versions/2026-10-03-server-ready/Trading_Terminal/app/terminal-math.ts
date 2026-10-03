import type { Candle, CandlestickPattern, IndicatorPack } from "./terminal-types";

export function ema(values: number[], period: number): Array<number | null> {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output: Array<number | null> = [];
  let current = values[0];
  values.forEach((value, index) => {
    current = index === 0 ? value : value * alpha + current * (1 - alpha);
    output.push(index + 1 < period ? null : current);
  });
  return output;
}

export function indicators(candles: Candle[]): IndicatorPack {
  const closes = candles.map((item) => item.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = closes.map((_, index) => {
    const fast = ema12[index];
    const slow = ema26[index];
    return fast == null || slow == null ? null : fast - slow;
  });
  const compact = macd.map((value) => value ?? 0);
  const signalRaw = ema(compact, 9);
  const signal = signalRaw.map((value, index) => (macd[index] == null ? null : value));
  const histogram = macd.map((value, index) =>
    value == null || signal[index] == null ? null : value - Number(signal[index]),
  );
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    macd,
    signal,
    histogram,
  };
}

export function formatPrice(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  const digits = value >= 1000 ? 2 : value >= 10 ? 2 : value >= 1 ? 3 : 5;
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

type PatternSeed = Pick<CandlestickPattern, "id" | "label" | "direction" | "startTime" | "endTime" | "upperLevel" | "lowerLevel" | "explanation" | "qualityScore" | "contextAligned" | "contextNotes">;

function finalizePattern(seed: PatternSeed, candles: Candle[], patternEndIndex: number): CandlestickPattern {
  let status: CandlestickPattern["status"] = "PENDING";
  let confirmationTime: number | undefined;
  let resolvedDirection = seed.direction;
  for (let index = patternEndIndex + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (seed.direction !== "BEARISH" && candle.close > seed.upperLevel) {
      status = "CONFIRMED";
      resolvedDirection = "BULLISH";
      confirmationTime = candle.time;
      break;
    }
    if (seed.direction !== "BULLISH" && candle.close < seed.lowerLevel) {
      status = "CONFIRMED";
      resolvedDirection = "BEARISH";
      confirmationTime = candle.time;
      break;
    }
    if (seed.direction === "BULLISH" && candle.close < seed.lowerLevel) {
      status = "INVALIDATED";
      confirmationTime = candle.time;
      break;
    }
    if (seed.direction === "BEARISH" && candle.close > seed.upperLevel) {
      status = "INVALIDATED";
      confirmationTime = candle.time;
      break;
    }
  }
  const directionWord = resolvedDirection === "BULLISH" ? "вверх" : resolvedDirection === "BEARISH" ? "вниз" : "из диапазона";
  const confirmation = status === "CONFIRMED"
    ? `Подтверждена закрытием ${directionWord}`
    : status === "INVALIDATED"
      ? "Модель отменена противоположным закрытием"
      : seed.direction === "BULLISH"
        ? `Ждём закрытие выше ${formatPrice(seed.upperLevel)}`
        : seed.direction === "BEARISH"
          ? `Ждём закрытие ниже ${formatPrice(seed.lowerLevel)}`
          : `Ждём закрытие выше ${formatPrice(seed.upperLevel)} или ниже ${formatPrice(seed.lowerLevel)}`;
  const qualityScore = Math.min(100, Math.max(0, (seed.qualityScore ?? 0) + (status === "CONFIRMED" ? 8 : status === "INVALIDATED" ? -12 : 0)));
  return { ...seed, qualityScore, direction: resolvedDirection, status, confirmationTime, confirmation };
}

export function latestPatternDetails(source: Candle[]): CandlestickPattern | null {
  const candles = source.filter((candle) => candle.closed !== false);
  if (candles.length < 2) return null;
  const pack = indicators(candles);
  const firstIndex = Math.max(1, candles.length - 10);
  for (let index = candles.length - 1; index >= firstIndex; index -= 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const currentBody = Math.abs(current.close - current.open);
    const previousBody = Math.abs(previous.close - previous.open);
    const range = Math.max(current.high - current.low, Number.EPSILON);
    const upperWick = current.high - Math.max(current.open, current.close);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const pairUpper = Math.max(previous.high, current.high);
    const pairLower = Math.min(previous.low, current.low);
    const currentHighBody = Math.max(current.open, current.close);
    const currentLowBody = Math.min(current.open, current.close);
    const previousHighBody = Math.max(previous.open, previous.close);
    const previousLowBody = Math.min(previous.open, previous.close);
    const prePatternWindow = candles.slice(Math.max(0, index - 7), index);
    const preAverageRange = prePatternWindow.reduce((sum, candle) => sum + Math.max(candle.high - candle.low, Number.EPSILON), 0) / Math.max(1, prePatternWindow.length);
    const preMove = previous.close - (prePatternWindow.at(0)?.close ?? previous.close);
    const afterRise = preMove >= preAverageRange * 0.7;
    const afterFall = preMove <= -preAverageRange * 0.7;

    const bullishEngulfing = previous.close < previous.open && current.close > current.open && current.open <= previous.close && current.close >= previous.open;
    const bearishEngulfing = previous.close > previous.open && current.close < current.open && current.open >= previous.close && current.close <= previous.open;
    const harami = currentHighBody < previousHighBody && currentLowBody > previousLowBody && currentBody <= previousBody * 0.9;

    let seed: PatternSeed | null = null;
    if (bullishEngulfing || bearishEngulfing) {
      const bullish = bullishEngulfing;
      seed = {
        id: bullish ? "BULLISH_ENGULFING" : "BEARISH_ENGULFING",
        label: bullish ? "Бычье поглощение" : "Медвежье поглощение",
        direction: bullish ? "BULLISH" : "BEARISH",
        startTime: previous.time,
        endTime: current.time,
        upperLevel: pairUpper,
        lowerLevel: pairLower,
        explanation: "Тело второй свечи полностью поглотило тело первой. Для входа всё равно требуется закрытие в сторону модели.",
      };
    } else if (harami) {
      const direction = previous.close < previous.open && current.close > current.open
        ? "BULLISH"
        : previous.close > previous.open && current.close < current.open
          ? "BEARISH"
          : "NEUTRAL";
      seed = {
        id: direction === "BULLISH" ? "BULLISH_HARAMI" : direction === "BEARISH" ? "BEARISH_HARAMI" : "HARAMI",
        label: direction === "BULLISH" ? "Бычья харами" : direction === "BEARISH" ? "Медвежья харами" : "Харами",
        direction,
        startTime: previous.time,
        endTime: current.time,
        upperLevel: pairUpper,
        lowerLevel: pairLower,
        explanation: "Тело второй свечи находится внутри тела первой. Это предупреждение о возможном развороте, а не самостоятельный вход.",
      };
    } else if (currentBody / range <= 0.12) {
      seed = { id: "DOJI", label: "Доджи", direction: "NEUTRAL", startTime: current.time, endTime: current.time, upperLevel: current.high, lowerLevel: current.low, explanation: "Тело свечи очень мало: рынок показывает равновесие. Ждём выхода закрытием из её диапазона." };
    } else if (lowerWick >= currentBody * 2 && upperWick <= Math.max(currentBody, range * 0.12)) {
      seed = afterRise
        ? { id: "HANGING_MAN", label: "Повешенный", direction: "BEARISH", startTime: current.time, endTime: current.time, upperLevel: current.high, lowerLevel: current.low, explanation: "Длинная нижняя тень после роста предупреждает об истощении покупателей. Нужна медвежья подтверждающая свеча." }
        : { id: "HAMMER", label: "Молот", direction: "BULLISH", startTime: current.time, endTime: current.time, upperLevel: current.high, lowerLevel: current.low, explanation: "Длинная нижняя тень после снижения показывает выкуп. Нужна бычья подтверждающая свеча." };
    } else if (upperWick >= currentBody * 2 && lowerWick <= Math.max(currentBody, range * 0.12)) {
      seed = afterFall
        ? { id: "INVERTED_HAMMER", label: "Перевёрнутый молот", direction: "BULLISH", startTime: current.time, endTime: current.time, upperLevel: current.high, lowerLevel: current.low, explanation: "Длинная верхняя тень после снижения показывает первую попытку покупателей. Нужна бычья подтверждающая свеча." }
        : { id: "SHOOTING_STAR", label: "Падающая звезда", direction: "BEARISH", startTime: current.time, endTime: current.time, upperLevel: current.high, lowerLevel: current.low, explanation: "Длинная верхняя тень после роста показывает отбой продавцов. Нужна медвежья подтверждающая свеча." };
    }
    if (seed) {
      const contextWindow = candles.slice(Math.max(0, index - 7), index);
      const averageRange = contextWindow.reduce((sum, candle) => sum + Math.max(candle.high - candle.low, Number.EPSILON), 0) / Math.max(1, contextWindow.length);
      const averageBody = contextWindow.reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / Math.max(1, contextWindow.length);
      const averageVolume = contextWindow.reduce((sum, candle) => sum + Math.max(0, candle.volume), 0) / Math.max(1, contextWindow.length);
      const firstContextClose = contextWindow.at(0)?.close ?? previous.close;
      const priorMove = previous.close - firstContextClose;
      const recentHigh = Math.max(...contextWindow.map((candle) => candle.high));
      const recentLow = Math.min(...contextWindow.map((candle) => candle.low));
      const atLowerExtreme = pairLower <= recentLow + averageRange * 0.18;
      const atUpperExtreme = pairUpper >= recentHigh - averageRange * 0.18;
      const emaValues = [pack.ema20[index], pack.ema50[index], pack.ema200[index]].filter((value): value is number => value != null);
      const patternMidpoint = (pairUpper + pairLower) / 2;
      const nearEma = emaValues.some((value) => Math.abs(patternMidpoint - value) <= averageRange * 0.65);
      const bodyQuality = seed.id === "BULLISH_ENGULFING" || seed.id === "BEARISH_ENGULFING"
        ? currentBody >= averageBody * 0.72 && previousBody >= averageBody * 0.62
        : seed.id.includes("HARAMI")
          ? previousBody >= averageBody * 0.82 && currentBody <= previousBody * 0.72
          : seed.id === "HAMMER" || seed.id === "HANGING_MAN" || seed.id === "INVERTED_HAMMER" || seed.id === "SHOOTING_STAR"
            ? range >= averageRange * 0.76 && currentBody <= range * 0.46
            : range >= averageRange * 0.5;
      const trendContext = seed.direction === "BULLISH"
        ? priorMove <= -averageRange * 0.7 || atLowerExtreme
        : seed.direction === "BEARISH"
          ? priorMove >= averageRange * 0.7 || atUpperExtreme
          : true;
      const contextAligned = seed.direction === "NEUTRAL" ? nearEma || atLowerExtreme || atUpperExtreme : trendContext;
      const volumeSupports = current.volume >= averageVolume * 1.05;
      const contextNotes = [
        bodyQuality ? "форма модели достаточна" : "слабые пропорции свечей",
        trendContext ? "есть предшествующее движение/экстремум" : "нет разворотного контекста",
        nearEma ? "рядом EMA" : "вдали от EMA",
        volumeSupports ? "объём подтверждает" : "без усиления объёмом",
      ];
      const qualityScore = 25 + (bodyQuality ? 25 : 0) + (trendContext ? 24 : 0) + (nearEma ? 13 : 0) + (volumeSupports ? 8 : 0);
      return finalizePattern({ ...seed, qualityScore, contextAligned, contextNotes }, candles, index);
    }
  }
  return null;
}

export function latestPattern(candles: Candle[]): string[] {
  const pattern = latestPatternDetails(candles);
  return pattern ? [pattern.label] : [];
}

export function formingPatternDetails(source: Candle[]): CandlestickPattern | null {
  const live = [...source].sort((left, right) => left.time - right.time).at(-1);
  if (!live || live.closed !== false) return null;
  const closed = source.filter((candle) => candle.closed !== false);
  const tentative = latestPatternDetails([...closed, { ...live, closed: true }]);
  if (!tentative || (tentative.endTime !== live.time && tentative.confirmationTime !== live.time)) return null;
  return {
    ...tentative,
    label: `Возможная: ${tentative.label}`,
    status: "PENDING",
    endTime: live.time,
    confirmationTime: undefined,
    qualityScore: Math.max(0, (tentative.qualityScore ?? 0) - 8),
    explanation: `Модель ещё формируется на открытой свече. ${tentative.explanation}`,
    confirmation: `Не подтверждена до закрытия свечи · верх ${formatPrice(tentative.upperLevel)} · низ ${formatPrice(tentative.lowerLevel)}`,
  };
}

export function currentMacdState(pack: IndicatorPack): {
  bias: "bull" | "bear" | "neutral";
  crossed: boolean;
  contracting: boolean;
  label: string;
} {
  const last = pack.histogram.length - 1;
  if (last < 2 || pack.histogram[last] == null || pack.histogram[last - 1] == null) {
    return { bias: "neutral", crossed: false, contracting: false, label: "Недостаточно данных" };
  }
  const now = Number(pack.histogram[last]);
  const before = Number(pack.histogram[last - 1]);
  const crossed = (now >= 0 && before < 0) || (now <= 0 && before > 0);
  const contracting = Math.abs(now) < Math.abs(before);
  const bias = now > 0 ? "bull" : now < 0 ? "bear" : "neutral";
  const label = crossed
    ? bias === "bull"
      ? "Бычье пересечение"
      : "Медвежье пересечение"
    : contracting
      ? "Импульс ослабевает"
      : bias === "bull"
        ? "Бычий импульс"
        : "Медвежий импульс";
  return { bias, crossed, contracting, label };
}

export function findImpulse(candles: Candle[]): { index: number; midpoint: number; direction: "up" | "down" } | null {
  if (candles.length < 18) return null;
  const start = Math.max(14, candles.length - 35);
  let winner: { index: number; midpoint: number; direction: "up" | "down"; strength: number } | null = null;
  for (let index = start; index < candles.length; index += 1) {
    const lookback = candles.slice(index - 14, index);
    const averageRange = lookback.reduce((sum, item) => sum + item.high - item.low, 0) / lookback.length;
    const candle = candles[index];
    const range = candle.high - candle.low;
    const bodyShare = Math.abs(candle.close - candle.open) / Math.max(range, Number.EPSILON);
    const strength = range / Math.max(averageRange, Number.EPSILON);
    if (strength >= 1.7 && bodyShare >= 0.58 && (!winner || strength > winner.strength)) {
      winner = {
        index,
        midpoint: (candle.high + candle.low) / 2,
        direction: candle.close >= candle.open ? "up" : "down",
        strength,
      };
    }
  }
  return winner;
}
