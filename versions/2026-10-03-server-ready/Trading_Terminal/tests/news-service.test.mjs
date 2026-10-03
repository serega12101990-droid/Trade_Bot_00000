import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("Alpha Vantage news is normalized for the selected ticker", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { normalizeAlphaVantageFeed } = await server.ssrLoadModule("/app/news-service.ts");
    const payload = {
      feed: [{
        title: "AMD quarterly earnings beat expectations",
        url: "https://example.com/amd-earnings",
        time_published: "20260809T101500",
        summary: "Revenue and guidance exceeded estimates.",
        source: "Example Wire",
        overall_sentiment_score: -0.4,
        overall_sentiment_label: "Bearish",
        topics: [{ topic: "Earnings", relevance_score: "0.91" }],
        ticker_sentiment: [{ ticker: "AMD", relevance_score: "0.94", ticker_sentiment_score: "0.62", ticker_sentiment_label: "Bullish" }],
      }, {
        title: "Duplicate",
        url: "https://example.com/amd-earnings",
        time_published: "20260809T101600",
      }],
    };
    const items = normalizeAlphaVantageFeed(payload, "AMD", "stocks");
    assert.equal(items.length, 1);
    assert.equal(items[0].category, "earnings");
    assert.equal(items[0].sentiment, "BULLISH");
    assert.equal(items[0].importance, "HIGH");
    assert.equal(items[0].relevanceScore, 0.94);

    const crypto = normalizeAlphaVantageFeed({ feed: [{
      title: "Bitcoin market update",
      url: "https://example.com/btc",
      time_published: "20260809T111500",
      topics: [{ topic: "Blockchain", relevance_score: "0.7" }],
      ticker_sentiment: [{ ticker: "CRYPTO:BTC", relevance_score: "0.8", ticker_sentiment_score: "-0.31", ticker_sentiment_label: "Bearish" }],
    }] }, "BTCUSDT", "crypto");
    assert.equal(crypto[0].category, "crypto");
    assert.equal(crypto[0].sentiment, "BEARISH");
  } finally {
    await server.close();
  }
});
