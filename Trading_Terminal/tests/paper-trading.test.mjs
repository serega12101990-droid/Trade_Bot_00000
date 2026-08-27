import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function loadSimulator() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const loaded = await server.ssrLoadModule("/app/paper-trading-store.ts");
  return {
    server,
    simulatePaperPosition: loaded.simulatePaperPosition,
    paperCurrency: loaded.paperCurrency,
    quoteToPaperBalance: loaded.quoteToPaperBalance,
    paperEntrySourceForForecast: loaded.paperEntrySourceForForecast,
    mergePaperPosition: loaded.mergePaperPosition,
    calculateManualPaperClose: loaded.calculateManualPaperClose,
    calculateManualPaperEntry: loaded.calculateManualPaperEntry,
    paperEntryNetRewardRisk: loaded.paperEntryNetRewardRisk,
    calculateShadowForecastResult: loaded.calculateShadowForecastResult,
    hasContinuousExecutionHistory: loaded.hasContinuousExecutionHistory,
    strategyAttribution: loaded.strategyAttribution,
    assessPaperCandidateEntry: loaded.assessPaperCandidateEntry,
    candidatePreEntryOutcome: loaded.candidatePreEntryOutcome,
  };
}

test("auto entry waits for a better price instead of opening a poor live reward/risk", async () => {
  const { server, assessPaperCandidateEntry } = await loadSimulator();
  try {
    const result = assessPaperCandidateEntry({
      side: "SHORT", markPrice: 55.42, targetPrice: 54.88, stopPrice: 57.78,
      feeBps: 10, slippageBps: 5,
    });
    assert.equal(result.action, "WAIT_PRICE");
    assert.ok(result.economics.ratio < 1);
    assert.ok(result.bestRatio >= 1);
  } finally {
    await server.close();
  }
});

test("candidate is retired when its stop or target was already reached before entry", async () => {
  const { server, candidatePreEntryOutcome } = await loadSimulator();
  try {
    const base = Date.UTC(2026, 7, 26, 6, 0);
    const stopped = candidatePreEntryOutcome({
      side: "SHORT", targetPrice: 95, stopPrice: 105, notBefore: base,
      candles: [{ time: base + 60_000, open: 100, high: 106, low: 94, close: 101, volume: 1, closed: true }],
    });
    assert.equal(stopped?.outcome, "INVALIDATION");
    const targetPassed = candidatePreEntryOutcome({
      side: "LONG", targetPrice: 110, stopPrice: 95, notBefore: base,
      candles: [{ time: base + 60_000, open: 100, high: 111, low: 99, close: 109, volume: 1, closed: true }],
    });
    assert.equal(targetPassed?.outcome, "TARGET");
  } finally {
    await server.close();
  }
});

test("shared trade outcome is attributed proportionally across aligned strategies", async () => {
  const { server, strategyAttribution } = await loadSimulator();
  try {
    const forecast = JSON.stringify({ strategyMatches: [
      { id: "ema-corridor", label: "EMA окно", shortLabel: "EMA", tone: "violet", state: "CONFIRMED", direction: "BEAR", summary: "Окно" },
      { id: "legacy-macd", label: "MACD", shortLabel: "MACD", tone: "blue", state: "SUPPORTING", direction: "BEAR", summary: "Импульс" },
      { id: "nison", label: "Нисон", shortLabel: "НИСОН", tone: "amber", state: "WATCH", direction: "BULL", summary: "Недостаточно данных" },
    ] });
    const rows = [{
      side: "SHORT", status: "CLOSED", entry_time: 1, realized_pnl: 20, forecast_json: forecast,
    }];
    const result = strategyAttribution(rows);
    assert.equal(result.length, 2);
    assert.ok(result.every((item) => item.closedCredit === 0.5));
    assert.ok(result.every((item) => item.winCredit === 0.5));
    assert.ok(result.every((item) => item.winRatePct === 100));
    assert.ok(result.every((item) => item.realizedPnl === 10));
  } finally {
    await server.close();
  }
});

test("manual mode can deliberately open WAIT while AUTO remains READY-only", async () => {
  const { server, paperEntrySourceForForecast } = await loadSimulator();
  try {
    assert.equal(paperEntrySourceForForecast("READY", "BULL", "MANUAL"), "MANUAL");
    assert.equal(paperEntrySourceForForecast("READY", "BEAR", "AUTO"), "AUTO");
    assert.equal(paperEntrySourceForForecast("WAIT_CONFIRMATION", "BULL", "MANUAL"), "MANUAL_WAIT");
    assert.equal(paperEntrySourceForForecast("WAIT_CONFIRMATION", "BEAR", "AUTO"), null);
    assert.equal(paperEntrySourceForForecast("NO_TRADE", "BULL", "MANUAL"), null);
    assert.equal(paperEntrySourceForForecast("WAIT_CONFIRMATION", "SIDEWAYS", "MANUAL"), null);
  } finally {
    await server.close();
  }
});

test("paper execution waits when one-minute history has a real data gap", async () => {
  const { server, hasContinuousExecutionHistory } = await loadSimulator();
  try {
    const cursor = Date.UTC(2026, 7, 18, 10, 0);
    assert.equal(hasContinuousExecutionHistory("crypto", cursor, [
      { time: cursor + 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1, closed: true },
    ]), true);
    assert.equal(hasContinuousExecutionHistory("crypto", cursor, [
      { time: cursor + 31 * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1, closed: true },
    ]), false);
  } finally {
    await server.close();
  }
});

test("paper execution accepts sparse MOEX minutes when the response still covers the saved cursor", async () => {
  const { server, hasContinuousExecutionHistory } = await loadSimulator();
  try {
    const cursor = Date.UTC(2026, 7, 22, 15, 56);
    assert.equal(hasContinuousExecutionHistory("moex", cursor, [
      { time: cursor, open: 5194, high: 5194, low: 5194, close: 5194, volume: 1, closed: true },
      { time: Date.UTC(2026, 7, 24, 6, 50), open: 5213, high: 5215, low: 5200, close: 5205, volume: 1, closed: true },
    ]), true);
    assert.equal(hasContinuousExecutionHistory("moex", cursor, [
      { time: Date.UTC(2026, 7, 24, 6, 50), open: 5213, high: 5215, low: 5200, close: 5205, volume: 1, closed: true },
    ]), false);
  } finally {
    await server.close();
  }
});

test("skipped forecasts calculate a shadow result without changing the paper balance", async () => {
  const { server, calculateShadowForecastResult } = await loadSimulator();
  try {
    const winner = calculateShadowForecastResult({ side: "LONG", entryPrice: 100, exitPrice: 103, targetPrice: 102, stopPrice: 98, firstTouch: "TARGET", feeBps: 10, slippageBps: 5 });
    const loser = calculateShadowForecastResult({ side: "SHORT", entryPrice: 100, exitPrice: 98, targetPrice: 95, stopPrice: 102, firstTouch: "INVALIDATION", feeBps: 10, slippageBps: 5 });
    assert.equal(winner.outcome, "WIN");
    assert.equal(winner.exitPrice, 102);
    assert.ok(winner.resultPct > 1.6 && winner.resultPct < 1.8);
    assert.equal(winner.estimatedCostPct, 0.3);
    assert.equal(loser.outcome, "LOSS");
    assert.equal(loser.exitPrice, 102);
    assert.ok(loser.resultPct < -2.2);
  } finally {
    await server.close();
  }
});

test("manual entry opens immediately at the current mark with position sizing", async () => {
  const { server, calculateManualPaperEntry } = await loadSimulator();
  try {
    const result = calculateManualPaperEntry({
      side: "SHORT",
      markPrice: 100,
      targetPrice: 90,
      stopPrice: 105,
      balance: 10_000,
      riskPerTradePct: 1,
      maxOpenPositions: 5,
      feeBps: 10,
      slippageBps: 5,
      quotePerUsdt: 1,
    });
    assert.ok(result.entryPrice < 100);
    assert.ok(result.quantity > 0);
    assert.ok(result.notional > 0 && result.notional <= 2_000.01);
    assert.ok(result.fees > 0);
    assert.ok(result.unrealizedPnl < 0);
  } finally {
    await server.close();
  }
});

test("paper entry rejects a stale chase when costs reduce net reward/risk below one", async () => {
  const { server, calculateManualPaperEntry, paperEntryNetRewardRisk } = await loadSimulator();
  try {
    const economics = paperEntryNetRewardRisk({
      side: "LONG", markPrice: 53.8, targetPrice: 54.85133330121024, stopPrice: 52.5,
      feeBps: 10, slippageBps: 5,
    });
    assert.ok(economics.ratio < 1);
    assert.throws(() => calculateManualPaperEntry({
      side: "LONG", markPrice: 53.8, targetPrice: 54.85133330121024, stopPrice: 52.5,
      balance: 10_000, riskPerTradePct: 1, maxOpenPositions: 5,
      feeBps: 10, slippageBps: 5, quotePerUsdt: 80,
    }), /прибыль\/риск/);
  } finally {
    await server.close();
  }
});

test("MOEX position size is rounded down to whole exchange lots", async () => {
  const { server, calculateManualPaperEntry } = await loadSimulator();
  try {
    const result = calculateManualPaperEntry({
      side: "LONG", markPrice: 100, targetPrice: 115, stopPrice: 95,
      balance: 10_000, riskPerTradePct: 1, maxOpenPositions: 5,
      feeBps: 10, slippageBps: 5, quotePerUsdt: 80, lotSize: 100,
    });
    assert.equal(result.quantity % 100, 0);
  } finally {
    await server.close();
  }
});

test("manual close applies exit slippage, both fees, and quote conversion", async () => {
  const { server, calculateManualPaperClose } = await loadSimulator();
  try {
    const result = calculateManualPaperClose({
      side: "LONG",
      entryPrice: 100,
      markPrice: 105,
      quantity: 10,
      notional: 1_000,
      entryFeesNative: 1,
      feeBps: 10,
      slippageBps: 5,
      quotePerUsdt: 80,
    });
    assert.ok(result.exitPrice < 105 && result.exitPrice > 104.9);
    assert.ok(result.feesNative > 2);
    assert.ok(result.realizedPnlNative > 47 && result.realizedPnlNative < 48);
    assert.equal(result.realizedPnl, result.realizedPnlNative / 80);
    assert.equal(result.fees, result.feesNative / 80);
  } finally {
    await server.close();
  }
});

test("a confirmed scale-in recalculates weighted entry, size, and notional", async () => {
  const { server, mergePaperPosition } = await loadSimulator();
  try {
    const merged = mergePaperPosition({ currentEntryPrice: 100, currentQuantity: 2, addEntryPrice: 110, addQuantity: 1 });
    assert.equal(merged.quantity, 3);
    assert.equal(merged.notional, 310);
    assert.equal(merged.addedNotional, 110);
    assert.ok(Math.abs(merged.entryPrice - 103.3333333333) < 0.000001);
  } finally {
    await server.close();
  }
});

test("paper trade closes a long at TP after fees and slippage", async () => {
  const { server, simulatePaperPosition } = await loadSimulator();
  try {
    const result = simulatePaperPosition({
      side: "LONG", entryPrice: 100, targetPrice: 110, stopPrice: 95, quantity: 10,
      dueTime: 10, feeBps: 10, slippageBps: 5,
      candles: [{ time: 2, open: 100, high: 111, low: 99, close: 109, volume: 1, closed: true }],
    });
    assert.equal(result.status, "CLOSED");
    assert.equal(result.exitReason, "TP");
    assert.ok(result.realizedPnl > 97 && result.realizedPnl < 98);
    assert.ok(result.fees > 2);
  } finally {
    await server.close();
  }
});

test("MOEX paper trades freeze a virtual RUB rate and convert PnL back to USDT", async () => {
  const { server, paperCurrency, quoteToPaperBalance } = await loadSimulator();
  try {
    assert.deepEqual(paperCurrency("moex", 80), { quoteCurrency: "RUB", quotePerUsdt: 80 });
    assert.deepEqual(paperCurrency("stocks", 80), { quoteCurrency: "USD", quotePerUsdt: 1 });
    assert.deepEqual(paperCurrency("commodities", 80, "GC", 3400), { quoteCurrency: "USD", quotePerUsdt: 1 });
    assert.deepEqual(paperCurrency("forex", 80, "EURUSD", 1.18), { quoteCurrency: "USD", quotePerUsdt: 1 });
    assert.deepEqual(paperCurrency("forex", 80, "USDJPY", 147.5), { quoteCurrency: "JPY", quotePerUsdt: 147.5 });
    assert.equal(quoteToPaperBalance(8_000, 80), 100);
    assert.equal(quoteToPaperBalance(-4_000, 80), -50);
  } finally {
    await server.close();
  }
});

test("paper trade uses the stop when TP and SL touch inside one candle", async () => {
  const { server, simulatePaperPosition } = await loadSimulator();
  try {
    const result = simulatePaperPosition({
      side: "LONG", entryPrice: 100, targetPrice: 110, stopPrice: 95, quantity: 10,
      dueTime: 10, feeBps: 10, slippageBps: 5,
      candles: [{ time: 2, open: 100, high: 111, low: 94, close: 103, volume: 1, closed: true }],
    });
    assert.equal(result.status, "CLOSED");
    assert.equal(result.exitReason, "AMBIGUOUS_SL");
    assert.ok(result.realizedPnl < 0);
  } finally {
    await server.close();
  }
});

test("open paper trade reports mark-to-market PnL without closing", async () => {
  const { server, simulatePaperPosition } = await loadSimulator();
  try {
    const result = simulatePaperPosition({
      side: "SHORT", entryPrice: 100, targetPrice: 90, stopPrice: 106, quantity: 5,
      dueTime: 10, feeBps: 10, slippageBps: 5,
      candles: [{ time: 2, open: 100, high: 101, low: 96, close: 97, volume: 1, closed: true }],
    });
    assert.equal(result.status, "OPEN");
    assert.equal(result.exitReason, null);
    assert.ok(result.unrealizedPnl > 13);
  } finally {
    await server.close();
  }
});
