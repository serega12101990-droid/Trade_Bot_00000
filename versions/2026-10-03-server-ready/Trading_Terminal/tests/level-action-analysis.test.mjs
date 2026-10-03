import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withLevelAction(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { await run(await server.ssrLoadModule("/app/level-action-analysis.ts")); } finally { await server.close(); }
}

function candlesWithResistance() {
  const start = Date.UTC(2026, 7, 1);
  const candles = Array.from({ length: 64 }, (_, index) => {
    const center = 100 + Math.sin(index / 3) * 0.18;
    return {
      time: start + index * 15 * 60_000,
      open: center - 0.08,
      high: center + 0.48,
      low: center - 0.48,
      close: center + 0.08,
      volume: 1_000,
      closed: true,
    };
  });
  candles[48] = { ...candles[48], open: 100.1, high: 105, low: 99.8, close: 100.2 };
  return candles;
}

test("level action recognizes a false breakout and return below resistance", async () => {
  await withLevelAction(({ analyzeLevelAction }) => {
    const candles = candlesWithResistance();
    candles.push({ time: candles.at(-1).time + 15 * 60_000, open: 105.15, high: 105.65, low: 104.5, close: 104.68, volume: 1_800, closed: true });
    const result = analyzeLevelAction(candles, "15m", { "15m": candles }, "BEAR");
    assert.ok(result);
    assert.equal(result.scenario, "FALSE_BREAKOUT");
    assert.equal(result.direction, "BEAR");
    assert.equal(result.alignment, "CONFIRMS");
    assert.ok(result.primaryLevel.strength >= 30);
  });
});

test("level action recognizes a candle closing beyond resistance", async () => {
  await withLevelAction(({ analyzeLevelAction }) => {
    const candles = candlesWithResistance();
    candles.push({ time: candles.at(-1).time + 15 * 60_000, open: 104.65, high: 105.95, low: 104.55, close: 105.75, volume: 1_900, closed: true });
    const result = analyzeLevelAction(candles, "15m", { "15m": candles }, "BULL");
    assert.ok(result);
    assert.equal(result.scenario, "BREAKOUT");
    assert.equal(result.direction, "BULL");
  });
});

test("level action ignores an unfinished candle", async () => {
  await withLevelAction(({ analyzeLevelAction }) => {
    const candles = candlesWithResistance();
    const closedTime = candles.at(-1).time + 15 * 60_000;
    candles.push({ time: closedTime, open: 105.15, high: 105.7, low: 104.45, close: 104.65, volume: 1_800, closed: true });
    candles.push({ time: closedTime + 15 * 60_000, open: 104.65, high: 120, low: 80, close: 118, volume: 99_000, closed: false });
    const result = analyzeLevelAction(candles, "15m", { "15m": candles }, "BEAR");
    assert.ok(result);
    assert.equal(result.asofTime, closedTime);
    assert.equal(result.direction, "BEAR");
  });
});

test("a matching senior timeframe increases level strength", async () => {
  await withLevelAction(({ analyzeLevelAction }) => {
    const candles = candlesWithResistance();
    candles.push({ time: candles.at(-1).time + 15 * 60_000, open: 105.15, high: 105.65, low: 104.5, close: 104.68, volume: 1_800, closed: true });
    const senior = candlesWithResistance().map((candle, index) => ({ ...candle, time: candle.time + index * 225 * 60_000 }));
    const localOnly = analyzeLevelAction(candles, "15m", { "15m": candles }, "BEAR");
    const withSenior = analyzeLevelAction(candles, "15m", { "15m": candles, "4h": senior }, "BEAR");
    assert.ok(localOnly && withSenior);
    assert.ok(withSenior.primaryLevel.strength > localOnly.primaryLevel.strength);
    assert.equal(withSenior.primaryLevel.timeframe, "4h");
  });
});
