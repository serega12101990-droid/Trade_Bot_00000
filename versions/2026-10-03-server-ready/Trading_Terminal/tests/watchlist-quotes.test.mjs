import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("TradingView delayed MOEX rows are mapped to watchlist quotes", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { parseTradingViewMoexQuotes } = await server.ssrLoadModule("/app/api/watchlist-quotes/route.ts");
    const quotes = parseTradingViewMoexQuotes({ data: [{ s: "RUS:SBERP", d: [270.5, -0.25, 272, 269, 1787727186, "delayed_streaming_900"] }] }, ["SBERP"]);
    assert.equal(quotes.length, 1);
    assert.deepEqual(quotes[0], {
      symbol: "SBERP",
      market: "moex",
      price: 270.5,
      changePct: -0.25,
      high: 272,
      low: 269,
      updatedAt: 1787727186000,
      source: "TradingView MOEX · задержка 15 мин",
    });
  } finally {
    await server.close();
  }
});
