import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function loadStatuses() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const loaded = await server.ssrLoadModule("/app/market-center-status.ts");
  return { server, ...loaded };
}

test("market clocks identify the sessions shown at 07:10 Moscow time", async () => {
  const { server, getMarketCenterStatus } = await loadStatuses();
  try {
    const time = Date.parse("2026-08-10T04:10:00Z");
    assert.equal(getMarketCenterStatus("Europe/Moscow", time).label, "Утренняя");
    assert.equal(getMarketCenterStatus("Europe/London", time).label, "Закрыто");
    assert.equal(getMarketCenterStatus("America/New_York", time).label, "Закрыто");
    assert.equal(getMarketCenterStatus("Asia/Hong_Kong", time).label, "Перерыв");
  } finally {
    await server.close();
  }
});

test("New York clock separates premarket, regular and postmarket", async () => {
  const { server, getMarketCenterStatus } = await loadStatuses();
  try {
    assert.equal(getMarketCenterStatus("America/New_York", Date.parse("2026-08-10T12:00:00Z")).label, "Премаркет");
    assert.equal(getMarketCenterStatus("America/New_York", Date.parse("2026-08-10T14:00:00Z")).label, "Открыто");
    assert.equal(getMarketCenterStatus("America/New_York", Date.parse("2026-08-10T21:00:00Z")).label, "Постмаркет");
  } finally {
    await server.close();
  }
});

