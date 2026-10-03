import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
  appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const store = await server.ssrLoadModule("/app/scalping-observation-store.ts");
test.after(() => server.close());
const now = Date.now() - 1000;
const observation = (overrides = {}) => ({ symbol: "BTCUSDT", signalKey: "BTCUSDT:BOUNCE:LONG:123",
  capturedAt: now, policyVersion: "spoofed", entryAllowed: true, entryBlockReason: null,
  snapshot: { version: 2, signalKey: "BTCUSDT:BOUNCE:LONG:123", capturedAt: now, status: "READY",
    strategyId: "DENSITY_BOUNCE", direction: "LONG", price: 100 }, ...overrides });

test("shadow observation validates input and recomputes execution permission on server", () => {
  const [value] = store.validatedScalpObservations([observation()], now);
  assert.equal(value.entryAllowed, false);
  assert.notEqual(value.policyVersion, "spoofed");
  assert.ok(value.entryBlockReason);
  for (const invalid of [null, {}, observation({ symbol: "../file" }), observation({ capturedAt: now + 120_000 }),
    observation({ snapshot: { ...observation().snapshot, price: -1 } }),
    observation({ snapshot: { ...observation().snapshot, strategyId: "unknown" } }),
    observation({ snapshot: { ...observation().snapshot, signalKey: "changed" } })]) {
    assert.equal(store.validatedScalpObservations([invalid], now).length, 0);
  }
});

test("D1 shadow journal retries are idempotent and never overwrite first snapshot or affect balance", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../drizzle/0008_wild_black_tom.sql", import.meta.url), "utf8"));
  const db = {
    prepare(sql) { return { sql, args: [], bind(...args) { this.args = args; return this; },
      async first() { return sqlite.prepare(sql).get(...this.args); } }; },
    async batch(statements) { return statements.map((item) => sqlite.prepare(item.sql).run(...item.args)); },
  };
  try {
    const first = await store.saveScalpObservations([observation()], db);
    assert.equal(first.total, 1);
    assert.deepEqual(first.acceptedKeys, [observation().signalKey]);
    const retry = await store.saveScalpObservations([observation({ snapshot: { ...observation().snapshot, price: 200 } })], db);
    assert.equal(retry.total, 1);
    const saved = JSON.parse(sqlite.prepare("SELECT observation_json FROM scalping_observations").get().observation_json);
    assert.equal(saved.snapshot.price, 100);
    assert.deepEqual(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name), ["scalping_observations"]);
  } finally { sqlite.close(); }
});
