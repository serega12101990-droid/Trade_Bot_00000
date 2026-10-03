import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withMath(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { await run(await server.ssrLoadModule("/app/terminal-math.ts")); } finally { await server.close(); }
}

function trendCandles(direction) {
  const step = direction === "up" ? 0.8 : -0.8;
  return Array.from({ length: 28 }, (_, index) => {
    const open = 100 + index * step;
    const close = open + step * 0.72;
    return { time: Date.UTC(2026, 7, 1) + index * 900_000, open, close, high: Math.max(open, close) + 0.12, low: Math.min(open, close) - 0.12, volume: 1_000, closed: true };
  });
}

test("the same lower-wick shape after a rise is a bearish hanging man, not a bullish hammer", async () => {
  await withMath(({ latestPatternDetails }) => {
    const candles = trendCandles("up");
    const open = candles.at(-1).close + 0.1;
    candles.push({ time: candles.at(-1).time + 900_000, open, close: open + 0.3, high: open + 0.35, low: open - 1.35, volume: 1_600, closed: true });
    const pattern = latestPatternDetails(candles);
    assert.equal(pattern.id, "HANGING_MAN");
    assert.equal(pattern.direction, "BEARISH");
    assert.equal(pattern.contextAligned, true);
    assert.ok(pattern.qualityScore >= 58);
  });
});

test("an upper-wick reversal after a fall is treated as a bullish inverted hammer", async () => {
  await withMath(({ latestPatternDetails }) => {
    const candles = trendCandles("down");
    const open = candles.at(-1).close - 0.1;
    candles.push({ time: candles.at(-1).time + 900_000, open, close: open + 0.3, high: open + 1.4, low: open - 0.05, volume: 1_600, closed: true });
    const pattern = latestPatternDetails(candles);
    assert.equal(pattern.id, "INVERTED_HAMMER");
    assert.equal(pattern.direction, "BULLISH");
    assert.equal(pattern.contextAligned, true);
  });
});

test("a possible Nison model on the open candle stays pending", async () => {
  await withMath(({ formingPatternDetails }) => {
    const candles = trendCandles("up");
    const open = candles.at(-1).close + 0.1;
    const live = { time: candles.at(-1).time + 900_000, open, close: open + 0.3, high: open + 0.35, low: open - 1.35, volume: 1_600, closed: false };
    const pattern = formingPatternDetails([...candles, live]);
    assert.ok(pattern);
    assert.equal(pattern.status, "PENDING");
    assert.equal(pattern.endTime, live.time);
    assert.equal(pattern.confirmationTime, undefined);
  });
});
