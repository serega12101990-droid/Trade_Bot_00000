import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("chart pan moves continuously between history and free future space", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { panViewport } = await server.ssrLoadModule("/app/market-chart.tsx");
    assert.deepEqual(panViewport(0, 30, -20, 100, 500), { offset: 0, futureSlots: 50 });
    assert.deepEqual(panViewport(0, 30, 12, 100, 500), { offset: 0, futureSlots: 18 });
    assert.deepEqual(panViewport(0, 10, 25, 100, 500), { offset: 15, futureSlots: 0 });
    assert.deepEqual(panViewport(20, 0, -30, 100, 500), { offset: 0, futureSlots: 10 });
  } finally {
    await server.close();
  }
});

test("forecast paths are converted into deterministic valid OHLC candles", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { buildForecastCandles } = await server.ssrLoadModule("/app/market-chart.tsx");
    const scenario = {
      id: "bull",
      label: "Рост",
      direction: "BULL",
      weight: 58,
      target: 104,
      path: [100, 100.7, 101.3, 102.4, 104],
    };
    const bandLow = [99.5, 99.9, 100.4, 101.2, 102.4];
    const bandHigh = [100.5, 101.5, 102.3, 103.7, 105.6];
    const first = buildForecastCandles(scenario, 1.2, bandLow, bandHigh);
    const second = buildForecastCandles(scenario, 1.2, bandLow, bandHigh);

    assert.deepEqual(first, second, "visual candles must not change randomly between renders");
    assert.equal(first.length, scenario.path.length - 1);
    assert.equal(first[0].open, scenario.path[0]);
    assert.equal(first.at(-1).close, scenario.target);
    first.forEach((candle, index) => {
      if (index > 0) assert.equal(candle.open, first[index - 1].close, "forecast candles should remain continuous");
      assert.ok(candle.high >= Math.max(candle.open, candle.close));
      assert.ok(candle.low <= Math.min(candle.open, candle.close));
      assert.ok(candle.high <= bandHigh[index + 1]);
      assert.ok(candle.low >= bandLow[index + 1]);
    });
  } finally {
    await server.close();
  }
});
