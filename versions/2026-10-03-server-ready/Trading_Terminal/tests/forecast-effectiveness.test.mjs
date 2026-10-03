import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("quality gate refuses to promote unconfirmed 4h scenarios to trade-ready", async (context) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { buildForecast } = await server.ssrLoadModule("/app/terminal-forecast.ts");
    const snapshot = JSON.parse(await readFile(new URL("./fixtures/market-candles.json", import.meta.url), "utf8"));
    const totals = { all: 0, allCorrect: 0, ready: 0, readyCorrect: 0, waiting: 0, noTrade: 0, contradictions: 0 };

    for (const asset of snapshot.assets) {
      const candles = asset.data["4h"] ?? [];
      const last = candles.length - 9;
      const first = Math.min(205, Math.max(55, last - 36));
      const step = Math.max(1, Math.floor((last - first) / 36));
      for (let index = first; index < last; index += step) {
        const history = candles.slice(0, index + 1);
        const forecast = buildForecast(history, "4h", { "4h": history }, null, asset.market);
        if (!forecast) continue;
        const threshold = Math.max(forecast.atr * 0.42, forecast.features.close * 0.0005);
        const upperBarrier = forecast.features.close + forecast.atr * 1.05;
        const lowerBarrier = forecast.features.close - forecast.atr * 1.05;
        let actual = "SIDEWAYS";
        for (const candle of candles.slice(index + 1, index + forecast.horizonBars + 1)) {
          const bullHit = candle.high >= upperBarrier;
          const bearHit = candle.low <= lowerBarrier;
          if (bullHit && bearHit) { actual = "SIDEWAYS"; break; }
          if (bullHit) { actual = "BULL"; break; }
          if (bearHit) { actual = "BEAR"; break; }
        }
        if (actual === "SIDEWAYS") {
          const future = candles[index + forecast.horizonBars];
          const move = future.close - forecast.features.close;
          actual = move > threshold ? "BULL" : move < -threshold ? "BEAR" : "SIDEWAYS";
        }
        totals.all += 1;
        if (actual === forecast.primary) totals.allCorrect += 1;
        if (forecast.decision === "READY") {
          totals.ready += 1;
          if (actual === forecast.primary) totals.readyCorrect += 1;
        } else if (forecast.decision === "WAIT_CONFIRMATION") totals.waiting += 1;
        else totals.noTrade += 1;

        const primary = forecast.scenarios.find((scenario) => scenario.direction === forecast.primary);
        if (forecast.primary === "BULL" && primary.target <= forecast.features.close) totals.contradictions += 1;
        if (forecast.primary === "BEAR" && primary.target >= forecast.features.close) totals.contradictions += 1;
      }
    }

    const allAccuracy = totals.all ? (totals.allCorrect / totals.all) * 100 : 0;
    const readyAccuracy = totals.ready ? (totals.readyCorrect / totals.ready) * 100 : 0;
    context.diagnostic(`4h sample: all=${totals.all}, all accuracy=${allAccuracy.toFixed(1)}%, ready=${totals.ready}, ready accuracy=${readyAccuracy.toFixed(1)}%, wait=${totals.waiting}, no-trade=${totals.noTrade}`);
    assert.equal(totals.contradictions, 0);
    assert.equal(totals.ready, 0, "a scenario without a confirmed MTF entry must not be promoted to trade-ready");
    assert.ok(totals.waiting > 0, "strong but unconfirmed scenarios should wait for confirmation");
    assert.ok(totals.noTrade > 0, "weak scenarios should be explicitly rejected");
  } finally {
    await server.close();
  }
});
