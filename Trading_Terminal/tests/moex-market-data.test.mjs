import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("MOEX ISS candles are converted from Moscow time into chart candles", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { moexPageStarts, parseMoexCandlePage, parseMoexLotSize, parseTradingViewMoexMinute, yahooSymbolForMarket } = await server.ssrLoadModule("/app/market-data-service.ts");
    const parsed = parseMoexCandlePage({
      candles: {
        columns: ["begin", "end", "open", "high", "low", "close", "volume"],
        data: [["2026-08-10 07:00:00", "2026-08-10 07:00:59", 100, 103, 99, 102, 1200]],
      },
      "candles.cursor": {
        columns: ["INDEX", "TOTAL", "PAGESIZE"],
        data: [[0, 750, 500]],
      },
    });
    assert.equal(parsed.candles.length, 1);
    assert.equal(new Date(parsed.candles[0].time).toISOString(), "2026-08-10T04:00:00.000Z");
    assert.deepEqual(
      { open: parsed.candles[0].open, high: parsed.candles[0].high, low: parsed.candles[0].low, close: parsed.candles[0].close, volume: parsed.candles[0].volume },
      { open: 100, high: 103, low: 99, close: 102, volume: 1200 },
    );
    assert.equal(parsed.total, 750);
    assert.equal(parsed.pageSize, 500);
    assert.equal(parsed.hasCursor, true);
    assert.deepEqual(moexPageStarts(750, 500, 30), [0, 500]);
    assert.equal(moexPageStarts(20_000, 500, 30).length, 30);
    assert.equal(moexPageStarts(20_000, 500, 30).at(-1), 14_500);
    assert.deepEqual(moexPageStarts(500, 500, 4, false), [0, 500, 1000, 1500]);

    const withoutCursor = parseMoexCandlePage({ candles: {
      columns: ["begin", "end", "open", "high", "low", "close", "volume"],
      data: [["2026-08-10 07:00:00", "2026-08-10 07:00:59", 100, 103, 99, 102, 1200]],
    } });
    assert.equal(withoutCursor.hasCursor, false);
    assert.equal(parseMoexLotSize({ securities: { columns: ["SECID", "LOTSIZE"], data: [["KMAZ", 10]] } }), 10);
    assert.equal(yahooSymbolForMarket("sberp", "moex"), "SBERP.ME");
    assert.deepEqual(parseTradingViewMoexMinute({ data: [{ s: "RUS:SBERP", d: [1787726280, 270.48, 270.5, 270.47, 270.5, 141] }] }, "SBERP"), {
      time: 1787726280000,
      open: 270.48,
      high: 270.5,
      low: 270.47,
      close: 270.5,
      volume: 141,
      closed: true,
    });
  } finally {
    await server.close();
  }
});
