import type { Candle, Market, Timeframe } from "./terminal-types";

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "1w": 10080,
};

const BYBIT_INTERVAL: Record<number, string> = {
  1: "1", 5: "5", 15: "15", 30: "30", 60: "60", 240: "240", 1440: "D", 10080: "W",
};

const OKX_INTERVAL: Record<number, string> = {
  1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1H", 240: "4H", 1440: "1Dutc", 10080: "1Wutc",
};

const YAHOO_INTERVAL: Record<number, { interval: string; range: string; sourceMinutes: number }> = {
  1: { interval: "1m", range: "7d", sourceMinutes: 1 },
  5: { interval: "5m", range: "60d", sourceMinutes: 5 },
  15: { interval: "15m", range: "60d", sourceMinutes: 15 },
  30: { interval: "30m", range: "60d", sourceMinutes: 30 },
  60: { interval: "60m", range: "730d", sourceMinutes: 60 },
  240: { interval: "60m", range: "730d", sourceMinutes: 60 },
  1440: { interval: "1d", range: "5y", sourceMinutes: 1440 },
  10080: { interval: "1d", range: "5y", sourceMinutes: 1440 },
};

export const COMMODITY_YAHOO_SYMBOLS: Record<string, string> = {
  GC: "GC=F",
  SI: "SI=F",
  CL: "CL=F",
  BZ: "BZ=F",
  NG: "NG=F",
  HG: "HG=F",
};

export function yahooSymbolForMarket(symbol: string, market: Market) {
  if (market === "forex") return `${symbol.replace(/[^A-Z]/gi, "").toUpperCase()}=X`;
  if (market === "commodities") return COMMODITY_YAHOO_SYMBOLS[symbol.toUpperCase()] ?? symbol;
  if (market === "moex") return `${symbol.trim().toUpperCase()}.ME`;
  return symbol;
}

const MOEX_INTERVAL: Record<number, { interval: number; sourceMinutes: number; lookbackDays: number; maxPages: number }> = {
  1: { interval: 1, sourceMinutes: 1, lookbackDays: 10, maxPages: 20 },
  5: { interval: 1, sourceMinutes: 1, lookbackDays: 20, maxPages: 24 },
  15: { interval: 1, sourceMinutes: 1, lookbackDays: 30, maxPages: 30 },
  30: { interval: 10, sourceMinutes: 10, lookbackDays: 120, maxPages: 6 },
  60: { interval: 60, sourceMinutes: 60, lookbackDays: 365, maxPages: 2 },
  240: { interval: 60, sourceMinutes: 60, lookbackDays: 365, maxPages: 8 },
  1440: { interval: 24, sourceMinutes: 1440, lookbackDays: 1825, maxPages: 2 },
  10080: { interval: 7, sourceMinutes: 10080, lookbackDays: 3650, maxPages: 2 },
};

const memoryCache = new Map<string, { expires: number; payload: MarketDataResult }>();
const moexLotCache = new Map<string, { expires: number; lotSize: number }>();
const tradingViewMoexHistory = new Map<string, Candle[]>();
let moexIssUnavailableUntil = 0;

async function readJson(url: string, timeoutMs = 15_000) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Northstar-Trading-Terminal/0.3" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function postJson(url: string, body: unknown, timeoutMs = 15_000) {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "User-Agent": "Northstar-Trading-Terminal/0.3" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

function normalize(candles: Candle[], limit = 1000) {
  const byTime = new Map<number, Candle>();
  candles.forEach((candle) => {
    if ([candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
      byTime.set(candle.time, candle);
    }
  });
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

async function fetchBybit(symbol: string, minutes: number): Promise<Candle[]> {
  const params = new URLSearchParams({ category: "linear", symbol, interval: BYBIT_INTERVAL[minutes], limit: "1000" });
  const payload = await readJson(`https://api.bybit.com/v5/market/kline?${params}`);
  if (payload.retCode !== 0) throw new Error(String(payload.retMsg ?? "Bybit error"));
  const rows = (payload.result as { list?: unknown[] } | undefined)?.list ?? [];
  const now = Date.now();
  return normalize(rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const time = Number(row[0]);
    return [{ time, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closed: time + minutes * 60_000 <= now }];
  }));
}

async function fetchOkx(symbol: string, minutes: number): Promise<Candle[]> {
  const base = symbol.replace(/USDT$/i, "");
  const params = new URLSearchParams({ instId: `${base}-USDT-SWAP`, bar: OKX_INTERVAL[minutes], limit: "300" });
  const payload = await readJson(`https://www.okx.com/api/v5/market/candles?${params}`);
  if (payload.code !== "0") throw new Error(String(payload.msg ?? "OKX error"));
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return normalize(rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    return [{ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closed: String(row[8] ?? "0") === "1" }];
  }));
}

function resample(candles: Candle[], targetMinutes: number) {
  const bucketMs = targetMinutes * 60_000;
  const grouped = new Map<number, Candle[]>();
  candles.forEach((candle) => {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs;
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), candle]);
  });
  return normalize([...grouped.entries()].map(([time, rows]) => ({
    time,
    open: rows[0].open,
    high: Math.max(...rows.map((row) => row.high)),
    low: Math.min(...rows.map((row) => row.low)),
    close: rows.at(-1)?.close ?? rows[0].close,
    volume: rows.reduce((sum, row) => sum + row.volume, 0),
    closed: rows.every((row) => row.closed) && time + bucketMs <= Date.now(),
  })));
}

type IssBlock = { columns?: string[]; data?: unknown[][] };

function issRows(block: IssBlock | undefined) {
  const columns = block?.columns ?? [];
  return (block?.data ?? []).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

export function parseMoexLotSize(payload: Record<string, unknown>) {
  const row = issRows(payload.securities as IssBlock | undefined)[0];
  const lotSize = Number(row?.LOTSIZE ?? row?.lotsize);
  if (!Number.isInteger(lotSize) || lotSize <= 0) throw new Error("MOEX не вернула корректный размер лота");
  return lotSize;
}

export async function getMoexLotSize(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  const cached = moexLotCache.get(normalized);
  if (cached && cached.expires > Date.now()) return cached.lotSize;
  const params = new URLSearchParams({
    "iss.meta": "off",
    "iss.only": "securities",
    "securities.columns": "SECID,LOTSIZE",
  });
  const url = `https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${encodeURIComponent(normalized)}.json?${params}`;
  if (moexIssUnavailableUntil > Date.now()) return 1;
  try {
    const lotSize = parseMoexLotSize(await readJson(url, 5_000));
    moexLotCache.set(normalized, { expires: Date.now() + 24 * 60 * 60_000, lotSize });
    return lotSize;
  } catch {
    moexIssUnavailableUntil = Date.now() + 5 * 60_000;
    // Paper trading remains conservative and uses whole shares while ISS metadata
    // is unavailable. The real lot is restored automatically on the next ISS pass.
    return 1;
  }
}

function parseMoscowDateTime(value: unknown) {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(`${value.trim().replace(" ", "T")}+03:00`);
}

export function parseMoexCandlePage(payload: Record<string, unknown>) {
  const rows = issRows(payload.candles as IssBlock | undefined);
  const cursor = issRows(payload["candles.cursor"] as IssBlock | undefined)[0];
  const candles = rows.flatMap((row) => {
    const time = parseMoscowDateTime(row.begin);
    const end = parseMoscowDateTime(row.end);
    const candle = {
      time,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      closed: Number.isFinite(end) ? end <= Date.now() : true,
    };
    return [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ? [candle] : [];
  });
  return {
    candles,
    hasCursor: Boolean(cursor),
    total: Number(cursor?.TOTAL ?? cursor?.total ?? candles.length),
    pageSize: Number(cursor?.PAGESIZE ?? cursor?.pagesize ?? candles.length),
  };
}

export function moexPageStarts(total: number, pageSize: number, maxPages: number, hasCursor = true) {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const safeTotal = Math.max(0, Math.floor(total));
  const safeMaxPages = Math.max(1, Math.floor(maxPages));
  const pageCount = hasCursor
    ? Math.max(1, Math.min(safeMaxPages, Math.ceil(safeTotal / safePageSize)))
    : safeMaxPages;
  return Array.from({ length: pageCount }, (_, index) => index * safePageSize);
}

async function fetchMoex(symbol: string, minutes: number): Promise<Candle[]> {
  const config = MOEX_INTERVAL[minutes];
  const from = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const till = new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const fetchPage = async (start: number) => {
    const params = new URLSearchParams({
      from,
      till,
      interval: String(config.interval),
      start: String(start),
      limit: "500",
      "iss.meta": "off",
      "iss.only": "candles,candles.cursor",
      "iss.reverse": "true",
    });
    const url = `https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${encodeURIComponent(symbol)}/candles.json?${params}`;
    return parseMoexCandlePage(await readJson(url, 5_000));
  };

  const first = await fetchPage(0);
  if (!first.candles.length) throw new Error(`MOEX не вернула свечи для ${symbol}`);
  const collected = [...first.candles];
  const starts = moexPageStarts(first.total, first.pageSize || first.candles.length, config.maxPages, first.hasCursor).slice(1);
  for (let batchStart = 0; batchStart < starts.length; batchStart += 4) {
    const pages = await Promise.all(starts.slice(batchStart, batchStart + 4).map(fetchPage));
    pages.forEach((page) => collected.push(...page.candles));
    if (pages.some((page) => page.candles.length === 0)) break;
  }
  const normalized = normalize(collected, 20_000);
  return config.sourceMinutes === minutes ? normalized : resample(normalized, minutes);
}

async function fetchYahoo(symbol: string, minutes: number, market: Market): Promise<Candle[]> {
  const config = YAHOO_INTERVAL[minutes];
  const params = new URLSearchParams({ interval: config.interval, range: config.range, includePrePost: "false", events: "div,splits" });
  const providerSymbol = yahooSymbolForMarket(symbol, market);
  const payload = await readJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?${params}`);
  const chart = payload.chart as { error?: unknown; result?: unknown[] } | undefined;
  if (chart?.error) throw new Error("Yahoo chart error");
  const result = chart?.result?.[0] as { timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>> } } | undefined;
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote) throw new Error("Yahoo returned no candles");
  const now = Date.now();
  const candles = timestamps.flatMap((seconds, index) => {
    const prices = [quote.open?.[index], quote.high?.[index], quote.low?.[index], quote.close?.[index]];
    if (prices.some((value) => value == null || !Number.isFinite(Number(value)))) return [];
    const rawVolume = Number(quote.volume?.[index] ?? 0);
    const volume = Number.isFinite(rawVolume) && rawVolume >= 0 ? rawVolume : 0;
    const time = Number(seconds) * 1000;
    return [{ time, open: Number(prices[0]), high: Number(prices[1]), low: Number(prices[2]), close: Number(prices[3]), volume, closed: time + config.sourceMinutes * 60_000 <= now }];
  });
  const normalized = normalize(candles);
  return config.sourceMinutes === minutes ? normalized : resample(normalized, minutes);
}

export function parseTradingViewMoexMinute(payload: Record<string, unknown>, symbol: string): Candle | null {
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const row = rows.find((item) => item && typeof item === "object" && String((item as { s?: unknown }).s ?? "").toUpperCase() === `RUS:${symbol.toUpperCase()}`) as { d?: unknown[] } | undefined;
  const data = row?.d ?? [];
  const time = Number(data[0]) * 1000;
  const open = Number(data[1]);
  const high = Number(data[2]);
  const low = Number(data[3]);
  const close = Number(data[4]);
  const volume = Number(data[5] ?? 0);
  if (![time, open, high, low, close, volume].every(Number.isFinite) || time <= 0 || close <= 0) return null;
  return { time, open, high, low, close, volume: Math.max(0, volume), closed: time + 60_000 <= Date.now() };
}

async function fetchTradingViewMoexMinute(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  const payload = await postJson("https://scanner.tradingview.com/russia/scan", {
    symbols: { tickers: [`RUS:${normalized}`], query: { types: [] } },
    columns: ["time|1", "open|1", "high|1", "low|1", "close|1", "volume|1", "last_bar_update_time|1", "update_mode"],
  }, 8_000);
  const candle = parseTradingViewMoexMinute(payload, normalized);
  if (!candle) throw new Error(`TradingView не вернул минутную свечу для ${normalized}`);
  const history = normalize([...(tradingViewMoexHistory.get(normalized) ?? []), candle]);
  tradingViewMoexHistory.set(normalized, history);
  return history;
}

async function fetchLocalMoexHistory(symbol: string, minutes: number) {
  const timeframe = Object.entries(TIMEFRAME_MINUTES).find(([, value]) => value === minutes)?.[0] as Timeframe | undefined;
  if (!timeframe) throw new Error("Локальный источник не поддерживает этот таймфрейм");
  const params = new URLSearchParams({ symbol: symbol.trim().toUpperCase(), timeframe });
  const payload = await readJson(`http://127.0.0.1:3021/market-data?${params}`, 8_000) as unknown as { candles?: Candle[] };
  const candles = normalize(payload.candles ?? []);
  if (!candles.length) throw new Error(`Локальный источник не вернул историю для ${symbol}`);
  return candles;
}

async function fetchMoexResilient(symbol: string, minutes: number) {
  try {
    return { candles: await fetchLocalMoexHistory(symbol, minutes), source: "TradingView MOEX · история с задержкой 15 мин" };
  } catch {
    // The bridge is a local companion; fall through to public sources when the
    // terminal was started without the desktop launcher.
  }
  if (moexIssUnavailableUntil <= Date.now()) {
    try {
      return { candles: await fetchMoex(symbol, minutes), source: "MOEX ISS" };
    } catch {
      moexIssUnavailableUntil = Date.now() + 5 * 60_000;
    }
  }
  if (minutes === 1) {
    return { candles: await fetchTradingViewMoexMinute(symbol), source: "TradingView MOEX · задержка 15 мин" };
  }
  return { candles: await fetchYahoo(symbol, minutes, "moex"), source: "Yahoo MOEX fallback" };
}

export type MarketDataResult = {
  symbol: string;
  timeframe: Timeframe;
  source: string;
  fetchedAt: string;
  candles: Candle[];
};

export type ExecutionMarketDataResult = {
  symbol: string;
  resolutionMinutes: 1;
  source: string;
  fetchedAt: string;
  candles: Candle[];
};

export async function getExecutionMarketData(symbol: string, market: Market): Promise<ExecutionMarketDataResult> {
  const cacheKey = `${market}:${symbol}:execution:1`;
  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return { ...cached.payload, resolutionMinutes: 1 };
  }
  let candles: Candle[];
  let source: string;
  if (market === "crypto") {
    try {
      candles = await fetchBybit(symbol, 1);
      source = "Bybit 1m execution";
    } catch {
      candles = await fetchOkx(symbol, 1);
      source = "OKX 1m execution";
    }
  } else if (market === "moex") {
    const fallback = await fetchMoexResilient(symbol, 1);
    candles = fallback.candles;
    source = `${fallback.source} 1m execution`;
  } else {
    candles = await fetchYahoo(symbol, 1, market);
    source = market === "forex" ? "Yahoo FX 1m execution" : market === "commodities" ? "Yahoo Futures 1m execution" : "Yahoo 1m execution";
  }
  const payload: ExecutionMarketDataResult = { symbol, resolutionMinutes: 1, source, fetchedAt: new Date().toISOString(), candles };
  memoryCache.set(cacheKey, {
    expires: Date.now() + (market === "crypto" ? 20_000 : market === "moex" ? 45_000 : 60_000),
    payload: { symbol, timeframe: "15m", source, fetchedAt: payload.fetchedAt, candles },
  });
  return payload;
}

export async function getMarketData(symbol: string, market: Market, timeframe: Timeframe): Promise<MarketDataResult> {
  const minutes = TIMEFRAME_MINUTES[timeframe];
  const cacheKey = `${market}:${symbol}:${minutes}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.payload;

  let candles: Candle[];
  let source: string;
  if (market === "crypto") {
    try {
      candles = await fetchBybit(symbol, minutes);
      source = "Bybit live";
    } catch {
      candles = await fetchOkx(symbol, minutes);
      source = "OKX live";
    }
  } else if (market === "moex") {
    const fallback = await fetchMoexResilient(symbol, minutes);
    candles = fallback.candles;
    source = fallback.source;
  } else {
    candles = await fetchYahoo(symbol, minutes, market);
    source = market === "forex" ? "Yahoo FX · 24/5" : market === "commodities" ? "Yahoo Futures · 24/5" : "Yahoo live";
  }
  const payload = { symbol, timeframe, source, fetchedAt: new Date().toISOString(), candles };
  memoryCache.set(cacheKey, { expires: Date.now() + (market === "crypto" ? 20_000 : 120_000), payload });
  return payload;
}
