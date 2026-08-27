import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withStrategies(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { await run(await server.ssrLoadModule("/app/experimental-strategies.ts")); } finally { await server.close(); }
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
