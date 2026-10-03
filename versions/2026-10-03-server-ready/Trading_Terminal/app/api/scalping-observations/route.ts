import { NextRequest, NextResponse } from "next/server";
import { readScalpObservationCount, saveScalpObservations } from "../../scalping-observation-store";

export async function GET() {
  try { return NextResponse.json(await readScalpObservationCount(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "База наблюдений недоступна. Требуется миграция журнала." }, { status: 503 }); }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { observations?: unknown[] };
    if (!Array.isArray(body.observations) || body.observations.length > 100) return NextResponse.json({ error: "Допускается до 100 наблюдений" }, { status: 400 });
    return NextResponse.json(await saveScalpObservations(body.observations));
  } catch { return NextResponse.json({ error: "Наблюдения пока не сохранены в базе" }, { status: 503 }); }
}
