import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withVpa(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { await run(await server.ssrLoadModule("/app/vpa-analysis.ts")); } finally { await server.close(); }
}

function baseCandles(count = 30) {
  const start = Date.UTC(2026, 7, 1);
  return Array.from({ length: count }, (_, index) => {
    const center = 100 + Math.sin(index / 3) * 0.18;
    return {
      time: start + index * 15 * 60_000,
      open: center - 0.08,
      high: center + 0.42,
      low: center - 0.42,
      close: center + 0.08,
      volume: 1_000,
      closed: true,
    };
  });
}

test("VPA confirms a high-volume breakout with a strong close", async () => {
  await withVpa(({ analyzeVolumePrice }) => {
    const candles = baseCandles();
    const time = candles.at(-1).time + 15 * 60_000;
    candles.push({ time, open: 100.1, high: 102.2, low: 99.9, close: 102, volume: 2_100, closed: true });
    const result = analyzeVolumePrice(candles, "crypto", "15m", "BULL");
    assert.ok(result);
    assert.equal(result.event, "CONFIRMED_BREAKOUT");
    assert.equal(result.direction, "BULL");
    assert.equal(result.alignment, "CONFIRMS");
    assert.ok(result.relativeVolume >= 2);
  });
});

test("VPA marks a high-volume rejection above the prior high as a false breakout", async () => {
  await withVpa(({ analyzeVolumePrice }) => {
    const candles = baseCandles();
    const previousHigh = Math.max(...candles.slice(-20).map((candle) => candle.high));
    const time = candles.at(-1).time + 15 * 60_000;
    candles.push({ time, open: previousHigh - 0.12, high: previousHigh + 1.1, low: previousHigh - 0.35, close: previousHigh - 0.08, volume: 1_900, closed: true });
    const result = analyzeVolumePrice(candles, "crypto", "15m", "BULL");
    assert.ok(result);
    assert.equal(result.event, "FALSE_BREAKOUT");
    assert.equal(result.direction, "BEAR");
    assert.equal(result.alignment, "CONFLICTS");
  });
});

test("VPA ignores an unfinished candle and records the closed-candle timestamp", async () => {
  await withVpa(({ analyzeVolumePrice }) => {
    const candles = baseCandles();
    const closedTime = candles.at(-1).time + 15 * 60_000;
    candles.push({ time: closedTime, open: 100, high: 102.4, low: 99.8, close: 102.2, volume: 2_200, closed: true });
    candles.push({ time: closedTime + 15 * 60_000, open: 102.2, high: 110, low: 90, close: 91, volume: 99_000, closed: false });
    const result = analyzeVolumePrice(candles, "crypto", "15m", "BULL");
    assert.ok(result);
    assert.equal(result.asofTime, closedTime);
    assert.equal(result.direction, "BULL");
  });
});

test("stock intraday VPA prefers the same session-time volume baseline", async () => {
  await withVpa(({ analyzeVolumePrice }) => {
    const candles = [];
    const sessionStart = Date.UTC(2026, 6, 1, 13, 30);
    for (let day = 0; day < 7; day += 1) {
      for (let slot = 0; slot < 5; slot += 1) {
        const center = 100 + day * 0.1;
        candles.push({
          time: sessionStart + day * 24 * 60 * 60_000 + slot * 15 * 60_000,
          open: center,
          high: center + 0.4,
          low: center - 0.4,
          close: center + 0.05,
          volume: slot === 0 ? 5_000 : 1_000,
          closed: true,
        });
      }
    }
    const latestTime = sessionStart + 7 * 24 * 60 * 60_000;
    candles.push({ time: latestTime, open: 100.6, high: 101, low: 100.4, close: 100.8, volume: 5_200, closed: true });
    const result = analyzeVolumePrice(candles, "stocks", "15m", "BULL");
    assert.ok(result);
    assert.equal(result.baselineMode, "SAME_SESSION");
    assert.ok(result.relativeVolume < 1.1, "the normal opening volume must not look like a 5x anomaly");
  });
});
