import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function loadWatchlist() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const loaded = await server.ssrLoadModule("/app/watchlist-preferences.ts");
  return { server, ...loaded };
}

test("manual ticker normalization supports US stocks and USDT crypto", async () => {
  const { server, normalizeUserTicker, defaultExpansionAssets } = await loadWatchlist();
  try {
    assert.deepEqual(normalizeUserTicker("brk.b", "stocks"), { symbol: "BRK.B", displaySymbol: "BRK.B", fallbackName: "BRK.B" });
    assert.deepEqual(normalizeUserTicker("ada/usdt", "crypto"), { symbol: "ADAUSDT", displaySymbol: "ADA/USDT", fallbackName: "ADA" });
    assert.deepEqual(normalizeUserTicker("sber", "moex"), { symbol: "SBER", displaySymbol: "SBER", fallbackName: "SBER" });
    assert.deepEqual(normalizeUserTicker("eur/usd", "forex"), { symbol: "EURUSD", displaySymbol: "EUR/USD", fallbackName: "EUR / USD" });
    assert.equal(normalizeUserTicker("gold", "commodities").symbol, "GC");
    assert.equal(normalizeUserTicker("brent", "commodities").symbol, "BZ");
    assert.equal(defaultExpansionAssets().filter((asset) => asset.market === "forex").length, 6);
    assert.equal(defaultExpansionAssets().filter((asset) => asset.market === "commodities").length, 6);
    assert.throws(() => normalizeUserTicker("???", "stocks"), /тикер/i);
  } finally {
    await server.close();
  }
});

test("watchlist sorting handles symbol, price and change", async () => {
  const { server, sortWatchlistAssets } = await loadWatchlist();
  try {
    const assets = [
      { symbol: "BBB", market: "stocks", quote: { price: 20, changePct: -2 } },
      { symbol: "AAA", market: "stocks", quote: { price: 10, changePct: 3 } },
    ];
    assert.deepEqual(sortWatchlistAssets(assets, "symbol-asc").map((item) => item.symbol), ["AAA", "BBB"]);
    assert.deepEqual(sortWatchlistAssets(assets, "change-desc").map((item) => item.symbol), ["AAA", "BBB"]);
    assert.deepEqual(sortWatchlistAssets(assets, "price-desc").map((item) => item.symbol), ["BBB", "AAA"]);
  } finally {
    await server.close();
  }
});
