import type { Asset, Market } from "./terminal-types";

export type WatchlistSort = "default" | "symbol-asc" | "change-desc" | "change-asc" | "price-desc" | "price-asc" | "market";

export type SavedWatchlistAsset = {
  symbol: string;
  displaySymbol: string;
  name: string;
  market: Market;
};

export const DEFAULT_EXPANSION_ASSETS: SavedWatchlistAsset[] = [
  { symbol: "EURUSD", displaySymbol: "EUR/USD", name: "Евро / Доллар США", market: "forex" },
  { symbol: "GBPUSD", displaySymbol: "GBP/USD", name: "Фунт стерлингов / Доллар США", market: "forex" },
  { symbol: "USDJPY", displaySymbol: "USD/JPY", name: "Доллар США / Японская иена", market: "forex" },
  { symbol: "USDCHF", displaySymbol: "USD/CHF", name: "Доллар США / Швейцарский франк", market: "forex" },
  { symbol: "AUDUSD", displaySymbol: "AUD/USD", name: "Австралийский доллар / Доллар США", market: "forex" },
  { symbol: "USDCAD", displaySymbol: "USD/CAD", name: "Доллар США / Канадский доллар", market: "forex" },
  { symbol: "GC", displaySymbol: "GC · Gold", name: "Золото · непрерывный фьючерс", market: "commodities" },
  { symbol: "SI", displaySymbol: "SI · Silver", name: "Серебро · непрерывный фьючерс", market: "commodities" },
  { symbol: "CL", displaySymbol: "CL · WTI", name: "Нефть WTI · непрерывный фьючерс", market: "commodities" },
  { symbol: "BZ", displaySymbol: "BZ · Brent", name: "Нефть Brent · непрерывный фьючерс", market: "commodities" },
  { symbol: "NG", displaySymbol: "NG · Natural Gas", name: "Природный газ · непрерывный фьючерс", market: "commodities" },
  { symbol: "HG", displaySymbol: "HG · Copper", name: "Медь · непрерывный фьючерс", market: "commodities" },
];

export function defaultExpansionAssets(): Asset[] {
  return DEFAULT_EXPANSION_ASSETS.map((asset) => ({
    ...asset,
    quote: { price: null, changePct: null, high: null, low: null },
    data: {},
    signal: null,
  }));
}

export function normalizeUserTicker(raw: string, market: Market) {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, "").replace("/", "");
  if (market === "crypto") {
    const base = compact.replace(/[-_.]?USDT$/, "");
    if (!/^[A-Z0-9]{2,12}$/.test(base)) throw new Error("Введите тикер криптовалюты, например ADA или ADA/USDT");
    return {
      symbol: `${base}USDT`,
      displaySymbol: `${base}/USDT`,
      fallbackName: base,
    };
  }
  if (market === "forex") {
    const pair = compact.replace(/[-_.]/g, "");
    if (!/^[A-Z]{6}$/.test(pair)) throw new Error("Введите валютную пару, например EUR/USD или USDJPY");
    return {
      symbol: pair,
      displaySymbol: `${pair.slice(0, 3)}/${pair.slice(3)}`,
      fallbackName: `${pair.slice(0, 3)} / ${pair.slice(3)}`,
    };
  }
  if (market === "commodities") {
    const aliases: Record<string, { symbol: string; displaySymbol: string; name: string }> = {
      GOLD: { symbol: "GC", displaySymbol: "GC · Gold", name: "Золото · непрерывный фьючерс" },
      XAU: { symbol: "GC", displaySymbol: "GC · Gold", name: "Золото · непрерывный фьючерс" },
      GC: { symbol: "GC", displaySymbol: "GC · Gold", name: "Золото · непрерывный фьючерс" },
      SILVER: { symbol: "SI", displaySymbol: "SI · Silver", name: "Серебро · непрерывный фьючерс" },
      XAG: { symbol: "SI", displaySymbol: "SI · Silver", name: "Серебро · непрерывный фьючерс" },
      SI: { symbol: "SI", displaySymbol: "SI · Silver", name: "Серебро · непрерывный фьючерс" },
      WTI: { symbol: "CL", displaySymbol: "CL · WTI", name: "Нефть WTI · непрерывный фьючерс" },
      CL: { symbol: "CL", displaySymbol: "CL · WTI", name: "Нефть WTI · непрерывный фьючерс" },
      BRENT: { symbol: "BZ", displaySymbol: "BZ · Brent", name: "Нефть Brent · непрерывный фьючерс" },
      BZ: { symbol: "BZ", displaySymbol: "BZ · Brent", name: "Нефть Brent · непрерывный фьючерс" },
      GAS: { symbol: "NG", displaySymbol: "NG · Natural Gas", name: "Природный газ · непрерывный фьючерс" },
      NATGAS: { symbol: "NG", displaySymbol: "NG · Natural Gas", name: "Природный газ · непрерывный фьючерс" },
      NG: { symbol: "NG", displaySymbol: "NG · Natural Gas", name: "Природный газ · непрерывный фьючерс" },
      COPPER: { symbol: "HG", displaySymbol: "HG · Copper", name: "Медь · непрерывный фьючерс" },
      HG: { symbol: "HG", displaySymbol: "HG · Copper", name: "Медь · непрерывный фьючерс" },
    };
    const matched = aliases[compact];
    if (!matched) throw new Error("Доступны: Gold, Silver, WTI, Brent, Natural Gas и Copper");
    return { symbol: matched.symbol, displaySymbol: matched.displaySymbol, fallbackName: matched.name };
  }
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(compact)) {
    throw new Error(market === "moex" ? "Введите тикер MOEX, например SBER или GAZP" : "Введите биржевой тикер, например AAPL или BRK.B");
  }
  return { symbol: compact, displaySymbol: compact, fallbackName: compact };
}

export function savedAssetToAsset(saved: SavedWatchlistAsset): Asset {
  return {
    ...saved,
    userAdded: true,
    quote: { price: null, changePct: null, high: null, low: null },
    data: {},
    signal: null,
  };
}

function compareNullableNumbers(left: number | null, right: number | null, direction: "asc" | "desc") {
  const leftValid = typeof left === "number" && Number.isFinite(left);
  const rightValid = typeof right === "number" && Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return direction === "asc" ? left - right : right - left;
}

export function sortWatchlistAssets(assets: Asset[], sort: WatchlistSort) {
  const copy = [...assets];
  if (sort === "symbol-asc") return copy.sort((left, right) => left.symbol.localeCompare(right.symbol));
  if (sort === "change-desc") return copy.sort((left, right) => compareNullableNumbers(left.quote.changePct, right.quote.changePct, "desc"));
  if (sort === "change-asc") return copy.sort((left, right) => compareNullableNumbers(left.quote.changePct, right.quote.changePct, "asc"));
  if (sort === "price-desc") return copy.sort((left, right) => compareNullableNumbers(left.quote.price, right.quote.price, "desc"));
  if (sort === "price-asc") return copy.sort((left, right) => compareNullableNumbers(left.quote.price, right.quote.price, "asc"));
  if (sort === "market") return copy.sort((left, right) => left.market.localeCompare(right.market) || left.symbol.localeCompare(right.symbol));
  return copy;
}
