import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function loadSimulator() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const loaded = await server.ssrLoadModule("/app/paper-trading-store.ts");
  const forecastModule = await server.ssrLoadModule("/app/terminal-forecast.ts");
  const policyModule = await server.ssrLoadModule("/app/strategy-policy.ts");
  return {
    server,
    simulatePaperPosition: loaded.simulatePaperPosition,
    paperCurrency: loaded.paperCurrency,
    quoteToPaperBalance: loaded.quoteToPaperBalance,
    paperEntrySourceForForecast: loaded.paperEntrySourceForForecast,
    mergePaperPosition: loaded.mergePaperPosition,
    calculateManualPaperClose: loaded.calculateManualPaperClose,
    calculateManualPaperEntry: loaded.calculateManualPaperEntry,
    calculateSignalPaperEntry: loaded.calculateSignalPaperEntry,
    paperEntryNetRewardRisk: loaded.paperEntryNetRewardRisk,
    calculateShadowForecastResult: loaded.calculateShadowForecastResult,
    hasContinuousExecutionHistory: loaded.hasContinuousExecutionHistory,
    strategyAttribution: loaded.strategyAttribution,
    paperCombinationStats: loaded.paperCombinationStats,
    paperContextStats: loaded.paperContextStats,
    assessPaperCandidateEntry: loaded.assessPaperCandidateEntry,
    candidatePreEntryOutcome: loaded.candidatePreEntryOutcome,
    paperSignalEntryTime: loaded.paperSignalEntryTime,
    paperPositionStopRisk: loaded.paperPositionStopRisk,
    paperTradeReturnR: loaded.paperTradeReturnR,
    forecastAllowsNewPaperEntry: loaded.forecastAllowsNewPaperEntry,
    modelVersion: forecastModule.SCENARIO_MODEL_VERSION,
    policyVersion: policyModule.STRATEGY_POLICY_VERSION,
    paperPortfolioCapacity: loaded.paperPortfolioCapacity,
    withPaperEntryLock: loaded.withPaperEntryLock,
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

test("READY paper entry preserves the forecast price while live execution remains a shadow diagnostic", async () => {
  const { server, calculateSignalPaperEntry, assessPaperCandidateEntry } = await loadSimulator();
  try {
    const signalPrice = 6.086;
    const targetPrice = 6.271153553631094;
    const stopPrice = 5.904;
    const execution = assessPaperCandidateEntry({
      side: "LONG", markPrice: signalPrice, targetPrice, stopPrice,
      feeBps: 10, slippageBps: 5,
    });
    assert.equal(execution.action, "WAIT_PRICE");
    const entry = calculateSignalPaperEntry({
      side: "LONG", signalPrice, targetPrice, stopPrice,
      balance: 10_000, riskPerTradePct: 1, maxOpenPositions: 5,
      feeBps: 10, quotePerUsdt: 80, lotSize: 10,
    });
    assert.equal(entry.entryPrice, signalPrice);
    assert.ok(entry.quantity > 0);
    assert.equal(entry.quantity % 10, 0);
    assert.ok(entry.fees > 0);
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
    assert.ok(result.every((item) => item.closedTrades === 1));
    assert.ok(result.every((item) => item.sampleSufficient === false));
  } finally {
    await server.close();
  }
});

test("strategy combinations distinguish confluence from an actual opposing signal", async () => {
  const { server, paperCombinationStats } = await loadSimulator();
  try {
    const forecast = JSON.stringify({ regime: "TRANSITION", strategyMatches: [
      { id: "ema-corridor", label: "EMA окно", shortLabel: "EMA", tone: "violet", state: "CONFIRMED", direction: "BEAR", summary: "Окно" },
      { id: "legacy-macd", label: "MACD", shortLabel: "MACD", tone: "blue", state: "SUPPORTING", direction: "BEAR", summary: "Импульс" },
      { id: "nison", label: "Нисон", shortLabel: "НИСОН", tone: "amber", state: "CONFIRMED", direction: "BULL", summary: "Противоположная модель" },
      { id: "vpa", label: "VPA", shortLabel: "VPA", tone: "lime", state: "WATCH", direction: "SIDEWAYS", summary: "Недостаточно данных" },
    ] });
    const rows = [
      { side: "SHORT", status: "CLOSED", entry_time: 1, exit_time: 2, realized_pnl: 20, risk_amount: 10, max_favorable_pct: 2, max_adverse_pct: -0.5, forecast_json: forecast },
      { side: "SHORT", status: "CLOSED", entry_time: 3, exit_time: 4, realized_pnl: -10, risk_amount: 10, max_favorable_pct: 0.2, max_adverse_pct: -1, forecast_json: forecast },
    ];
    const [result] = paperCombinationStats(rows);
    assert.equal(result.kind, "conflict");
    assert.deepEqual(result.strategyIds, ["ema-corridor", "legacy-macd"]);
    assert.deepEqual(result.conflictStrategyIds, ["nison"]);
    assert.equal(result.total, 2);
    assert.equal(result.profitFactor, 2);
    assert.equal(result.expectancyR, 0.5);
    assert.equal(result.sampleSufficient, false);
  } finally {
    await server.close();
  }
});

test("paper context statistics split closed trades by market timeframe and regime", async () => {
  const { server, paperContextStats } = await loadSimulator();
  try {
    const rows = [
      { market: "crypto", timeframe: "4h", side: "LONG", status: "CLOSED", entry_time: 1, exit_time: 2, realized_pnl: 12, risk_amount: 10, forecast_json: JSON.stringify({ regime: "TREND_UP" }) },
      { market: "stocks", timeframe: "4h", side: "SHORT", status: "CLOSED", entry_time: 3, exit_time: 4, realized_pnl: -6, risk_amount: 10, forecast_json: JSON.stringify({ regime: "TRANSITION" }) },
    ];
    const result = paperContextStats(rows);
    assert.equal(result.filter((item) => item.dimension === "market").length, 2);
    assert.equal(result.find((item) => item.dimension === "timeframe" && item.key === "4h")?.total, 2);
    assert.equal(result.find((item) => item.dimension === "regime" && item.key === "TREND_UP")?.realizedPnl, 12);
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
    assert.ok(result.notional > 0 && result.notional <= 1_000.01);
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

test("new paper stops include exit slippage and both fees within the 0.35 percent risk budget", async () => {
  const { server, calculateSignalPaperEntry, simulatePaperPosition } = await loadSimulator();
  try {
    for (const side of ["LONG", "SHORT"]) {
      const stopPrice = side === "LONG" ? 95 : 105;
      const entry = calculateSignalPaperEntry({ side, signalPrice: 100, targetPrice: side === "LONG" ? 110 : 90,
        stopPrice, balance: 10_000, riskPerTradePct: 1, maxOpenPositions: 5,
        feeBps: 10, slippageBps: 5, quotePerUsdt: 80 });
      const closed = simulatePaperPosition({ side, entryPrice: entry.entryPrice, targetPrice: side === "LONG" ? 110 : 90,
        stopPrice, quantity: entry.quantity, dueTime: 10, feeBps: 10, slippageBps: 5,
        candles: [{ time: 2, open: 100, high: side === "SHORT" ? 106 : 101,
          low: side === "LONG" ? 94 : 99, close: stopPrice, volume: 1, closed: true }] });
      assert.equal(entry.entryPrice, 100);
      assert.ok(entry.notional <= 80_000 + 1e-6);
      assert.ok(entry.riskAmount <= 2_800 + 1e-6);
      assert.ok(Math.abs(closed.realizedPnl) / 80 <= 35 + 1e-6);
      assert.ok(Math.abs(entry.riskAmount + closed.realizedPnl) < 1e-6);
    }
  } finally { await server.close(); }
});

test("tighter user risk and notional settings remain tighter than the new caps", async () => {
  const { server, calculateSignalPaperEntry } = await loadSimulator();
  try {
    const input = { side: "LONG", signalPrice: 100, targetPrice: 115, stopPrice: 95,
      balance: 10_000, riskPerTradePct: 0.1, maxOpenPositions: 20, feeBps: 10, quotePerUsdt: 1 };
    const wide = calculateSignalPaperEntry(input);
    const tight = calculateSignalPaperEntry({ ...input, stopPrice: 99.9 });
    assert.ok(wide.riskAmount <= 10 + 1e-6);
    assert.ok(tight.riskAmount <= 10 + 1e-6);
    assert.ok(tight.notional <= 500 + 1e-6);
    assert.ok(wide.notional <= 500 + 1e-6);
  } finally { await server.close(); }
});

test("scale-in sizes the combined position including reserved risk and entry fees", async () => {
  const { server, calculateManualPaperEntry, paperPositionStopRisk, mergePaperPosition } = await loadSimulator();
  try {
    const existing = { side: "LONG", entryPrice: 100, stopPrice: 95, quantity: 3,
      entryFeesNative: 0.45, feeBps: 10, slippageBps: 5 };
    const reserved = paperPositionStopRisk(existing);
    const input = { side: "LONG", markPrice: 101, targetPrice: 115, stopPrice: 95, balance: 10_000,
      riskPerTradePct: 1, maxOpenPositions: 5, feeBps: 10, slippageBps: 5, quotePerUsdt: 1,
      reservedRiskNative: reserved, reservedNotionalNative: 300 };
    const added = calculateManualPaperEntry(input);
    const merged = mergePaperPosition({ currentEntryPrice: 100, currentQuantity: 3,
      addEntryPrice: added.entryPrice, addQuantity: added.quantity });
    const combinedRisk = paperPositionStopRisk({ ...existing, entryPrice: merged.entryPrice,
      quantity: merged.quantity, entryFeesNative: existing.entryFeesNative + added.feesNative });
    assert.ok(combinedRisk <= 35 + 1e-6);
    assert.ok(merged.notional <= 1_000 + 1e-6);
    assert.throws(() => calculateManualPaperEntry({ ...input, reservedRiskNative: 35 }), /Лимит риска/);
    assert.throws(() => calculateManualPaperEntry({ ...input, reservedNotionalNative: 1_000 }), /Лимит риска/);
  } finally { await server.close(); }
});

test("MOEX expectancy R uses native PnL and risk in matching currencies", async () => {
  const { server, paperTradeReturnR, strategyAttribution, paperContextStats } = await loadSimulator();
  try {
    const forecast = JSON.stringify({ regime: "TREND_UP", strategyMatches: [
      { id: "legacy-macd", label: "MACD", shortLabel: "MACD", tone: "blue", state: "CONFIRMED", direction: "BULL", summary: "Импульс" },
    ] });
    const row = { market: "moex", timeframe: "4h", side: "LONG", status: "CLOSED", entry_time: 1,
      exit_time: 2, realized_pnl: 20, realized_pnl_native: 1_600, risk_amount: 800, fx_rate: 80, forecast_json: forecast };
    assert.equal(paperTradeReturnR(row), 2);
    assert.equal(paperTradeReturnR({ ...row, realized_pnl_native: null }), 2);
    assert.equal(strategyAttribution([row])[0].expectancyR, 2);
    assert.equal(paperContextStats([row]).find((item) => item.dimension === "market").expectancyR, 2);
  } finally { await server.close(); }
});

test("signal entries become available at candle close and ignore earlier candle extremes", async () => {
  const { server, paperSignalEntryTime, simulatePaperPosition } = await loadSimulator();
  try {
    const open = Date.UTC(2026, 8, 4, 8, 0);
    const availableAt = paperSignalEntryTime(open, "4h", "crypto");
    assert.equal(availableAt, open + 4 * 60 * 60_000);
    // A US 4h candle beginning at 13:30 New York ends with the regular 16:00 close.
    assert.equal(paperSignalEntryTime(Date.UTC(2026, 8, 4, 17, 30), "4h", "stocks"), Date.UTC(2026, 8, 4, 20, 0));
    const result = simulatePaperPosition({ side: "LONG", entryPrice: 100, targetPrice: 110, stopPrice: 95,
      quantity: 1, dueTime: availableAt + 60 * 60_000, entryTime: availableAt, feeBps: 0, slippageBps: 0,
      candles: [
        { time: availableAt - 60_000, open: 94, high: 112, low: 90, close: 100, volume: 1, closed: true },
        { time: availableAt, open: 100, high: 101, low: 99, close: 100.5, volume: 1, closed: true },
      ] });
    assert.equal(result.status, "OPEN");
    assert.ok(Math.abs(result.maxFavorablePct - 1) < 1e-9);
    assert.ok(Math.abs(result.maxAdversePct + 1) < 1e-9);
  } finally { await server.close(); }
});

test("short excursions and accumulated scale-in fees match fixed-quantity PnL", async () => {
  const { server, simulatePaperPosition } = await loadSimulator();
  try {
    const result = simulatePaperPosition({ side: "SHORT", entryPrice: 100, targetPrice: 80, stopPrice: 120,
      quantity: 10, dueTime: 10, feeBps: 10, slippageBps: 0, entryFeesNative: 3,
      candles: [{ time: 2, open: 100, high: 110, low: 90, close: 95, volume: 1, closed: true }] });
    assert.equal(result.maxFavorablePct, 10);
    assert.equal(result.maxAdversePct, -10);
    assert.equal(result.fees, 3);
    assert.equal(result.unrealizedPnl, 50 - 3 - 0.95);
  } finally { await server.close(); }
});

test("new paper entry requires the current model and eligible strategy policy", async () => {
  const { server, forecastAllowsNewPaperEntry, modelVersion, policyVersion } = await loadSimulator();
  try {
    const allowed = JSON.stringify({ strategyPolicy: { version: policyVersion, eligible: true,
      participantIds: ["ema-macd-selective"], reasons: [] } });
    assert.equal(forecastAllowsNewPaperEntry(modelVersion, allowed), true);
    assert.equal(forecastAllowsNewPaperEntry("scenario-v1.5.0", allowed), false);
    assert.equal(forecastAllowsNewPaperEntry(modelVersion, JSON.stringify({ decision: "READY" })), false);
    assert.equal(forecastAllowsNewPaperEntry(modelVersion, JSON.stringify({ strategyPolicy: {
      version: policyVersion, eligible: false, participantIds: [], reasons: ["No confirmation"] } })), false);
  } finally { await server.close(); }
});

test("new policy snapshots attribute PnL only to the selected composite", async () => {
  const { server, strategyAttribution, paperCombinationStats, policyVersion } = await loadSimulator();
  try {
    const row = { side: "LONG", status: "CLOSED", entry_time: 1, exit_time: 2,
      realized_pnl: 20, risk_amount: 10, forecast_json: JSON.stringify({
        strategyPolicy: { version: policyVersion, eligible: true, participantIds: ["ema-macd-selective"], reasons: [] },
        strategyMatches: [
          { id: "ema-macd-selective", label: "Пилот", shortLabel: "Пилот", tone: "blue", state: "CONFIRMED", direction: "BULL", summary: "Связка" },
          { id: "legacy-macd", label: "MACD", shortLabel: "MACD", tone: "blue", state: "CONFIRMED", direction: "BULL", summary: "Самостоятельный крест" },
          { id: "nison", label: "Нисон", shortLabel: "Нисон", tone: "amber", state: "CONFIRMED", direction: "BEAR", summary: "Тень" },
        ],
      }) };
    const [credit] = strategyAttribution([row]);
    assert.equal(credit.id, "ema-macd-selective");
    assert.equal(credit.realizedPnl, 20);
    assert.equal(strategyAttribution([row]).length, 1);
    const [combination] = paperCombinationStats([row]);
    assert.deepEqual(combination.strategyIds, ["ema-macd-selective"]);
    assert.deepEqual(combination.conflictStrategyIds, []);
  } finally { await server.close(); }
});

test("seven instruments cannot bypass the total 2 percent portfolio stop risk", async () => {
  const { server, paperPortfolioCapacity, calculateSignalPaperEntry } = await loadSimulator();
  try {
    const positions = [];
    let denied = 0;
    for (let index = 0; index < 7; index += 1) {
      const symbol = `SYMBOL${index}`;
      const capacity = paperPortfolioCapacity({ balance: 10_000, maxOpenPositions: 20, feeBps: 10,
        slippageBps: 5, market: "crypto", symbol, quotePerUsdt: 1, positions });
      if (!capacity.allowed) { denied += 1; continue; }
      const entry = calculateSignalPaperEntry({ side: "LONG", signalPrice: 100, stopPrice: 90, targetPrice: 120,
        balance: 10_000, riskPerTradePct: 1, maxOpenPositions: 20, feeBps: 10, slippageBps: 5,
        quotePerUsdt: 1, portfolioRiskBudgetNative: capacity.riskBudgetNative,
        portfolioNotionalBudgetNative: capacity.notionalBudgetNative });
      positions.push({ id: symbol, market: "crypto", symbol, side: "LONG", entry_price: entry.entryPrice,
        quantity: entry.quantity, stop_price: 90, fees_native: entry.feesNative, fx_rate: 1 });
    }
    assert.equal(positions.length, 6);
    assert.equal(denied, 1);
    const total = paperPortfolioCapacity({ balance: 10_000, maxOpenPositions: 20, feeBps: 10,
      slippageBps: 5, market: "crypto", symbol: "NEXT", quotePerUsdt: 1, positions });
    assert.ok(total.riskUsdt <= 200 + 1e-6);
    assert.ok(total.riskUsdt >= 200 - 1e-6);
    assert.equal(total.allowed, false);
  } finally { await server.close(); }
});

test("portfolio capacity converts frozen FX and does not net opposite exposures", async () => {
  const { server, paperPortfolioCapacity } = await loadSimulator();
  try {
    const positions = [
      { id: "rub", market: "moex", symbol: "RUB", side: "LONG", entry_price: 8_000,
        quantity: 10, stop_price: 7_920, fees_native: 80, fx_rate: 80 },
      { id: "usd", market: "stocks", symbol: "USD", side: "SHORT", entry_price: 100,
        quantity: 10, stop_price: 101, fees_native: 1, fx_rate: 1 },
    ];
    const result = paperPortfolioCapacity({ balance: 10_000, maxOpenPositions: 5, feeBps: 10,
      slippageBps: 0, market: "moex", symbol: "NEXT", quotePerUsdt: 80, positions });
    assert.equal(result.notionalUsdt, 2_000);
    assert.ok(Math.abs(result.riskUsdt - 24) < 1e-9);
    assert.ok(Math.abs(result.riskBudgetNative - 176 * 80) < 1e-9);
    const limited = paperPortfolioCapacity({ balance: 10_000, maxOpenPositions: 2, feeBps: 10,
      slippageBps: 0, market: "moex", symbol: "NEXT", quotePerUsdt: 80, positions });
    assert.equal(limited.allowed, false);
    assert.match(limited.reason, /лимит инструментов/);
    const grossLimit = paperPortfolioCapacity({ balance: 2_000, maxOpenPositions: 5, feeBps: 0,
      slippageBps: 0, market: "moex", symbol: "NEXT", quotePerUsdt: 80, positions });
    assert.equal(grossLimit.allowed, false);
    assert.match(grossLimit.reason, /100%/);
  } finally { await server.close(); }
});

test("portfolio capacity evaluates the proposed whole-position stop before allowing a scale-in", async () => {
  const { server, paperPortfolioCapacity } = await loadSimulator();
  try {
    const input = { balance: 10_000, maxOpenPositions: 5, feeBps: 0, slippageBps: 0,
      market: "crypto", symbol: "BTC", quotePerUsdt: 1, positions: [
        { id: "held", market: "crypto", symbol: "BTC", side: "LONG", entry_price: 100,
          quantity: 10, stop_price: 99, fees_native: 0, fx_rate: 1 },
      ] };
    assert.equal(paperPortfolioCapacity(input).allowed, true);
    const wider = paperPortfolioCapacity({ ...input, replacingStop: { tradeId: "held", stopPrice: 75 } });
    assert.equal(wider.allowed, false);
    assert.equal(wider.riskUsdt, 250);
  } finally { await server.close(); }
});

test("entry mutations serialize even when a preceding entry fails", async () => {
  const { server, withPaperEntryLock } = await loadSimulator();
  try {
    const events = [];
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    const first = withPaperEntryLock(async () => { events.push("first-read"); await wait; events.push("first-write"); });
    const second = withPaperEntryLock(async () => { events.push("second-read"); throw new Error("rejected entry"); });
    const secondRejected = assert.rejects(second, /rejected entry/);
    const third = withPaperEntryLock(async () => { events.push("third-read"); });
    await Promise.resolve();
    assert.deepEqual(events, ["first-read"]);
    release();
    await Promise.all([first, secondRejected, third]);
    assert.deepEqual(events, ["first-read", "first-write", "second-read", "third-read"]);
  } finally { await server.close(); }
});
