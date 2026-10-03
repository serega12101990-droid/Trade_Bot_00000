import { NextRequest, NextResponse } from "next/server";
import { readScalpingTrades, upsertScalpingTrades } from "../../scalping-store";
import type { ScalpPaperTrade } from "../../scalping-engine";

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function GET(request: NextRequest) {
  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 2_000);
    return json(await readScalpingTrades(limit));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Журнал скальпинга недоступен" }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { trades?: ScalpPaperTrade[] };
    if (!Array.isArray(body.trades) || body.trades.length > 2_000) return json({ error: "Некорректный список сделок" }, 400);
    return json(await upsertScalpingTrades(body.trades));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Сделки скальпинга не сохранены" }, 500);
  }
}
