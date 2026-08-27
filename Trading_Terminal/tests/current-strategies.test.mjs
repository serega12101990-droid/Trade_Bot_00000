import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withForecast(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    await run(await server.ssrLoadModule("/app/terminal-forecast.ts"));
  } finally {
    await server.close();
  }
}

function candlesFromCloses(closes, step = 15 * 60_000) {
  const start = Date.UTC(2026, 7, 1);
  return closes.map((close, index) => ({
    time: start + index * step,
    open: index ? closes[index - 1] : close,
    high: Math.max(index ? closes[index - 1] : close, close) + 0.08,
    low: Math.min(index ? closes[index - 1] : close, close) - 0.08,
    close,
    volume: index === closes.length - 1 ? 3_000 : 1_000,
    closed: true,
  }));
}

test("Nison confirmation keeps its own direction and never inherits the opposite forecast", async () => {
  await withForecast(({ detectNisonStrategy }) => {
    const candles = candlesFromCloses(Array.from({ length: 57 }, (_, index) => 100 + index * 0.01));
    candles.push(
      { time: candles.at(-1).time + 900_000, open: 102, high: 103, low: 97, close: 98, volume: 1_500, closed: true },
      { time: candles.at(-1).time + 1_800_000, open: 97.5, high: 103.2, low: 97.2, close: 102.5, volume: 2_000, closed: true },
      { time: candles.at(-1).time + 2_700_000, open: 102.4, high: 104.3, low: 102.2, close: 104, volume: 2_200, closed: true },
    );
    const bull = detectNisonStrategy(candles, "15m", "BULL");
    assert.ok(bull);
    assert.equal(bull.state, "CONFIRMED");
    assert.equal(bull.direction, "BULL");
    assert.ok(bull.trial);
    assert.equal(detectNisonStrategy(candles, "15m", "BEAR"), null);
  });
});

test("MTF entry requires actual lower-timeframe confirmations", async () => {
  await withForecast(({ detectMtfEntryStrategy }) => {
    const anchor = candlesFromCloses(Array.from({ length: 80 }, (_, index) => 100 + index * 0.12), 4 * 60 * 60_000);
    const five = candlesFromCloses(Array.from({ length: 80 }, (_, index) => 105 + index * 0.2), 5 * 60_000);
    const one = candlesFromCloses(Array.from({ length: 80 }, (_, index) => 120 + index * 0.08), 60_000);
    const match = detectMtfEntryStrategy(anchor, "4h", { "1m": one, "5m": five, "4h": anchor }, "BULL");
    assert.ok(match);
    assert.equal(match.state, "CONFIRMED");
    assert.equal(match.entryConfirmations.length, 2);
    assert.ok(match.trial);
    assert.equal(detectMtfEntryStrategy(anchor, "4h", { "4h": anchor }, "BULL"), null);
  });
});

test("legacy MACD becomes confirmed only on a fresh cross inside aligned EMA structure", async () => {
  await withForecast(({ detectLegacyMacdStrategy }) => {
    const closes = Array.from({ length: 80 }, (_, index) => 100 + index * 0.2);
    for (let index = 0; index < 8; index += 1) closes.push(closes.at(-1) - 0.18);
    let confirmed = null;
    for (let index = 0; index < 12 && !confirmed; index += 1) {
      closes.push(closes.at(-1) + 0.55);
      confirmed = detectLegacyMacdStrategy(candlesFromCloses(closes), "15m", "BULL")?.state === "CONFIRMED"
        ? detectLegacyMacdStrategy(candlesFromCloses(closes), "15m", "BULL")
        : null;
    }
    assert.ok(confirmed, "a pullback inside a rising EMA structure should eventually produce a confirmed MACD recross");
    assert.ok(confirmed.trial);
  });
});
