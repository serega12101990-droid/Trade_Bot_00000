import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { summarizeWindowStudies } from "../app/ema-window-study-stats.mjs";

const D = 300_000, T = Date.UTC(2026, 8, 8, 12);
let server, lab, journal;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  lab = await server.ssrLoadModule("/app/ema-window-study.ts");
  journal = await server.ssrLoadModule("/app/forecast-journal-store.ts");
});
after(async () => { await server?.close(); });
const candle = (time, open = 100, high = 100.2, low = 99.8, close = 100) => ({ time, open, high, low, close, volume: 1000, closed: true });
const seed = () => Array.from({ length: 200 }, (_, i) => candle(T - (200 - i) * D));
function setup(length = 4) {
  const trial = { mode: "STATISTICAL", side: "SHORT", signalTime: T - 240 * 60_000, availableAt: T, market: "crypto", entryPrice: 100, stopPrice: 104, targetPrice: 94, expiresAt: T + length * D, riskReward: 1.5, executionResolutionMinutes: 5 };
  const study = { version: "window-obstacles-v1", mode: "SHADOW", asOf: T, anchorTimeframe: "4h", market: "crypto", side: "SHORT", entryPrice: 100, stopPrice: 104, baselineTarget: 94, firstTarget: 98, fullTarget: 94, firstObstacleId: "support", breakoutLevel: 102, buffer: .1, trailDistance: 1, obstacles: [{ id: "support", kind: "SWING", timeframe: "1h", price: 97.9, low: 97.8, high: 98, knownAt: T, label: "Support" }], missingTimeframes: [], controlSeed: seed(), feeBpsPerSide: 5, slippageBpsPerSide: 5 };
  return { study, trial };
}
const run = (s, bars, resolution = 5) => lab.evaluateWindowStudy(s.study, s.trial, bars, resolution, s.trial.expiresAt + D);
const route = () => [candle(T, 100, 100.2, 97.8, 98), candle(T + D, 98, 99.3, 96, 96.5), candle(T + 2 * D, 96.5, 96.6, 95, 95.5), candle(T + 3 * D, 95.5, 95.6, 93.8, 94)];

test("map freezes only closed historical evidence and preserves the original signal", () => {
  const data = {};
  for (const [tf, duration] of [["15m", 900_000], ["30m", 1800_000], ["1h", 3600_000], ["4h", 14400_000], ["1d", 86400_000]]) {
    const end = Math.floor(T / duration) * duration;
    data[tf] = Array.from({ length: 220 }, (_, i) => { const p = 95 + Math.sin(i / 3); return candle(end - (220 - i) * duration, p, p + .5, p - .5, p + .1); });
  }
  data["5m"] = seed();
  const { trial } = setup();
  const match = { id: "ema-corridor", label: "EMA", direction: "BEAR", state: "CONFIRMED", sourcePrice: 102, routeStages: [{ price: 94 }, { price: 90 }], trial };
  const original = structuredClone(match);
  const result = lab.attachWindowStudy(match, "4h", data, T, "crypto");
  assert.ok(result.windowStudy);
  assert.deepEqual(match, original);
  assert.equal(result.trial, trial);
  assert.ok(result.windowStudy.obstacles.some(o => o.kind === "EMA"));
  const channelMap = lab.attachWindowStudy({ ...match, id: "ema-window-channel" }, "4h", data, T, "crypto").windowStudy;
  assert.ok(channelMap.obstacles.some(o => o.kind === "SWING"));
  assert.ok(result.windowStudy.obstacles.every(o => o.knownAt <= T));
  assert.match(result.windowStudy.fullTargetLabel, /4h EMA/);
  assert.ok(result.windowStudy.fullTarget < trial.entryPrice);
  const withFuture = structuredClone(data);
  withFuture["1d"].push(candle(T, 80, 200, 70, 150));
  withFuture["4h"].push({ ...candle(T - 1, 80, 200, 70, 150), closed: false });
  assert.deepEqual(lab.attachWindowStudy(match, "4h", withFuture, T, "crypto").windowStudy, result.windowStudy);
  assert.equal(lab.attachWindowStudy(result, "4h", withFuture, T + D, "crypto"), result);
});

test("partial exit weights proceeds and trails only from the next bar", () => {
  const result = run(setup(), route());
  assert.equal(result.status, "EVALUATED");
  const variants = Object.fromEntries(result.variants.map(v => [v.id, v]));
  assert.ok(Math.abs(variants.PARTIAL.grossReturnPct - 4) < 1e-9);
  assert.ok(Math.abs(variants.TRAIL.grossReturnPct - 1.5) < 1e-9);
  assert.equal(variants.TRAIL.exitTime, T + D);
  assert.equal(variants.TRAIL.exitReason, "TRAIL");
  assert.equal(variants.PARTIAL.fills.reduce((s, f) => s + f.fraction, 0), 1);
  assert.ok(variants.PARTIAL.netReturnPct < variants.PARTIAL.grossReturnPct);
  assert.equal(result.directionCorrect, true);
  assert.equal(result.firstTargetTouched, true);
  assert.equal(result.fullWindowTouched, true);
});

test("the obstacle map never silently drops barriers and TP1 cannot exceed the full window", () => {
  const data = {};
  for (const [index, [tf, duration]] of [["15m", 900_000], ["30m", 1800_000], ["1h", 3600_000], ["4h", 14400_000], ["1d", 86400_000]].entries()) {
    const end = Math.floor(T / duration) * duration;
    data[tf] = Array.from({ length: 220 }, (_, i) => {
      const p = 90 + index * 2 + i * .15 + Math.sin(i * Math.PI / 3) * 2;
      return candle(end - (220 - i) * duration, p, p + .2, p - .2, p);
    });
  }
  const s = setup();
  const match = { id: "ema-window-channel", trial: { ...s.trial, entryPrice: 150, stopPrice: 160, targetPrice: 80 } };
  const result = lab.attachWindowStudy(match, "4h", data, T, "crypto").windowStudy;
  assert.ok(result.obstacles.length > 40, `${result.obstacles.length} retained barriers`);
  assert.ok(result.firstTarget >= result.fullTarget);
  const thin = Array.from({ length: 30 }, (_, i) => candle(T - (30 - i) * 14400_000, 95, 95.1, 94.9, 95));
  const noMap = lab.attachWindowStudy({ id: "ema-corridor", trial: s.trial }, "4h", { "4h": thin }, T, "crypto").windowStudy;
  assert.equal(noMap.obstacles.length, 0);
  assert.equal(noMap.firstTarget, noMap.fullTarget);
  assert.ok(noMap.missingTimeframes.includes("4h"));
});

test("bases and impulse origins are captured without waiting for a future reaction", () => {
  const data = Array.from({ length: 220 }, (_, i) => candle(T - (220 - i) * 900_000, 95, 95.2, 94.8, 95));
  Object.assign(data[215], { open: 95, high: 97.2, low: 94.9, close: 97 });
  for (let i = 216; i < 220; i++) Object.assign(data[i], { open: 97, high: 97.2, low: 96.8, close: 97 });
  const s = setup();
  const match = { id: "ema-window-channel", trial: s.trial, sourcePrice: 102 };
  const result = lab.attachWindowStudy(match, "15m", { "15m": data, "5m": seed() }, T, "crypto");
  assert.ok(result.windowStudy.obstacles.some(o => o.kind === "IMPULSE_BASE"));
  assert.ok(result.windowStudy.obstacles.some(o => o.kind === "CONSOLIDATION"));
  assert.ok(result.windowStudy.missingTimeframes.includes("1d"));
});

test("minute execution waits for completed 5m gates and excludes the pre-availability candle", () => {
  const s = setup();
  const minutes = route().flatMap(b => Array.from({ length: 5 }, (_, i) => i === 0
    ? { ...b, time: b.time, closed: true }
    : candle(b.time + i * 60_000, b.close, b.close + .001, b.close - .001, b.close)));
  const result = run(s, minutes, 1);
  assert.equal(result.status, "EVALUATED");
  assert.equal(result.variants.find(v => v.id === "PARTIAL").fills.at(-1).time, T + 3 * D);
  const late = setup(); late.trial.availableAt = T + 30_000;
  const lateResult = run(late, minutes, 1);
  assert.equal(lateResult.status, "EVALUATED");
  assert.ok(lateResult.variants.every(v => v.fills[0].time >= T + 60_000));
});

test("far target remains locked before two completed 5m closes", () => {
  const result = run(setup(2), [candle(T, 100, 100.1, 93, 99), candle(T + D, 99, 99.2, 98.5, 99)]);
  assert.equal(result.fullWindowTouched, true, "a path touch is not a staged execution");
  const partial = result.variants.find(v => v.id === "PARTIAL");
  assert.equal(partial.exitReason, "EXPIRY");
  assert.equal(partial.fills[0].price, 98);
  assert.equal(partial.fills[1].price, 99);
  assert.equal(result.unlockedObstacles, 0);
});

test("overlapping obstacles unlock together, without requiring extra unrelated candles", () => {
  const s = setup();
  s.study.obstacles.push({ ...s.study.obstacles[0], id: "same-zone-ema", kind: "EMA" });
  const result = run(s, route());
  assert.equal(result.unlockedObstacles, 2);
  assert.equal(result.variants.find(v => v.id === "PARTIAL").exitReason, "TARGET");
});

test("gaps fill stops at a worse open and same-bar target/stop stays ambiguous", () => {
  const gap = run(setup(1), [candle(T, 106, 106.5, 105, 106)]);
  assert.equal(gap.variants[0].fills[0].price, 106);
  const both = run(setup(1), [candle(T, 100, 105, 93, 100)]);
  assert.ok(both.variants.every(v => v.ambiguous));
  assert.ok(both.variants.every(v => v.fills[0].price === 104));
});

test("missing, conflicting and unclosed candles do not become simulated profits", () => {
  assert.equal(run(setup(), route().filter((_, i) => i !== 1)).status, "PENDING_DATA");
  assert.equal(run(setup(), [...route(), { ...route()[0], low: 97 }]).status, "PENDING_DATA");
  assert.equal(run(setup(), route().map((c, i) => i === 3 ? { ...c, closed: false } : c)).status, "PENDING_DATA");
  assert.equal(run(setup(), route(), null).status, "PENDING_DATA");
  const s = setup(); s.study.controlSeed = [];
  assert.equal(run(s, route()).status, "PENDING_DATA");
});

test("future bars are ignored and identical duplicates are idempotent", () => {
  const s = setup();
  const expected = run(s, route());
  assert.deepEqual(run(s, [...route(), route()[1], candle(T + D * 5, 100, 200, 1, 100)]), expected);
  assert.equal(lab.evaluateWindowStudy(s.study, s.trial, route(), 5, T).status, "WAITING");
});

test("two closes reclaiming the boundary cancel only experimental continuation", () => {
  const s = setup(3);
  const result = run(s, [candle(T, 100, 102.7, 99.9, 102.5), candle(T + D, 102.5, 103.2, 102.4, 103), candle(T + D * 2, 103, 103.1, 99.8, 100)]);
  assert.equal(result.cancelledAt, T + 2 * D);
  assert.equal(result.variants.find(v => v.id === "PARTIAL").exitReason, "CANCEL");
  assert.equal(result.variants[0].exitReason, "EXPIRY");
  assert.equal(result.variants[0].grossReturnPct, 0);
});

test("rising lows with recovered EMA and MACD cancel a short before boundary reclaim", () => {
  const result = run(setup(), [
    candle(T, 100, 100.5, 98.2, 100.3), candle(T + D, 100.3, 100.8, 98.8, 100.6),
    candle(T + 2 * D, 100.6, 101.1, 99.2, 101), candle(T + 3 * D, 101, 101.1, 99.5, 100),
  ]);
  assert.equal(result.cancelledAt, T + 3 * D);
  assert.match(result.cancellationReason, /EMA20\/50/);
  assert.equal(result.variants.find(v => v.id === "PARTIAL").exitReason, "CANCEL");
  assert.equal(result.variants[0].exitReason, "EXPIRY");
});

test("long and short variants are symmetric before price-dependent costs", () => {
  const s = setup();
  const short = run(s, route());
  s.study.side = s.trial.side = "LONG";
  for (const k of ["stopPrice", "baselineTarget", "firstTarget", "fullTarget", "breakoutLevel"]) s.study[k] = 200 - s.study[k];
  s.trial.stopPrice = 96; s.trial.targetPrice = 106;
  s.study.obstacles = s.study.obstacles.map(o => ({ ...o, low: 200 - o.high, high: 200 - o.low, price: 200 - o.price }));
  const long = run(s, route().map(c => ({ ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close })));
  assert.equal(long.status, "EVALUATED");
  long.variants.forEach((v, i) => assert.ok(Math.abs(v.grossReturnPct - short.variants[i].grossReturnPct) < 1e-9));
});

test("raw path wins are distinct from executable outcomes and overlapping episodes", () => {
  const s = setup(); s.study.evaluation = run(s, route());
  const match = { id: "ema-corridor", label: "EMA", trial: s.trial, windowStudy: s.study };
  const record = { symbol: "SOLUSDT", market: "crypto", timeframe: "4h", asofTime: T, matches: [match] };
  const overlap = structuredClone(record); overlap.asofTime += D; overlap.matches[0].trial.signalTime += D; overlap.matches[0].trial.availableAt += D;
  const result = summarizeWindowStudies([overlap, record, record])[0];
  assert.equal(result.observations, 2); assert.equal(result.duplicates, 1); assert.equal(result.overlapping, 1);
  assert.equal(result.evaluated, 1); assert.equal(result.variants[0].evaluated, 1);
  assert.equal(result.variants[0].winRatePct, 100);
  assert.equal(result.variants[0].sampleSufficient, false);
  const uncertain = structuredClone(record); uncertain.matches[0].windowStudy.evaluation.variants.forEach(v => { v.ambiguous = true; });
  const uncertainStats = summarizeWindowStudies([uncertain])[0];
  assert.equal(uncertainStats.directionRatePct, 100);
  assert.equal(uncertainStats.variants[0].winRatePct, null);
  assert.equal(uncertainStats.variants[0].paired, 0);
});

test("journal evaluates new study even when old risk lab is already complete; old trials are preserved", (t) => {
  const s = setup();
  t.mock.method(Date, "now", () => s.trial.expiresAt + D);
  s.trial.shadowLabVersion = "risk-lab-v4"; s.trial.shadowVariants = [];
  s.trial.result = { outcome: "WIN", returnPct: 42 };
  const original = { strategyMatches: [{ id: "ema-corridor", trial: s.trial, windowStudy: s.study }] };
  assert.equal(journal.forecastNeedsRiskLab(JSON.stringify(original)), true);
  const result = journal.evaluateStrategyTrials(JSON.stringify(original), [], route());
  const parsed = JSON.parse(result.forecastJson);
  assert.equal(result.changed, true);
  assert.equal(parsed.strategyMatches[0].windowStudy.evaluation.status, "EVALUATED");
  assert.deepEqual(parsed.strategyMatches[0].trial, s.trial);
  assert.equal(journal.forecastNeedsRiskLab(result.forecastJson), false);
  const old = JSON.stringify({ strategyMatches: [{ id: "ema-corridor", trial: s.trial }] });
  assert.equal(journal.evaluateStrategyTrials(old, [], route()).changed, false);
  assert.equal(JSON.parse(journal.evaluateStrategyTrials(old, [], route()).forecastJson).strategyMatches[0].windowStudy, undefined);
});

test("a synchronized confirmed forecast carries the frozen map without replacing its original trial", async () => {
  const { buildForecast, detectEmaWindowStrategy } = await server.ssrLoadModule("/app/terminal-forecast.ts");
  const make = (closes, duration) => closes.map((close, i) => ({
    ...candle(T - (closes.length - i) * duration, close + .04, close + .25, close - .25, close),
    volume: i === closes.length - 1 ? 3000 : 1000 + i,
  }));
  const data = {
    "15m": make([...Array(217).fill(257), 257, 256.7, 256.4], 900_000),
    "5m": make([...Array.from({ length: 77 }, (_, i) => 258.5 - i * .02), 256.9, 256.7, 256.35], D),
    "1h": make(Array(220).fill(255.5), 3600_000),
    "30m": make([...Array(170).fill(250), ...Array(50).fill(254)], 1800_000),
    "4h": make(Array(80).fill(256.4), 14400_000),
  };
  data["15m"].at(-2).high = 257.25;
  data["5m"].at(-1).low = 256.15;
  const original = detectEmaWindowStrategy(data["4h"], "4h", data, "BEAR");
  assert.equal(original.state, "CONFIRMED");
  const forecast = buildForecast(data["4h"], "4h", data, null, "crypto");
  const match = forecast.strategyMatches.find(m => m.id === "ema-corridor");
  assert.equal(match.windowStudy.asOf, T);
  assert.equal(match.windowStudy.mode, "SHADOW");
  assert.deepEqual(match.trial, { ...original.trial, market: "crypto" });
  assert.ok(match.windowStudy.obstacles.length > 0);
  assert.ok(match.windowStudy.controlSeed.length >= 60);
});
