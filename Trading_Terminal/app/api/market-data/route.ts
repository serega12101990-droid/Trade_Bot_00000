import { NextRequest, NextResponse } from "next/server";
import { getMarketData, TIMEFRAME_MINUTES } from "../../market-data-service";
import type { Market, Timeframe } from "../../terminal-types";

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function GET(request: NextRequest) {
  const symbol = (request.nextUrl.searchParams.get("symbol") ?? "").toUpperCase().replace("/", "");
  const market = request.nextUrl.searchParams.get("market") as Market | null;
  const timeframe = request.nextUrl.searchParams.get("timeframe") as Timeframe | null;
  if (!/^[A-Z0-9._-]{2,15}$/.test(symbol) || !market || !timeframe || !TIMEFRAME_MINUTES[timeframe] || !["crypto", "stocks", "moex", "forex", "commodities"].includes(market)) {
    return json({ error: "Некорректный тикер или таймфрейм" }, 400);
  }
  try {
    return json(await getMarketData(symbol, market, timeframe));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Источник данных недоступен" }, 502);
  }
}
