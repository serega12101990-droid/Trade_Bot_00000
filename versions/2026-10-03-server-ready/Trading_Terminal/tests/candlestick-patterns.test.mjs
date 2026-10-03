import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("harami reports its two candles and an explicit confirmation level", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { latestPatternDetails } = await server.ssrLoadModule("/app/terminal-math.ts");
    const mother = { time: 1, open: 100, high: 102, low: 88, close: 90, volume: 10, closed: true };
    const inside = { time: 2, open: 92, high: 97, low: 91, close: 96, volume: 8, closed: true };
    const pending = latestPatternDetails([mother, inside]);
    assert.equal(pending.id, "BULLISH_HARAMI");
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.startTime, 1);
    assert.equal(pending.endTime, 2);
    assert.match(pending.confirmation, /выше/);

    const confirmation = { time: 3, open: 96, high: 104, low: 95, close: 103, volume: 14, closed: true };
    const confirmed = latestPatternDetails([mother, inside, confirmation]);
    assert.equal(confirmed.id, "BULLISH_HARAMI");
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal(confirmed.confirmationTime, 3);
  } finally {
    await server.close();
  }
});
