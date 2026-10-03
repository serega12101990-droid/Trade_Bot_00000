import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { mergeAssets, positiveInteger, runWithConcurrency, summarizeScanResults } from "../scripts/automation_daemon.mjs";

async function withAutomationModules(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const runtime = await server.ssrLoadModule("/app/automation-runtime-state.ts");
    const scan = await server.ssrLoadModule("/app/forecast-scan-service.ts");
    await run({ runtime, scan });
  } finally {
    await server.close();
  }
}

test("automation watchlist normalizes symbols and removes duplicates", async () => {
  await withAutomationModules(async ({ runtime }) => {
    const count = runtime.replaceAutomationWatchlist([
      { symbol: "btc/usdt", market: "crypto", name: "Bitcoin" },
      { symbol: "BTCUSDT", market: "crypto", name: "Bitcoin duplicate" },
      { symbol: "AAPL", market: "stocks", name: "Apple" },
      { symbol: "bad symbol", market: "stocks" },
    ]);
    assert.equal(count, 2);
    assert.deepEqual(runtime.readAutomationRuntimeState().watchlist.map((asset) => asset.symbol), ["BTCUSDT", "AAPL"]);
  });
});

test("forecast scan validation rejects unsupported markets and stale signals", async () => {
  await withAutomationModules(async ({ scan }) => {
    assert.equal(scan.normalizeForecastScanRequest({ symbol: "sol/usdt", market: "crypto" }).symbol, "SOLUSDT");
    assert.throws(() => scan.normalizeForecastScanRequest({ symbol: "AAPL", market: "unknown" }), /рынок/);
    const now = Date.UTC(2026, 8, 2, 12, 0);
    assert.equal(scan.isFreshAutomationSignal({ asofTime: now - 60_000, setupTimeframe: 15 }, now), true);
    assert.equal(scan.isFreshAutomationSignal({ asofTime: now - 7 * 60 * 60_000, setupTimeframe: 15 }, now), false);
    const bars = scan.closedAutomationCandles([
      { time: now - 8 * 60 * 60_000, open: 1, high: 2, low: 1, close: 2, volume: 10, closed: true },
      { time: now - 2 * 60 * 60_000, open: 2, high: 3, low: 2, close: 3, volume: 5, closed: true },
    ], "4h", now);
    assert.equal(bars.length, 1, "a provider cannot force a live 4h candle into the forecast");
  });
});

test("scanner admits the last 4h session candle at its actual close but never before", async () => {
  await withAutomationModules(async ({ scan }) => {
    for (const [market, open, close] of [
      ["moex", "2026-09-04T20:00:00Z", "2026-09-04T20:50:00Z"],
      ["stocks", "2026-09-04T17:30:00Z", "2026-09-04T20:00:00Z"],
    ]) {
      const candle = { time: Date.parse(open), open: 100, high: 101, low: 99, close: 100, volume: 100, closed: true };
      assert.equal(scan.closedAutomationCandles([candle], "4h", Date.parse(close) - 1, market).length, 0);
      assert.equal(scan.closedAutomationCandles([candle], "4h", Date.parse(close), market).length, 1);
      assert.equal(scan.closedAutomationCandles([{ ...candle, closed: false }], "4h", Date.parse(close), market).length, 0);
    }
  });
});

test("local daemon merges fallback assets and summarizes scan outcomes", async () => {
  const assets = mergeAssets(
    [{ symbol: "BTCUSDT", market: "crypto" }],
    [{ symbol: "BTC/USDT", market: "crypto" }, { symbol: "EURUSD", market: "forex" }],
  );
  assert.equal(assets.length, 2);
  assert.equal(positiveInteger("0", 3, 1, 8), 1);
  const order = [];
  const values = await runWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    order.push(value);
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8]);
  assert.equal(order.length, 4);
  const summary = summarizeScanResults([
    { ok: true, symbol: "BTCUSDT", payload: { created: true, decision: "READY" } },
    { ok: true, symbol: "AAPL", payload: { created: false, decision: null } },
    { ok: false, symbol: "SBER", error: "Источник недоступен" },
  ], 3, Date.now() - 100, "4h", "run-test");
  assert.equal(summary.created, 1);
  assert.equal(summary.existing, 1);
  assert.equal(summary.ready, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.status, "COMPLETED");
});
