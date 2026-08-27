import http from "node:http";
import { fetchTradingViewHistory } from "./tradingview-history-client.mjs";

const PORT = Number(process.env.NORTHSTAR_MOEX_BRIDGE_PORT ?? 3021);
const cache = new Map();
const pending = new Map();
const TIMEFRAMES = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]);

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

async function history(symbol, timeframe) {
  const key = `${symbol}:${timeframe}`;
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.payload;
  if (pending.has(key)) return pending.get(key);
  const task = fetchTradingViewHistory(symbol, timeframe, 1000).then((candles) => {
    const payload = {
      symbol,
      timeframe,
      source: "TradingView MOEX · история с задержкой 15 мин",
      fetchedAt: new Date().toISOString(),
      candles,
    };
    cache.set(key, { expires: Date.now() + (timeframe === "1m" ? 30_000 : 120_000), payload });
    return payload;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return json(response, 204, {});
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/health") return json(response, 200, { ok: true, service: "northstar-moex-history" });
  if (url.pathname !== "/market-data" || request.method !== "GET") return json(response, 404, { error: "Not found" });
  const symbol = String(url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const timeframe = String(url.searchParams.get("timeframe") ?? "").trim();
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || !TIMEFRAMES.has(timeframe)) return json(response, 400, { error: "Invalid MOEX history request" });
  try {
    return json(response, 200, await history(symbol, timeframe));
  } catch (error) {
    return json(response, 502, { error: error instanceof Error ? error.message : "MOEX history unavailable" });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Northstar MOEX history bridge: http://127.0.0.1:${PORT}`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
