import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withStrategies(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { await run(await server.ssrLoadModule("/app/experimental-strategies.ts")); } finally { await server.close(); }
}

function candlesFromCloses(closes, stepMs) {
  const start = Date.UTC(2026, 8, 1);
  return closes.map((close, index) => ({
    time: start + index * stepMs,
    open: index ? closes[index - 1] : close,
    high: Math.max(index ? closes[index - 1] : close, close) + 0.12,
    low: Math.min(index ? closes[index - 1] : close, close) - 0.12,
    close,
    volume: 1_000 + index,
    closed: true,
  }));
}

function acceleratingTrend(direction, count = 90) {
  return Array.from({ length: count }, (_, index) => direction === "BULL"
    ? 100 + index * 0.04 + index * index * 0.0015
    : 140 - index * 0.04 - index * index * 0.0015);
}

test("New York opening range waits for three bodies and then starts a 3R statistical trade", async () => {
  await withStrategies(async ({ detectOpeningRangeThreeCandle }) => {
    const start = Date.UTC(2026, 7, 14, 13, 30); // 09:30 America/New_York
    const candle = (minute, open, high, low, close) => ({
      time: start + minute * 60_000, open, high, low, close, volume: 1_000, closed: true,
    });
    const candles = [
      candle(0, 100, 101, 99, 100.2),
      candle(1, 101.1, 101.5, 101.05, 101.3),
      candle(2, 101.2, 101.7, 101.1, 101.6),
      candle(3, 101.4, 102, 101.2, 101.9),
      candle(4, 101.8, 102.2, 101.7, 102.1),
    ];
    const match = detectOpeningRangeThreeCandle(candles, start + 5 * 60_000);
    assert.ok(match);
    assert.equal(match.id, "opening-range-3");
    assert.equal(match.state, "CONFIRMED");
    assert.equal(match.direction, "BULL");
    assert.equal(match.trial.side, "LONG");
    assert.equal(match.trial.riskReward, 3);
    assert.equal(match.trial.entryPrice, 102);
    assert.equal(match.trial.stopPrice, 101.2);
    assert.ok(Math.abs(match.trial.targetPrice - 104.4) < 1e-9);
  });
});

test("MACD exhaustion is detected while the histogram contracts against still-falling lines", async () => {
  await withStrategies(async ({ detectMacdImpulseExhaustion }) => {
    const closes = [
      ...Array.from({ length: 36 }, (_, index) => 120 + index * 0.05),
      120, 118, 115, 111, 106, 101, 97, 94, 92, 90.8, 89.9, 89.3, 88.9,
    ];
    const candles = closes.map((close, index) => ({
      time: Date.UTC(2026, 7, 1) + index * 60 * 60_000,
      open: close + 0.2,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1_000 + index,
      closed: true,
    }));
    const match = detectMacdImpulseExhaustion(candles, "1h");
    assert.ok(match, "decelerating bearish impulse should produce an early MACD exhaustion observation");
    assert.equal(match.id, "macd-exhaustion");
    assert.equal(match.direction, "BULL");
    assert.equal(match.experimental, true);
  });
});

test("top-down MACD+EMA shadow waits for strict closed higher timeframes and opens only on a fresh 5m trigger", async () => {
  await withStrategies(async ({ detectTopDownMacdEmaShadow }) => {
    const higher = acceleratingTrend("BULL");
    const frames = {
      "15m": candlesFromCloses(higher, 15 * 60_000),
      "30m": candlesFromCloses(higher, 30 * 60_000),
      "1h": candlesFromCloses(higher, 60 * 60_000),
      "4h": candlesFromCloses(higher, 4 * 60 * 60_000),
      "1d": candlesFromCloses(higher, 24 * 60 * 60_000),
    };
    const fiveCloses = acceleratingTrend("BULL", 85);
    for (let index = 0; index < 7; index += 1) fiveCloses.push(fiveCloses.at(-1) - 0.16);

    let confirmed = null;
    for (let index = 0; index < 14 && !confirmed; index += 1) {
      fiveCloses.push(fiveCloses.at(-1) + 0.5);
      const match = detectTopDownMacdEmaShadow({ ...frames, "5m": candlesFromCloses(fiveCloses, 5 * 60_000) });
      if (match?.state === "CONFIRMED") confirmed = match;
    }

    assert.ok(confirmed, "a fresh 5m restart inside a fully aligned hierarchy should create a shadow trial");
    assert.equal(confirmed.id, "macd-ema-topdown");
    assert.equal(confirmed.experimental, true);
    assert.equal(confirmed.direction, "BULL");
    assert.equal(confirmed.topDownMacdEma.strictHigherTimeframesAligned, true);
    assert.notEqual(confirmed.topDownMacdEma.fiveMinuteTrigger, "NONE");
    assert.equal(confirmed.trial.executionResolutionMinutes, 5);
    assert.equal(confirmed.trial.availableAt, confirmed.trial.signalTime + 5 * 60_000);
  });
});

test("top-down MACD+EMA shadow records a higher-timeframe conflict without opening a trial", async () => {
  await withStrategies(async ({ detectTopDownMacdEmaShadow }) => {
    const bullish = acceleratingTrend("BULL");
    const bearish = acceleratingTrend("BEAR");
    const match = detectTopDownMacdEmaShadow({
      "5m": candlesFromCloses(bullish, 5 * 60_000),
      "15m": candlesFromCloses(bullish, 15 * 60_000),
      "30m": candlesFromCloses(bullish, 30 * 60_000),
      "1h": candlesFromCloses(bullish, 60 * 60_000),
      "4h": candlesFromCloses(bearish, 4 * 60 * 60_000),
      "1d": candlesFromCloses(bullish, 24 * 60 * 60_000),
    });

    assert.ok(match);
    assert.equal(match.state, "WATCH");
    assert.equal(match.trial, undefined);
    assert.equal(match.topDownMacdEma.strictHigherTimeframesAligned, false);
    assert.ok(match.blockers.some((item) => item.startsWith("4h:")));
  });
});
