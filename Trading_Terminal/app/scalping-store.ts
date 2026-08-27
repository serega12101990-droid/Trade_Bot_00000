import { auditScalpTrades, type ScalpPaperTrade, type ScalpSignalSnapshot } from "./scalping-engine";

type D1 = D1Database;

type ScalpTradeRow = {
  id: string;
  symbol: string;
  side: ScalpPaperTrade["side"];
  status: ScalpPaperTrade["status"];
  entry_price: number;
  quantity: number;
  notional: number;
  stop_price: number;
  target_price: number;
  opened_at: number;
  entry_fee: number;
  entry_mode: ScalpPaperTrade["entryMode"];
  validity: "VALID" | "INVALID_LEGACY";
  invalid_reason: string | null;
  signal_key: string | null;
  signal_snapshot_json: string | null;
  closed_at: number | null;
  exit_price: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  fees: number | null;
  max_favorable_pct: number | null;
  max_adverse_pct: number | null;
  exit_reason: ScalpPaperTrade["exitReason"] | null;
  created_at: number;
  updated_at: number;
};

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS scalping_trades (
  id TEXT PRIMARY KEY NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  entry_price REAL NOT NULL,
  quantity REAL NOT NULL,
  notional REAL NOT NULL,
  stop_price REAL NOT NULL,
  target_price REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  entry_fee REAL NOT NULL,
  entry_mode TEXT NOT NULL,
  validity TEXT NOT NULL DEFAULT 'VALID',
  invalid_reason TEXT,
  signal_key TEXT,
  signal_snapshot_json TEXT,
  closed_at INTEGER,
  exit_price REAL,
  pnl REAL,
  pnl_pct REAL,
  fees REAL,
  max_favorable_pct REAL,
  max_adverse_pct REAL,
  exit_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

let schemaReady = false;

async function ensureColumn(db: D1, column: string, definition: string) {
  const info = await db.prepare("PRAGMA table_info(scalping_trades)").all<{ name: string }>();
  if (((info.results ?? []) as Array<{ name: string }>).some((item) => item.name === column)) return;
  await db.prepare(`ALTER TABLE scalping_trades ADD COLUMN ${column} ${definition}`).run();
}

async function getBinding() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("База журнала скальпинга недоступна. Перезапустите терминал.");
  return env.DB;
}

export async function ensureScalpingSchema() {
  const db = await getBinding();
  if (schemaReady) return db;
  await db.batch([
    db.prepare(CREATE_TABLE),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_scalping_status_opened ON scalping_trades (status, opened_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_scalping_symbol_opened ON scalping_trades (symbol, opened_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_scalping_validity_closed ON scalping_trades (validity, closed_at)"),
  ]);
  await ensureColumn(db, "max_favorable_pct", "REAL");
  await ensureColumn(db, "max_adverse_pct", "REAL");
  await db.prepare("PRAGMA optimize").run();
  schemaReady = true;
  return db;
}

function parseSnapshot(value: string | null): ScalpSignalSnapshot | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ScalpSignalSnapshot;
    return parsed && parsed.version === 2 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mapRow(row: ScalpTradeRow): ScalpPaperTrade {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    status: row.status,
    entryPrice: row.entry_price,
    quantity: row.quantity,
    notional: row.notional,
    stopPrice: row.stop_price,
    targetPrice: row.target_price,
    openedAt: row.opened_at,
    entryFee: row.entry_fee,
    entryMode: row.entry_mode,
    validity: row.validity,
    invalidReason: row.invalid_reason ?? undefined,
    signalKey: row.signal_key ?? undefined,
    signalSnapshot: parseSnapshot(row.signal_snapshot_json),
    closedAt: row.closed_at ?? undefined,
    exitPrice: row.exit_price ?? undefined,
    pnl: row.pnl ?? undefined,
    pnlPct: row.pnl_pct ?? undefined,
    fees: row.fees ?? undefined,
    maxFavorablePct: row.max_favorable_pct ?? undefined,
    maxAdversePct: row.max_adverse_pct ?? undefined,
    exitReason: row.exit_reason ?? undefined,
    updatedAt: row.updated_at,
  };
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function isAcceptableTrade(trade: ScalpPaperTrade) {
  return /^SCALP-[A-Z0-9]{3,20}-\d{8,20}$/.test(trade.id)
    && /^[A-Z0-9]{3,20}$/.test(trade.symbol)
    && ["LONG", "SHORT"].includes(trade.side)
    && ["OPEN", "CLOSED"].includes(trade.status)
    && ["AUTO", "MANUAL"].includes(trade.entryMode)
    && [trade.entryPrice, trade.quantity, trade.notional, trade.stopPrice, trade.targetPrice, trade.openedAt, trade.entryFee].every(finite);
}

export async function upsertScalpingTrades(input: ScalpPaperTrade[]) {
  const db = await ensureScalpingSchema();
  const audited = auditScalpTrades(input.filter(isAcceptableTrade)).audited.slice(0, 2_000);
  for (let offset = 0; offset < audited.length; offset += 50) {
    const statements = audited.slice(offset, offset + 50).map((trade) => {
      const now = Date.now();
      const updatedAt = trade.updatedAt ?? trade.closedAt ?? trade.openedAt ?? now;
      return db.prepare(`INSERT INTO scalping_trades (
        id, symbol, side, status, entry_price, quantity, notional, stop_price, target_price,
        opened_at, entry_fee, entry_mode, validity, invalid_reason, signal_key, signal_snapshot_json,
        closed_at, exit_price, pnl, pnl_pct, fees, max_favorable_pct, max_adverse_pct, exit_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol, side = excluded.side, status = excluded.status,
        entry_price = excluded.entry_price, quantity = excluded.quantity, notional = excluded.notional,
        stop_price = excluded.stop_price, target_price = excluded.target_price, opened_at = excluded.opened_at,
        entry_fee = excluded.entry_fee, entry_mode = excluded.entry_mode, validity = excluded.validity,
        invalid_reason = excluded.invalid_reason, signal_key = excluded.signal_key,
        signal_snapshot_json = excluded.signal_snapshot_json, closed_at = excluded.closed_at,
        exit_price = excluded.exit_price, pnl = excluded.pnl, pnl_pct = excluded.pnl_pct,
        fees = excluded.fees, max_favorable_pct = excluded.max_favorable_pct,
        max_adverse_pct = excluded.max_adverse_pct, exit_reason = excluded.exit_reason, updated_at = excluded.updated_at
      WHERE excluded.updated_at >= scalping_trades.updated_at`)
        .bind(
          trade.id, trade.symbol, trade.side, trade.status, trade.entryPrice, trade.quantity, trade.notional,
          trade.stopPrice, trade.targetPrice, trade.openedAt, trade.entryFee, trade.entryMode,
          trade.validity ?? "VALID", trade.invalidReason ?? null, trade.signalKey ?? null,
          trade.signalSnapshot ? JSON.stringify(trade.signalSnapshot) : null, trade.closedAt ?? null,
          trade.exitPrice ?? null, trade.pnl ?? null, trade.pnlPct ?? null, trade.fees ?? null,
          trade.maxFavorablePct ?? null, trade.maxAdversePct ?? null, trade.exitReason ?? null, trade.openedAt, updatedAt,
        );
    });
    if (statements.length) await db.batch(statements);
  }
  return readScalpingTrades();
}

export async function readScalpingTrades(limit = 2_000) {
  const db = await ensureScalpingSchema();
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 2_000);
  const result = await db.prepare("SELECT * FROM scalping_trades ORDER BY opened_at DESC LIMIT ?")
    .bind(safeLimit)
    .all<ScalpTradeRow>();
  const trades = (result.results ?? []).map(mapRow);
  const validClosed = trades.filter((trade) => trade.status === "CLOSED" && trade.validity !== "INVALID_LEGACY");
  return {
    trades,
    total: trades.length,
    validClosed: validClosed.length,
    invalid: trades.filter((trade) => trade.validity === "INVALID_LEGACY").length,
  };
}
