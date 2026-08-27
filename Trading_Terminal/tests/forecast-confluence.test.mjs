import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withConfluence(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { await run(await server.ssrLoadModule("/app/forecast-confluence.ts")); } finally { await server.close(); }
}

test("confluence is diagnostic and exposes aligned 5m/1m confirmations", async () => {
  await withConfluence(({ forecastConfluence }) => {
    const result = forecastConfluence("BULL", [
      { id: "ema-corridor", label: "EMA", shortLabel: "EMA", tone: "violet", state: "CONFIRMED", direction: "BULL", summary: "Окно свободно" },
      { id: "legacy-macd", label: "MACD", shortLabel: "MACD", tone: "blue", state: "SUPPORTING", direction: "BULL", summary: "Импульс растёт" },
      { id: "nison", label: "Нисон", shortLabel: "НИСОН", tone: "amber", state: "CONFIRMED", direction: "BULL", summary: "Поглощение подтверждено" },
      { id: "mtf-entry", label: "MTF", shortLabel: "MTF", tone: "teal", state: "CONFIRMED", direction: "BULL", summary: "Вход подтверждён", entryConfirmations: [
        { timeframe: "5m", state: "CONFIRMED", macdSupports: true, candleSupports: true, volumeSupports: true, summary: "5м подтверждает" },
        { timeframe: "1m", state: "SUPPORTING", macdSupports: true, candleSupports: false, volumeSupports: false, summary: "1м формируется" },
      ] },
    ]);
    assert.equal(result.grade, "STRONG");
    assert.equal(result.items.find((item) => item.id === "5m").state, "CONFIRMED");
    assert.equal(result.items.find((item) => item.id === "1m").state, "SUPPORTING");
  });
});

test("an opposite candle signal is shown as a conflict instead of strengthening the idea", async () => {
  await withConfluence(({ forecastConfluence }) => {
    const result = forecastConfluence("BULL", [
      { id: "nison", label: "Нисон", shortLabel: "НИСОН", tone: "amber", state: "CONFIRMED", direction: "BEAR", summary: "Медвежья модель" },
    ]);
    assert.equal(result.items.find((item) => item.id === "nison").state, "CONFLICT");
    assert.equal(result.grade, "INSUFFICIENT");
  });
});

test("missing and weak opposite strategies stay neutral while confirmed opposition blocks", async () => {
  await withConfluence(({ forecastConfluence, strategyAgreement }) => {
    const weak = { id: "legacy-macd", label: "MACD", shortLabel: "MACD", tone: "blue", state: "WATCH", direction: "BEAR", summary: "Данных недостаточно" };
    const aligned = { id: "ema-corridor", label: "EMA", shortLabel: "EMA", tone: "violet", state: "CONFIRMED", direction: "BULL", summary: "Окно подтверждено" };
    const neutralResult = forecastConfluence("BULL", [aligned, weak]);
    assert.equal(neutralResult.items.find((item) => item.id === "macd").state, "UNAVAILABLE");
    assert.equal(strategyAgreement("BULL", [aligned, weak]).blocked, false);

    const confirmedOpposite = { ...weak, state: "CONFIRMED", summary: "Подтверждённый медвежий импульс" };
    const conflict = strategyAgreement("BULL", [aligned, confirmedOpposite]);
    assert.equal(conflict.blocked, true);
    assert.equal(conflict.confirmedConflicts.length, 1);
  });
});
