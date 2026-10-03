import { NextRequest, NextResponse } from "next/server";
import { catalogMatches, parseMoexSuggestions, parseOkxSuggestions, parseYahooCandidates, rankInstrument, yahooSuggestion } from "../../instrument-search-service";
import type { InstrumentSuggestion } from "../../instrument-search-service";
import type { Market } from "../../terminal-types";

type SearchCacheEntry = { expires: number; suggestions: InstrumentSuggestion[] };

const cache = new Map<string, SearchCacheEntry>();

async function readJson(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Northstar-Trading-Terminal/0.3" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function searchMoex(query: string) {
  const params = new URLSearchParams({
    "iss.meta": "off",
    "iss.only": "securities,marketdata",
    "securities.columns": "SECID,SHORTNAME,SECNAME,PREVPRICE",
    "marketdata.columns": "SECID,LAST,MARKETPRICE,LASTTOPREVPRICE",
  });
  const payload = await readJson(`https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json?${params}`);
  return parseMoexSuggestions(payload, query);
}

async function searchCrypto(query: string) {
  const payload = await readJson("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
  return parseOkxSuggestions(payload, query);
}

async function yahooChartQuote(symbol: string) {
  const params = new URLSearchParams({ interval: "1m", range: "1d", includePrePost: "true" });
  const payload = await readJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`);
  const chart = payload.chart as { result?: unknown[] } | undefined;
  const result = chart?.result?.[0] as {
    meta?: Record<string, number>;
    indicators?: { quote?: Array<Record<string, Array<number | null>>> };
  } | undefined;
  const meta = result?.meta ?? {};
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const price = Number(meta.regularMarketPrice ?? [...closes].reverse().find((value) => value != null));
  const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose);
  if (!Number.isFinite(price)) throw new Error("No price");
  return { price, changePct: Number.isFinite(previousClose) && previousClose ? ((price / previousClose) - 1) * 100 : null };
}

async function searchStocks(query: string) {
  const params = new URLSearchParams({
    q: query,
    quotesCount: "12",
    newsCount: "0",
    enableFuzzyQuery: "true",
    quotesQueryId: "tss_match_phrase_query",
  });
  const candidates = parseYahooCandidates(await readJson(`https://query1.finance.yahoo.com/v1/finance/search?${params}`))
    .sort((left, right) => rankInstrument(query, { ...left, displaySymbol: left.symbol }) - rankInstrument(query, { ...right, displaySymbol: right.symbol }))
    .slice(0, 7);
  const quotes = await Promise.allSettled(candidates.map((candidate) => candidate.price == null ? yahooChartQuote(candidate.symbol) : Promise.resolve(undefined)));
  return candidates.flatMap((candidate, index) => {
    const quoteResult = quotes[index];
    const liveQuote = quoteResult.status === "fulfilled" ? quoteResult.value : undefined;
    const suggestion = yahooSuggestion(candidate, liveQuote);
    return suggestion ? [suggestion] : [];
  });
}

async function searchCatalog(market: "forex" | "commodities", query: string) {
  const candidates = catalogMatches(market, query);
  const quotes = await Promise.allSettled(candidates.map((candidate) => yahooChartQuote(candidate.providerSymbol)));
  return candidates.flatMap((candidate, index): InstrumentSuggestion[] => {
    const result = quotes[index];
    if (result.status !== "fulfilled") return [];
    return [{
      symbol: candidate.symbol,
      displaySymbol: candidate.displaySymbol,
      name: candidate.name,
      market: candidate.market,
      price: result.value.price,
      changePct: result.value.changePct,
      currency: candidate.currency,
      source: market === "forex" ? "Yahoo FX · 24/5" : "Yahoo Futures · 24/5",
    }];
  });
}

export async function GET(request: NextRequest) {
  const market = request.nextUrl.searchParams.get("market") as Market | null;
  const query = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 60);
  if (!market || !["crypto", "stocks", "moex", "forex", "commodities"].includes(market)) {
    return NextResponse.json({ error: "Неизвестный рынок" }, { status: 400 });
  }
  if (!query) return NextResponse.json({ suggestions: [] }, { headers: { "Cache-Control": "no-store" } });

  const key = `${market}:${query.toLocaleLowerCase("ru-RU")}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json({ suggestions: cached.suggestions, cached: true }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const suggestions = market === "moex"
      ? await searchMoex(query)
      : market === "crypto"
        ? await searchCrypto(query)
        : market === "forex" || market === "commodities"
          ? await searchCatalog(market, query)
          : await searchStocks(query);
    cache.set(key, { suggestions, expires: Date.now() + (market === "crypto" ? 20_000 : 60_000) });
    return NextResponse.json({ suggestions, updatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: market === "moex" ? "MOEX сейчас недоступна. Проверьте системный VPN." : "Источник поиска временно недоступен" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
