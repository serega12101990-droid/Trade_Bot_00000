import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function loadSearch() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const loaded = await server.ssrLoadModule("/app/instrument-search-service.ts");
  return { server, ...loaded };
}

test("instrument search ranks exact tickers before partial name matches", async () => {
  const { server, filterAndRank } = await loadSearch();
  try {
    const results = filterAndRank("sber", [
      { symbol: "SBERP", displaySymbol: "SBERP", name: "Сбербанк-п", market: "moex", price: 300, changePct: 0, currency: "RUB", source: "test" },
      { symbol: "SBER", displaySymbol: "SBER", name: "Сбербанк", market: "moex", price: 310, changePct: 0, currency: "RUB", source: "test" },
      { symbol: "OTHER", displaySymbol: "OTHER", name: "Sber example", market: "moex", price: 1, changePct: 0, currency: "RUB", source: "test" },
    ]);
    assert.deepEqual(results.map((item) => item.symbol), ["SBER", "SBERP", "OTHER"]);
  } finally {
    await server.close();
  }
});

test("MOEX search matches a Cyrillic company name and keeps its live price", async () => {
  const { server, parseMoexSuggestions } = await loadSearch();
  try {
    const payload = {
      securities: { columns: ["SECID", "SHORTNAME", "SECNAME", "PREVPRICE"], data: [["SBER", "Сбербанк", "Сбербанк России", 305]] },
      marketdata: { columns: ["SECID", "LAST", "MARKETPRICE", "LASTTOPREVPRICE"], data: [["SBER", 310.5, 309, 1.25]] },
    };
    assert.deepEqual(parseMoexSuggestions(payload, "сбер")[0], {
      symbol: "SBER", displaySymbol: "SBER", name: "Сбербанк", market: "moex", price: 310.5,
      changePct: 1.25, currency: "RUB", source: "MOEX ISS",
    });
  } finally {
    await server.close();
  }
});

test("OKX search recognizes a cryptocurrency by its full name", async () => {
  const { server, parseOkxSuggestions } = await loadSearch();
  try {
    const payload = { code: "0", data: [{ instId: "BTC-USDT-SWAP", last: "64000", open24h: "62000" }] };
    const result = parseOkxSuggestions(payload, "bitcoin")[0];
    assert.equal(result.symbol, "BTCUSDT");
    assert.equal(result.price, 64000);
  } finally {
    await server.close();
  }
});

test("new market catalogs search forex and commodities by ticker and Russian name", async () => {
  const { server, catalogMatches } = await loadSearch();
  try {
    assert.equal(catalogMatches("forex", "EUR/USD")[0].providerSymbol, "EURUSD=X");
    assert.equal(catalogMatches("commodities", "золото")[0].symbol, "GC");
    assert.equal(catalogMatches("commodities", "нефть").length, 2);
  } finally {
    await server.close();
  }
});
