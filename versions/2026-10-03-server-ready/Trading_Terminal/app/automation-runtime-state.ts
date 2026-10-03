import type { Market, SignalIdea, Timeframe } from "./terminal-types";

export type AutomationAsset = {
  symbol: string;
  market: Market;
  displaySymbol?: string;
  name?: string;
  signal?: SignalIdea | null;
};

export type AutomationRunSummary = {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  trigger: "LOCAL_DAEMON" | "MANUAL";
  timeframe: Timeframe;
  startedAt: number;
  finishedAt?: number;
  total: number;
  completed: number;
  created: number;
  existing: number;
  failed: number;
  ready: number;
  waiting: number;
  noTrade: number;
  errors?: Array<{ symbol: string; message: string }>;
};

const MARKETS: Market[] = ["crypto", "stocks", "moex", "forex", "commodities"];
let watchlist: AutomationAsset[] = [];
let lastHeartbeatAt: number | null = null;
let lastRun: AutomationRunSummary | null = null;

export function normalizeAutomationAsset(value: unknown): AutomationAsset | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AutomationAsset>;
  const market = String(candidate.market ?? "") as Market;
  const symbol = String(candidate.symbol ?? "").trim().toUpperCase().replace("/", "");
  if (!MARKETS.includes(market) || !/^[A-Z0-9._-]{2,15}$/.test(symbol)) return null;
  return {
    symbol,
    market,
    displaySymbol: String(candidate.displaySymbol ?? symbol).slice(0, 30),
    name: String(candidate.name ?? symbol).slice(0, 80),
    signal: candidate.signal && typeof candidate.signal === "object" ? candidate.signal : null,
  };
}

export function replaceAutomationWatchlist(values: unknown[]) {
  const unique = new Map<string, AutomationAsset>();
  values.slice(0, 200).forEach((value) => {
    const asset = normalizeAutomationAsset(value);
    if (asset) unique.set(`${asset.market}:${asset.symbol}`, asset);
  });
  watchlist = [...unique.values()];
  return watchlist.length;
}

export function readAutomationRuntimeState() {
  return {
    active: lastHeartbeatAt != null && Date.now() - lastHeartbeatAt < 3 * 60_000,
    watchlist: watchlist.map((asset) => ({ ...asset })),
    watchlistCount: watchlist.length,
    lastHeartbeatAt,
    lastRun,
  };
}

export function recordAutomationHeartbeat(at = Date.now()) {
  lastHeartbeatAt = at;
}

export function recordAutomationRun(summary: AutomationRunSummary) {
  lastHeartbeatAt = Date.now();
  lastRun = summary;
}
