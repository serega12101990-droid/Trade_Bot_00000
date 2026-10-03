import { NextRequest, NextResponse } from "next/server";
import { authorizeAutomationRequest } from "../../../automation-auth";
import { scanForecastAsset } from "../../../forecast-scan-service";

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}
export async function POST(request: NextRequest) {
  try {
    if (!await authorizeAutomationRequest(request)) return json({ error: "Автоматический сканер не авторизован" }, 401);
    return json(await scanForecastAsset(await request.json()));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Автоматический сканер завершился с ошибкой" }, 500);
  }
}
