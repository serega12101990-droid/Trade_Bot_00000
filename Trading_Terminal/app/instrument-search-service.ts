import type { Market } from "./terminal-types";

export type InstrumentSuggestion = {
  symbol: string;
  displaySymbol: string;
  name: string;
  market: Market;
  price: number;
  changePct: number | null;
  currency: "USD" | "USDT" | "RUB" | "JPY" | "CHF" | "CAD";
  source: string;
};

type SearchCandidate = InstrumentSuggestion & { searchText?: string };

type MoexBlock = { columns?: string[]; data?: unknown[][] };

const CRYPTO_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  XRP: "XRP",
  TRX: "TRON",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  AVAX: "Avalanche",
  LINK: "Chainlink",
  DOT: "Polkadot",
  LTC: "Litecoin",
  BCH: "Bitcoin Cash",
  TON: "Toncoin",
  SUI: "Sui",
  UNI: "Uniswap",
  AAVE: "Aave",
  SHIB: "Shiba Inu",
  PEPE: "Pepe",
  NEAR: "NEAR Protocol",
  APT: "Aptos",
};

export type CatalogInstrument = {
  symbol: string;
  providerSymbol: string;
  displaySymbol: string;
  name: string;
  market: "forex" | "commodities";
  currency: InstrumentSuggestion["currency"];
  searchText: string;
};

export const FOREX_CATALOG: CatalogInstrument[] = [
  { symbol: "EURUSD", providerSymbol: "EURUSD=X", displaySymbol: "EUR/USD", name: "Евро / Доллар США", market: "forex", currency: "USD", searchText: "евро доллар euro dollar" },
  { symbol: "GBPUSD", providerSymbol: "GBPUSD=X", displaySymbol: "GBP/USD", name: "Фунт стерлингов / Доллар США", market: "forex", currency: "USD", searchText: "фунт доллар pound sterling" },
  { symbol: "USDJPY", providerSymbol: "USDJPY=X", displaySymbol: "USD/JPY", name: "Доллар США / Японская иена", market: "forex", currency: "JPY", searchText: "доллар иена yen" },
  { symbol: "USDCHF", providerSymbol: "USDCHF=X", displaySymbol: "USD/CHF", name: "Доллар США / Швейцарский франк", market: "forex", currency: "CHF", searchText: "доллар франк swiss franc" },
  { symbol: "AUDUSD", providerSymbol: "AUDUSD=X", displaySymbol: "AUD/USD", name: "Австралийский доллар / Доллар США", market: "forex", currency: "USD", searchText: "австралийский доллар aussie" },
  { symbol: "USDCAD", providerSymbol: "USDCAD=X", displaySymbol: "USD/CAD", name: "Доллар США / Канадский доллар", market: "forex", currency: "CAD", searchText: "доллар канадский canadian" },
];

export const COMMODITY_CATALOG: CatalogInstrument[] = [
  { symbol: "GC", providerSymbol: "GC=F", displaySymbol: "GC · Gold", name: "Золото · непрерывный фьючерс", market: "commodities", currency: "USD", searchText: "gold золото xau" },
  { symbol: "SI", providerSymbol: "SI=F", displaySymbol: "SI · Silver", name: "Серебро · непрерывный фьючерс", market: "commodities", currency: "USD", searchText: "silver серебро xag" },
  { symbol: "CL", providerSymbol: "CL=F", displaySymbol: "CL · WTI", name: "Нефть WTI · непрерывный фьючерс", market: "commodities", currency: "USD", searchText: "oil нефть crude wti" },
  { symbol: "BZ", providerSymbol: "BZ=F", displaySymbol: "BZ · Brent", name: "Нефть Brent · непрерывный фьючерс", market: "commodities", currency: "USD", searchText: "oil нефть brent" },
  { symbol: "NG", providerSymbol: "NG=F", displaySymbol: "NG · Natural Gas", name: "Природный газ · непрерывный фьючерс", market: "commodities", currency: "USD", searchText: "gas природный газ natural gas" },
  { symbol: "HG", providerSymbol: "HG=F", displaySymbol: "HG · Copper", name: "Медь · непрерывный фьючерс", market: "commodities", currency: "USD", searchText: "copper медь" },
];

export function catalogMatches(market: "forex" | "commodities", query: string, limit = 7) {
  const catalog = market === "forex" ? FOREX_CATALOG : COMMODITY_CATALOG;
  return catalog
    .map((candidate) => ({ candidate, rank: rankInstrument(query, candidate) }))
    .filter((item) => item.rank < 99)
    .sort((left, right) => left.rank - right.rank || left.candidate.symbol.localeCompare(right.candidate.symbol))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function comparable(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

export function rankInstrument(query: string, candidate: Pick<SearchCandidate, "symbol" | "displaySymbol" | "name" | "searchText">) {
  const needle = comparable(query);
  if (!needle) return 99;
  const symbol = comparable(candidate.symbol.replace(/USDT$/i, ""));
  const displaySymbol = comparable(candidate.displaySymbol);
  const name = comparable(`${candidate.name} ${candidate.searchText ?? ""}`);
  if (symbol === needle || displaySymbol === needle) return 0;
  if (symbol.startsWith(needle) || displaySymbol.startsWith(needle)) return 1;
  if (name.startsWith(needle)) return 2;
  if (symbol.includes(needle) || displaySymbol.includes(needle)) return 3;
  if (name.includes(needle)) return 4;
  return 99;
}

export function filterAndRank(query: string, candidates: SearchCandidate[], limit = 7) {
  return candidates
    .map((candidate) => ({ candidate, rank: rankInstrument(query, candidate) }))
    .filter((item) => item.rank < 99 && Number.isFinite(item.candidate.price))
    .sort((left, right) => left.rank - right.rank || left.candidate.symbol.localeCompare(right.candidate.symbol))
    .slice(0, limit)
    .map(({ candidate }) => {
      const { searchText: _searchText, ...suggestion } = candidate;
      return suggestion;
    });
}

export function blockRows(block: MoexBlock | undefined) {
  const columns = block?.columns ?? [];
  return (block?.data ?? []).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

export function parseMoexSuggestions(payload: Record<string, unknown>, query: string) {
  const securities = blockRows(payload.securities as MoexBlock | undefined);
  const quotes = new Map(blockRows(payload.marketdata as MoexBlock | undefined).map((row) => [String(row.SECID), row]));
  const candidates = securities.flatMap((security): SearchCandidate[] => {
    const symbol = String(security.SECID ?? "").toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) return [];
    const quote = quotes.get(symbol);
    const price = Number(quote?.LAST ?? quote?.MARKETPRICE ?? security.PREVPRICE);
    if (!Number.isFinite(price)) return [];
    const shortName = String(security.SHORTNAME ?? "").trim();
    const fullName = String(security.SECNAME ?? "").trim();
    return [{
      symbol,
      displaySymbol: symbol,
      name: shortName || fullName || symbol,
      searchText: fullName,
      market: "moex",
      price,
      changePct: Number.isFinite(Number(quote?.LASTTOPREVPRICE)) ? Number(quote?.LASTTOPREVPRICE) : null,
      currency: "RUB",
      source: "MOEX ISS",
    }];
  });
  return filterAndRank(query, candidates);
}

export function parseOkxSuggestions(payload: Record<string, unknown>, query: string) {
  if (payload.code !== "0" || !Array.isArray(payload.data)) return [];
  const candidates = payload.data.flatMap((raw): SearchCandidate[] => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, string>;
    const match = /^([A-Z0-9]+)-USDT-SWAP$/.exec(row.instId ?? "");
    if (!match) return [];
    const base = match[1];
    const price = Number(row.last);
    if (!Number.isFinite(price)) return [];
    const open = Number(row.open24h);
    const name = CRYPTO_NAMES[base] ?? `${base} / Tether`;
    return [{
      symbol: `${base}USDT`,
      displaySymbol: `${base}/USDT`,
      name,
      searchText: `${base} USDT Tether криптовалюта`,
      market: "crypto",
      price,
      changePct: Number.isFinite(open) && open ? ((price / open) - 1) * 100 : null,
      currency: "USDT",
      source: "OKX live",
    }];
  });
  return filterAndRank(query, candidates);
}

export function parseYahooCandidates(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.quotes)) return [];
  return payload.quotes.flatMap((raw): Array<{ symbol: string; name: string; price: number | null; changePct: number | null }> => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const symbol = String(row.symbol ?? "").toUpperCase();
    const quoteType = String(row.quoteType ?? "").toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || !["EQUITY", "ETF"].includes(quoteType)) return [];
    const price = Number(row.regularMarketPrice);
    const changePct = Number(row.regularMarketChangePercent);
    return [{
      symbol,
      name: String(row.longname ?? row.shortname ?? row.displayName ?? symbol).trim(),
      price: Number.isFinite(price) ? price : null,
      changePct: Number.isFinite(changePct) ? changePct : null,
    }];
  });
}

export function yahooSuggestion(candidate: { symbol: string; name: string; price: number | null; changePct: number | null }, quote?: { price: number; changePct: number | null }): InstrumentSuggestion | null {
  const price = quote?.price ?? candidate.price;
  if (price == null || !Number.isFinite(price)) return null;
  return {
    symbol: candidate.symbol,
    displaySymbol: candidate.symbol,
    name: candidate.name,
    market: "stocks",
    price,
    changePct: quote?.changePct ?? candidate.changePct,
    currency: "USD",
    source: "Yahoo live",
  };
}
