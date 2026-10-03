import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const FIVE_MINUTES = 5 * 60_000;

async function withRiskLab(run, now = Date.UTC(2026, 8, 2, 12)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const originalNow = Date.now;
  try {
    // September 1 fixtures must not age out just because this test runs later.
    Date.now = () => now;
    await run(await server.ssrLoadModule("/app/forecast-journal-store.ts"));
  } finally {
    Date.now = originalNow;
    await server.close();
  }
}

function candle(time, { open = 100, high = 100.2, low = 99.8, close = 100, volume = 1_000 } = {}) {
  return { time, open, high, low, close, volume, closed: true };
}

function trial(signalTime, overrides = {}) {
  return {
    mode: "STATISTICAL",
    side: "LONG",
    signalTime,
    availableAt: signalTime + FIVE_MINUTES,
    market: "crypto",
    entryPrice: 100,
    targetPrice: 104,
    stopPrice: 98,
    expiresAt: signalTime + FIVE_MINUTES * 5,
    riskReward: 2,
    executionResolutionMinutes: 5,
    ...overrides,
  };
}

function preciseSeries(signalTime, postCandles) {
  const history = Array.from({ length: 25 }, (_, index) => candle(signalTime - (25 - index) * FIVE_MINUTES));
  return [...history, ...postCandles];
}

test("5m retest enters only after the confirming close and never uses that candle's earlier high", async () => {
  await withRiskLab(async ({ evaluateTrialShadowVariants }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime);
    const candles = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES, { open: 100.3, high: 101, low: 99.5, close: 100.4 }),
      candle(signalTime + FIVE_MINUTES * 2, { open: 100.4, high: 103.5, low: 100.2, close: 101.2 }),
      candle(signalTime + FIVE_MINUTES * 3, { open: 101.2, high: 103, low: 100.8, close: 102 }),
      candle(signalTime + FIVE_MINUTES * 4, { open: 102, high: 103, low: 101, close: 102.2 }),
    ]);
    const variant = evaluateTrialShadowVariants(setup, candles).find((item) => item.id === "RETEST_CONFIRM_5M");

    assert.equal(variant.status, "EVALUATED");
    assert.equal(variant.entryTime, signalTime + FIVE_MINUTES * 3);
    assert.equal(variant.entryPrice, 101.2);
    assert.equal(variant.result.exitReason, "EXPIRY", "the confirmation candle must not be replayed after its close-time entry");
    assert.ok(variant.result.returnPct > 0);
  });
});

test("5m retest is cancelled when the original stop is reached before confirmation", async () => {
  await withRiskLab(async ({ evaluateTrialShadowVariants }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime, { expiresAt: signalTime + FIVE_MINUTES * 6 });
    const candles = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES, { open: 100.3, high: 100.8, low: 99.5, close: 100.2 }),
      candle(signalTime + FIVE_MINUTES * 2, { open: 100.2, high: 100.3, low: 97.5, close: 98.5 }),
      candle(signalTime + FIVE_MINUTES * 3, { open: 98.5, high: 101.5, low: 98.4, close: 101.2 }),
      candle(signalTime + FIVE_MINUTES * 4),
      candle(signalTime + FIVE_MINUTES * 5),
    ]);
    const variant = evaluateTrialShadowVariants(setup, candles).find((item) => item.id === "RETEST_CONFIRM_5M");

    assert.equal(variant.status, "NOT_TRIGGERED");
    assert.match(variant.reason, /цель или стоп/);
  });
});

test("5m retest does not create a flat entry at the exact expiry boundary", async () => {
  await withRiskLab(async ({ evaluateTrialShadowVariants }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime);
    const candles = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES, { open: 100.2, high: 100.8, low: 99.5, close: 100.1 }),
      candle(signalTime + FIVE_MINUTES * 2, { open: 100.1, high: 100.5, low: 100.05, close: 100.2 }),
      candle(signalTime + FIVE_MINUTES * 3, { open: 100.2, high: 100.6, low: 100.1, close: 100.3 }),
      candle(signalTime + FIVE_MINUTES * 4, { open: 100.3, high: 101.2, low: 100.2, close: 101 }),
    ]);
    const variant = evaluateTrialShadowVariants(setup, candles).find((item) => item.id === "RETEST_CONFIRM_5M");

    assert.equal(variant.status, "NOT_TRIGGERED");
    assert.match(variant.reason, /слишком поздно/);
  });
});

test("EMA20 cancellation exits on the second closed 5m candle and ignores later recovery", async () => {
  await withRiskLab(async ({ evaluateTrialShadowVariants }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime, { targetPrice: 110, stopPrice: 90 });
    const candles = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES, { open: 100, high: 100.1, low: 98.8, close: 99 }),
      candle(signalTime + FIVE_MINUTES * 2, { open: 99, high: 99.2, low: 98.2, close: 98.5 }),
      candle(signalTime + FIVE_MINUTES * 3, { open: 98.5, high: 111, low: 98.4, close: 110 }),
      candle(signalTime + FIVE_MINUTES * 4, { open: 110, high: 111, low: 109, close: 110 }),
    ]);
    const variant = evaluateTrialShadowVariants(setup, candles).find((item) => item.id === "EMA20_CANCEL_5M");

    assert.equal(variant.status, "EVALUATED");
    assert.equal(variant.result.exitReason, "EMA20_CANCEL");
    assert.equal(variant.result.exitTime, signalTime + FIVE_MINUTES * 2);
    assert.equal(variant.result.exitPrice, 98.5);
  });
});

test("breakeven is armed only after a completed candle reaches 1R", async () => {
  await withRiskLab(async ({ evaluateTrialShadowVariants }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime, { targetPrice: 106, expiresAt: signalTime + FIVE_MINUTES * 3 });
    const ambiguousOrder = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES, { open: 100, high: 102.2, low: 97.5, close: 101 }),
      candle(signalTime + FIVE_MINUTES * 2),
    ]);
    const conservative = evaluateTrialShadowVariants(setup, ambiguousOrder).find((item) => item.id === "BREAKEVEN_1R");
    assert.equal(conservative.result.exitReason, "STOP", "1R and the original stop in one candle must not fabricate a breakeven exit");

    const ordered = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES, { open: 100, high: 102.2, low: 99, close: 101.5 }),
      candle(signalTime + FIVE_MINUTES * 2, { open: 101.5, high: 101.7, low: 99.5, close: 100.2 }),
    ]);
    const protectedResult = evaluateTrialShadowVariants(setup, ordered).find((item) => item.id === "BREAKEVEN_1R");
    assert.equal(protectedResult.result.exitReason, "BREAKEVEN");
    assert.equal(protectedResult.result.exitTime, signalTime + FIVE_MINUTES * 2);
    assert.equal(protectedResult.result.returnPct, 0);
  });
});

test("an incomplete low-timeframe window falls back for baseline and never fabricates 5m variants", async () => {
  await withRiskLab(async ({ evaluateStrategyTrials }) => {
    const hour = 60 * 60_000;
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime, { targetPrice: 104, stopPrice: 96, expiresAt: signalTime + hour * 4, executionResolutionMinutes: 1 });
    const fallback = [
      candle(signalTime + hour, { high: 102, low: 99, close: 101 }),
      candle(signalTime + hour * 2, { high: 105, low: 100, close: 104 }),
      candle(signalTime + hour * 3, { high: 104.5, low: 103, close: 104 }),
      candle(signalTime + hour * 4, { high: 104.5, low: 103, close: 104 }),
    ];
    const precise = [
      candle(signalTime + hour * 3 + FIVE_MINUTES * 4),
      candle(signalTime + hour * 3 + FIVE_MINUTES * 5),
    ];
    const forecastJson = JSON.stringify({
      strategyMatches: [{ id: "ema-corridor", label: "EMA", shortLabel: "EMA", tone: "violet", state: "CONFIRMED", direction: "BULL", summary: "test", trial: setup }],
    });
    const evaluated = evaluateStrategyTrials(forecastJson, fallback, precise);
    const savedTrial = JSON.parse(evaluated.forecastJson).strategyMatches[0].trial;

    assert.equal(evaluated.changed, true);
    assert.equal(savedTrial.result.exitReason, "TARGET");
    assert.equal(savedTrial.shadowLabVersion, "risk-lab-v4");
    assert.ok(savedTrial.shadowVariants.every((variant) => variant.status === "PENDING_DATA" && variant.eligible === false));
  });
});

test("missing lower-timeframe history expires without inventing results after the recovery window", async () => {
  await withRiskLab(async ({ evaluateTrialShadowVariants }) => {
    const setup = trial(Date.UTC(2026, 8, 1, 12));
    const variants = evaluateTrialShadowVariants(setup, []);
    assert.ok(variants.length > 0);
    assert.ok(variants.every(variant => variant.status === "UNAVAILABLE" && variant.eligible === false && !variant.result));
  }, Date.UTC(2026, 8, 20, 12));
});

test("trial excursions keep MFE non-negative and MAE non-positive", async () => {
  await withRiskLab(async ({ evaluateTrialBaseline }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const longResult = evaluateTrialBaseline(
      trial(signalTime, { targetPrice: 110, stopPrice: 90 }),
      [candle(signalTime + FIVE_MINUTES, { open: 99, high: 99.5, low: 97, close: 98 })],
    );
    assert.equal(longResult.maxFavorablePct, 0);
    assert.ok(longResult.maxAdversePct < 0);

    const shortResult = evaluateTrialBaseline(
      trial(signalTime, { side: "SHORT", targetPrice: 90, stopPrice: 110 }),
      [candle(signalTime + FIVE_MINUTES, { open: 101, high: 103, low: 100.5, close: 102 })],
    );
    assert.equal(shortResult.maxFavorablePct, 0);
    assert.ok(shortResult.maxAdversePct < 0);
  });
});

test("risk lab starts at the actual signal availability time and rejects internal gaps", async () => {
  await withRiskLab(async ({ evaluateTrialBaseline, hasCompleteLowTimeframeCoverage }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime, { expiresAt: signalTime + FIVE_MINUTES * 4 });
    const result = evaluateTrialBaseline(setup, [
      candle(signalTime + 60_000, { high: 105, low: 99, close: 104 }),
      candle(signalTime + FIVE_MINUTES, { high: 101, low: 99, close: 100 }),
      candle(signalTime + FIVE_MINUTES * 2, { high: 101, low: 99, close: 100 }),
      candle(signalTime + FIVE_MINUTES * 3, { high: 101, low: 99, close: 100 }),
      candle(signalTime + FIVE_MINUTES * 4, { high: 101, low: 99, close: 100 }),
    ]);
    assert.equal(result.exitReason, "EXPIRY", "movement before availableAt must not become a target hit");

    const complete = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES),
      candle(signalTime + FIVE_MINUTES * 2),
      candle(signalTime + FIVE_MINUTES * 3),
      candle(signalTime + FIVE_MINUTES * 4),
    ]);
    assert.equal(hasCompleteLowTimeframeCoverage(setup, complete), true);
    assert.equal(hasCompleteLowTimeframeCoverage(setup, complete.filter((item) => item.time !== signalTime + FIVE_MINUTES * 2)), false);
    assert.equal(hasCompleteLowTimeframeCoverage(setup, complete.filter((item) => item.time !== signalTime + FIVE_MINUTES)), false);
  });
});

test("baseline excursions stop accumulating when TP or SL closes the trial", async () => {
  await withRiskLab(async ({ evaluateTrialBaseline }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const result = evaluateTrialBaseline(
      trial(signalTime, { targetPrice: 104, stopPrice: 96 }),
      [
        candle(signalTime + FIVE_MINUTES, { open: 100, high: 104.2, low: 99, close: 104 }),
        candle(signalTime + FIVE_MINUTES * 2, { open: 104, high: 140, low: 60, close: 80 }),
      ],
    );

    assert.equal(result.exitReason, "TARGET");
    assert.equal(result.exitTime, signalTime + FIVE_MINUTES);
    assert.ok(result.maxFavorablePct < 5, "post-exit highs must not inflate MFE");
    assert.ok(result.maxAdversePct > -2, "post-exit lows must not inflate MAE");
  });
});

test("risk-lab migration never rewrites a stored baseline result", async () => {
  await withRiskLab(async ({ evaluateStrategyTrials }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const oldTrial = trial(signalTime, {
      targetPrice: 104,
      stopPrice: 96,
      expiresAt: signalTime + FIVE_MINUTES * 3,
      result: {
        outcome: "WIN",
        exitReason: "TARGET",
        exitTime: signalTime + FIVE_MINUTES,
        exitPrice: 104,
        returnPct: 4,
        maxFavorablePct: 40,
        maxAdversePct: 2,
      },
    });
    const fallback = [
      candle(signalTime + FIVE_MINUTES, { open: 100, high: 104.2, low: 99, close: 104 }),
      candle(signalTime + FIVE_MINUTES * 2, { open: 104, high: 140, low: 60, close: 80 }),
    ];
    const forecastJson = JSON.stringify({
      strategyMatches: [{ id: "ema-corridor", label: "EMA", shortLabel: "EMA", tone: "violet", state: "CONFIRMED", direction: "BULL", summary: "test", trial: oldTrial }],
    });
    const migrated = evaluateStrategyTrials(forecastJson, fallback, []);
    const saved = JSON.parse(migrated.forecastJson).strategyMatches[0].trial;

    assert.equal(saved.shadowLabVersion, "risk-lab-v4");
    assert.equal(saved.result.exitReason, "TARGET");
    assert.equal(saved.result.maxFavorablePct, 40);
    assert.equal(saved.result.maxAdversePct, 2);
    assert.ok(saved.shadowVariants.every((variant) => variant.status === "PENDING_DATA"));
  });
});

test("risk-lab aggregation separates eligible, evaluated and not-triggered observations", async () => {
  await withRiskLab(async ({ summarizeTrialShadowVariants }) => {
    const result = { outcome: "WIN", exitReason: "TARGET", exitTime: 2, exitPrice: 102, returnPct: 2, maxFavorablePct: 2, maxAdversePct: -0.5 };
    const stats = summarizeTrialShadowVariants([
      { labVersion: "risk-lab-v4", id: "RETEST_CONFIRM_5M", label: "Retest", status: "EVALUATED", eligible: true, dataResolutionMinutes: 5, reason: "test", baselineReturnPct: -1, result },
      { labVersion: "risk-lab-v4", id: "RETEST_CONFIRM_5M", label: "Retest", status: "NOT_TRIGGERED", eligible: true, dataResolutionMinutes: 5, reason: "test", baselineReturnPct: 2 },
      { labVersion: "risk-lab-v4", id: "RETEST_CONFIRM_5M", label: "Retest", status: "UNAVAILABLE", eligible: false, dataResolutionMinutes: null, reason: "test" },
    ]).find((item) => item.id === "RETEST_CONFIRM_5M");

    assert.equal(stats.eligible, 2);
    assert.equal(stats.observations, 3);
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.triggered, 1);
    assert.equal(stats.notTriggered, 1);
    assert.equal(stats.unavailable, 1);
    assert.equal(stats.avoidedLosses, 1);
    assert.equal(stats.missedWinners, 1);
    assert.equal(stats.averageDeltaVsBaselinePct, 0.5);
    assert.equal(stats.averageExecutedDeltaVsBaselinePct, 3);
    assert.equal(stats.wins, 1);
    assert.equal(stats.winRatePct, 100);
    assert.equal(stats.sampleSufficient, false);
    assert.equal(stats.promotionCandidate, false);
  });
});

test("risk-lab paired delta uses the same low-timeframe baseline instead of a legacy result", async () => {
  await withRiskLab(async ({ evaluateTrialShadowVariants }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const setup = trial(signalTime, { targetPrice: 104, stopPrice: 96 });
    const candles = preciseSeries(signalTime, [
      candle(signalTime + FIVE_MINUTES, { open: 100, high: 101, low: 99, close: 100.5 }),
      candle(signalTime + FIVE_MINUTES * 2, { open: 100.5, high: 104.2, low: 100, close: 104 }),
      candle(signalTime + FIVE_MINUTES * 3, { open: 104, high: 104.2, low: 103, close: 103.5 }),
      candle(signalTime + FIVE_MINUTES * 4, { open: 103.5, high: 104, low: 103, close: 103.8 }),
    ]);
    const legacyBaseline = { outcome: "LOSS", exitReason: "STOP", exitTime: 1, exitPrice: 96, returnPct: -4, maxFavorablePct: 0, maxAdversePct: -4 };
    const variants = evaluateTrialShadowVariants(setup, candles, legacyBaseline);

    assert.ok(variants.every((variant) => Math.abs(variant.baselineReturnPct - 4) < 1e-9));
  });
});

test("strategy-specific migration leaves trials from other strategies untouched", async () => {
  await withRiskLab(async ({ evaluateStrategyTrials }) => {
    const signalTime = Date.UTC(2026, 8, 1, 12);
    const emaTrial = trial(signalTime, { result: { outcome: "WIN", exitReason: "TARGET", exitTime: signalTime + FIVE_MINUTES, exitPrice: 104, returnPct: 4, maxFavorablePct: 4, maxAdversePct: -1 } });
    const otherTrial = trial(signalTime, { result: { outcome: "LOSS", exitReason: "STOP", exitTime: signalTime + FIVE_MINUTES, exitPrice: 98, returnPct: -2, maxFavorablePct: 0, maxAdversePct: -2 } });
    const forecastJson = JSON.stringify({ strategyMatches: [
      { id: "ema-corridor", label: "EMA", shortLabel: "EMA", tone: "violet", state: "CONFIRMED", direction: "BULL", summary: "test", trial: emaTrial },
      { id: "mtf-confirmation", label: "MTF", shortLabel: "MTF", tone: "cyan", state: "CONFIRMED", direction: "BULL", summary: "test", trial: otherTrial },
    ] });
    const migrated = evaluateStrategyTrials(forecastJson, [], [], "ema-corridor");
    const matches = JSON.parse(migrated.forecastJson).strategyMatches;

    assert.equal(matches[0].trial.shadowLabVersion, "risk-lab-v4");
    assert.equal(matches[1].trial.shadowLabVersion, undefined);
  });
});
