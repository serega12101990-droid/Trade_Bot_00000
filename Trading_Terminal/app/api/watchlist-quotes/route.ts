import { NextRequest, NextResponse } from "next/server";

type Quote = {
  symbol: string;
  market: "crypto" | "stocks" | "moex" | "forex" | "commodities";
  price: number;
  changePct: number;
  high?: number;
  low?: number;
  updatedAt?: number;
  source: string;
};

const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "TRXUSDT", "XRPUSDT"];
const STOCKS = [
  "AMZN", "TSLA", "NFLX", "AMD", "CVNA", "HOOD", "COIN", "SMCI", "PANW", "COHR",
  "BSX", "CMG", "LULU", "DASH", "LITE", "CRWD", "APP", "UBER", "NBIS", "SNDK",
];
const FOREX = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD"];
const COMMODITIES = ["GC", "SI", "CL", "BZ", "NG", "HG"];
const COMMODITY_YAHOO_SYMBOLS: Record<string, string> = { GC: "GC=F", SI: "SI=F", CL: "CL=F", BZ: "BZ=F", NG: "NG=F", HG: "HG=F" };

let cryptoCache: { key: string; expires: number; quotes: Quote[] } | null = null;
let stockCache: { key: string; expires: number; quotes: Quote[] } | null = null;
let moexCache: { key: string; expires: number; quotes: Quote[] } | null = null;
let moexFallbackCache: { key: string; expires: number; quotes: Quote[] } | null = null;
let forexCache: { key: string; expires: number; quotes: Quote[] } | null = null;
let commodityCache: { key: string; expires: number; quotes: Quote[] } | null = null;
let moexIssUnavailableUntil = 0;

function requestedSymbols(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("symbols");
  if (!raw) return { crypto: CRYPTO, stocks: STOCKS, moex: [] as string[], forex: FOREX, commodities: COMMODITIES };
  const crypto = new Set<string>();
  const stocks = new Set<string>();
  const moex = new Set<string>();
  const forex = new Set<string>();
  const commodities = new Set<string>();
  raw.split(",").slice(0, 160).forEach((item) => {
    const [market, rawSymbol] = item.split(":");
    const symbol = (rawSymbol ?? "").toUpperCase().replace("/", "");
    if (market === "crypto" && /^[A-Z0-9]{2,12}USDT$/.test(symbol)) crypto.add(symbol);
    if (market === "stocks" && /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) stocks.add(symbol);
    if (market === "moex" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) moex.add(symbol);
    if (market === "forex" && /^[A-Z]{6}$/.test(symbol)) forex.add(symbol);
    if (market === "commodities" && symbol in COMMODITY_YAHOO_SYMBOLS) commodities.add(symbol);
  });
  return { crypto: [...crypto], stocks: [...stocks], moex: [...moex], forex: [...forex], commodities: [...commodities] };
}

async function readJson(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Northstar-Trading-Terminal/0.2" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "User-Agent": "Northstar-Trading-Terminal/0.3" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function fetchCryptoQuotes(symbols: string[]) {
  const key = [...symbols].sort().join(",");
  if (cryptoCache && cryptoCache.key === key && cryptoCache.expires > Date.now()) return cryptoCache.quotes;
  const payload = await readJson("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
  if (payload.code !== "0" || !Array.isArray(payload.data)) throw new Error("OKX quotes unavailable");
  const wanted = new Set(symbols.map((symbol) => `${symbol.replace(/USDT$/, "")}-USDT-SWAP`));
  const quotes = payload.data.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, string>;
    if (!wanted.has(row.instId)) return [];
    const price = Number(row.last);
    const open = Number(row.open24h);
    if (!Number.isFinite(price)) return [];
    return [{
      symbol: row.instId.replace("-USDT-SWAP", "USDT"),
      market: "crypto",
      price,
      changePct: Number.isFinite(open) && open ? ((price / open) - 1) * 100 : 0,
      high: Number(row.high24h),
      low: Number(row.low24h),
      updatedAt: Number(row.ts),
      source: "OKX live",
    } satisfies Quote];
  });
  cryptoCache = { key, expires: Date.now() + 20_000, quotes };
  return quotes;
}

async function fetchYahooQuote(symbol: string, market: "stocks" | "moex" | "forex" | "commodities"): Promise<Quote> {
  const params = new URLSearchParams({
    interval: "1m",
    range: "1d",
    includePrePost: "false",
    events: "div,splits",
  });
  const providerSymbol = market === "forex" ? `${symbol}=X` : market === "commodities" ? COMMODITY_YAHOO_SYMBOLS[symbol] : market === "moex" ? `${symbol}.ME` : symbol;
  const payload = await readJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?${params}`);
  const chart = payload.chart as { error?: unknown; result?: unknown[] } | undefined;
  if (chart?.error) throw new Error(`Yahoo ${symbol} error`);
  const result = chart?.result?.[0] as {
    meta?: Record<string, number>;
    timestamp?: number[];
    indicators?: { quote?: Array<Record<string, Array<number | null>>> };
  } | undefined;
  const meta = result?.meta ?? {};
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const price = Number(meta.regularMarketPrice ?? [...closes].reverse().find((value) => value != null));
  const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose);
  if (!Number.isFinite(price)) throw new Error(`Yahoo ${symbol} returned no price`);
  return {
    symbol,
    market,
    price,
    changePct: Number.isFinite(previousClose) && previousClose ? ((price / previousClose) - 1) * 100 : 0,
    high: Number(meta.regularMarketDayHigh),
    low: Number(meta.regularMarketDayLow),
    updatedAt: Number(meta.regularMarketTime) * 1000,
    source: market === "forex" ? "Yahoo FX · 24/5" : market === "commodities" ? "Yahoo Futures · 24/5" : market === "moex" ? "Yahoo MOEX fallback" : "Yahoo live",
  };
}

async function fetchYahooQuotes(symbols: string[], market: "stocks" | "moex" | "forex" | "commodities") {
  const key = [...symbols].sort().join(",");
  const activeCache = market === "stocks" ? stockCache : market === "moex" ? moexFallbackCache : market === "forex" ? forexCache : commodityCache;
  if (activeCache && activeCache.key === key && activeCache.expires > Date.now()) return activeCache.quotes;
  const quotes: Quote[] = [];
  for (let start = 0; start < symbols.length; start += 4) {
    const batch = await Promise.allSettled(symbols.slice(start, start + 4).map((symbol) => fetchYahooQuote(symbol, market)));
    batch.forEach((result) => {
      if (result.status === "fulfilled") quotes.push(result.value);
    });
  }
  if (!quotes.length) throw new Error("Yahoo quotes unavailable");
  const nextCache = { key, expires: Date.now() + 120_000, quotes };
  if (market === "stocks") stockCache = nextCache;
  else if (market === "moex") moexFallbackCache = nextCache;
  else if (market === "forex") forexCache = nextCache;
  else commodityCache = nextCache;
  return quotes;
}

function moexBlockRows(block: { columns?: string[]; data?: unknown[][] } | undefined) {
  const columns = block?.columns ?? [];
  return (block?.data ?? []).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

async function fetchMoexQuotes(symbols: string[]) {
  const key = [...symbols].sort().join(",");
  if (moexCache && moexCache.key === key && moexCache.expires > Date.now()) return moexCache.quotes;
  const params = new URLSearchParams({
    "iss.meta": "off",
    "iss.only": "securities,marketdata",
    "securities.columns": "SECID,PREVPRICE",
    "marketdata.columns": "SECID,LAST,MARKETPRICE,LCURRENTPRICE,LASTTOPREVPRICE,OPEN,HIGH,LOW,SYSTIME,UPDATETIME",
    limit: "500",
  });
  const payload = await readJson(`https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json?${params}`);
  const wanted = new Set(symbols);
  const securities = new Map(moexBlockRows(payload.securities as { columns?: string[]; data?: unknown[][] } | undefined).map((row) => [String(row.SECID), row]));
  const quotes = moexBlockRows(payload.marketdata as { columns?: string[]; data?: unknown[][] } | undefined).flatMap((row): Quote[] => {
    const symbol = String(row.SECID ?? "");
    if (!wanted.has(symbol)) return [];
    const security = securities.get(symbol);
    const previousClose = Number(security?.PREVPRICE);
    const price = Number(row.LAST ?? row.MARKETPRICE ?? row.LCURRENTPRICE ?? security?.PREVPRICE);
    if (!Number.isFinite(price)) return [];
    const directChange = Number(row.LASTTOPREVPRICE);
    const updated = typeof row.SYSTIME === "string" ? Date.parse(`${row.SYSTIME.replace(" ", "T")}+03:00`) : Number.NaN;
    return [{
      symbol,
      market: "moex",
      price,
      changePct: Number.isFinite(directChange) ? directChange : Number.isFinite(previousClose) && previousClose ? ((price / previousClose) - 1) * 100 : 0,
      high: Number(row.HIGH),
      low: Number(row.LOW),
      updatedAt: Number.isFinite(updated) ? updated : undefined,
      source: "MOEX ISS",
    }];
  });
  if (!quotes.length) throw new Error("MOEX quotes unavailable");
  moexCache = { key, expires: Date.now() + 120_000, quotes };
  return quotes;
}

export function parseTradingViewMoexQuotes(payload: Record<string, unknown>, symbols: string[]) {
  const wanted = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  return (Array.isArray(payload.data) ? payload.data : []).flatMap((raw): Quote[] => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as { s?: unknown; d?: unknown[] };
    const symbol = String(row.s ?? "").replace(/^RUS:/i, "").toUpperCase();
    if (!wanted.has(symbol)) return [];
    const data = row.d ?? [];
    const price = Number(data[0]);
    if (!Number.isFinite(price) || price <= 0) return [];
    const changePct = Number(data[1]);
    const high = Number(data[2]);
    const low = Number(data[3]);
    const updatedAt = Number(data[4]) * 1000;
    return [{
      symbol,
      market: "moex",
      price,
      changePct: Number.isFinite(changePct) ? changePct : 0,
      high: Number.isFinite(high) ? high : undefined,
      low: Number.isFinite(low) ? low : undefined,
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : undefined,
      source: "TradingView MOEX · задержка 15 мин",
    }];
  });
}

async function fetchTradingViewMoexQuotes(symbols: string[]) {
  const key = [...symbols].sort().join(",");
  if (moexFallbackCache && moexFallbackCache.key === key && moexFallbackCache.expires > Date.now()) return moexFallbackCache.quotes;
  const payload = await postJson("https://scanner.tradingview.com/russia/scan", {
    symbols: { tickers: symbols.map((symbol) => `RUS:${symbol}`), query: { types: [] } },
    columns: ["close", "change", "high", "low", "last_bar_update_time", "update_mode"],
  });
  const quotes = parseTradingViewMoexQuotes(payload, symbols);
  if (!quotes.length) throw new Error("TradingView MOEX quotes unavailable");
  moexFallbackCache = { key, expires: Date.now() + 45_000, quotes };
  return quotes;
}

async function fetchMoexQuotesWithFallback(symbols: string[]) {
  if (moexIssUnavailableUntil <= Date.now()) {
    try {
      return await fetchMoexQuotes(symbols);
    } catch {
      moexIssUnavailableUntil = Date.now() + 5 * 60_000;
    }
  }
  return fetchTradingViewMoexQuotes(symbols);
}

export async function GET(request: NextRequest) {
  const symbols = requestedSymbols(request);
  const results = await Promise.allSettled([
    symbols.crypto.length ? fetchCryptoQuotes(symbols.crypto) : Promise.resolve([]),
    symbols.stocks.length ? fetchYahooQuotes(symbols.stocks, "stocks") : Promise.resolve([]),
    symbols.moex.length ? fetchMoexQuotesWithFallback(symbols.moex) : Promise.resolve([]),
    symbols.forex.length ? fetchYahooQuotes(symbols.forex, "forex") : Promise.resolve([]),
    symbols.commodities.length ? fetchYahooQuotes(symbols.commodities, "commodities") : Promise.resolve([]),
  ]);
  const quotes = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!quotes.length) {
    return NextResponse.json(
      { error: "Источники котировок временно недоступны" },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
  return NextResponse.json(
    { updatedAt: new Date().toISOString(), quotes },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
