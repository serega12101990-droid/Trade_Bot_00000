import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function loadVolumeBalance() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const loaded = await server.ssrLoadModule("/app/volume-balance.ts");
  return { server, ...loaded };
}

test("OHLCV volume balance uses the close location inside each candle", async () => {
  const { server, estimateCandleVolume } = await loadVolumeBalance();
  try {
    assert.deepEqual(
      estimateCandleVolume({ time: 1, open: 95, high: 100, low: 90, close: 100, volume: 100, closed: true }),
      { buyVolume: 100, sellVolume: 0 },
    );
    assert.deepEqual(
      estimateCandleVolume({ time: 2, open: 95, high: 100, low: 90, close: 90, volume: 100, closed: true }),
      { buyVolume: 0, sellVolume: 100 },
    );
    assert.deepEqual(
      estimateCandleVolume({ time: 3, open: 95, high: 100, low: 90, close: 95, volume: 100, closed: true }),
      { buyVolume: 50, sellVolume: 50 },
    );
  } finally {
    await server.close();
  }
});

test("selected candle balance reports delta, shares and price change", async () => {
  const { server, estimateVolumeBalance } = await loadVolumeBalance();
  try {
    const result = estimateVolumeBalance([
      { time: 1, open: 90, high: 100, low: 80, close: 100, volume: 100, closed: true },
      { time: 2, open: 100, high: 110, low: 90, close: 100, volume: 200, closed: true },
    ]);
    assert.equal(result.candleCount, 2);
    assert.equal(result.totalVolume, 300);
    assert.equal(result.buyVolume, 200);
    assert.equal(result.sellVolume, 100);
    assert.equal(result.delta, 100);
    assert.ok(Math.abs(result.deltaPercent - 33.333333) < 0.0001);
    assert.ok(Math.abs(result.priceChangePercent - 11.111111) < 0.0001);
    assert.equal(result.strongestCandleTime, 2);
  } finally {
    await server.close();
  }
});
