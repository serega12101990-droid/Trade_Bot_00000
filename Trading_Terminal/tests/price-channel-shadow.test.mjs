import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withDetector(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { await run(await server.ssrLoadModule("/app/price-channel-shadow.ts")); } finally { await server.close(); }
}

function descendingChannel() {
  const start = Date.UTC(2026, 7, 1);
  const candles = [];
  for (let index = 0; index < 24; index += 1) {
    const close = 96 + index * 0.58;
    candles.push({
      time: start + index * 900_000,
      open: close - 0.3,
      high: close + 0.35,
      low: close - 0.45,
      close,
      volume: 1_000 + index * 12,
      closed: true,
    });
  }
  for (let index = 0; index < 58; index += 1) {
    const center = 109.6 - index * 0.105;
    const close = center + Math.sin(index * Math.PI / 4) * 0.9;
    candles.push({
      time: start + (24 + index) * 900_000,
      open: close + Math.cos(index) * 0.12,
      high: close + 0.32,
      low: close - 0.32,
      close,
      volume: 1_300 + (index % 7) * 45,
      closed: true,
    });
  }
  return candles;
}

test("descending EMA-window channel is recorded as shadow observation without a trade", async () => {
  await withDetector(({ detectEmaWindowChannelShadow }) => {
    const match = detectEmaWindowChannelShadow(descendingChannel());
    assert.ok(match);
    assert.equal(match.id, "ema-window-channel");
    assert.equal(match.direction, "BEAR");
    assert.equal(match.experimental, true);
    assert.ok(match.priceChannel.qualityScore >= 60);
    assert.ok(match.priceChannel.upperTouches >= 2);
    assert.ok(match.priceChannel.lowerTouches >= 2);
    assert.equal(match.trial, undefined, "an intact channel must not create a statistical entry on every candle");
  });
});

test("a fresh confirmed lower break creates one short statistical trial", async () => {
  await withDetector(({ detectEmaWindowChannelShadow }) => {
    const candles = descendingChannel();
    const intact = detectEmaWindowChannelShadow(candles);
    assert.ok(intact);
    const lower = intact.priceChannel.lowerPrice;
    const previous = candles.at(-2);
    const latest = candles.at(-1);
    Object.assign(previous, { open: lower - 0.15, high: lower - 0.05, low: lower - 0.9, close: lower - 0.7, volume: 3_000 });
    Object.assign(latest, { open: lower - 0.65, high: lower - 0.55, low: lower - 1.35, close: lower - 1.1, volume: 3_200 });
    const match = detectEmaWindowChannelShadow(candles);
    assert.ok(match);
    assert.equal(match.priceChannel.phase, "BREAKOUT_DOWN");
    assert.equal(match.state, "CONFIRMED");
    assert.equal(match.trial.side, "SHORT");
    assert.ok(match.trial.targetPrice < match.trial.entryPrice);
    assert.ok(match.trial.stopPrice > match.trial.entryPrice);
  });
});

test("flat noise without the impulse and descending route is ignored", async () => {
  await withDetector(({ detectEmaWindowChannelShadow }) => {
    const start = Date.UTC(2026, 7, 1);
    const candles = Array.from({ length: 90 }, (_, index) => {
      const close = 100 + Math.sin(index / 3) * 0.2;
      return { time: start + index * 900_000, open: close, high: close + 0.2, low: close - 0.2, close, volume: 1_000, closed: true };
    });
    assert.equal(detectEmaWindowChannelShadow(candles), null);
  });
});
