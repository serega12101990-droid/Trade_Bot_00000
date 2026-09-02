import { getExecutionMarketData, getMoexLotSize } from "./market-data-service";
import { ensureForecastSchema, evaluateDueForecasts } from "./forecast-journal-store";
import { getMarketSessionState, nextMarketBarTime } from "./market-calendar";
import { SCENARIO_MODEL_VERSION } from "./terminal-forecast";
import type {
  Candle,
  ForecastDecision,
  ForecastDirection,
  ForecastProjection,
  ForecastStrategyId,
  ForecastStrategyMatch,
  ForecastStrategyTone,
  Market,
  PaperAccount,
  PaperEntryMode,
  PaperEntryBlockReason,
  PaperEntrySource,
  PaperQuoteCurrency,
  PaperTrade,
  PaperTradeExitReason,
  PaperTradeSide,
  PaperTradeStatus,
  PaperTradeTimeSource,
  PaperShadowOutcome,
  PaperTradingPayload,
  Timeframe,
} from "./terminal-types";

type D1 = D1Database;

const ACCOUNT_ID = "northstar-paper-default";
const DEFAULT_BALANCE = 10_000;
const DEFAULT_RISK_PCT = 1;
const DEFAULT_FEE_BPS = 10;
const DEFAULT_SLIPPAGE_BPS = 5;
const DEFAULT_MAX_POSITIONS = 5;
const DEFAULT_ENTRY_MODE: PaperEntryMode = "MANUAL";
const DEFAULT_RUB_PER_USDT = 80;
const MAX_EXECUTION_HISTORY_GAP_MS = 30 * 60_000;
const MAX_ENTRY_MARK_AGE_MS = 5 * 60_000;
const MAX_MOEX_DELAYED_MARK_AGE_MS = 20 * 60_000;
const MINIMUM_ENTRY_NET_REWARD_RISK = 1;

export function hasContinuousExecutionHistory(
  market: Market,
  lastProcessedTime: number,
  candles: Candle[],
) {
  const closed = candles
    .filter((candle) => candle.closed !== false)
    .sort((left, right) => left.time - right.time);
  const firstUnprocessed = closed.find((candle) => candle.time > lastProcessedTime);
  if (!firstUnprocessed) return false;
  const expectedNext = nextMarketBarTime(lastProcessedTime, "1m", market);
  if (firstUnprocessed.time < expectedNext + MAX_EXECUTION_HISTORY_GAP_MS) return true;

  // MOEX omits minutes without trades. A sparse instrument can therefore jump
  // from the end of one session to the next traded minute even though ISS
  // returned the complete requested range. Seeing the already processed candle
  // in the same response proves that the cursor is covered and the gap consists
  // of empty bars rather than a truncated response after a server outage.
  return closed.some((candle) => candle.time === lastProcessedTime);
}

const CREATE_ACCOUNT_TABLE = `CREATE TABLE IF NOT EXISTS paper_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  initial_balance REAL NOT NULL,
  balance REAL NOT NULL,
  risk_per_trade_pct REAL NOT NULL,
  fee_bps REAL NOT NULL,
  slippage_bps REAL NOT NULL,
  max_open_positions INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  entry_mode TEXT NOT NULL DEFAULT 'MANUAL',
  rub_per_usdt REAL NOT NULL DEFAULT 80,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_TRADE_TABLE = `CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  entry_source TEXT NOT NULL DEFAULT 'AUTO',
  quote_currency TEXT NOT NULL DEFAULT 'USDT',
  fx_rate REAL NOT NULL DEFAULT 1,
  signal_time INTEGER NOT NULL,
  due_time INTEGER NOT NULL,
  entry_time INTEGER,
  entry_time_source TEXT NOT NULL DEFAULT 'TIMEFRAME_CANDLE',
  first_entry_time INTEGER,
  scale_in_count INTEGER NOT NULL DEFAULT 0,
  exit_time INTEGER,
  exit_time_source TEXT,
  entry_price REAL,
  target_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  exit_price REAL,
  quantity REAL,
  notional REAL,
  risk_amount REAL,
  fees REAL NOT NULL DEFAULT 0,
  fees_native REAL NOT NULL DEFAULT 0,
  realized_pnl REAL,
  realized_pnl_native REAL,
  pnl_pct REAL,
  unrealized_pnl REAL,
  unrealized_pnl_native REAL,
  unrealized_pnl_pct REAL,
  last_price REAL,
  max_favorable_pct REAL,
  max_adverse_pct REAL,
  exit_reason TEXT,
  last_processed_time INTEGER,
  entry_block_reason TEXT,
  entry_block_detail TEXT,
  entry_blocked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES paper_accounts(id),
  FOREIGN KEY (forecast_id) REFERENCES forecast_journal(id)
)`;

type AccountRow = {
  id: string;
  name: string;
  initial_balance: number;
  balance: number;
  risk_per_trade_pct: number;
  fee_bps: number;
  slippage_bps: number;
  max_open_positions: number;
  enabled: number;
  entry_mode: PaperEntryMode;
  rub_per_usdt: number;
  created_at: number;
  updated_at: number;
};

type TradeRow = {
  id: string;
  account_id: string;
  forecast_id: string;
  model_version: string;
  symbol: string;
  market: Market;
  timeframe: Timeframe;
  side: PaperTradeSide;
  status: PaperTradeStatus;
  entry_source: PaperEntrySource;
  quote_currency: PaperQuoteCurrency;
  fx_rate: number;
  signal_time: number;
  due_time: number;
  entry_time: number | null;
  entry_time_source: PaperTradeTimeSource;
  first_entry_time: number | null;
  scale_in_count: number;
  exit_time: number | null;
  exit_time_source: PaperTradeTimeSource | null;
  entry_price: number | null;
  target_price: number;
  stop_price: number;
  exit_price: number | null;
  quantity: number | null;
  notional: number | null;
  risk_amount: number | null;
  fees: number;
  fees_native: number;
  realized_pnl: number | null;
  realized_pnl_native: number | null;
  pnl_pct: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_native: number | null;
  unrealized_pnl_pct: number | null;
  last_price: number | null;
  max_favorable_pct: number | null;
  max_adverse_pct: number | null;
  exit_reason: PaperTradeExitReason;
  last_processed_time: number | null;
  entry_block_reason?: PaperEntryBlockReason;
  entry_block_detail?: string | null;
  entry_blocked_at?: number | null;
  shadow_forecast_status?: "PENDING" | "EVALUATED" | null;
  shadow_entry_price?: number | null;
  shadow_exit_price?: number | null;
  shadow_evaluation_time?: number | null;
  shadow_target_hit?: number | null;
  shadow_invalidation_hit?: number | null;
  shadow_first_touch?: "TARGET" | "INVALIDATION" | "AMBIGUOUS" | "NONE" | null;
  signal_price?: number | null;
  forecast_json?: string | null;
  created_at: number;
  updated_at: number;
};

type ReadyForecastRow = {
  id: string;
  model_version: string;
  symbol: string;
  market: Market;
  timeframe: Timeframe;
  asof_time: number;
  due_time: number;
  primary_direction: "BULL" | "SIDEWAYS" | "BEAR";
  current_price: number;
  target_price: number;
  invalidation_price: number;
  forecast_json: string;
};

type ForecastStatusRow = ReadyForecastRow & { status: "PENDING" | "EVALUATED" };

export type PaperSimulation = {
  status: "OPEN" | "CLOSED";
  exitReason: PaperTradeExitReason;
  exitTime: number | null;
  exitPrice: number | null;
  fees: number;
  realizedPnl: number | null;
  pnlPct: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  lastPrice: number;
  maxFavorablePct: number;
  maxAdversePct: number;
  lastProcessedTime: number;
};

let schemaReady = false;
let evaluationPromise: Promise<{ queued: number; evaluated: number }> | null = null;

function applySlippage(price: number, side: PaperTradeSide, entering: boolean, slippageBps: number) {
  const rate = slippageBps / 10_000;
  const buying = (side === "LONG" && entering) || (side === "SHORT" && !entering);
  return price * (buying ? 1 + rate : 1 - rate);
}

function pnlAt(side: PaperTradeSide, entryPrice: number, exitPrice: number, quantity: number) {
  return (side === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity;
}

export function paperEntryNetRewardRisk(input: {
  side: PaperTradeSide;
  markPrice: number;
  targetPrice: number;
  stopPrice: number;
  feeBps: number;
  slippageBps: number;
}) {
  const entryPrice = applySlippage(input.markPrice, input.side, true, input.slippageBps);
  const targetExecution = applySlippage(input.targetPrice, input.side, false, input.slippageBps);
  const stopExecution = applySlippage(input.stopPrice, input.side, false, input.slippageBps);
  const entryFee = entryPrice * input.feeBps / 10_000;
  const reward = pnlAt(input.side, entryPrice, targetExecution, 1) - entryFee - targetExecution * input.feeBps / 10_000;
  const loss = Math.abs(Math.min(0, pnlAt(input.side, entryPrice, stopExecution, 1) - entryFee - stopExecution * input.feeBps / 10_000));
  return {
    entryPrice,
    targetExecution,
    stopExecution,
    netReward: reward,
    netLoss: loss,
    ratio: loss > 0 ? reward / loss : 0,
  };
}

export function assessPaperCandidateEntry(input: {
  side: PaperTradeSide;
  markPrice: number;
  targetPrice: number;
  stopPrice: number;
  feeBps: number;
  slippageBps: number;
  minimumNetRewardRisk?: number;
}) {
  const minimum = input.minimumNetRewardRisk ?? MINIMUM_ENTRY_NET_REWARD_RISK;
  const economics = paperEntryNetRewardRisk(input);
  const validLevels = input.side === "LONG"
    ? input.targetPrice > economics.entryPrice && input.stopPrice < economics.entryPrice
    : input.targetPrice < economics.entryPrice && input.stopPrice > economics.entryPrice;
  const bestMarkBeforeInvalidation = input.stopPrice * (input.side === "LONG" ? 1.000001 : 0.999999);
  const bestEconomics = paperEntryNetRewardRisk({ ...input, markPrice: bestMarkBeforeInvalidation });
  if (!validLevels) return { action: "WAIT_PRICE" as const, economics, bestRatio: bestEconomics.ratio };
  if (economics.ratio >= minimum) return { action: "OPEN" as const, economics, bestRatio: bestEconomics.ratio };
  if (!Number.isFinite(bestEconomics.ratio) || bestEconomics.ratio < minimum) {
    return { action: "SKIP_LOW_RR" as const, economics, bestRatio: bestEconomics.ratio };
  }
  return { action: "WAIT_PRICE" as const, economics, bestRatio: bestEconomics.ratio };
}

export function candidatePreEntryOutcome(input: {
  side: PaperTradeSide;
  targetPrice: number;
  stopPrice: number;
  notBefore: number;
  candles: Candle[];
}) {
  const start = Math.floor(input.notBefore / 60_000) * 60_000;
  const ordered = input.candles
    .filter((candle) => candle.closed !== false && candle.time >= start)
    .sort((left, right) => left.time - right.time);
  for (const candle of ordered) {
    const targetHit = input.side === "LONG" ? candle.high >= input.targetPrice : candle.low <= input.targetPrice;
    const invalidationHit = input.side === "LONG" ? candle.low <= input.stopPrice : candle.high >= input.stopPrice;
    if (invalidationHit) return { outcome: "INVALIDATION" as const, candle };
    if (targetHit) return { outcome: "TARGET" as const, candle };
  }
  return null;
}

function freshExecutionMark(candle: Candle, market: Market, notBefore: number, now = Date.now()) {
  const candleClose = candle.time + 60_000;
  const maximumAge = market === "moex" ? MAX_MOEX_DELAYED_MARK_AGE_MS : MAX_ENTRY_MARK_AGE_MS;
  return candle.closed !== false && candle.time <= now && candleClose >= notBefore && now - candleClose <= maximumAge;
}

function candidateHistoryCovered(trade: Pick<TradeRow, "market" | "created_at">, candles: Candle[]) {
  const oldest = candles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time)[0];
  if (!oldest) return false;
  if (trade.market !== "moex") return true;
  const start = Math.floor(trade.created_at / 60_000) * 60_000;
  return oldest.time <= start + MAX_EXECUTION_HISTORY_GAP_MS;
}

export function paperCurrency(market: Market, rubPerUsdt: number, symbol = "", markPrice?: number): { quoteCurrency: PaperQuoteCurrency; quotePerUsdt: number } {
  if (market === "moex") return { quoteCurrency: "RUB", quotePerUsdt: Math.min(500, Math.max(10, rubPerUsdt)) };
  if (market === "stocks" || market === "commodities") return { quoteCurrency: "USD", quotePerUsdt: 1 };
  if (market === "forex") {
    const pair = symbol.replace(/[^A-Z]/gi, "").toUpperCase();
    const quote = pair.slice(3, 6);
    if (quote === "USD") return { quoteCurrency: "USD", quotePerUsdt: 1 };
    if (["JPY", "CHF", "CAD"].includes(quote)) {
      const quoteCurrency = quote as PaperQuoteCurrency;
      const quotePerUsdt = pair.startsWith("USD") && Number.isFinite(markPrice) && Number(markPrice) > 0 ? Number(markPrice) : 0;
      return { quoteCurrency, quotePerUsdt };
    }
    return { quoteCurrency: "USD", quotePerUsdt: 1 };
  }
  return { quoteCurrency: "USDT", quotePerUsdt: 1 };
}

export function quoteToPaperBalance(value: number | null, quotePerUsdt: number) {
  if (value == null) return null;
  return value / Math.max(0.000001, quotePerUsdt);
}

export function mergePaperPosition(input: {
  currentEntryPrice: number;
  currentQuantity: number;
  addEntryPrice: number;
  addQuantity: number;
}) {
  const currentNotional = input.currentEntryPrice * input.currentQuantity;
  const addedNotional = input.addEntryPrice * input.addQuantity;
  const quantity = input.currentQuantity + input.addQuantity;
  if (![currentNotional, addedNotional, quantity].every(Number.isFinite) || quantity <= 0) {
    throw new Error("Некорректные данные для докупки виртуальной позиции");
  }
  const notional = currentNotional + addedNotional;
  return { entryPrice: notional / quantity, quantity, notional, addedNotional };
}

export function calculateManualPaperClose(input: {
  side: PaperTradeSide;
  entryPrice: number;
  markPrice: number;
  quantity: number;
  notional: number;
  entryFeesNative: number;
  feeBps: number;
  slippageBps: number;
  quotePerUsdt: number;
}) {
  const exitPrice = applySlippage(input.markPrice, input.side, false, input.slippageBps);
  const exitFeeNative = exitPrice * input.quantity * input.feeBps / 10_000;
  const feesNative = input.entryFeesNative + exitFeeNative;
  const realizedPnlNative = pnlAt(input.side, input.entryPrice, exitPrice, input.quantity) - feesNative;
  return {
    exitPrice,
    feesNative,
    fees: quoteToPaperBalance(feesNative, input.quotePerUsdt) ?? 0,
    realizedPnlNative,
    realizedPnl: quoteToPaperBalance(realizedPnlNative, input.quotePerUsdt) ?? 0,
    pnlPct: input.notional > 0 ? realizedPnlNative / input.notional * 100 : 0,
  };
}

export function calculateManualPaperEntry(input: {
  side: PaperTradeSide;
  markPrice: number;
  targetPrice: number;
  stopPrice: number;
  balance: number;
  riskPerTradePct: number;
  maxOpenPositions: number;
  feeBps: number;
  slippageBps: number;
  quotePerUsdt: number;
  lotSize?: number | null;
  minimumNetRewardRisk?: number;
}) {
  const economics = paperEntryNetRewardRisk(input);
  const entryPrice = economics.entryPrice;
  const validLevels = input.side === "LONG"
    ? input.targetPrice > entryPrice && input.stopPrice < entryPrice
    : input.targetPrice < entryPrice && input.stopPrice > entryPrice;
  if (!validLevels) throw new Error("Текущая цена уже вышла за допустимые TP/SL этого прогноза");
  const minimumNetRewardRisk = Number(input.minimumNetRewardRisk ?? MINIMUM_ENTRY_NET_REWARD_RISK);
  if (!Number.isFinite(economics.ratio) || economics.ratio < minimumNetRewardRisk) {
    throw new Error(`После текущей цены и расходов прибыль/риск ${economics.ratio.toFixed(2)}:1 ниже минимума ${minimumNetRewardRisk.toFixed(2)}:1`);
  }
  const stopExecution = economics.stopExecution;
  const riskPerUnit = Math.abs(entryPrice - stopExecution);
  const riskBudget = Math.max(0, input.balance * input.riskPerTradePct / 100 * input.quotePerUsdt);
  const notionalCap = Math.max(0, input.balance / Math.max(1, input.maxOpenPositions) * input.quotePerUsdt);
  const rawQuantity = Math.min(riskBudget / riskPerUnit, notionalCap / entryPrice);
  const lotSize = Number(input.lotSize ?? 0);
  const quantity = Number.isInteger(lotSize) && lotSize > 0
    ? Math.floor(rawQuantity / lotSize) * lotSize
    : rawQuantity;
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Не удалось рассчитать размер виртуальной позиции");
  const notional = entryPrice * quantity;
  const riskAmount = riskPerUnit * quantity;
  const feesNative = notional * input.feeBps / 10_000;
  const estimatedExitPrice = applySlippage(input.markPrice, input.side, false, input.slippageBps);
  const estimatedExitFee = estimatedExitPrice * quantity * input.feeBps / 10_000;
  const unrealizedPnlNative = pnlAt(input.side, entryPrice, estimatedExitPrice, quantity) - feesNative - estimatedExitFee;
  return {
    entryPrice,
    quantity,
    notional,
    riskAmount,
    feesNative,
    fees: quoteToPaperBalance(feesNative, input.quotePerUsdt) ?? 0,
    unrealizedPnlNative,
    unrealizedPnl: quoteToPaperBalance(unrealizedPnlNative, input.quotePerUsdt) ?? 0,
    unrealizedPnlPct: notional > 0 ? unrealizedPnlNative / notional * 100 : 0,
    netRewardRisk: economics.ratio,
  };
}

export function calculateSignalPaperEntry(input: {
  side: PaperTradeSide;
  signalPrice: number;
  targetPrice: number;
  stopPrice: number;
  balance: number;
  riskPerTradePct: number;
  maxOpenPositions: number;
  feeBps: number;
  quotePerUsdt: number;
  lotSize?: number | null;
}) {
  // Statistical PAPER positions must preserve the model's own reference price.
  // Fees remain in PnL, while live slippage and net R:R are diagnostics only.
  return calculateManualPaperEntry({
    side: input.side,
    markPrice: input.signalPrice,
    targetPrice: input.targetPrice,
    stopPrice: input.stopPrice,
    balance: input.balance,
    riskPerTradePct: input.riskPerTradePct,
    maxOpenPositions: input.maxOpenPositions,
    feeBps: input.feeBps,
    slippageBps: 0,
    quotePerUsdt: input.quotePerUsdt,
    lotSize: input.lotSize,
    minimumNetRewardRisk: 0,
  });
}

export function simulatePaperPosition(input: {
  side: PaperTradeSide;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  quantity: number;
  dueTime: number;
  candles: Candle[];
  feeBps: number;
  slippageBps: number;
}): PaperSimulation {
  const candles = input.candles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (!candles.length) throw new Error("Нет закрытых свечей для сопровождения виртуальной позиции");
  const notional = input.entryPrice * input.quantity;
  const entryFee = notional * input.feeBps / 10_000;
  let maxFavorablePct = 0;
  let maxAdversePct = 0;
  let rawExit: number | null = null;
  let exitTime: number | null = null;
  let exitReason: PaperTradeExitReason = null;

  for (const candle of candles) {
    const favorable = input.side === "LONG"
      ? ((candle.high / input.entryPrice) - 1) * 100
      : ((input.entryPrice / candle.low) - 1) * 100;
    const adverse = input.side === "LONG"
      ? ((candle.low / input.entryPrice) - 1) * 100
      : ((input.entryPrice / candle.high) - 1) * 100;
    maxFavorablePct = Math.max(maxFavorablePct, favorable);
    maxAdversePct = Math.min(maxAdversePct, adverse);
    const targetHit = input.side === "LONG" ? candle.high >= input.targetPrice : candle.low <= input.targetPrice;
    const stopHit = input.side === "LONG" ? candle.low <= input.stopPrice : candle.high >= input.stopPrice;
    if (targetHit && stopHit) {
      rawExit = input.stopPrice;
      exitTime = candle.time;
      exitReason = "AMBIGUOUS_SL";
      break;
    }
    if (stopHit) {
      rawExit = input.stopPrice;
      exitTime = candle.time;
      exitReason = "SL";
      break;
    }
    if (targetHit) {
      rawExit = input.targetPrice;
      exitTime = candle.time;
      exitReason = "TP";
      break;
    }
    if (candle.time >= input.dueTime) {
      rawExit = candle.close;
      exitTime = candle.time;
      exitReason = "EXPIRED";
      break;
    }
  }

  const last = candles.at(-1)!;
  if (rawExit != null && exitTime != null) {
    const exitPrice = applySlippage(rawExit, input.side, false, input.slippageBps);
    const exitFee = exitPrice * input.quantity * input.feeBps / 10_000;
    const fees = entryFee + exitFee;
    const realizedPnl = pnlAt(input.side, input.entryPrice, exitPrice, input.quantity) - fees;
    return {
      status: "CLOSED",
      exitReason,
      exitTime,
      exitPrice,
      fees,
      realizedPnl,
      pnlPct: notional > 0 ? realizedPnl / notional * 100 : 0,
      unrealizedPnl: null,
      unrealizedPnlPct: null,
      lastPrice: exitPrice,
      maxFavorablePct,
      maxAdversePct,
      lastProcessedTime: exitTime,
    };
  }

  const liquidationPrice = applySlippage(last.close, input.side, false, input.slippageBps);
  const estimatedExitFee = liquidationPrice * input.quantity * input.feeBps / 10_000;
  const unrealizedPnl = pnlAt(input.side, input.entryPrice, liquidationPrice, input.quantity) - entryFee - estimatedExitFee;
  return {
    status: "OPEN",
    exitReason: null,
    exitTime: null,
    exitPrice: null,
    fees: entryFee,
    realizedPnl: null,
    pnlPct: null,
    unrealizedPnl,
    unrealizedPnlPct: notional > 0 ? unrealizedPnl / notional * 100 : 0,
    lastPrice: last.close,
    maxFavorablePct,
    maxAdversePct,
    lastProcessedTime: last.time,
  };
}

async function ensureColumn(db: D1, table: "paper_accounts" | "paper_trades", column: string, definition: string) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (((info.results ?? []) as Array<{ name: string }>).some((item) => item.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export async function ensurePaperSchema() {
  const db = await ensureForecastSchema();
  if (schemaReady) return db;
  await db.batch([
    db.prepare(CREATE_ACCOUNT_TABLE),
    db.prepare(CREATE_TRADE_TABLE),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_trade_forecast ON paper_trades (forecast_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_trade_status_signal ON paper_trades (status, signal_time)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_trade_symbol_timeframe ON paper_trades (symbol, timeframe, signal_time)"),
  ]);
  await ensureColumn(db, "paper_accounts", "entry_mode", "TEXT NOT NULL DEFAULT 'MANUAL'");
  await ensureColumn(db, "paper_accounts", "rub_per_usdt", "REAL NOT NULL DEFAULT 80");
  await ensureColumn(db, "paper_trades", "entry_source", "TEXT NOT NULL DEFAULT 'AUTO'");
  await ensureColumn(db, "paper_trades", "quote_currency", "TEXT NOT NULL DEFAULT 'USDT'");
  await ensureColumn(db, "paper_trades", "fx_rate", "REAL NOT NULL DEFAULT 1");
  await ensureColumn(db, "paper_trades", "fees_native", "REAL NOT NULL DEFAULT 0");
  await ensureColumn(db, "paper_trades", "realized_pnl_native", "REAL");
  await ensureColumn(db, "paper_trades", "unrealized_pnl_native", "REAL");
  await ensureColumn(db, "paper_trades", "first_entry_time", "INTEGER");
  await ensureColumn(db, "paper_trades", "scale_in_count", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(db, "paper_trades", "entry_time_source", "TEXT NOT NULL DEFAULT 'TIMEFRAME_CANDLE'");
  await ensureColumn(db, "paper_trades", "exit_time_source", "TEXT");
  await ensureColumn(db, "paper_trades", "entry_block_reason", "TEXT");
  await ensureColumn(db, "paper_trades", "entry_block_detail", "TEXT");
  await ensureColumn(db, "paper_trades", "entry_blocked_at", "INTEGER");
  const now = Date.now();
  await db.prepare(`INSERT INTO paper_accounts (
    id, name, initial_balance, balance, risk_per_trade_pct, fee_bps, slippage_bps,
    max_open_positions, enabled, entry_mode, rub_per_usdt, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(ACCOUNT_ID, "Northstar Paper", DEFAULT_BALANCE, DEFAULT_BALANCE, DEFAULT_RISK_PCT, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS, DEFAULT_MAX_POSITIONS, DEFAULT_ENTRY_MODE, DEFAULT_RUB_PER_USDT, now, now)
    .run();
  await db.prepare("PRAGMA optimize").run();
  schemaReady = true;
  return db;
}

async function accountRow(db: D1) {
  const account = await db.prepare("SELECT * FROM paper_accounts WHERE id = ?").bind(ACCOUNT_ID).first<AccountRow>();
  if (!account) throw new Error("Paper-счёт не создан");
  return account;
}

function forecastDecision(row: ReadyForecastRow): ForecastDecision | null {
  try {
    const parsed = JSON.parse(row.forecast_json) as { decision?: ForecastDecision };
    return parsed.decision === "READY" || parsed.decision === "WAIT_CONFIRMATION" || parsed.decision === "NO_TRADE"
      ? parsed.decision
      : null;
  } catch {
    return null;
  }
}

export function paperEntrySourceForForecast(
  decision: ForecastDecision | null,
  direction: ForecastDirection,
  mode: PaperEntryMode,
): PaperEntrySource | null {
  if (direction !== "BULL" && direction !== "BEAR") return null;
  if (decision === "READY") return mode === "AUTO" ? "AUTO" : "MANUAL";
  if (decision === "WAIT_CONFIRMATION" && mode === "MANUAL") return "MANUAL_WAIT";
  return null;
}

function isReadyForecast(row: ReadyForecastRow) {
  return paperEntrySourceForForecast(forecastDecision(row), row.primary_direction, "AUTO") === "AUTO";
}

function candidateStatement(db: D1, account: AccountRow, row: ReadyForecastRow, source: PaperEntrySource, now: number, id = crypto.randomUUID()) {
  const currency = paperCurrency(row.market, account.rub_per_usdt, row.symbol);
  return db.prepare(`INSERT INTO paper_trades (
    id, account_id, forecast_id, model_version, symbol, market, timeframe, side, status,
    entry_source, quote_currency, fx_rate, signal_time, due_time, target_price, stop_price,
    fees, fees_native, exit_reason, entry_block_reason, entry_block_detail, entry_blocked_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, NULL, ?, ?)
  ON CONFLICT(forecast_id) DO NOTHING`).bind(
    id, ACCOUNT_ID, row.id, row.model_version, row.symbol, row.market, row.timeframe,
    row.primary_direction === "BULL" ? "LONG" : "SHORT", source, currency.quoteCurrency, currency.quotePerUsdt,
    row.asof_time, row.due_time, row.target_price, row.invalidation_price, now, now,
  );
}

export async function syncPaperCandidates() {
  const db = await ensurePaperSchema();
  const account = await accountRow(db);
  if (!account.enabled || account.entry_mode !== "AUTO") return 0;
  const now = Date.now();
  const forecasts = await db.prepare(`SELECT f.id, f.model_version, f.symbol, f.market, f.timeframe,
    f.asof_time, f.due_time, f.primary_direction, f.current_price, f.target_price, f.invalidation_price, f.forecast_json
    FROM forecast_journal f LEFT JOIN paper_trades p ON p.forecast_id = f.id
    WHERE p.id IS NULL AND f.model_version = ? AND f.status = 'PENDING' AND f.due_time > ?
    ORDER BY f.asof_time ASC LIMIT 500`)
    .bind(SCENARIO_MODEL_VERSION, now).all<ReadyForecastRow>();
  const readyRows = (forecasts.results ?? []) as ReadyForecastRow[];
  const statements = readyRows.filter(isReadyForecast).map((row) => candidateStatement(db, account, row, "AUTO", now));
  if (!statements.length) return 0;
  const results = await db.batch(statements);
  return (results as Array<{ meta: { changes?: number } }>).reduce((sum: number, result) => sum + Number(result.meta.changes ?? 0), 0);
}

async function skipTrade(db: D1, id: string, reason: Exclude<PaperTradeExitReason, null>) {
  await db.prepare("UPDATE paper_trades SET status = 'SKIPPED', exit_reason = ?, entry_block_reason = NULL, entry_block_detail = NULL, entry_blocked_at = NULL, updated_at = ? WHERE id = ?")
    .bind(reason, Date.now(), id).run();
}

async function blockCandidate(
  db: D1,
  trade: TradeRow,
  reason: Exclude<PaperEntryBlockReason, null>,
  detail: string,
  candle?: Candle | null,
) {
  const now = Date.now();
  await db.prepare(`UPDATE paper_trades SET entry_block_reason = ?, entry_block_detail = ?, entry_blocked_at = ?,
    last_price = COALESCE(?, last_price), last_processed_time = COALESCE(?, last_processed_time), updated_at = ?
    WHERE id = ? AND status = 'CANDIDATE'`).bind(
    reason, detail, now, candle?.close ?? null, candle?.time ?? null, now, trade.id,
  ).run();
}

async function mergeCandidateIntoOpenTrade(
  db: D1,
  account: AccountRow,
  candidate: TradeRow,
  existing: TradeRow,
  entryCandle: Candle,
  closedCandles: Candle[],
) {
  if (existing.entry_price == null || existing.quantity == null || existing.quantity <= 0) {
    await skipTrade(db, candidate.id, "NO_ENTRY_DATA");
    return { evaluated: 1, balanceDelta: 0 };
  }
  if (existing.side !== candidate.side) {
    await skipTrade(db, candidate.id, "OPPOSITE_POSITION");
    return { evaluated: 1, balanceDelta: 0 };
  }

  const quotePerUsdt = existing.fx_rate > 0 ? existing.fx_rate : paperCurrency(existing.market, account.rub_per_usdt, existing.symbol, existing.last_price ?? existing.entry_price ?? undefined).quotePerUsdt;
  const addEntryPrice = applySlippage(entryCandle.open, candidate.side, true, account.slippage_bps);
  const stopExecution = applySlippage(candidate.stop_price, candidate.side, false, account.slippage_bps);
  const addRiskPerUnit = Math.abs(addEntryPrice - stopExecution);
  const addRiskBudget = Math.max(0, account.balance * account.risk_per_trade_pct / 100 * quotePerUsdt);
  const addNotionalCap = Math.max(0, account.balance / Math.max(1, account.max_open_positions) * quotePerUsdt);
  const addQuantity = Math.min(addRiskBudget / addRiskPerUnit, addNotionalCap / addEntryPrice);
  if (!Number.isFinite(addQuantity) || addQuantity <= 0) {
    await skipTrade(db, candidate.id, "INVALID_LEVELS");
    return { evaluated: 1, balanceDelta: 0 };
  }

  const merged = mergePaperPosition({
    currentEntryPrice: existing.entry_price,
    currentQuantity: existing.quantity,
    addEntryPrice,
    addQuantity,
  });
  const validLevels = candidate.side === "LONG"
    ? candidate.target_price > merged.entryPrice && candidate.stop_price < merged.entryPrice
    : candidate.target_price < merged.entryPrice && candidate.stop_price > merged.entryPrice;
  if (!validLevels) {
    await skipTrade(db, candidate.id, "INVALID_LEVELS");
    return { evaluated: 1, balanceDelta: 0 };
  }

  const riskAmount = Math.abs(merged.entryPrice - stopExecution) * merged.quantity;
  const simulationWindow = closedCandles.filter((candle) => candle.time >= entryCandle.time);
  const simulation = simulatePaperPosition({
    side: candidate.side,
    entryPrice: merged.entryPrice,
    targetPrice: candidate.target_price,
    stopPrice: candidate.stop_price,
    quantity: merged.quantity,
    dueTime: candidate.due_time,
    candles: simulationWindow,
    feeBps: account.fee_bps,
    slippageBps: account.slippage_bps,
  });
  const feesBase = quoteToPaperBalance(simulation.fees, quotePerUsdt) ?? 0;
  const realizedPnlBase = quoteToPaperBalance(simulation.realizedPnl, quotePerUsdt);
  const unrealizedPnlBase = quoteToPaperBalance(simulation.unrealizedPnl, quotePerUsdt);
  const now = Date.now();
  const firstEntryTime = existing.first_entry_time ?? existing.entry_time ?? entryCandle.time;
  await db.batch([
    db.prepare(`UPDATE paper_trades SET model_version = ?, timeframe = ?, status = ?, due_time = ?,
      entry_time = ?, first_entry_time = ?, scale_in_count = scale_in_count + 1, exit_time = ?, entry_price = ?,
      target_price = ?, stop_price = ?, exit_price = ?, quantity = ?, notional = ?, risk_amount = ?, fees = ?,
      fees_native = ?, realized_pnl = ?, realized_pnl_native = ?, pnl_pct = ?, unrealized_pnl = ?,
      unrealized_pnl_native = ?, unrealized_pnl_pct = ?, last_price = ?, max_favorable_pct = ?, max_adverse_pct = ?,
      exit_reason = ?, last_processed_time = ?, updated_at = ? WHERE id = ?`).bind(
      candidate.model_version, candidate.timeframe, simulation.status, candidate.due_time,
      entryCandle.time, firstEntryTime, simulation.exitTime, merged.entryPrice,
      candidate.target_price, candidate.stop_price, simulation.exitPrice, merged.quantity, merged.notional,
      riskAmount, feesBase, simulation.fees, realizedPnlBase, simulation.realizedPnl, simulation.pnlPct,
      unrealizedPnlBase, simulation.unrealizedPnl, simulation.unrealizedPnlPct, simulation.lastPrice,
      simulation.maxFavorablePct, simulation.maxAdversePct, simulation.exitReason,
      simulation.lastProcessedTime, now, existing.id,
    ),
    db.prepare(`UPDATE paper_trades SET status = 'MERGED', entry_time = ?, first_entry_time = ?, exit_time = ?,
      entry_price = ?, quantity = ?, notional = ?, risk_amount = ?, last_price = ?, exit_reason = 'MERGED_POSITION',
      last_processed_time = ?, updated_at = ? WHERE id = ?`).bind(
      entryCandle.time, entryCandle.time, entryCandle.time, addEntryPrice, addQuantity, merged.addedNotional,
      addRiskPerUnit * addQuantity, addEntryPrice, entryCandle.time, now, candidate.id,
    ),
  ]);
  if (simulation.status === "CLOSED" && realizedPnlBase != null) {
    await db.prepare("UPDATE paper_accounts SET balance = balance + ?, updated_at = ? WHERE id = ?")
      .bind(realizedPnlBase, now, ACCOUNT_ID).run();
    return { evaluated: 1, balanceDelta: realizedPnlBase };
  }
  return { evaluated: 1, balanceDelta: 0 };
}

function latestPaperMark(candles: Candle[]) {
  return [...candles]
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
    .sort((left, right) => left.time - right.time)
    .at(-1);
}

async function executionLotSize(trade: Pick<TradeRow, "market" | "symbol">) {
  return trade.market === "moex" ? getMoexLotSize(trade.symbol) : null;
}

async function openAutomaticCandidateAtSignal(db: D1, account: AccountRow, trade: TradeRow) {
  const signalPrice = Number(trade.signal_price);
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) {
    await skipTrade(db, trade.id, "NO_ENTRY_DATA");
    return false;
  }

  const currency = paperCurrency(trade.market, account.rub_per_usdt, trade.symbol, signalPrice);
  let lotSize: number | null = null;
  try {
    lotSize = await executionLotSize(trade);
  } catch {
    // A temporary metadata outage must not erase a READY statistical sample.
    // The position is sized fractionally and the missing lot metadata remains
    // a live-execution concern, not a paper-journal blocker.
  }
  const entry = calculateSignalPaperEntry({
    side: trade.side,
    signalPrice,
    targetPrice: trade.target_price,
    stopPrice: trade.stop_price,
    balance: account.balance,
    riskPerTradePct: account.risk_per_trade_pct,
    maxOpenPositions: account.max_open_positions,
    feeBps: account.fee_bps,
    quotePerUsdt: currency.quotePerUsdt,
    lotSize,
  });
  const executionShadow = assessPaperCandidateEntry({
    side: trade.side,
    markPrice: signalPrice,
    targetPrice: trade.target_price,
    stopPrice: trade.stop_price,
    feeBps: account.fee_bps,
    slippageBps: account.slippage_bps,
    minimumNetRewardRisk: MINIMUM_ENTRY_NET_REWARD_RISK,
  });
  const executionWouldOpen = executionShadow.action === "OPEN";
  const shadowDetail = executionWouldOpen
    ? `Тень исполнения: вход допустим; чистая прибыль/риск ${executionShadow.economics.ratio.toFixed(2)}:1`
    : `Тень исполнения: реальный вход ожидал бы лучшую цену; чистая прибыль/риск ${executionShadow.economics.ratio.toFixed(2)}:1`;
  const now = Date.now();
  const updated = await db.prepare(`UPDATE paper_trades SET status = 'OPEN', entry_time = ?, entry_time_source = 'SIGNAL_PRICE',
    first_entry_time = ?, quote_currency = ?, fx_rate = ?, entry_price = ?, quantity = ?, notional = ?, risk_amount = ?,
    fees = ?, fees_native = ?, unrealized_pnl = ?, unrealized_pnl_native = ?, unrealized_pnl_pct = ?, last_price = ?,
    max_favorable_pct = 0, max_adverse_pct = 0, exit_reason = NULL, entry_block_reason = ?, entry_block_detail = ?,
    entry_blocked_at = ?, last_processed_time = ?, updated_at = ? WHERE id = ? AND status = 'CANDIDATE'`).bind(
      trade.signal_time, trade.signal_time, currency.quoteCurrency, currency.quotePerUsdt, entry.entryPrice,
      entry.quantity, entry.notional, entry.riskAmount, entry.fees, entry.feesNative, entry.unrealizedPnl,
      entry.unrealizedPnlNative, entry.unrealizedPnlPct, signalPrice,
      executionWouldOpen ? null : "WAIT_BETTER_PRICE", shadowDetail,
      executionWouldOpen ? null : now, trade.signal_time, now, trade.id,
    ).run();
  return Number(updated.meta.changes ?? 0) > 0;
}

async function openReadyCandidatesAtSignal(db: D1, account: AccountRow) {
  const candidates = await db.prepare(`SELECT p.*, f.current_price AS signal_price
    FROM paper_trades p JOIN forecast_journal f ON f.id = p.forecast_id
    WHERE p.account_id = ? AND p.status = 'CANDIDATE' AND p.entry_source = 'AUTO'
    ORDER BY p.signal_time ASC LIMIT 500`).bind(ACCOUNT_ID).all<TradeRow>();
  let opened = 0;
  for (const trade of candidates.results ?? []) {
    try {
      if (await openAutomaticCandidateAtSignal(db, account, trade)) opened += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Некорректные данные цены сигнала";
      await blockCandidate(db, trade, "QUOTE_UNAVAILABLE", `Не удалось восстановить вход по сигналу: ${detail}`);
    }
  }
  return opened;
}

async function openManualCandidateNow(db: D1, account: AccountRow, trade: TradeRow, candles: Candle[]) {
  const now = Date.now();
  if (trade.due_time <= now) {
    await skipTrade(db, trade.id, "EXPIRED");
    throw new Error("Срок прогноза уже истёк — ручной вход отменён");
  }
  const session = getMarketSessionState(trade.market, now);
  if (!session.isOpen) {
    if (trade.entry_source === "AUTO") {
      await blockCandidate(db, trade, "MARKET_CLOSED", "Рынок закрыт; вход будет проверен в следующую торговую сессию");
      return { evaluated: 0, balanceDelta: 0, openedNow: false };
    }
    throw new Error("Рынок сейчас закрыт — вход будет возможен только во время торговой сессии");
  }
  const latest = latestPaperMark(candles);
  if (!latest) {
    if (trade.entry_source === "AUTO") {
      await blockCandidate(db, trade, "QUOTE_UNAVAILABLE", "Источник не вернул минутную цену");
      return { evaluated: 0, balanceDelta: 0, openedNow: false };
    }
    throw new Error("Не удалось получить текущую цену для ручного входа");
  }
  if (!freshExecutionMark(latest, trade.market, trade.created_at, now)) {
    if (trade.entry_source === "AUTO") {
      const detail = trade.market === "moex" && latest.time + 60_000 < trade.created_at
        ? "Задержанная лента ещё не дошла до времени появления сигнала"
        : `Последняя закрытая минутная свеча старше ${trade.market === "moex" ? "двадцати" : "пяти"} минут`;
      await blockCandidate(db, trade, "STALE_QUOTE", detail, latest);
      return { evaluated: 0, balanceDelta: 0, openedNow: false };
    }
    throw new Error("Последняя минутная цена устарела — вход отменён до восстановления живых котировок");
  }
  if (!candidateHistoryCovered(trade, candles)) {
    if (trade.entry_source === "AUTO") {
      await blockCandidate(db, trade, "QUOTE_UNAVAILABLE", "Нет непрерывной минутной истории от момента появления сигнала", latest);
      return { evaluated: 0, balanceDelta: 0, openedNow: false };
    }
    throw new Error("Нет полной минутной истории от момента появления рекомендации");
  }
  const preEntryOutcome = candidatePreEntryOutcome({
    side: trade.side,
    targetPrice: trade.target_price,
    stopPrice: trade.stop_price,
    notBefore: trade.created_at,
    candles,
  });
  if (preEntryOutcome) {
    await skipTrade(db, trade.id, preEntryOutcome.outcome === "INVALIDATION" ? "PRE_ENTRY_INVALIDATION" : "TARGET_PASSED_BEFORE_ENTRY");
    return { evaluated: 1, balanceDelta: 0, openedNow: false };
  }
  const assessment = assessPaperCandidateEntry({
    side: trade.side,
    markPrice: latest.close,
    targetPrice: trade.target_price,
    stopPrice: trade.stop_price,
    feeBps: account.fee_bps,
    slippageBps: account.slippage_bps,
  });
  if (assessment.action === "SKIP_LOW_RR") {
    await skipTrade(db, trade.id, "LOW_NET_REWARD_RISK");
    return { evaluated: 1, balanceDelta: 0, openedNow: false };
  }
  if (assessment.action === "WAIT_PRICE") {
    const detail = `Чистая прибыль/риск ${assessment.economics.ratio.toFixed(2)}:1; нужен минимум ${MINIMUM_ENTRY_NET_REWARD_RISK.toFixed(2)}:1`;
    await blockCandidate(db, trade, "WAIT_BETTER_PRICE", detail, latest);
    return { evaluated: 0, balanceDelta: 0, openedNow: false };
  }
  const duplicate = await db.prepare("SELECT * FROM paper_trades WHERE account_id = ? AND market = ? AND symbol = ? AND status = 'OPEN' AND id <> ? ORDER BY updated_at DESC LIMIT 1")
    .bind(ACCOUNT_ID, trade.market, trade.symbol, trade.id).first<TradeRow>();
  const entryTimeSource: PaperTradeTimeSource = trade.entry_source === "AUTO" ? "EXECUTION_MARK" : "MANUAL_ACTION";
  const entryTimestamp = trade.entry_source === "AUTO" ? Math.min(now, latest.time + 60_000) : now;
  const currency = paperCurrency(trade.market, account.rub_per_usdt, trade.symbol, latest.close);
  const quotePerUsdt = trade.fx_rate > 0 ? trade.fx_rate : currency.quotePerUsdt;
  if (!Number.isFinite(quotePerUsdt) || quotePerUsdt <= 0) throw new Error(`Не удалось определить виртуальный курс ${currency.quoteCurrency}/USDT`);
  const lotSize = await executionLotSize(trade);

  if (trade.entry_source === "MANUAL_ADD") {
    if (!duplicate || duplicate.entry_price == null || duplicate.quantity == null || duplicate.notional == null) {
      await skipTrade(db, trade.id, "POSITION_CLOSED_BEFORE_ADD");
      throw new Error("Позиция закрылась до выполнения ручной докупки");
    }
    if (duplicate.side !== trade.side) {
      await skipTrade(db, trade.id, "OPPOSITE_POSITION");
      throw new Error("Нельзя докупить позицию в противоположную сторону");
    }
    const added = calculateManualPaperEntry({
      side: trade.side,
      markPrice: latest.close,
      targetPrice: trade.target_price,
      stopPrice: trade.stop_price,
      balance: account.balance,
      riskPerTradePct: account.risk_per_trade_pct,
      maxOpenPositions: account.max_open_positions,
      feeBps: account.fee_bps,
      slippageBps: account.slippage_bps,
      quotePerUsdt,
      lotSize,
    });
    const merged = mergePaperPosition({
      currentEntryPrice: duplicate.entry_price,
      currentQuantity: duplicate.quantity,
      addEntryPrice: added.entryPrice,
      addQuantity: added.quantity,
    });
    const validMergedLevels = trade.side === "LONG"
      ? trade.target_price > merged.entryPrice && trade.stop_price < merged.entryPrice
      : trade.target_price < merged.entryPrice && trade.stop_price > merged.entryPrice;
    if (!validMergedLevels) {
      await skipTrade(db, trade.id, "INVALID_LEVELS");
      throw new Error("После докупки уровни TP/SL стали некорректными");
    }
    const stopExecution = applySlippage(trade.stop_price, trade.side, false, account.slippage_bps);
    const riskAmount = Math.abs(merged.entryPrice - stopExecution) * merged.quantity;
    const entryFeesNative = duplicate.fees_native + added.feesNative;
    const estimatedExitPrice = applySlippage(latest.close, trade.side, false, account.slippage_bps);
    const estimatedExitFee = estimatedExitPrice * merged.quantity * account.fee_bps / 10_000;
    const unrealizedPnlNative = pnlAt(trade.side, merged.entryPrice, estimatedExitPrice, merged.quantity) - entryFeesNative - estimatedExitFee;
    const unrealizedPnl = quoteToPaperBalance(unrealizedPnlNative, quotePerUsdt) ?? 0;
    await db.batch([
      db.prepare(`UPDATE paper_trades SET model_version = ?, timeframe = ?, due_time = ?, entry_time = ?, entry_time_source = ?, quote_currency = ?, fx_rate = ?,
        scale_in_count = scale_in_count + 1, entry_price = ?, target_price = ?, stop_price = ?, quantity = ?,
        notional = ?, risk_amount = ?, fees = ?, fees_native = ?, unrealized_pnl = ?, unrealized_pnl_native = ?,
        unrealized_pnl_pct = ?, last_price = ?, exit_reason = NULL, last_processed_time = ?, updated_at = ?
        WHERE id = ? AND status = 'OPEN'`).bind(
        trade.model_version, trade.timeframe, trade.due_time, now, entryTimeSource, currency.quoteCurrency, quotePerUsdt, merged.entryPrice, trade.target_price,
        trade.stop_price, merged.quantity, merged.notional, riskAmount,
        quoteToPaperBalance(entryFeesNative, quotePerUsdt) ?? 0, entryFeesNative, unrealizedPnl,
        unrealizedPnlNative, merged.notional > 0 ? unrealizedPnlNative / merged.notional * 100 : 0,
        latest.close, latest.time, now, duplicate.id,
      ),
      db.prepare(`UPDATE paper_trades SET status = 'MERGED', entry_time = ?, entry_time_source = ?, first_entry_time = ?, exit_time = ?, exit_time_source = ?,
        entry_price = ?, quantity = ?, notional = ?, risk_amount = ?, fees = ?, fees_native = ?, last_price = ?,
        exit_reason = 'MERGED_POSITION', last_processed_time = ?, updated_at = ? WHERE id = ? AND status = 'CANDIDATE'`).bind(
        now, entryTimeSource, now, now, entryTimeSource, added.entryPrice, added.quantity, added.notional, added.riskAmount, added.fees,
        added.feesNative, latest.close, latest.time, now, trade.id,
      ),
    ]);
    return { evaluated: 1, balanceDelta: 0, openedNow: true, addedNow: true, entryPrice: added.entryPrice, entryTime: now };
  }

  if (duplicate) {
    await skipTrade(db, trade.id, "DUPLICATE_SYMBOL");
    throw new Error(`По ${trade.symbol} уже открыта виртуальная позиция`);
  }
  const openCount = await db.prepare("SELECT COUNT(*) AS count FROM paper_trades WHERE account_id = ? AND status = 'OPEN'")
    .bind(ACCOUNT_ID).first<{ count: number }>();
  if (Number(openCount?.count ?? 0) >= account.max_open_positions) {
    await skipTrade(db, trade.id, "POSITION_LIMIT");
    throw new Error("Достигнут лимит открытых виртуальных позиций");
  }
  const entry = calculateManualPaperEntry({
    side: trade.side,
    markPrice: latest.close,
    targetPrice: trade.target_price,
    stopPrice: trade.stop_price,
    balance: account.balance,
    riskPerTradePct: account.risk_per_trade_pct,
    maxOpenPositions: account.max_open_positions,
    feeBps: account.fee_bps,
      slippageBps: account.slippage_bps,
      quotePerUsdt,
      lotSize,
    });
  await db.prepare(`UPDATE paper_trades SET status = 'OPEN', entry_time = ?, entry_time_source = ?, first_entry_time = ?, quote_currency = ?, fx_rate = ?, entry_price = ?,
    quantity = ?, notional = ?, risk_amount = ?, fees = ?, fees_native = ?, unrealized_pnl = ?,
    unrealized_pnl_native = ?, unrealized_pnl_pct = ?, last_price = ?, max_favorable_pct = 0,
    max_adverse_pct = 0, exit_reason = NULL, entry_block_reason = NULL, entry_block_detail = NULL, entry_blocked_at = NULL,
    last_processed_time = ?, updated_at = ?
    WHERE id = ? AND status = 'CANDIDATE'`).bind(
    entryTimestamp, entryTimeSource, entryTimestamp, currency.quoteCurrency, quotePerUsdt, entry.entryPrice, entry.quantity, entry.notional, entry.riskAmount, entry.fees, entry.feesNative,
    entry.unrealizedPnl, entry.unrealizedPnlNative, entry.unrealizedPnlPct, latest.close, latest.time, now, trade.id,
  ).run();
  return { evaluated: 1, balanceDelta: 0, openedNow: true, addedNow: false, entryPrice: entry.entryPrice, entryTime: entryTimestamp };
}

async function processTrade(db: D1, account: AccountRow, trade: TradeRow, executionCandles: Candle[] = []) {
  const preciseClosed = executionCandles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (trade.status === "CANDIDATE") {
    if (!preciseClosed.length) return { evaluated: 0, balanceDelta: 0 };
    return openManualCandidateNow(db, account, trade, preciseClosed);
  }
  if (!preciseClosed.length) return { evaluated: 0, balanceDelta: 0 };
  const quotePerUsdt = trade.fx_rate > 0 ? trade.fx_rate : paperCurrency(trade.market, account.rub_per_usdt, trade.symbol, trade.last_price ?? trade.entry_price ?? undefined).quotePerUsdt;
  const entryTime = trade.entry_time;
  const entryPrice = trade.entry_price;
  const quantity = trade.quantity;
  const notional = trade.notional;
  const riskAmount = trade.risk_amount;

  if (entryTime == null || entryPrice == null || quantity == null || notional == null || riskAmount == null) {
    await skipTrade(db, trade.id, "NO_ENTRY_DATA");
    return { evaluated: 1, balanceDelta: 0 };
  }
  const coverageCursor = trade.last_processed_time ?? entryTime;
  if (!hasContinuousExecutionHistory(trade.market, coverageCursor, preciseClosed)) {
    // Never fabricate an exit from a coarse candle after an execution-data outage.
    // The position remains open until a continuous 1m history can be replayed.
    return { evaluated: 0, balanceDelta: 0 };
  }
  const preciseStart = Math.max(Math.ceil(entryTime / 60_000) * 60_000, (trade.last_processed_time ?? 0) + 1);
  const preciseWindow = preciseClosed.filter((candle) => candle.time >= preciseStart);
  if (!preciseWindow.length) return { evaluated: 0, balanceDelta: 0 };
  const simulation = simulatePaperPosition({
    side: trade.side,
    entryPrice,
    targetPrice: trade.target_price,
    stopPrice: trade.stop_price,
    quantity,
    dueTime: trade.due_time,
    candles: preciseWindow,
    feeBps: account.fee_bps,
    slippageBps: account.slippage_bps,
  });
  const feesBase = quoteToPaperBalance(simulation.fees, quotePerUsdt) ?? 0;
  const realizedPnlBase = quoteToPaperBalance(simulation.realizedPnl, quotePerUsdt);
  const unrealizedPnlBase = quoteToPaperBalance(simulation.unrealizedPnl, quotePerUsdt);
  const maxFavorablePct = Math.max(trade.max_favorable_pct ?? 0, simulation.maxFavorablePct);
  const maxAdversePct = Math.min(trade.max_adverse_pct ?? 0, simulation.maxAdversePct);
  const updated = await db.prepare(`UPDATE paper_trades SET status = ?, entry_time = ?, first_entry_time = COALESCE(first_entry_time, ?), exit_time = ?, exit_time_source = ?, entry_price = ?,
    exit_price = ?, quantity = ?, notional = ?, risk_amount = ?, fees = ?, fees_native = ?, realized_pnl = ?,
    realized_pnl_native = ?, pnl_pct = ?, unrealized_pnl = ?, unrealized_pnl_native = ?, unrealized_pnl_pct = ?,
    last_price = ?, max_favorable_pct = ?, max_adverse_pct = ?,
    exit_reason = ?, last_processed_time = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'`)
    .bind(
      simulation.status, entryTime, entryTime, simulation.exitTime, simulation.status === "CLOSED" ? "ONE_MINUTE_CANDLE" : null, entryPrice, simulation.exitPrice, quantity, notional,
      riskAmount, feesBase, simulation.fees, realizedPnlBase, simulation.realizedPnl, simulation.pnlPct,
      unrealizedPnlBase, simulation.unrealizedPnl, simulation.unrealizedPnlPct, simulation.lastPrice,
      maxFavorablePct, maxAdversePct,
      simulation.exitReason, simulation.lastProcessedTime, Date.now(), trade.id,
    ).run();
  if (Number(updated.meta.changes ?? 0) < 1) return { evaluated: 0, balanceDelta: 0 };
  if (simulation.status === "CLOSED" && trade.status !== "CLOSED" && realizedPnlBase != null) {
    await db.prepare("UPDATE paper_accounts SET balance = balance + ?, updated_at = ? WHERE id = ?")
      .bind(realizedPnlBase, Date.now(), ACCOUNT_ID).run();
    return { evaluated: 1, balanceDelta: realizedPnlBase };
  }
  return { evaluated: 1, balanceDelta: 0 };
}

async function runPaperEvaluation() {
  const db = await ensurePaperSchema();
  const queued = await syncPaperCandidates();
  let account = await accountRow(db);
  if (!account.enabled) return { queued, evaluated: 0 };
  const openedAtSignal = account.entry_mode === "AUTO" ? await openReadyCandidatesAtSignal(db, account) : 0;
  const active = await db.prepare("SELECT * FROM paper_trades WHERE account_id = ? AND status IN ('CANDIDATE', 'OPEN') ORDER BY signal_time ASC LIMIT 100")
    .bind(ACCOUNT_ID).all<TradeRow>();
  const executionData = new Map<string, Awaited<ReturnType<typeof getExecutionMarketData>>>();
  let evaluated = openedAtSignal;
  for (const trade of active.results ?? []) {
    if (trade.status === "CANDIDATE" && trade.due_time <= Date.now()) {
      await skipTrade(db, trade.id, "EXPIRED");
      evaluated += 1;
      continue;
    }
    if (trade.status === "CANDIDATE") {
      const session = getMarketSessionState(trade.market, Date.now());
      if (!session.isOpen) {
        await blockCandidate(db, trade, "MARKET_CLOSED", "Рынок закрыт; вход будет проверен в следующую торговую сессию");
        continue;
      }
    }
    try {
      const executionKey = `${trade.market}:${trade.symbol}`;
      let execution = executionData.get(executionKey);
      if (!execution) {
        execution = await getExecutionMarketData(trade.symbol, trade.market);
        executionData.set(executionKey, execution);
      }
      const result = await processTrade(db, account, trade, execution.candles);
      evaluated += result.evaluated;
      if (result.balanceDelta) account = { ...account, balance: account.balance + result.balanceDelta };
    } catch (error) {
      if (trade.status === "CANDIDATE") {
        const detail = error instanceof Error ? error.message : "Источник минутных котировок недоступен";
        await blockCandidate(db, trade, "QUOTE_UNAVAILABLE", detail);
      }
      // Open positions remain unchanged until continuous one-minute history is available.
    }
  }
  return { queued, evaluated };
}

export async function evaluatePaperTrades() {
  if (evaluationPromise) return evaluationPromise;
  evaluationPromise = runPaperEvaluation().finally(() => {
    evaluationPromise = null;
  });
  return evaluationPromise;
}

export function calculateShadowForecastResult(input: {
  side: PaperTradeSide;
  entryPrice: number | null | undefined;
  exitPrice: number | null | undefined;
  targetPrice?: number | null;
  stopPrice?: number | null;
  firstTouch?: "TARGET" | "INVALIDATION" | "AMBIGUOUS" | "NONE" | null;
  feeBps: number;
  slippageBps: number;
}): { exitPrice: number; grossResultPct: number; resultPct: number; estimatedCostPct: number; outcome: PaperShadowOutcome } | null {
  if (input.entryPrice == null || input.exitPrice == null || !Number.isFinite(input.entryPrice) || !Number.isFinite(input.exitPrice) || input.entryPrice <= 0) return null;
  const resolvedExitPrice = input.firstTouch === "TARGET" && input.targetPrice != null
    ? input.targetPrice
    : (input.firstTouch === "INVALIDATION" || input.firstTouch === "AMBIGUOUS") && input.stopPrice != null
      ? input.stopPrice
      : input.exitPrice;
  const rawMovePct = (resolvedExitPrice / input.entryPrice - 1) * 100;
  const grossResultPct = input.side === "LONG" ? rawMovePct : -rawMovePct;
  const estimatedCostPct = Math.max(0, (input.feeBps + input.slippageBps) * 2 / 100);
  const resultPct = grossResultPct - estimatedCostPct;
  const outcome: PaperShadowOutcome = Math.abs(resultPct) < 0.005 ? "FLAT" : resultPct > 0 ? "WIN" : "LOSS";
  return { exitPrice: resolvedExitPrice, grossResultPct, resultPct, estimatedCostPct, outcome };
}

function mapTradeWithAccount(row: TradeRow, account: AccountRow): PaperTrade {
  const shadow = row.status === "SKIPPED" && row.shadow_forecast_status === "EVALUATED"
    ? calculateShadowForecastResult({
        side: row.side,
        entryPrice: row.shadow_entry_price,
        exitPrice: row.shadow_exit_price,
        targetPrice: row.target_price,
        stopPrice: row.stop_price,
        firstTouch: row.shadow_first_touch,
        feeBps: account.fee_bps,
        slippageBps: account.slippage_bps,
      })
    : null;
  return {
    id: row.id,
    forecastId: row.forecast_id,
    modelVersion: row.model_version,
    symbol: row.symbol,
    market: row.market,
    timeframe: row.timeframe,
    side: row.side,
    status: row.status,
    entrySource: row.entry_source,
    quoteCurrency: row.quote_currency,
    fxRate: row.fx_rate,
    signalTime: row.signal_time,
    dueTime: row.due_time,
    entryTime: row.entry_time,
    entryTimeSource: row.entry_time_source,
    firstEntryTime: row.first_entry_time,
    scaleInCount: row.scale_in_count,
    exitTime: row.exit_time,
    exitTimeSource: row.exit_time_source,
    entryPrice: row.entry_price,
    targetPrice: row.target_price,
    stopPrice: row.stop_price,
    exitPrice: row.exit_price,
    quantity: row.quantity,
    notional: row.notional,
    riskAmount: row.risk_amount,
    fees: row.fees,
    feesNative: row.fees_native,
    realizedPnl: row.realized_pnl,
    realizedPnlNative: row.realized_pnl_native,
    pnlPct: row.pnl_pct,
    unrealizedPnl: row.unrealized_pnl,
    unrealizedPnlNative: row.unrealized_pnl_native,
    unrealizedPnlPct: row.unrealized_pnl_pct,
    lastPrice: row.last_price,
    maxFavorablePct: row.max_favorable_pct,
    maxAdversePct: row.max_adverse_pct,
    exitReason: row.exit_reason,
    lastProcessedTime: row.last_processed_time,
    entryBlockReason: row.entry_block_reason ?? null,
    entryBlockDetail: row.entry_block_detail ?? null,
    entryBlockedAt: row.entry_blocked_at ?? null,
    shadowForecastStatus: row.shadow_forecast_status ?? null,
    shadowEntryPrice: row.shadow_entry_price ?? null,
    shadowExitPrice: shadow?.exitPrice ?? row.shadow_exit_price ?? null,
    shadowEvaluationTime: row.shadow_evaluation_time ?? null,
    shadowGrossResultPct: shadow?.grossResultPct ?? null,
    shadowResultPct: shadow?.resultPct ?? null,
    shadowEstimatedCostPct: shadow?.estimatedCostPct ?? null,
    shadowOutcome: shadow?.outcome ?? null,
    shadowTargetHit: row.shadow_target_hit == null ? null : Boolean(row.shadow_target_hit),
    shadowInvalidationHit: row.shadow_invalidation_hit == null ? null : Boolean(row.shadow_invalidation_hit),
    shadowFirstTouch: row.shadow_first_touch ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ATTRIBUTABLE_STRATEGIES = new Set<ForecastStrategyId>([
  "ema-corridor",
  "legacy-macd",
  "macd-exhaustion",
  "opening-range-3",
  "mtf-entry",
  "nison",
  "vpa",
  "level-action",
]);

function tradeStrategyParticipants(row: TradeRow): ForecastStrategyMatch[] {
  const direction: ForecastDirection = row.side === "LONG" ? "BULL" : "BEAR";
  try {
    const forecast = JSON.parse(row.forecast_json ?? "") as Partial<ForecastProjection>;
    const unique = new Map<ForecastStrategyId, ForecastStrategyMatch>();
    (forecast.strategyMatches ?? [])
      .filter((match) => ATTRIBUTABLE_STRATEGIES.has(match.id))
      .filter((match) => match.direction === direction)
      .filter((match) => match.state === "CONFIRMED" || match.state === "SUPPORTING")
      .forEach((match) => unique.set(match.id, match));
    if (unique.size) return [...unique.values()];
  } catch {
    // Old forecasts without strategy metadata receive a generic attribution below.
  }
  return [{
    id: "scenario-forecast",
    label: "Сценарный прогноз",
    shortLabel: "СЦЕНАРИЙ",
    tone: "slate",
    state: "SUPPORTING",
    direction,
    summary: "Сделка создана без раздельной информации о стратегиях",
  }];
}

export function strategyAttribution(rows: TradeRow[]): PaperTradingPayload["strategyStats"] {
  const stats = new Map<ForecastStrategyId, {
    id: ForecastStrategyId;
    label: string;
    tone: ForecastStrategyTone;
    openedCredit: number;
    activeCredit: number;
    closedCredit: number;
    winCredit: number;
    lossCredit: number;
    realizedPnl: number;
    rawTrades: number;
  }>();
  rows.filter((row) => row.entry_time != null && (row.status === "OPEN" || row.status === "CLOSED")).forEach((row) => {
    const participants = tradeStrategyParticipants(row);
    const credit = 1 / participants.length;
    participants.forEach((match) => {
      const current = stats.get(match.id) ?? {
        id: match.id,
        label: match.label,
        tone: match.tone,
        openedCredit: 0,
        activeCredit: 0,
        closedCredit: 0,
        winCredit: 0,
        lossCredit: 0,
        realizedPnl: 0,
        rawTrades: 0,
      };
      current.openedCredit += credit;
      current.rawTrades += 1;
      if (row.status === "OPEN") current.activeCredit += credit;
      if (row.status === "CLOSED") {
        current.closedCredit += credit;
        current.realizedPnl += (row.realized_pnl ?? 0) * credit;
        if ((row.realized_pnl ?? 0) > 0) current.winCredit += credit;
        else current.lossCredit += credit;
      }
      stats.set(match.id, current);
    });
  });
  return [...stats.values()].map((item) => ({
    ...item,
    winRatePct: item.closedCredit > 0 ? item.winCredit / item.closedCredit * 100 : null,
  })).sort((left, right) => right.openedCredit - left.openedCredit || right.realizedPnl - left.realizedPnl);
}

async function payload(db: D1, queuedNow: number, evaluatedNow: number): Promise<PaperTradingPayload> {
  const [account, rows] = await Promise.all([
    accountRow(db),
    db.prepare(`SELECT p.*,
      f.status AS shadow_forecast_status,
      f.current_price AS shadow_entry_price,
      f.actual_close AS shadow_exit_price,
      f.evaluation_time AS shadow_evaluation_time,
      f.target_hit AS shadow_target_hit,
      f.invalidation_hit AS shadow_invalidation_hit,
      f.first_touch AS shadow_first_touch,
      f.forecast_json AS forecast_json
      FROM paper_trades p
      LEFT JOIN forecast_journal f ON f.id = p.forecast_id
      WHERE p.account_id = ? ORDER BY p.signal_time DESC, p.created_at DESC LIMIT 500`)
      .bind(ACCOUNT_ID).all<TradeRow>(),
  ]);
  const tradeRows = (rows.results ?? []) as TradeRow[];
  const trades: PaperTrade[] = tradeRows.map((row) => mapTradeWithAccount(row, account));
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const wins = closed.filter((trade) => (trade.realizedPnl ?? 0) > 0).length;
  const losses = closed.filter((trade) => (trade.realizedPnl ?? 0) <= 0).length;
  const realizedPnl = closed.reduce((sum, trade) => sum + (trade.realizedPnl ?? 0), 0);
  const unrealizedPnl = trades.filter((trade) => trade.status === "OPEN").reduce((sum, trade) => sum + (trade.unrealizedPnl ?? 0), 0);
  const fees = trades.reduce((sum, trade) => sum + trade.fees, 0);
  const grossProfit = closed.reduce((sum, trade) => sum + Math.max(0, trade.realizedPnl ?? 0), 0);
  const grossLoss = Math.abs(closed.reduce((sum, trade) => sum + Math.min(0, trade.realizedPnl ?? 0), 0));
  const equity = account.balance + unrealizedPnl;
  const shadowEvaluatedTrades = trades.filter((trade) => trade.status === "SKIPPED" && trade.shadowOutcome != null);
  const shadowWins = shadowEvaluatedTrades.filter((trade) => trade.shadowOutcome === "WIN").length;
  const shadowLosses = shadowEvaluatedTrades.filter((trade) => trade.shadowOutcome === "LOSS").length;
  const shadowFlat = shadowEvaluatedTrades.filter((trade) => trade.shadowOutcome === "FLAT").length;
  const mappedAccount: PaperAccount = {
    id: account.id,
    name: account.name,
    initialBalance: account.initial_balance,
    balance: account.balance,
    equity,
    riskPerTradePct: account.risk_per_trade_pct,
    feeBps: account.fee_bps,
    slippageBps: account.slippage_bps,
    maxOpenPositions: account.max_open_positions,
    enabled: Boolean(account.enabled),
    entryMode: account.entry_mode,
    rubPerUsdt: account.rub_per_usdt,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
  return {
    account: mappedAccount,
    summary: {
      total: trades.length,
      candidates: trades.filter((trade) => trade.status === "CANDIDATE").length,
      open: trades.filter((trade) => trade.status === "OPEN").length,
      closed: closed.length,
      skipped: trades.filter((trade) => trade.status === "SKIPPED").length,
      merged: trades.filter((trade) => trade.status === "MERGED").length,
      voided: trades.filter((trade) => trade.status === "VOIDED").length,
      wins,
      losses,
      winRatePct: closed.length ? wins / closed.length * 100 : null,
      realizedPnl,
      unrealizedPnl,
      netPnlPct: account.initial_balance > 0 ? (equity / account.initial_balance - 1) * 100 : 0,
      fees,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      shadowEvaluated: shadowEvaluatedTrades.length,
      shadowWins,
      shadowLosses,
      shadowFlat,
      shadowWinRatePct: shadowWins + shadowLosses ? shadowWins / (shadowWins + shadowLosses) * 100 : null,
      shadowAverageResultPct: shadowEvaluatedTrades.length
        ? shadowEvaluatedTrades.reduce((sum, trade) => sum + (trade.shadowResultPct ?? 0), 0) / shadowEvaluatedTrades.length
        : null,
    },
    strategyStats: strategyAttribution(tradeRows),
    trades,
    evaluatedNow,
    queuedNow,
    updatedAt: new Date().toISOString(),
  };
}

export async function readPaperTrading(runEvaluation = false) {
  const db = await ensurePaperSchema();
  if (runEvaluation) await evaluateDueForecasts();
  const result = runEvaluation ? await evaluatePaperTrades() : { queued: 0, evaluated: 0 };
  return payload(db, result.queued, result.evaluated);
}

export async function openPaperRecommendation(forecastId: string, allowAddToPosition = false) {
  if (evaluationPromise) await evaluationPromise;
  const db = await ensurePaperSchema();
  const account = await accountRow(db);
  if (!account.enabled) throw new Error("Сначала включите виртуальную торговлю");
  const row = await db.prepare(`SELECT id, model_version, symbol, market, timeframe, asof_time, due_time,
    status, primary_direction, current_price, target_price, invalidation_price, forecast_json
    FROM forecast_journal WHERE id = ? LIMIT 1`).bind(forecastId).first<ForecastStatusRow>();
  if (!row) throw new Error("Прогноз не найден");
  if (row.status !== "PENDING" || row.due_time <= Date.now()) throw new Error("Срок этого прогноза уже завершён");
  const entrySource = paperEntrySourceForForecast(forecastDecision(row), row.primary_direction, "MANUAL");
  if (!entrySource) throw new Error("Ручной вход доступен только для свежего направленного прогноза «ГОТОВ» или «ЖДЁМ»");
  const existing = await db.prepare("SELECT * FROM paper_trades WHERE forecast_id = ? LIMIT 1").bind(forecastId).first<TradeRow>();
  if (existing) {
    if (existing.status === "CANDIDATE" && existing.entry_source !== "AUTO") {
      const data = await getExecutionMarketData(existing.symbol, existing.market);
      const opened = await openManualCandidateNow(db, account, existing, data.candles);
      return { ...(await payload(db, 0, opened.evaluated)), manualCreated: false, ...opened };
    }
    return { ...(await payload(db, 0, 0)), manualCreated: false };
  }

  const activeRows = await db.prepare(`SELECT * FROM paper_trades
    WHERE account_id = ? AND market = ? AND symbol = ? AND status IN ('CANDIDATE', 'OPEN')
    ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, updated_at DESC`)
    .bind(ACCOUNT_ID, row.market, row.symbol).all<TradeRow>();
  const activeTrades = (activeRows.results ?? []) as TradeRow[];
  const pending = activeTrades.find((trade) => trade.status === "CANDIDATE");
  if (pending) throw new Error(`По ${row.symbol} уже ожидается виртуальный вход. Сначала дождитесь его открытия или отмены.`);
  const openPosition = activeTrades.find((trade) => trade.status === "OPEN");
  const requestedSide: PaperTradeSide = row.primary_direction === "BULL" ? "LONG" : "SHORT";
  if (openPosition && openPosition.side !== requestedSide) {
    throw new Error(`По ${row.symbol} уже открыта позиция ${openPosition.side}. Докупка в противоположную сторону запрещена — сначала закройте текущую позицию.`);
  }
  if (openPosition && !allowAddToPosition) {
    return {
      ...(await payload(db, 0, 0)),
      manualCreated: false,
      requiresAddConfirmation: true,
      existingPosition: {
        id: openPosition.id,
        symbol: openPosition.symbol,
        side: openPosition.side,
        entryPrice: openPosition.entry_price,
        targetPrice: openPosition.target_price,
        stopPrice: openPosition.stop_price,
        scaleInCount: openPosition.scale_in_count,
      },
      proposedLevels: { targetPrice: row.target_price, stopPrice: row.invalidation_price },
    };
  }

  const now = Date.now();
  const tradeId = crypto.randomUUID();
  const inserted = await candidateStatement(db, account, row, openPosition ? "MANUAL_ADD" : entrySource, now, tradeId).run();
  if (Number(inserted.meta.changes ?? 0) < 1) return { ...(await payload(db, 0, 0)), manualCreated: false };
  const trade = await db.prepare("SELECT * FROM paper_trades WHERE id = ? LIMIT 1").bind(tradeId).first<TradeRow>();
  if (!trade) throw new Error("Виртуальная сделка не была создана");
  try {
    const data = await getExecutionMarketData(row.symbol, row.market);
    const opened = await openManualCandidateNow(db, account, trade, data.candles);
    return {
      ...(await payload(db, 0, opened.evaluated)),
      manualCreated: true,
      ...opened,
    };
  } catch (error) {
    const pendingTrade = await db.prepare("SELECT status FROM paper_trades WHERE id = ? LIMIT 1").bind(tradeId).first<{ status: PaperTradeStatus }>();
    if (pendingTrade?.status === "CANDIDATE") await skipTrade(db, tradeId, "NO_ENTRY_DATA");
    throw error;
  }
}

export async function voidPaperTrade(tradeId: string) {
  const db = await ensurePaperSchema();
  const trade = await db.prepare("SELECT * FROM paper_trades WHERE id = ? AND account_id = ? LIMIT 1")
    .bind(tradeId, ACCOUNT_ID).first<TradeRow>();
  if (!trade) throw new Error("Виртуальная сделка не найдена");
  if (trade.status !== "OPEN" && trade.status !== "CANDIDATE") {
    throw new Error("Аннулировать можно только открытую или ожидающую сделку");
  }
  const now = Date.now();
  await db.prepare(`UPDATE paper_trades SET status = 'VOIDED', exit_time = ?, exit_time_source = 'MANUAL_ACTION',
    exit_price = NULL, realized_pnl = NULL, realized_pnl_native = NULL, pnl_pct = NULL,
    unrealized_pnl = NULL, unrealized_pnl_native = NULL, unrealized_pnl_pct = NULL,
    exit_reason = 'INVALID_EXECUTION', updated_at = ? WHERE id = ? AND status IN ('OPEN', 'CANDIDATE')`)
    .bind(now, now, tradeId).run();
  return payload(db, 0, 0);
}

export async function closePaperTrade(tradeId: string) {
  if (evaluationPromise) await evaluationPromise;
  const db = await ensurePaperSchema();
  const account = await accountRow(db);
  const trade = await db.prepare("SELECT * FROM paper_trades WHERE id = ? AND account_id = ? LIMIT 1")
    .bind(tradeId, ACCOUNT_ID).first<TradeRow>();
  if (!trade) throw new Error("Виртуальная сделка не найдена");
  if (trade.status !== "OPEN") throw new Error("Закрыть вручную можно только открытую позицию");
  if (trade.entry_price == null || trade.quantity == null || trade.quantity <= 0 || trade.notional == null || trade.notional <= 0) {
    throw new Error("У позиции нет корректных данных входа");
  }

  const data = await getExecutionMarketData(trade.symbol, trade.market);
  const latest = [...data.candles]
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
    .sort((left, right) => left.time - right.time)
    .at(-1);
  if (!latest) throw new Error("Не удалось получить актуальную цену для закрытия");

  const quotePerUsdt = trade.fx_rate > 0
    ? trade.fx_rate
    : paperCurrency(trade.market, account.rub_per_usdt, trade.symbol, latest.close).quotePerUsdt;
  const close = calculateManualPaperClose({
    side: trade.side,
    entryPrice: trade.entry_price,
    markPrice: latest.close,
    quantity: trade.quantity,
    notional: trade.notional,
    entryFeesNative: trade.fees_native,
    feeBps: account.fee_bps,
    slippageBps: account.slippage_bps,
    quotePerUsdt,
  });
  const now = Date.now();
  const results = await db.batch([
    db.prepare(`UPDATE paper_trades SET status = 'CLOSED', exit_time = ?, exit_time_source = 'MANUAL_ACTION', exit_price = ?, fees = ?, fees_native = ?,
      realized_pnl = ?, realized_pnl_native = ?, pnl_pct = ?, unrealized_pnl = NULL, unrealized_pnl_native = NULL,
      unrealized_pnl_pct = NULL, last_price = ?, exit_reason = 'MANUAL_CLOSE', last_processed_time = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND status = 'OPEN'`).bind(
      now, close.exitPrice, close.fees, close.feesNative, close.realizedPnl, close.realizedPnlNative,
      close.pnlPct, close.exitPrice, latest.time, now, trade.id, ACCOUNT_ID,
    ),
    db.prepare(`UPDATE paper_accounts SET balance = balance + ?, updated_at = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM paper_trades WHERE id = ? AND status = 'CLOSED'
          AND exit_reason = 'MANUAL_CLOSE' AND updated_at = ?
      )`).bind(close.realizedPnl, now, ACCOUNT_ID, trade.id, now),
  ]) as Array<{ meta?: { changes?: number } }>;
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error("Позиция уже была закрыта другим обновлением");
  }

  return {
    ...(await payload(db, 0, 1)),
    manuallyClosed: true,
    closedTrade: {
      id: trade.id,
      symbol: trade.symbol,
      exitPrice: close.exitPrice,
      realizedPnl: close.realizedPnl,
      realizedPnlNative: close.realizedPnlNative,
      quoteCurrency: trade.quote_currency,
      quoteAsOf: latest.time,
    },
  };
}

export async function updatePaperSettings(settings: {
  enabled?: boolean;
  entryMode?: PaperEntryMode;
  rubPerUsdt?: number;
  riskPerTradePct?: number;
  feeBps?: number;
  slippageBps?: number;
  maxOpenPositions?: number;
}) {
  const db = await ensurePaperSchema();
  const account = await accountRow(db);
  const enabled = settings.enabled == null ? Boolean(account.enabled) : Boolean(settings.enabled);
  const entryMode = settings.entryMode == null ? account.entry_mode : settings.entryMode;
  const rubPerUsdt = settings.rubPerUsdt == null ? account.rub_per_usdt : Math.min(500, Math.max(10, settings.rubPerUsdt));
  const risk = settings.riskPerTradePct == null ? account.risk_per_trade_pct : Math.min(5, Math.max(0.1, settings.riskPerTradePct));
  const fee = settings.feeBps == null ? account.fee_bps : Math.min(100, Math.max(0, settings.feeBps));
  const slippage = settings.slippageBps == null ? account.slippage_bps : Math.min(100, Math.max(0, settings.slippageBps));
  const maxPositions = settings.maxOpenPositions == null ? account.max_open_positions : Math.min(25, Math.max(1, Math.round(settings.maxOpenPositions)));
  await db.prepare(`UPDATE paper_accounts SET enabled = ?, entry_mode = ?, rub_per_usdt = ?,
    risk_per_trade_pct = ?, fee_bps = ?, slippage_bps = ?, max_open_positions = ?, updated_at = ? WHERE id = ?`)
    .bind(enabled ? 1 : 0, entryMode, rubPerUsdt, risk, fee, slippage, maxPositions, Date.now(), ACCOUNT_ID).run();
  const queued = enabled && entryMode === "AUTO" ? await syncPaperCandidates() : 0;
  return payload(db, queued, 0);
}
