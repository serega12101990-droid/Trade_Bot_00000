import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withModules(run, db = null) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const bindingKey = "__scalpPolicyTestDb";
  globalThis[bindingKey] = db;
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [{ name: "scalp-policy-test-binding", resolveId(id) { if (id === "cloudflare:workers") return "\0scalp-policy-binding"; },
      load(id) { if (id === "\0scalp-policy-binding") return `export const env = { DB: globalThis.${bindingKey} };`; } }],
  });
  try {
    await run(await server.ssrLoadModule("/app/scalping-policy.ts"),
      await server.ssrLoadModule("/app/scalping-engine.ts"),
      await server.ssrLoadModule("/app/scalping-store.ts"));
  } finally { await server.close(); delete globalThis[bindingKey]; }
}

const entryTime = Date.UTC(2026, 8, 7, 21);
function trade(id = `SCALP-BTCUSDT-${entryTime}`, overrides = {}) {
  return { id, symbol: "BTCUSDT", side: "LONG", status: "OPEN", entryPrice: 100, quantity: 10,
    notional: 1000, stopPrice: 99, targetPrice: 102, openedAt: entryTime, entryFee: 0.55,
    entryMode: "AUTO", validity: "VALID", updatedAt: entryTime,
    signalSnapshot: { version: 2, strategyId: "DENSITY_BOUNCE", strategyVersion: "scalp-micro-v4.1" }, ...overrides };
}

test("scalp pause rejects every current strategy, missing strategy and manual relabelling", async () => {
  await withModules(({ SCALP_ENTRIES_PAUSED, SCALP_STRATEGY_POLICIES, scalpEntryPermission, scalpTradePersistencePermission }) => {
    assert.equal(SCALP_ENTRIES_PAUSED, true);
    assert.equal(SCALP_STRATEGY_POLICIES.find((item) => item.strategyId === "DENSITY_BOUNCE").status, "DISABLED");
    for (const id of [...SCALP_STRATEGY_POLICIES.map((item) => item.strategyId), undefined, "UNKNOWN"]) {
      assert.equal(scalpEntryPermission(id).allowed, false);
      for (const entryMode of ["AUTO", "MANUAL"]) {
        assert.equal(scalpTradePersistencePermission(trade(undefined, { entryMode, signalSnapshot: { strategyId: id } })).allowed, false);
      }
    }
    assert.equal(scalpTradePersistencePermission(trade(undefined, { status: "CLOSED", closedAt: entryTime + 1000 })).allowed, false);
  });
});

test("disabled scalp continues marking, TP, SL and manual exits without reopening closed entries", async () => {
  await withModules(({ scalpTradePersistencePermission }, { evaluateScalpTrade }) => {
    const existing = trade();
    const marked = evaluateScalpTrade(existing, 100.3, 100.4, entryTime + 1000, 5.5);
    assert.equal(marked.status, "OPEN");
    assert.equal(scalpTradePersistencePermission(marked, existing).allowed, true);
    for (const [bid, ask, control, reason] of [[102, 102.1, false, "TP"], [99, 99.1, false, "SL"], [100.3, 100.4, true, "MANUAL"]]) {
      const closed = evaluateScalpTrade(existing, bid, ask, entryTime + 2000, 5.5, control);
      assert.equal(closed.exitReason, reason);
      assert.equal(scalpTradePersistencePermission(closed, existing).allowed, true);
      assert.equal(scalpTradePersistencePermission({ ...closed, status: "OPEN" }, closed).allowed, false);
    }
    assert.equal(scalpTradePersistencePermission({ ...existing, entryPrice: 101 }, existing).allowed, false);
  });
});

test("completed legacy import is preserved while unknown legacy OPEN entries cannot bypass pause", async () => {
  await withModules(({ SCALP_ENTRY_POLICY_EFFECTIVE_AT, scalpTradePersistencePermission }) => {
    const legacy = trade(undefined, { openedAt: SCALP_ENTRY_POLICY_EFFECTIVE_AT - 100_000 });
    assert.equal(scalpTradePersistencePermission(legacy).allowed, false);
    assert.equal(scalpTradePersistencePermission({ ...legacy, status: "CLOSED", closedAt: SCALP_ENTRY_POLICY_EFFECTIVE_AT - 50_000 }).allowed, true);
  });
});

function fakeDb(existing) {
  const rowFromTrade = (item) => ({ id: item.id, symbol: item.symbol, side: item.side, status: item.status,
    entry_price: item.entryPrice, quantity: item.quantity, notional: item.notional, stop_price: item.stopPrice,
    target_price: item.targetPrice, opened_at: item.openedAt, entry_fee: item.entryFee, entry_mode: item.entryMode,
    validity: item.validity, invalid_reason: null, signal_key: item.signalKey ?? null,
    signal_snapshot_json: JSON.stringify(item.signalSnapshot), updated_at: item.updatedAt });
  const rows = new Map(existing.map((item) => [item.id, rowFromTrade(item)]));
  const written = [];
  return { written, prepare(sql) {
    return { sql, values: [], bind(...values) { this.values = values; return this; }, async run() { return {}; },
      async all() {
        if (sql.startsWith("PRAGMA")) return { results: ["max_favorable_pct", "max_adverse_pct"].map((name) => ({ name })) };
        const selected = sql.includes("WHERE id IN") ? this.values.map((id) => rows.get(id)).filter(Boolean) : [...rows.values()];
        return { results: selected };
      } };
  }, async batch(statements) {
    for (const statement of statements) {
      if (!statement.sql.startsWith("INSERT INTO scalping_trades")) continue;
      written.push(statement.values);
      const columns = ["id", "symbol", "side", "status", "entry_price", "quantity", "notional", "stop_price", "target_price",
        "opened_at", "entry_fee", "entry_mode", "validity", "invalid_reason", "signal_key", "signal_snapshot_json",
        "closed_at", "exit_price", "pnl", "pnl_pct", "fees", "max_favorable_pct", "max_adverse_pct", "exit_reason", "created_at", "updated_at"];
      rows.set(statement.values[0], Object.fromEntries(columns.map((column, index) => [column, statement.values[index]])));
    }
    return [];
  } };
}

test("server store rejects new direct API entries but saves an existing stopped position", async () => {
  const existing = trade();
  const db = fakeDb([existing]);
  await withModules(async (_policy, { evaluateScalpTrade }, { upsertScalpingTrades }) => {
    const closed = evaluateScalpTrade(existing, 99, 99.1, entryTime + 10_000, 5.5);
    const fresh = trade(`SCALP-ETHUSDT-${entryTime + 1}`, { symbol: "ETHUSDT", openedAt: entryTime + 1 });
    const manual = trade(`SCALP-SOLUSDT-${entryTime + 2}`, { symbol: "SOLUSDT", entryMode: "MANUAL", signalSnapshot: { version: 2, strategyId: "MANUAL" } });
    const result = await upsertScalpingTrades([fresh, manual, closed]);
    assert.equal(result.rejected.length, 2);
    assert.equal(db.written.length, 1);
    assert.equal(db.written[0][0], existing.id);
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].status, "CLOSED");
    assert.equal(result.trades[0].exitReason, "SL");
  }, db);
});
