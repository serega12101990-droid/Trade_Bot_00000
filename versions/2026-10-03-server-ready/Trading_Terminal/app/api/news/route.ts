import { NextRequest, NextResponse } from "next/server";
import { getMarketNews } from "../../news-service";
import type { Market } from "../../terminal-types";

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(request: NextRequest) {
  const symbol = (request.nextUrl.searchParams.get("symbol") ?? "").toUpperCase().replace("/", "");
  const market = request.nextUrl.searchParams.get("market") as Market | null;
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";
  if (!/^[A-Z0-9._-]{2,15}$/.test(symbol) || !market || !["crypto", "stocks", "moex", "forex", "commodities"].includes(market)) {
    return json({ error: "Некорректный тикер или рынок" }, 400);
  }
  try {
    return json(await getMarketNews(symbol, market, refresh));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Новости недоступны" }, 500);
  }
}
