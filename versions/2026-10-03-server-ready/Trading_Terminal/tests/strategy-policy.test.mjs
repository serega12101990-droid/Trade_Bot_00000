import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
  appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const policy = await server.ssrLoadModule("/app/strategy-policy.ts");
const forecastModule = await server.ssrLoadModule("/app/terminal-forecast.ts");
test.after(() => server.close());

function eligibleInput(direction = "BULL") {
  return { direction, features: { close: direction === "BULL" ? 103 : 97, ema20: 100,
    ema50: direction === "BULL" ? 99 : 101, macd: direction === "BULL" ? 2 : -2,
    macdSignal: direction === "BULL" ? 1 : -1, histogram: direction === "BULL" ? 1 : -1 },
  matches: [{ id: "mtf-entry", direction, state: "CONFIRMED", entryConfirmations:
    ["5m", "1m"].map((timeframe) => ({ timeframe, state: "CONFIRMED" })) }], entryDataFresh: true };
}

test("selective pilot admits either direction only with the full chain", () => {
  for (const direction of ["BULL", "BEAR"]) {
    const result = policy.assessStrategyPolicy(eligibleInput(direction));
    assert.equal(result.eligible, true);
    assert.deepEqual(result.participantIds, ["ema-macd-selective"]);
    assert.equal(policy.policyAllowsPaperEntry({ strategyPolicy: result }), true);
  }
});

test("MTF alone, missing minute data, wrong MACD side and stale data never admit a pilot", () => {
  const base = eligibleInput();
  const cases = [
    { ...base, features: { ...base.features, ema20: 104 } },
    { ...base, features: { ...base.features, histogram: -1 } },
    { ...base, features: { ...base.features, macd: null } },
    { ...base, entryDataFresh: false },
    { ...base, matches: [{ ...base.matches[0], entryConfirmations: [{ timeframe: "5m", state: "CONFIRMED" }] }] },
    { ...base, matches: [{ ...base.matches[0], direction: "BEAR" }] },
  ];
  for (const input of cases) {
    const result = policy.assessStrategyPolicy(input);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.participantIds, []);
    assert.ok(result.reasons.length);
  }
  assert.equal(policy.policyAllowsPaperEntry({ decision: "READY" }), false);
  assert.equal(policy.policyAllowsPaperEntry({ strategyPolicy: { version: "old", eligible: true } }), false);
});

test("disabled strategy opposition is diagnostic and cannot override an eligible pilot", () => {
  const base = eligibleInput();
  base.matches.push(...["nison", "level-action", "ema-corridor", "macd-ema-topdown"].map((id) => ({ id, direction: "BEAR", state: "CONFIRMED" })));
  assert.equal(policy.assessStrategyPolicy(base).eligible, true);
  const safety = forecastModule.forecastExecutionSafety({ primary: "BULL", current: 100, target: 104, invalidation: 98,
    selectivePolicy: true, opposingNisonConfirmed: true,
    levelAction: { alignment: "CONFLICTS", scenario: "REBOUND", riskReward: 0.2, primaryLevel: { strength: 90 } } });
  assert.equal(safety.blocked, false);
});

test("forecast ignores a forming base candle and future lower-timeframe confirmations", async () => {
  const snapshot = JSON.parse(await readFile(new URL("./fixtures/market-candles.json", import.meta.url), "utf8"));
  const asset = snapshot.assets.find((item) => item.symbol === "BTCUSDT");
  const base = asset.data["4h"].filter((candle) => candle.closed !== false);
  const normal = forecastModule.buildForecast(base, "4h", asset.data, null, asset.market);
  const forming = { ...base.at(-1), time: base.at(-1).time + 14_400_000, close: 1, high: 999999, low: 0.1, closed: false };
  const withForming = forecastModule.buildForecast([...base, forming], "4h", asset.data, null, asset.market);
  assert.deepEqual(withForming.features, normal.features);
  assert.equal(withForming.asofTime, normal.asofTime);
  const future = Object.fromEntries(["1m", "5m"].map((tf) => [tf, Array.from({ length: 60 }, (_, i) => ({
    time: forming.time + 30_000_000 + i * 300_000, open: 100 + i, close: 101 + i,
    high: 102 + i, low: 100 + i, volume: 1000, closed: true,
  }))]));
  const result = forecastModule.buildForecast(base, "4h", { ...asset.data, ...future }, null, asset.market);
  assert.equal(result.strategyPolicy.eligible, false);
  assert.notEqual(result.decision, "READY");
  assert.ok(result.strategyPolicy.reasons.some((reason) => reason.includes("минутные данные")));
  assert.equal(result.modelVersion, "scenario-v1.6.0");
});

test("complete synchronized forecasts can become READY and pass the paper guard for LONG and SHORT", async () => {
  const paper = await server.ssrLoadModule("/app/paper-trading-store.ts");
  // A deterministic oscillating trend exercises the real calibration, regime,
  // R:R and MTF gates together. This fixture proves reachability, not profitability.
  for (const sign of [1, -1]) {
    const value = (index) => 100 + sign * (index * 0.01 + Math.sin(index / 9) * 0.5 + Math.sin(index / 3) * 0.04);
    const base = Array.from({ length: 733 }, (_, index) => ({
      time: Date.UTC(2026, 3, 1) + index * 14_400_000,
      open: value(index - 1), close: value(index), high: Math.max(value(index), value(index - 1)) + 0.3,
      low: Math.min(value(index), value(index - 1)) - 0.3, volume: 1000, closed: true,
    }));
    const availableAt = base.at(-1).time + 14_400_000;
    const lower = (duration) => Array.from({ length: 90 }, (_, index) => {
      const close = base.at(-1).close + sign * (index - 89) * 0.05;
      const open = close - sign * 0.04;
      return { time: availableAt - (90 - index) * duration, open, close,
        high: Math.max(open, close) + 0.01, low: Math.min(open, close) - 0.01, volume: 1000, closed: true };
    });
    const forecast = forecastModule.buildForecast(base, "4h", { "4h": base, "5m": lower(300_000), "1m": lower(60_000) }, null, "crypto");
    assert.equal(forecast.primary, sign === 1 ? "BULL" : "BEAR");
    assert.equal(forecast.decision, "READY");
    assert.equal(forecast.strategyPolicy.eligible, true);
    assert.equal(paper.forecastAllowsNewPaperEntry(forecast.modelVersion, JSON.stringify(forecast)), true);
    assert.equal(paper.paperSignalEntryTime(forecast.asofTime, "4h", "crypto"), availableAt);
    const primary = forecast.scenarios.find((item) => item.direction === forecast.primary);
    const entry = paper.calculateSignalPaperEntry({ side: sign === 1 ? "LONG" : "SHORT",
      signalPrice: forecast.features.close, targetPrice: primary.target, stopPrice: forecast.invalidation,
      balance: 10_000, riskPerTradePct: 1, maxOpenPositions: 5, feeBps: 10, slippageBps: 5, quotePerUsdt: 1 });
    assert.ok(entry.quantity > 0);
    assert.ok(entry.riskAmount <= 35 + 1e-6);
  }
});
