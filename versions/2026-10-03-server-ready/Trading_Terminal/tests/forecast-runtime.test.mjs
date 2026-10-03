import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("scenario forecast returns calibrated finite projections", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { buildForecast } = await server.ssrLoadModule("/app/terminal-forecast.ts");
    const snapshot = JSON.parse(await readFile(new URL("./fixtures/market-candles.json", import.meta.url), "utf8"));
    const cases = [
      ["BTCUSDT", "4h"],
      ["ETHUSDT", "1d"],
      ["AMD", "4h"],
      ["TSLA", "1h"],
      ["XRPUSDT", "15m"],
    ];
    for (const [symbol, timeframe] of cases) {
      const asset = snapshot.assets.find((item) => item.symbol === symbol);
      const forecast = buildForecast(asset.data[timeframe], timeframe, asset.data, null, asset.market);
      assert.ok(forecast, `${symbol} ${timeframe} should produce a forecast`);
      assert.equal(forecast.scenarios.reduce((sum, item) => sum + item.weight, 0), 100);
      assert.ok(Number.isFinite(forecast.invalidation));
      assert.ok(forecast.scenarios.every((item) => Number.isFinite(item.target)));
      assert.ok(forecast.scenarios.every((item) => item.path.length === forecast.horizonBars + 1));
      assert.equal(forecast.projectedTimes.length, forecast.horizonBars + 1);
      assert.ok(forecast.projectedTimes.every((time, index, times) => index === 0 || time > times[index - 1]));
      assert.ok(["READY", "WAIT_CONFIRMATION", "NO_TRADE"].includes(forecast.decision));
      assert.ok(Array.isArray(forecast.strategyMatches));
      assert.ok(forecast.strategyMatches.some((item) => item.id === "scenario-forecast"));
      assert.ok(forecast.vpa, `${symbol} ${timeframe} should keep a VPA snapshot`);
      assert.ok(forecast.strategyMatches.some((item) => item.id === "vpa" && item.experimental));
      assert.ok(["CONFIRMS", "NEUTRAL", "CONFLICTS"].includes(forecast.vpa.alignment));
      assert.ok(forecast.levelAction, `${symbol} ${timeframe} should keep a level-action snapshot`);
      assert.ok(forecast.strategyMatches.some((item) => item.id === "level-action" && item.experimental));
      assert.ok(["REBOUND", "BREAKOUT", "FALSE_BREAKOUT", "APPROACH", "NO_SETUP"].includes(forecast.levelAction.scenario));
      assert.ok(Number.isFinite(forecast.levelAction.primaryLevel.price));
      assert.ok(["TREND_UP", "TREND_DOWN", "RANGE", "COMPRESSION", "TRANSITION"].includes(forecast.regime));
      assert.ok(forecast.edgeMargin >= 0);
      const primary = forecast.scenarios.find((item) => item.direction === forecast.primary);
      const minimumMove = Math.max(forecast.atr * 0.42, forecast.features.close * 0.0005);
      if (forecast.primary === "BULL") assert.ok(primary.target - forecast.features.close >= minimumMove);
      if (forecast.primary === "BEAR") assert.ok(forecast.features.close - primary.target >= minimumMove);
      if (forecast.decision === "READY") {
        assert.ok(forecast.primaryWeight >= 48);
        assert.ok(forecast.edgeMargin >= 12);
      }
      if (forecast.primary !== "SIDEWAYS") {
        const confirmation = {
          direction: forecast.primary === "BULL" ? "BUY" : "SELL",
          aggressiveCandle: true,
          volumeConfirmation: true,
          patterns: [forecast.primary === "BULL" ? "BULLISH_ENGULFING" : "BEARISH_ENGULFING"],
        };
        const confirmed = buildForecast(asset.data[timeframe], timeframe, asset.data, confirmation, asset.market);
        assert.ok(confirmed, `${symbol} ${timeframe} should remain analyzable with an external confirmation`);
      }
    }
  } finally {
    await server.close();
  }
});

test("READY safety gate rejects weak R:R and strong opposing evidence", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { forecastExecutionSafety } = await server.ssrLoadModule("/app/terminal-forecast.ts");
    const clean = forecastExecutionSafety({ primary: "BULL", current: 100, target: 104, invalidation: 98 });
    assert.equal(clean.blocked, false);
    assert.equal(clean.riskReward, 2);

    const weakReward = forecastExecutionSafety({ primary: "BULL", current: 100, target: 101, invalidation: 97 });
    assert.equal(weakReward.blocked, true);
    assert.ok(weakReward.reasons.some((reason) => reason.includes("R:R")));

    const vpaConflict = forecastExecutionSafety({
      primary: "BEAR", current: 100, target: 95, invalidation: 103,
      vpa: { alignment: "CONFLICTS", confidence: 87 },
    });
    assert.equal(vpaConflict.blocked, true);
    assert.ok(vpaConflict.reasons.some((reason) => reason.includes("VPA")));

    const levelConflict = forecastExecutionSafety({
      primary: "BEAR", current: 100, target: 95, invalidation: 103,
      levelAction: {
        alignment: "CONFLICTS", scenario: "REBOUND", riskReward: 0.22,
        primaryLevel: { strength: 74 },
      },
    });
    assert.equal(levelConflict.blocked, true);
    assert.ok(levelConflict.reasons.some((reason) => reason.includes("уровень")));
  } finally {
    await server.close();
  }
});

test("EMA window can use an EMA50 boundary on a lower timeframe and EMA200 target on a higher timeframe", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { detectEmaWindowStrategy } = await server.ssrLoadModule("/app/terminal-forecast.ts");
    const makeSeries = (closes, stepMs) => closes.map((close, index) => ({
      time: Date.UTC(2026, 7, 1) + index * stepMs,
      open: close,
      high: close + 0.25,
      low: close - 0.25,
      close,
      volume: 1_000 + index,
    }));
    const lowerBoundary = makeSeries([
      ...Array(67).fill(222.4),
      222.45,
      222.3,
      222.2,
    ], 15 * 60_000);
    const current = makeSeries(Array(30).fill(222.2), 60 * 60_000);
    const higherTarget = makeSeries([
      ...Array(170).fill(217),
      ...Array(50).fill(224.5),
    ], 4 * 60 * 60_000);
    const match = detectEmaWindowStrategy(current, "1h", {
      "15m": lowerBoundary,
      "1h": current,
      "4h": higherTarget,
    }, "BEAR");

    assert.ok(match, "a clean multi-timeframe EMA window should be detected");
    assert.equal(match.id, "ema-corridor");
    assert.equal(match.sourceTimeframe, "15m");
    assert.equal(match.sourceEma, 50);
    assert.equal(match.targetTimeframe, "4h");
    assert.equal(match.targetEma, 200);
    assert.equal(match.state, "WATCH", "missing 5m and a third checked timeframe should keep the window visible without authorising an entry");
    assert.ok(match.blockers.some((item) => item.includes("5м")));
  } finally {
    await server.close();
  }
});

test("EMA route stops at the nearest higher-timeframe EMA before unlocking the next target", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { detectEmaWindowStrategy } = await server.ssrLoadModule("/app/terminal-forecast.ts");
    const start = Date.UTC(2026, 7, 14);
    const makeSeries = (closes, stepMs, volume = 1_000) => closes.map((close, index) => ({
      time: start + index * stepMs,
      open: close + 0.04,
      high: close + 0.25,
      low: close - 0.25,
      close,
      volume: index === closes.length - 1 ? volume * 2 : volume + index,
      closed: true,
    }));
    const source15m = makeSeries([
      ...Array(217).fill(257),
      257,
      256.7,
      256.4,
    ], 15 * 60_000);
    source15m[source15m.length - 2].high = 257.25;
    const entry5m = makeSeries([
      ...Array.from({ length: 77 }, (_, index) => 258.5 - index * 0.02),
      256.9,
      256.7,
      256.35,
    ], 5 * 60_000, 2_000);
    entry5m[entry5m.length - 1].low = 256.15;
    const firstBarrier1h = makeSeries(Array(220).fill(255.5), 60 * 60_000);
    const secondBarrier30m = makeSeries([
      ...Array(170).fill(250),
      ...Array(50).fill(254),
    ], 30 * 60_000);
    const selected4h = makeSeries(Array(80).fill(256.4), 4 * 60 * 60_000);

    const match = detectEmaWindowStrategy(selected4h, "4h", {
      "5m": entry5m,
      "15m": source15m,
      "30m": secondBarrier30m,
      "1h": firstBarrier1h,
      "4h": selected4h,
    }, "BEAR");

    assert.ok(match, "the rejected EMA boundary should create a route");
    assert.equal(match.sourceTimeframe, "15m");
    assert.equal(match.sourceEma, 50);
    assert.equal(match.routeStages[0].timeframe, "1h");
    assert.equal(match.routeStages[0].ema, 20);
    assert.equal(match.routeStages[0].status, "ACTIVE");
    assert.equal(match.routeStages[1].status, "LOCKED");
    assert.equal(match.routeStages[1].requiresCloseBeyondPrevious, true);
    assert.ok(match.routeStages[0].suggestedTarget > match.routeStages[0].price, "a short TP should remain just before the EMA");
    assert.ok((match.routeStages[0].suggestedTarget / match.routeStages[0].price) - 1 < 0.002, "the intraday target buffer should stay tight");
    assert.equal(match.entryConfirmations[0].timeframe, "5m");
    assert.equal(match.entryConfirmations[0].state, "CONFIRMED");
    assert.equal(match.state, "CONFIRMED");
    assert.ok(match.trial, "a confirmed EMA route should start a separate statistical trial");
    assert.equal(match.trial.availableAt, selected4h.at(-1).time + 4 * 60 * 60_000, "shadow execution starts only after the signal candle closes");
  } finally {
    await server.close();
  }
});

test("the first 15m close through EMA50 arms a window instead of being skipped", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { detectEmaWindowStrategy } = await server.ssrLoadModule("/app/terminal-forecast.ts");
    const start = Date.UTC(2026, 7, 18);
    const makeSeries = (closes, stepMs) => closes.map((close, index) => ({
      time: start + index * stepMs,
      open: close,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: 1_000,
      closed: true,
    }));
    const source15m = makeSeries([...Array(72).fill(100), ...Array(7).fill(104), 99.4], 15 * 60_000);
    Object.assign(source15m.at(-1), { open: 104, high: 104.2, low: 99.1, volume: 2_400 });
    const current1h = makeSeries(Array(80).fill(99.4), 60 * 60_000);
    const target4h = makeSeries(Array(220).fill(91), 4 * 60 * 60_000);
    const match = detectEmaWindowStrategy(current1h, "1h", { "15m": source15m, "1h": current1h, "4h": target4h }, "BEAR");

    assert.ok(match);
    assert.equal(match.sourceTimeframe, "15m");
    assert.equal(match.sourceEma, 50);
    assert.equal(match.windowPhase, "BREAK_15M");
    assert.equal(match.state, "SUPPORTING");
    assert.equal(match.trendHeldBeforeBreak, true);
    assert.ok((match.breakoutVolumeRatio ?? 0) > 2);
  } finally {
    await server.close();
  }
});
