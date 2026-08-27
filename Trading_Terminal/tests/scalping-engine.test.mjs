import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withEngine(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    await run(await server.ssrLoadModule("/app/scalping-engine.ts"));
  } finally {
    await server.close();
  }
}

test("order-book imbalance measures the dominant side", async () => {
  await withEngine(({ bookImbalance }) => {
    assert.equal(bookImbalance([{ price: 100, size: 8 }], [{ price: 101, size: 2 }]), 0.6);
    assert.equal(bookImbalance([{ price: 100, size: 2 }], [{ price: 101, size: 8 }]), -0.6);
    assert.equal(bookImbalance([], []), 0);
  });
});

test("tape delta uses only the selected rolling window", async () => {
  await withEngine(({ tapeStats }) => {
    const now = 100_000;
    const result = tapeStats([
      { id: "1", time: now - 1_000, price: 100, size: 8, side: "Buy" },
      { id: "2", time: now - 2_000, price: 100, size: 2, side: "Sell" },
      { id: "old", time: now - 70_000, price: 100, size: 100, side: "Sell" },
    ], now, 30_000);
    assert.equal(result.tradeCount, 2);
    assert.equal(result.deltaPct, 0.6);
    assert.equal(result.totalVolume, 10);
  });
});

test("READY long needs aligned 15m context, 5m trend, 1m impulse, book and tape", async () => {
  await withEngine(({ assessScalpSignal }) => {
    const signal = assessScalpSignal({
      price: 102, bid: 101.99, ask: 102.01, spreadBps: 1.96,
      imbalance: 0.2, deltaPct: 0.25, tradesPerSecond: 1.2,
      ema20_15m: 100.5, ema50_15m: 99.5, histogram15m: 3,
      ema20_5m: 101, ema50_5m: 100, histogram5m: 2, previousHistogram5m: 1,
      ema20_1m: 101.5, histogram1m: 0.8, previousHistogram1m: 0.4,
    });
    assert.equal(signal.status, "READY");
    assert.equal(signal.direction, "LONG");
    assert.ok(signal.score >= 82);
  });
});

test("opposing or missing 15m context keeps an otherwise strong scalp out of READY", async () => {
  await withEngine(({ assessScalpSignal }) => {
    const base = {
      price: 102, bid: 101.99, ask: 102.01, spreadBps: 1.96,
      imbalance: 0.2, deltaPct: 0.25, tradesPerSecond: 1.2,
      ema20_5m: 101, ema50_5m: 100, histogram5m: 2, previousHistogram5m: 1,
      ema20_1m: 101.5, histogram1m: 0.8, previousHistogram1m: 0.4,
    };
    const missing = assessScalpSignal({ ...base, ema20_15m: null, ema50_15m: null, histogram15m: null });
    assert.equal(missing.status, "WAIT");
    assert.match(missing.reasons[0], /15м/);
    const opposing = assessScalpSignal({ ...base, ema20_15m: 103, ema50_15m: 104, histogram15m: -2 });
    assert.equal(opposing.status, "WAIT");
    assert.match(opposing.reasons.join(" "), /15м/);
  });
});

test("wide spread blocks a scalp even when momentum is aligned", async () => {
  await withEngine(({ assessScalpSignal }) => {
    const signal = assessScalpSignal({
      price: 100, bid: 99.9, ask: 100.1, spreadBps: 20,
      imbalance: 0.5, deltaPct: 0.5, tradesPerSecond: 5,
      ema20_15m: 99, ema50_15m: 98, histogram15m: 3,
      ema20_5m: 99, ema50_5m: 98, histogram5m: 2, previousHistogram5m: 1,
      ema20_1m: 99, histogram1m: 1, previousHistogram1m: 0.5,
    });
    assert.equal(signal.status, "NO_TRADE");
    assert.match(signal.reasons[0], /Спред/);
  });
});

test("position size is constrained by both stop risk and notional cap", async () => {
  await withEngine(({ calculateScalpEntry }) => {
    const entry = calculateScalpEntry({ side: "LONG", bid: 99.9, ask: 100, balance: 10_000, riskPct: 0.1, stopPct: 0.1, targetPct: 0.2, feeBps: 5, maxNotionalPct: 20 });
    assert.ok(entry);
    assert.equal(entry.entryPrice, 100);
    assert.equal(entry.notional, 2_000);
    assert.equal(entry.stopPrice, 99.9);
    assert.ok(entry.targetPrice > 100.4 && entry.targetPrice < 100.401);
    assert.ok(entry.netRewardRisk >= 1.499999);
  });
});

test("fee-aware target keeps the configured stop economically viable", async () => {
  await withEngine(({ minimumTargetPctForNetRewardRisk, scalpNetRewardRisk }) => {
    const minimum = minimumTargetPctForNetRewardRisk(0.15, 5.5, 1.5);
    assert.ok(minimum > 0.5 && minimum < 0.501);
    const oldEconomics = scalpNetRewardRisk(0.15, 0.25, 5.5);
    assert.ok(oldEconomics.ratio > 0.537 && oldEconomics.ratio < 0.539);
    assert.ok(oldEconomics.breakEvenWinRate > 65 && oldEconomics.breakEvenWinRate < 65.1);
  });
});

test("paper exit uses executable bid and includes both commissions", async () => {
  await withEngine(({ evaluateScalpTrade }) => {
    const trade = {
      id: "T1", symbol: "BTCUSDT", side: "LONG", status: "OPEN", entryPrice: 100,
      quantity: 10, notional: 1_000, stopPrice: 99, targetPrice: 101, openedAt: 1,
      entryFee: 0.5, entryMode: "MANUAL",
    };
    const closed = evaluateScalpTrade(trade, 101, 101.1, 2, 5);
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.exitReason, "TP");
    assert.ok(Math.abs(closed.fees - 1.005) < 1e-9);
    assert.ok(Math.abs(closed.pnl - 8.995) < 1e-9);
  });
});

test("a scalp closes by time only after its configured maximum duration", async () => {
  await withEngine(({ evaluateScalpTrade }) => {
    const trade = {
      id: "TIME", symbol: "BTCUSDT", side: "LONG", status: "OPEN", entryPrice: 100,
      quantity: 10, notional: 1_000, stopPrice: 99, targetPrice: 102, openedAt: 1_000,
      entryFee: 0.5, entryMode: "AUTO",
    };
    const early = evaluateScalpTrade(trade, 100.2, 100.3, 30 * 60_000, 5, { maxDurationMinutes: 30 });
    assert.equal(early.status, "OPEN");
    const closed = evaluateScalpTrade(trade, 100.2, 100.3, 30 * 60_000 + 1_000, 5, { maxDurationMinutes: 30 });
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.exitReason, "TIME");
    assert.equal(closed.exitPrice, 100.2);
  });
});

test("open trade mark reports executable unrealized PnL with estimated exit commission", async () => {
  await withEngine(({ markScalpTrade }) => {
    const trade = {
      id: "LIVE", symbol: "BTCUSDT", side: "LONG", status: "OPEN", entryPrice: 100,
      quantity: 10, notional: 1_000, stopPrice: 99, targetPrice: 102, openedAt: 1,
      entryFee: 0.5, entryMode: "AUTO",
    };
    const marked = markScalpTrade(trade, 101, 101.2, 5);
    assert.equal(marked.markPrice, 101);
    assert.ok(Math.abs(marked.fees - 1.005) < 1e-9);
    assert.ok(Math.abs(marked.pnl - 8.995) < 1e-9);
    assert.ok(Math.abs(marked.pnlPct - 0.8995) < 1e-9);
  });
});

test("legacy zero-fee PnL is adjusted without rewriting the archived row", async () => {
  await withEngine(({ estimatedMissingScalpFees, feeAdjustedScalpPnl }) => {
    const trade = {
      id: "LEGACY", symbol: "ETHUSDT", side: "LONG", status: "CLOSED", entryPrice: 2_000,
      quantity: 1, notional: 2_000, stopPrice: 1_997, targetPrice: 2_005, openedAt: 1,
      entryFee: 0, entryMode: "AUTO", exitPrice: 2_005, pnl: 5, fees: 0,
    };
    assert.ok(Math.abs(estimatedMissingScalpFees(trade, 5.5) - 2.20275) < 1e-9);
    assert.ok(Math.abs(feeAdjustedScalpPnl(trade, 5.5) - 2.79725) < 1e-9);
    assert.equal(trade.pnl, 5);
  });
});

test("trade duration uses close time for completed trades and current time for open trades", async () => {
  await withEngine(({ scalpTradeDurationMinutes }) => {
    const base = { openedAt: 60_000 };
    assert.equal(scalpTradeDurationMinutes({ ...base, status: "OPEN" }, 361_000), 5);
    assert.equal(scalpTradeDurationMinutes({ ...base, status: "CLOSED", closedAt: 661_000 }, 999_000), 10);
  });
});

test("three consecutive losses activate the scalping risk lock", async () => {
  await withEngine(({ scalpRiskState }) => {
    const trades = [1, 2, 3].map((id) => ({ id: String(id), symbol: "BTCUSDT", side: "LONG", status: "CLOSED", entryPrice: 100, quantity: 1, notional: 100, stopPrice: 99, targetPrice: 101, openedAt: 1, entryFee: 0, entryMode: "AUTO", closedAt: Date.now() - id, pnl: -1 }));
    const state = scalpRiskState(trades, 10_000);
    assert.equal(state.locked, true);
    assert.equal(state.consecutiveLosses, 3);
    assert.match(state.reason, /Три убыточные/);
  });
});

test("an open position is evaluated only by a quote for the same symbol", async () => {
  await withEngine(({ isScalpTradeQuoteCompatible }) => {
    const trade = { symbol: "BTCUSDT", status: "OPEN" };
    assert.equal(isScalpTradeQuoteCompatible(trade, "BTCUSDT"), true);
    assert.equal(isScalpTradeQuoteCompatible(trade, "SOLUSDT"), false);
    assert.equal(isScalpTradeQuoteCompatible(trade, null), false);
  });
});

test("legacy cross-symbol exits are removed from scalping statistics", async () => {
  await withEngine(({ sanitizeScalpTrades }) => {
    const base = { symbol: "BTCUSDT", side: "LONG", entryPrice: 63_000, quantity: 0.03, notional: 1_890, stopPrice: 62_900, targetPrice: 63_200, openedAt: 1, entryFee: 1, entryMode: "AUTO", status: "CLOSED" };
    const result = sanitizeScalpTrades([
      { ...base, id: "valid", exitPrice: 63_200, pnlPct: 0.25 },
      { ...base, id: "broken", exitPrice: 75, pnlPct: -2401 },
    ]);
    assert.equal(result.removed, 1);
    assert.deepEqual(result.cleaned.map((trade) => trade.id), ["valid"]);
  });
});

test("journal audit preserves a broken legacy row but marks it invalid", async () => {
  await withEngine(({ auditScalpTrades, scalpRiskState }) => {
    const base = { symbol: "BTCUSDT", side: "LONG", entryPrice: 63_000, quantity: 0.03, notional: 1_890, stopPrice: 62_900, targetPrice: 63_200, openedAt: 1, entryFee: 1, entryMode: "AUTO", status: "CLOSED", closedAt: Date.now() };
    const result = auditScalpTrades([
      { ...base, id: "valid", exitPrice: 63_200, pnl: 5, pnlPct: 0.25 },
      { ...base, id: "broken", exitPrice: 75, pnl: -64_000, pnlPct: -2_401 },
    ]);
    assert.equal(result.audited.length, 2);
    assert.equal(result.invalid, 1);
    assert.equal(result.audited.find((trade) => trade.id === "broken")?.validity, "INVALID_LEGACY");
    assert.equal(scalpRiskState(result.audited, 10_000).dailyPnl, 5);
  });
});

test("scalping win rate updates for the current version and rolling twenty trades", async () => {
  await withEngine(({ SCALP_STRATEGY_VERSION, scalpPerformanceStats }) => {
    const now = new Date(2026, 7, 23, 14, 0, 0).getTime();
    const makeTrade = (id, pnl, version = SCALP_STRATEGY_VERSION, mode = "AUTO", closedAt = now) => ({
      id, symbol: "BTCUSDT", side: "LONG", status: "CLOSED",
      entryPrice: 100, quantity: 1, notional: 100, stopPrice: 99, targetPrice: 101,
      openedAt: closedAt - 60_000, closedAt, entryFee: 0.05, entryMode: mode,
      exitPrice: pnl > 0 ? 101 : 99, pnl, pnlPct: pnl, fees: 0.1, validity: "VALID",
      signalSnapshot: { version: 2, strategyVersion: version },
    });
    const history = Array.from({ length: 20 }, (_, index) => makeTrade(`old-${index}`, index < 4 ? 1 : -1, "scalp-v2", "AUTO", now - (index + 1) * 60_000));
    const before = scalpPerformanceStats(history, 5.5, now);
    assert.equal(before.currentVersion.total, 0);
    assert.equal(before.recent.winRatePct, 20);
    const afterWin = scalpPerformanceStats([makeTrade("new-win", 1), ...history], 5.5, now);
    assert.equal(afterWin.currentVersion.total, 1);
    assert.equal(afterWin.currentVersion.winRatePct, 100);
    assert.equal(afterWin.recent.total, 20);
    assert.equal(afterWin.recent.wins, 5);
    assert.equal(afterWin.recent.winRatePct, 25);
    const withManualLoss = scalpPerformanceStats([makeTrade("manual", -1, SCALP_STRATEGY_VERSION, "MANUAL"), makeTrade("new-win", 1)], 5.5, now);
    assert.equal(withManualLoss.currentVersion.winRatePct, 100, "manual decisions must not dilute the automatic strategy");
    assert.equal(withManualLoss.manual.winRatePct, 0);
  });
});

test("relative book density uses the median level and requires lifecycle persistence", async () => {
  await withEngine(({ findBookDensity }) => {
    const levels = [
      { price: 100, size: 2 }, { price: 99.9, size: 2.1 }, { price: 99.8, size: 12 },
      { price: 99.7, size: 1.9 }, { price: 99.6, size: 2 }, { price: 99.5, size: 2.2 },
    ];
    const first = findBookDensity(levels, 100.1, "BID", {}, 1_000);
    assert.ok(first);
    assert.equal(first.price, 99.8);
    assert.ok(first.ratio > 5);
    assert.equal(first.ageMs, 0);
    const persisted = findBookDensity(levels, 100.1, "BID", { ...first, observations: 3 }, 3_000);
    assert.equal(persisted.ageMs, 2_000);
    assert.equal(persisted.observations, 4);
  });
});

test("density bounce becomes READY only for an InPlay instrument with confirming tape", async () => {
  await withEngine(({ assessMicrostructureSignal }) => {
    const context = {
      price: 100, bid: 99.99, ask: 100.01, spreadBps: 2,
      imbalance: 0.2, deltaPct: 0.18, tradesPerSecond: 1.2,
      turnover24h: 500_000_000, price24hPct: 8,
      ema20_15m: 99, ema50_15m: 98, histogram15m: 1,
      densityBid: { side: "BID", price: 99.95, size: 500, notional: 49_975, ratio: 5, distanceBps: 5, ageMs: 20_000, observations: 40,
        baselineNotional: 9_995, depthNotional: 200_000, depthShare: 0.25, initialSize: 500, minSize: 450, retention: 0.9, reloads: 2 },
    };
    const ready = assessMicrostructureSignal(context);
    assert.equal(ready.status, "READY");
    assert.equal(ready.direction, "LONG");
    assert.equal(ready.strategyId, "DENSITY_BOUNCE");
    const quietMarket = assessMicrostructureSignal({ ...context, price24hPct: 1 });
    assert.equal(quietMarket.status, "WAIT");
    assert.match(quietMarket.reasons.join(" "), /InPlay/);
  });
});

test("a brief or weak wall and an opposing 15m context cannot trigger an automatic density entry", async () => {
  await withEngine(({ assessMicrostructureSignal }) => {
    const densityBid = { side: "BID", price: 99.95, size: 500, notional: 49_975, ratio: 5, distanceBps: 5, ageMs: 20_000, observations: 40,
      baselineNotional: 9_995, depthNotional: 200_000, depthShare: 0.25, initialSize: 500, minSize: 450, retention: 0.9, reloads: 2 };
    const base = {
      price: 100, bid: 99.99, ask: 100.01, spreadBps: 2,
      imbalance: 0.2, deltaPct: 0.18, tradesPerSecond: 1.2,
      turnover24h: 500_000_000, price24hPct: 8, densityBid,
      ema20_15m: 99, ema50_15m: 98, histogram15m: 1,
    };
    const brief = assessMicrostructureSignal({ ...base, densityBid: { ...densityBid, ageMs: 2_000, observations: 5, reloads: 0 } });
    assert.equal(brief.status, "WAIT");
    const opposing = assessMicrostructureSignal({ ...base, ema20_15m: 101, ema50_15m: 102, histogram15m: -1 });
    assert.equal(opposing.status, "WAIT");
    assert.match(opposing.reasons.join(" "), /15м/);
  });
});

test("impulse breakout stays in shadow mode unless explicitly enabled", async () => {
  await withEngine(({ assessMicrostructureSignal }) => {
    const breakout = { side: "SHORT", level: 100, distanceBps: -8, touches: 3, compressed: true, broken: true, volumeRatio: 2 };
    const context = {
      price: 99.92, bid: 99.91, ask: 99.93, spreadBps: 2,
      imbalance: -0.2, deltaPct: -0.3, tradesPerSecond: 2,
      turnover24h: 300_000_000, price24hPct: -7, breakoutShort: breakout,
      ema20_15m: 100.5, ema50_15m: 101, histogram15m: -1,
    };
    const shadow = assessMicrostructureSignal(context);
    assert.equal(shadow.status, "WAIT");
    assert.match(shadow.reasons.join(" "), /теневой/);
  });
});

test("impulse breakout needs compression, repeated touches, volume and directional flow", async () => {
  await withEngine(({ assessMicrostructureSignal }) => {
    const breakout = { side: "SHORT", level: 100, distanceBps: -8, touches: 3, compressed: true, broken: true, volumeRatio: 2 };
    const signal = assessMicrostructureSignal({
      price: 99.92, bid: 99.91, ask: 99.93, spreadBps: 2,
      imbalance: -0.2, deltaPct: -0.3, tradesPerSecond: 2,
      turnover24h: 300_000_000, price24hPct: -7, breakoutShort: breakout,
      ema20_15m: 100.5, ema50_15m: 101, histogram15m: -1,
      enableImpulseBreakout: true,
    });
    assert.equal(signal.status, "READY");
    assert.equal(signal.direction, "SHORT");
    assert.equal(signal.strategyId, "IMPULSE_BREAKOUT");
  });
});

test("microstructure position puts the stop behind its reference level", async () => {
  await withEngine(({ calculateMicrostructureScalpEntry }) => {
    const entry = calculateMicrostructureScalpEntry({
      side: "LONG", bid: 100, ask: 100.02, referencePrice: 99.95,
      balance: 10_000, riskPct: 0.1, targetPct: 0.5, feeBps: 5.5, maxNotionalPct: 20, bufferBps: 2,
    });
    assert.ok(entry);
    assert.ok(entry.stopPrice < 99.95);
    assert.ok(entry.targetPrice > entry.entryPrice);
    assert.ok(entry.netRewardRisk >= 1.5);
  });
});

test("strategy performance is split between density and breakout models", async () => {
  await withEngine(({ scalpPerformanceStats }) => {
    const makeTrade = (id, strategyId, pnl) => ({
      id, symbol: "BTCUSDT", side: "LONG", status: "CLOSED", entryPrice: 100, quantity: 1,
      notional: 100, stopPrice: 99, targetPrice: 101, openedAt: 1, closedAt: 2,
      entryFee: 0.05, entryMode: "AUTO", exitPrice: pnl > 0 ? 101 : 99, pnl, pnlPct: pnl,
      fees: 0.1, validity: "VALID", signalSnapshot: { version: 2, strategyVersion: "scalp-micro-v4.1", strategyId },
    });
    const stats = scalpPerformanceStats([
      makeTrade("density-win", "DENSITY_BOUNCE", 1),
      makeTrade("breakout-loss", "IMPULSE_BREAKOUT", -1),
    ], 5.5, 100);
    assert.equal(stats.byStrategy.densityBounce.winRatePct, 100);
    assert.equal(stats.byStrategy.impulseBreakout.winRatePct, 0);
    assert.equal(stats.currentVersion.total, 2);
  });
});

test("same-level re-entry is blocked for thirty minutes after a stop", async () => {
  await withEngine(({ scalpReentryAllowed }) => {
    const now = 2_000_000;
    const trade = {
      symbol: "BTCUSDT", side: "LONG", status: "CLOSED", entryMode: "AUTO", entryPrice: 100,
      closedAt: now - 10 * 60_000, exitReason: "SL", signalSnapshot: { referencePrice: 99.95 },
    };
    assert.equal(scalpReentryAllowed([trade], "BTCUSDT", "LONG", 99.96, now), false);
    assert.equal(scalpReentryAllowed([trade], "BTCUSDT", "SHORT", 99.96, now), true);
  });
});

test("scalp trade tracks favorable and adverse excursion for later stop analysis", async () => {
  await withEngine(({ evaluateScalpTrade }) => {
    const trade = {
      id: "MAE", symbol: "BTCUSDT", side: "LONG", status: "OPEN", entryPrice: 100,
      quantity: 1, notional: 100, stopPrice: 99, targetPrice: 102, openedAt: 1,
      entryFee: 0.05, entryMode: "AUTO",
    };
    const adverse = evaluateScalpTrade(trade, 99.7, 99.8, 2, 5);
    assert.equal(adverse.status, "OPEN");
    assert.ok(adverse.maxAdversePct < -0.29);
    const favorable = evaluateScalpTrade(adverse, 100.5, 100.6, 3, 5);
    assert.ok(favorable.maxFavorablePct > 0.49);
  });
});
