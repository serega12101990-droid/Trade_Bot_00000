import { NextRequest, NextResponse } from "next/server";
import { evaluateDueForecasts, readForecastJournal, recordForecast } from "../../forecast-journal-store";
import { getExecutionMarketData, TIMEFRAME_MINUTES } from "../../market-data-service";
import { detectOpeningRangeThreeCandle } from "../../experimental-strategies";
import { syncPaperCandidates } from "../../paper-trading-store";
import type { Candle, ForecastProjection, Market, Timeframe } from "../../terminal-types";

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function GET(request: NextRequest) {
  try {
    const evaluated = request.nextUrl.searchParams.get("evaluate") === "1" ? await evaluateDueForecasts() : 0;
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 200);
    return json({ ...(await readForecastJournal(limit)), evaluatedNow: evaluated });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Журнал прогнозов недоступен" }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      symbol?: string;
      market?: Market;
      timeframe?: Timeframe;
      forecast?: ForecastProjection;
      candles?: Candle[];
    };
    const symbol = (body.symbol ?? "").toUpperCase().replace("/", "");
    const market = body.market;
    const timeframe = body.timeframe;
    const forecast = body.forecast;
    if (!/^[A-Z0-9._-]{2,15}$/.test(symbol) || !market || !["crypto", "stocks", "moex", "forex", "commodities"].includes(market) || !timeframe || !TIMEFRAME_MINUTES[timeframe]) {
      return json({ error: "Некорректный инструмент или таймфрейм" }, 400);
    }
    if (!forecast?.modelVersion || !Number.isFinite(forecast.asofTime) || !forecast.scenarios?.length || !forecast.features) {
      return json({ error: "Некорректный прогноз" }, 400);
    }
    const duration = TIMEFRAME_MINUTES[timeframe] * 60_000;
    const closedAt = forecast.asofTime + duration;
    const continuousMarket = market === "crypto" || market === "forex" || market === "commodities";
    const maximumAge = continuousMarket ? Math.max(6 * 60 * 60_000, duration * 1.5) : Math.max(72 * 60 * 60_000, duration * 1.5);
    if (Date.now() - closedAt > maximumAge) {
      return json({ error: "Архивный прогноз не записан: журнал принимает только свежие закрытые свечи" }, 409);
    }
    const candles = Array.isArray(body.candles) ? body.candles.slice(-1000) : [];
    let enrichedForecast = forecast;
    let preciseCandles: Candle[] = [];
    const needsPreciseCandles = forecast.strategyMatches?.some((match) => (match.trial?.executionResolutionMinutes ?? 10) <= 5)
      || market === "stocks" && timeframe === "15m";
    if (needsPreciseCandles) {
      try { preciseCandles = (await getExecutionMarketData(symbol, market)).candles; } catch { preciseCandles = []; }
    }
    if (market === "stocks" && timeframe === "15m" && preciseCandles.length) {
      try {
        const openingRange = detectOpeningRangeThreeCandle(preciseCandles, forecast.asofTime + duration);
        if (openingRange) enrichedForecast = {
          ...forecast,
          strategyMatches: [
            ...forecast.strategyMatches.filter((match) => match.id !== "opening-range-3"),
            openingRange,
          ],
        };
      } catch {
        // Без настоящих минутных свечей правило открытия NY не имитируется по 15-минутным данным.
      }
    }
    const result = await recordForecast(symbol, market, timeframe, enrichedForecast, candles, preciseCandles);
    const paperQueued = result.created ? await syncPaperCandidates() : 0;
    return json({ ...result, paperQueued }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Не удалось сохранить прогноз" }, 500);
  }
}
