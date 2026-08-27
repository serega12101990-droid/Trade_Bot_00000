import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
try {
  const { buildForecast, SCENARIO_MODEL_VERSION } = await server.ssrLoadModule("/app/terminal-forecast.ts");
  const snapshot = JSON.parse(await readFile(new URL("../public/data/terminal_snapshot.json", import.meta.url), "utf8"));
  const timeframes = ["15m", "30m", "1h", "4h", "1d"];
  const decisions = new Map();
  const strategies = new Map();
  const ready = [];
  for (const asset of snapshot.assets) {
    for (const timeframe of timeframes) {
      const candles = asset.data?.[timeframe] ?? [];
      if (candles.length < 55) continue;
      const forecast = buildForecast(candles, timeframe, asset.data, null, asset.market);
      if (!forecast) continue;
      decisions.set(forecast.decision, (decisions.get(forecast.decision) ?? 0) + 1);
      for (const match of forecast.strategyMatches) {
        const states = strategies.get(match.id) ?? { CONFIRMED: 0, SUPPORTING: 0, WATCH: 0, trials: 0 };
        states[match.state] += 1;
        if (match.trial) states.trials += 1;
        strategies.set(match.id, states);
      }
      if (forecast.decision === "READY") ready.push({ symbol: asset.symbol, timeframe, direction: forecast.primary, weight: forecast.primaryWeight, edge: forecast.edgeMargin, strategies: forecast.strategyMatches.filter((match) => match.state === "CONFIRMED").map((match) => match.shortLabel) });
    }
  }
  console.log(JSON.stringify({ modelVersion: SCENARIO_MODEL_VERSION, decisions: Object.fromEntries(decisions), strategies: Object.fromEntries(strategies), ready }, null, 2));
} finally {
  await server.close();
}
