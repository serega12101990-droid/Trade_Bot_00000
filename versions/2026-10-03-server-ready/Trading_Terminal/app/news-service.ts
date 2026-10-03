import type {
  Market,
  MarketNewsItem,
  MarketNewsPayload,
  NewsCategory,
  NewsImportance,
  NewsSentiment,
} from "./terminal-types";

type D1 = D1Database;

type AlphaTopic = { topic?: string; relevance_score?: string };
type AlphaTickerSentiment = {
  ticker?: string;
  relevance_score?: string;
  ticker_sentiment_score?: string;
  ticker_sentiment_label?: string;
};
type AlphaArticle = {
  title?: string;
  url?: string;
  time_published?: string;
  summary?: string;
  source?: string;
  topics?: AlphaTopic[];
  overall_sentiment_score?: number;
  overall_sentiment_label?: string;
  ticker_sentiment?: AlphaTickerSentiment[];
};
type AlphaResponse = {
  feed?: AlphaArticle[];
  Note?: string;
  Information?: string;
  "Error Message"?: string;
};

type NewsRow = {
  id: string;
  symbol: string;
  market: Market;
  published_at: number;
  title: string;
  summary: string;
  url: string;
  source: string;
  category: NewsCategory;
  sentiment: NewsSentiment;
  sentiment_score: number;
  relevance_score: number;
  importance: NewsImportance;
  topics_json: string;
  provider: "alpha-vantage";
  fetched_at: number;
};

const CACHE_TTL_MS = 10 * 60_000;
const MAX_NEWS_AGE_MS = 180 * 24 * 60 * 60_000;
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS market_news (
  id TEXT PRIMARY KEY NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  sentiment_score REAL NOT NULL,
  relevance_score REAL NOT NULL,
  importance TEXT NOT NULL,
  topics_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
)`;

let schemaReady = false;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePublishedAt(value?: string) {
  if (!value) return 0;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function providerTicker(symbol: string, market: Market) {
  if (market === "forex") return `FOREX:${symbol.replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 3)}`;
  if (market !== "crypto") return symbol;
  const base = symbol.toUpperCase().replace(/[-_/]/g, "").replace(/USDT$|USDC$|USD$/, "");
  return `CRYPTO:${base}`;
}

function normalizeTopics(article: AlphaArticle) {
  return (article.topics ?? [])
    .filter((topic) => topic.topic)
    .sort((left, right) => numberValue(right.relevance_score) - numberValue(left.relevance_score))
    .map((topic) => String(topic.topic))
    .slice(0, 5);
}

function newsCategory(article: AlphaArticle, market: Market, topics: string[]): NewsCategory {
  const text = `${article.title ?? ""} ${article.summary ?? ""} ${topics.join(" ")}`.toLowerCase();
  if (/earnings|quarter|revenue|guidance|profit|eps|financial results/.test(text)) return "earnings";
  if (/merger|acquisition|takeover|buyout|mergers_and_acquisitions/.test(text)) return "mergers";
  if (/insider|form 4|director (bought|sold)|executive (bought|sold)/.test(text)) return "insider";
  if (/analyst|upgrade|downgrade|price target|rating/.test(text)) return "analyst";
  if (/economy_|inflation|interest rate|federal reserve|fed |cpi|payroll|tariff/.test(text)) return "macro";
  if (market === "crypto" || /blockchain|bitcoin|crypto|ethereum/.test(text)) return "crypto";
  return "company";
}

function sentimentFrom(score: number, label?: string): NewsSentiment {
  const normalized = (label ?? "").toLowerCase();
  if (normalized.includes("bullish") || score >= 0.15) return "BULLISH";
  if (normalized.includes("bearish") || score <= -0.15) return "BEARISH";
  return "NEUTRAL";
}

function importanceFrom(relevance: number, sentimentScore: number, category: NewsCategory): NewsImportance {
  const eventBoost = ["earnings", "mergers", "insider", "macro"].includes(category) ? 0.12 : 0;
  const score = relevance * 0.72 + Math.abs(sentimentScore) * 0.28 + eventBoost;
  if (score >= 0.72) return "HIGH";
  if (score >= 0.4) return "MEDIUM";
  return "LOW";
}

export function normalizeAlphaVantageFeed(
  payload: AlphaResponse,
  symbol: string,
  market: Market,
): MarketNewsItem[] {
  const providerSymbol = providerTicker(symbol, market);
  const normalizedSymbol = symbol.toUpperCase().replace("/", "");
  const seen = new Set<string>();
  return (payload.feed ?? []).flatMap((article) => {
    const title = (article.title ?? "").trim();
    const url = (article.url ?? "").trim();
    const publishedAt = parsePublishedAt(article.time_published);
    if (!title || !url || !publishedAt || seen.has(url)) return [];
    seen.add(url);
    const tickerMatch = (article.ticker_sentiment ?? []).find((item) => item.ticker?.toUpperCase() === providerSymbol);
    const relevance = clamp(numberValue(tickerMatch?.relevance_score, Math.max(0, ...(article.topics ?? []).map((item) => numberValue(item.relevance_score)))), 0, 1);
    const sentimentScore = clamp(numberValue(tickerMatch?.ticker_sentiment_score, article.overall_sentiment_score ?? 0), -1, 1);
    const topics = normalizeTopics(article);
    const category = newsCategory(article, market, topics);
    return [{
      id: `${normalizedSymbol}:${publishedAt}:${url}`,
      symbol: normalizedSymbol,
      market,
      publishedAt,
      title,
      summary: (article.summary ?? "").trim(),
      url,
      source: (article.source ?? "Источник не указан").trim(),
      category,
      sentiment: sentimentFrom(sentimentScore, tickerMatch?.ticker_sentiment_label ?? article.overall_sentiment_label),
      sentimentScore,
      relevanceScore: relevance,
      importance: importanceFrom(relevance, sentimentScore, category),
      topics,
      provider: "alpha-vantage" as const,
    }];
  }).sort((left, right) => right.publishedAt - left.publishedAt);
}

async function getBinding() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("Локальная база новостей DB недоступна. Перезапустите терминал.");
  return env.DB;
}

async function getApiKey() {
  const { env } = await import("cloudflare:workers");
  const runtimeKey = String((env as unknown as { ALPHA_VANTAGE_API_KEY?: string }).ALPHA_VANTAGE_API_KEY ?? "").trim();
  const processKey = typeof process !== "undefined" ? String(process.env.ALPHA_VANTAGE_API_KEY ?? "").trim() : "";
  const key = runtimeKey || processKey;
  return key && key !== "replace_with_your_key" ? key : "";
}

export async function ensureNewsSchema() {
  const db = await getBinding();
  if (schemaReady) return db;
  await db.batch([
    db.prepare(CREATE_TABLE),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_market_news_symbol_url ON market_news (symbol, url)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_market_news_symbol_published ON market_news (symbol, published_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_market_news_fetched ON market_news (symbol, fetched_at)"),
  ]);
  await db.prepare("PRAGMA optimize").run();
  schemaReady = true;
  return db;
}

function parseTopics(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mapRow(row: NewsRow): MarketNewsItem {
  return {
    id: row.id,
    symbol: row.symbol,
    market: row.market,
    publishedAt: row.published_at,
    title: row.title,
    summary: row.summary,
    url: row.url,
    source: row.source,
    category: row.category,
    sentiment: row.sentiment,
    sentimentScore: row.sentiment_score,
    relevanceScore: row.relevance_score,
    importance: row.importance,
    topics: parseTopics(row.topics_json),
    provider: row.provider,
  };
}

async function readCached(db: D1, symbol: string, limit: number) {
  const rows = await db.prepare("SELECT * FROM market_news WHERE symbol = ? ORDER BY published_at DESC LIMIT ?")
    .bind(symbol, limit).all<NewsRow>();
  return (rows.results ?? []).map(mapRow);
}

async function latestFetch(db: D1, symbol: string) {
  const row = await db.prepare("SELECT MAX(fetched_at) AS fetched_at FROM market_news WHERE symbol = ?")
    .bind(symbol).first<{ fetched_at: number | null }>();
  return Number(row?.fetched_at ?? 0);
}

async function saveNews(db: D1, items: MarketNewsItem[], fetchedAt: number) {
  if (!items.length) return;
  const statements = items.map((item) => db.prepare(`INSERT INTO market_news (
    id, symbol, market, published_at, title, summary, url, source, category, sentiment,
    sentiment_score, relevance_score, importance, topics_json, provider, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol, url) DO UPDATE SET
    published_at = excluded.published_at, title = excluded.title, summary = excluded.summary,
    source = excluded.source, category = excluded.category, sentiment = excluded.sentiment,
    sentiment_score = excluded.sentiment_score, relevance_score = excluded.relevance_score,
    importance = excluded.importance, topics_json = excluded.topics_json,
    provider = excluded.provider, fetched_at = excluded.fetched_at`)
    .bind(
      crypto.randomUUID(), item.symbol, item.market, item.publishedAt, item.title, item.summary,
      item.url, item.source, item.category, item.sentiment, item.sentimentScore,
      item.relevanceScore, item.importance, JSON.stringify(item.topics), item.provider, fetchedAt,
    ));
  await db.batch(statements);
  await db.prepare("DELETE FROM market_news WHERE symbol = ? AND published_at < ?")
    .bind(items[0].symbol, Date.now() - MAX_NEWS_AGE_MS).run();
}

async function fetchAlphaVantage(symbol: string, market: Market, apiKey: string) {
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "NEWS_SENTIMENT");
  url.searchParams.set("tickers", providerTicker(symbol, market));
  url.searchParams.set("sort", "LATEST");
  url.searchParams.set("limit", "100");
  url.searchParams.set("apikey", apiKey);
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Alpha Vantage ответил с кодом ${response.status}`);
  const payload = await response.json() as AlphaResponse;
  const providerError = payload["Error Message"] || payload.Note || payload.Information;
  if (providerError && !payload.feed?.length) throw new Error(providerError);
  return payload;
}

function buildPayload(
  symbol: string,
  market: Market,
  configured: boolean,
  cached: boolean,
  fetchedAt: number,
  items: MarketNewsItem[],
  message?: string,
): MarketNewsPayload {
  const counts = new Map<NewsCategory, number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return {
    symbol,
    market,
    configured,
    provider: "Alpha Vantage",
    cached,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    items,
    categories: Array.from(counts, ([id, count]) => ({ id, count })),
    message,
  };
}

export async function getMarketNews(symbol: string, market: Market, forceRefresh = false): Promise<MarketNewsPayload> {
  const normalizedSymbol = symbol.toUpperCase().replace("/", "");
  const db = await ensureNewsSchema();
  const apiKey = await getApiKey();
  const cachedAt = await latestFetch(db, normalizedSymbol);
  const cachedItems = await readCached(db, normalizedSymbol, 150);
  if (!apiKey) {
    return buildPayload(
      normalizedSymbol,
      market,
      false,
      cachedItems.length > 0,
      cachedAt,
      cachedItems,
      "Добавьте ALPHA_VANTAGE_API_KEY в файл .dev.vars и перезапустите терминал.",
    );
  }
  if (!forceRefresh && cachedItems.length && Date.now() - cachedAt < CACHE_TTL_MS) {
    return buildPayload(normalizedSymbol, market, true, true, cachedAt, cachedItems);
  }
  try {
    const fetchedAt = Date.now();
    const providerPayload = await fetchAlphaVantage(normalizedSymbol, market, apiKey);
    const freshItems = normalizeAlphaVantageFeed(providerPayload, normalizedSymbol, market);
    await saveNews(db, freshItems, fetchedAt);
    const items = await readCached(db, normalizedSymbol, 150);
    return buildPayload(normalizedSymbol, market, true, false, fetchedAt, items, freshItems.length ? undefined : "Новых публикаций по тикеру не найдено.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось получить новости";
    if (cachedItems.length) return buildPayload(normalizedSymbol, market, true, true, cachedAt, cachedItems, `Показан кэш: ${message}`);
    return buildPayload(normalizedSymbol, market, true, false, 0, [], message);
  }
}
