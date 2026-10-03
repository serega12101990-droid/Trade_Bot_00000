import assert from "node:assert/strict";
import test from "node:test";

import { mapTradingViewSeries } from "../scripts/tradingview-history-client.mjs";

test("TradingView history rows become sorted terminal candles", () => {
  const now = 120_000;
  const candles = mapTradingViewSeries([
    { v: [20, 102, 106, 99, 104, 800] },
    { v: [10, 100, 103, 98, 102, 600] },
    { v: ["bad", 1, 2, 0, 1, 10] },
  ], "1m", now);

  assert.deepEqual(candles, [
    { time: 10_000, open: 100, high: 103, low: 98, close: 102, volume: 600, closed: true },
    { time: 20_000, open: 102, high: 106, low: 99, close: 104, volume: 800, closed: true },
  ]);
});

test("TradingView history keeps the current bar out of final signals", () => {
  const start = Date.UTC(2026, 8, 4, 8, 0);
  const candles = mapTradingViewSeries([
    { v: [start / 1000, 100, 103, 99, 102, 600] },
    { v: [(start + 4 * 60 * 60_000) / 1000, 102, 104, 101, 103, 200] },
  ], "4h", start + 5 * 60 * 60_000);
  assert.equal(candles[0].closed, true);
  assert.equal(candles[1].closed, false);
});

test("TradingView history normalizes missing and negative volume", () => {
  assert.deepEqual(mapTradingViewSeries([
    { v: [10, 1, 2, 0.5, 1.5] },
    { v: [20, 2, 3, 1, 2.5, -4] },
  ], "1m", 60_000).map((candle) => candle.volume), [0, 0]);
});
