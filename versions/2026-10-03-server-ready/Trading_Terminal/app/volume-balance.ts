import type { Candle } from "./terminal-types";

export type EstimatedVolumeBalance = {
  candleCount: number;
  startTime: number;
  endTime: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  deltaPercent: number;
  buyPercent: number;
  sellPercent: number;
  averageVolume: number;
  priceChangePercent: number;
  strongestCandleTime: number;
  strongestCandleVolume: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function estimateCandleVolume(candle: Candle) {
  const volume = Number.isFinite(candle.volume) ? Math.max(0, candle.volume) : 0;
  const range = candle.high - candle.low;
  const closeLocation = range > 0
    ? clamp((candle.close - candle.low) / range, 0, 1)
    : 0.5;

  const buyVolume = volume * closeLocation;
  return {
    buyVolume,
    sellVolume: volume - buyVolume,
  };
}

export function estimateVolumeBalance(source: Candle[]): EstimatedVolumeBalance | null {
  const candles = source
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .sort((left, right) => left.time - right.time);
  if (!candles.length) return null;

  let buyVolume = 0;
  let sellVolume = 0;
  let strongest = candles[0];
  candles.forEach((candle) => {
    const split = estimateCandleVolume(candle);
    buyVolume += split.buyVolume;
    sellVolume += split.sellVolume;
    if (candle.volume > strongest.volume) strongest = candle;
  });

  const totalVolume = buyVolume + sellVolume;
  const delta = buyVolume - sellVolume;
  const first = candles[0];
  const last = candles.at(-1)!;

  return {
    candleCount: candles.length,
    startTime: first.time,
    endTime: last.time,
    totalVolume,
    buyVolume,
    sellVolume,
    delta,
    deltaPercent: totalVolume > 0 ? (delta / totalVolume) * 100 : 0,
    buyPercent: totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50,
    sellPercent: totalVolume > 0 ? (sellVolume / totalVolume) * 100 : 50,
    averageVolume: totalVolume / candles.length,
    priceChangePercent: first.open !== 0 ? ((last.close / first.open) - 1) * 100 : 0,
    strongestCandleTime: strongest.time,
    strongestCandleVolume: Math.max(0, strongest.volume),
  };
}

