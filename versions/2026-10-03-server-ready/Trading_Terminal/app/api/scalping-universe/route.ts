import { NextResponse } from "next/server";

type UniverseRow = {
  symbol: string;
  turnover24h: number;
  price24hPct: number;
  openInterestValue: number;
  score: number;
};

let cache: { expiresAt: number; rows: UniverseRow[] } | null = null;

export async function GET() {
  try {
    if (cache && cache.expiresAt > Date.now()) {
      return NextResponse.json({ updatedAt: Date.now(), instruments: cache.rows }, { headers: { "Cache-Control": "no-store" } });
    }
    let providerRows: Array<Record<string, string>> = [];
    try {
      const response = await fetch("https://api.bybit.com/v5/market/tickers?category=linear", {
        cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "Northstar-Trading-Terminal/0.4" },
      });
      if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
      const payload = await response.json() as { retCode?: number; result?: { list?: Array<Record<string, string>> } };
      if (payload.retCode !== 0 || !Array.isArray(payload.result?.list)) throw new Error("Bybit returned no linear tickers");
      providerRows = payload.result.list;
    } catch {
      const response = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP", {
        cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "Northstar-Trading-Terminal/0.4" },
      });
      if (!response.ok) throw new Error(`OKX HTTP ${response.status}`);
      const payload = await response.json() as { code?: string; data?: Array<Record<string, string>> };
      if (payload.code !== "0" || !Array.isArray(payload.data)) throw new Error("Scalping universe unavailable");
      providerRows = payload.data.flatMap((row) => {
        if (!String(row.instId ?? "").endsWith("-USDT-SWAP")) return [];
        const last = Number(row.last);
        const open = Number(row.open24h);
        return [{
          symbol: String(row.instId).replace("-USDT-SWAP", "USDT"),
          turnover24h: String(Number(row.volCcy24h) * (Number.isFinite(last) ? last : 0)),
          price24hPcnt: Number.isFinite(last) && Number.isFinite(open) && open > 0 ? String(last / open - 1) : "0",
          openInterestValue: row.oiUsd ?? "0",
        }];
      });
    }
    const rows = providerRows.flatMap((row): UniverseRow[] => {
      const symbol = String(row.symbol ?? "");
      const turnover24h = Number(row.turnover24h);
      const price24hPct = Number(row.price24hPcnt) * 100;
      const openInterestValue = Number(row.openInterestValue);
      if (!/^[A-Z0-9]{2,16}USDT$/.test(symbol) || !Number.isFinite(turnover24h) || !Number.isFinite(price24hPct) || turnover24h < 100_000_000) return [];
      return [{
        symbol,
        turnover24h,
        price24hPct,
        openInterestValue: Number.isFinite(openInterestValue) ? openInterestValue : 0,
        score: Math.abs(price24hPct) * Math.log10(Math.max(turnover24h, 1)),
      }];
    }).sort((left, right) => right.score - left.score).slice(0, 8);
    cache = { expiresAt: Date.now() + 60_000, rows };
    return NextResponse.json({ updatedAt: Date.now(), instruments: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Сканер Bybit недоступен" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
