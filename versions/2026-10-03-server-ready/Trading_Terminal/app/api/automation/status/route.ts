import { NextRequest, NextResponse } from "next/server";
import { authorizeAutomationRequest } from "../../../automation-auth";
import {
  readAutomationRuntimeState,
  recordAutomationHeartbeat,
  recordAutomationRun,
  replaceAutomationWatchlist,
  type AutomationRunSummary,
} from "../../../automation-runtime-state";

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function GET(request: NextRequest) {
  if (!await authorizeAutomationRequest(request)) return json({ error: "Автоматический сканер не авторизован" }, 401);
  return json(readAutomationRuntimeState());
}

export async function POST(request: NextRequest) {
  try {
    if (!await authorizeAutomationRequest(request)) return json({ error: "Автоматический сканер не авторизован" }, 401);
    const body = await request.json() as {
      action?: "sync-watchlist" | "heartbeat" | "record-run";
      assets?: unknown[];
      at?: number;
      run?: AutomationRunSummary;
    };
    if (body.action === "sync-watchlist") {
      const watchlistCount = replaceAutomationWatchlist(Array.isArray(body.assets) ? body.assets : []);
      return json({ ...readAutomationRuntimeState(), watchlistCount });
    }
    if (body.action === "heartbeat") {
      recordAutomationHeartbeat(typeof body.at === "number" && Number.isFinite(body.at) ? body.at : Date.now());
      return json(readAutomationRuntimeState());
    }
    if (body.action === "record-run" && body.run?.id) {
      recordAutomationRun(body.run);
      return json(readAutomationRuntimeState());
    }
    return json({ error: "Некорректное действие автоматического сканера" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Состояние автоматического сканера не обновлено" }, 500);
  }
}
