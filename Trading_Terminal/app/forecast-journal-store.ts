import { getExecutionMarketData, getMarketData } from "./market-data-service";
import { projectMarketTimes } from "./market-calendar";
import { SCENARIO_MODEL_VERSION } from "./terminal-forecast";
import type {
  Candle,
  ForecastDecision,
  ForecastDirection,
  ForecastJournalPayload,
  ForecastJournalRecord,
  ForecastProjection,
  ForecastStrategyId,
  ForecastStrategyMatch,
  ForecastStrategyTone,
  LevelActionSnapshot,
  Market,
  MarketRegime,
  Timeframe,
  VpaSnapshot,
} from "./terminal-types";

type D1 = D1Database;

type JournalRow = {
  id: string;
  model_version: string;
  symbol: string;
  market: Market;
  timeframe: Timeframe;
  asof_time: number;
  due_time: number;
  status: "PENDING" | "EVALUATED";
  primary_direction: ForecastDirection;
  primary_weight: number;
  bull_weight: number;
  sideways_weight: number;
  bear_weight: number;
  current_price: number;
  target_price: number;
  invalidation_price: number;
  horizon_bars: number;
  bias_score: number;
  atr: number;
  historical_samples: number;
  similar_outcome_rate: number | null;
  drivers_json: string;
  forecast_json: string;
  created_at: string;
  evaluated_at: number | null;
  evaluation_time: number | null;
  actual_close: number | null;
  actual_direction: ForecastDirection | null;
  actual_return_pct: number | null;
  correct: number | null;
  target_hit: number | null;
  invalidation_hit: number | null;
  first_touch: "TARGET" | "INVALIDATION" | "AMBIGUOUS" | "NONE" | null;
  max_up_pct: number | null;
  max_down_pct: number | null;
  target_error_pct: number | null;
};

type PendingRow = Pick<JournalRow,
  "id" | "symbol" | "market" | "timeframe" | "asof_time" | "due_time" | "primary_direction" |
  "current_price" | "target_price" | "invalidation_price" | "atr" | "forecast_json"
>;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS forecast_journal (
  id TEXT PRIMARY KEY NOT NULL,
  model_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  asof_time INTEGER NOT NULL,
  due_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  primary_direction TEXT NOT NULL,
  primary_weight REAL NOT NULL,
  bull_weight REAL NOT NULL,
  sideways_weight REAL NOT NULL,
  bear_weight REAL NOT NULL,
  current_price REAL NOT NULL,
  target_price REAL NOT NULL,
  invalidation_price REAL NOT NULL,
  horizon_bars INTEGER NOT NULL,
  bias_score INTEGER NOT NULL,
  atr REAL NOT NULL,
  historical_samples INTEGER NOT NULL,
  similar_outcome_rate REAL,
  drivers_json TEXT NOT NULL,
  features_json TEXT NOT NULL,
  forecast_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  evaluated_at INTEGER,
  evaluation_time INTEGER,
  actual_close REAL,
  actual_direction TEXT,
  actual_return_pct REAL,
  correct INTEGER,
  target_hit INTEGER,
  invalidation_hit INTEGER,
  first_touch TEXT,
  max_up_pct REAL,
  max_down_pct REAL,
  target_error_pct REAL
)`;

let schemaReady = false;

async function getBinding() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("Локальная база прогноза DB недоступна. Перезапустите терминал.");
  return env.DB;
}

export async function ensureForecastSchema() {
  const db = await getBinding();
  if (schemaReady) return db;
  await db.batch([
    db.prepare(CREATE_TABLE),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_unique ON forecast_journal (model_version, symbol, timeframe, asof_time)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_forecast_pending_due ON forecast_journal (status, due_time)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_forecast_symbol_timeframe ON forecast_journal (symbol, timeframe, asof_time)"),
  ]);
  await db.prepare("PRAGMA optimize").run();
  schemaReady = true;
  return db;
}

function scenario(forecast: ForecastProjection, id: "bull" | "sideways" | "bear") {
  return forecast.scenarios.find((item) => item.id === id);
}

export async function recordForecast(
  symbol: string,
  market: Market,
  timeframe: Timeframe,
  forecast: ForecastProjection,
  candles: Candle[],
  preciseCandles: Candle[] = [],
) {
  const db = await ensureForecastSchema();
  const evaluated = await evaluatePendingWithCandles(db, symbol, timeframe, candles, preciseCandles);
  const primary = forecast.scenarios.find((item) => item.direction === forecast.primary);
  const bull = scenario(forecast, "bull");
  const sideways = scenario(forecast, "sideways");
  const bear = scenario(forecast, "bear");
  if (!primary || !bull || !sideways || !bear) throw new Error("Неполный набор сценариев прогноза");
  const projectedTimes = forecast.projectedTimes?.length === forecast.horizonBars + 1
    ? forecast.projectedTimes
    : projectMarketTimes(forecast.asofTime, forecast.horizonBars, timeframe, market);
  const strategyExpiry = Math.max(forecast.asofTime, ...forecast.strategyMatches.map((match) => match.trial?.expiresAt ?? forecast.asofTime));
  const dueTime = Math.max(projectedTimes.at(-1) ?? forecast.asofTime, strategyExpiry);
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO forecast_journal (
    id, model_version, symbol, market, timeframe, asof_time, due_time, status,
    primary_direction, primary_weight, bull_weight, sideways_weight, bear_weight,
    current_price, target_price, invalidation_price, horizon_bars, bias_score, atr,
    historical_samples, similar_outcome_rate, drivers_json, features_json, forecast_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(model_version, symbol, timeframe, asof_time) DO NOTHING`)
    .bind(
      id, forecast.modelVersion, symbol, market, timeframe, forecast.asofTime, dueTime,
      forecast.primary, forecast.primaryWeight, bull.weight, sideways.weight, bear.weight,
      forecast.features.close, primary.target, forecast.invalidation, forecast.horizonBars,
      forecast.biasScore, forecast.atr, forecast.historicalSamples, forecast.similarOutcomeRate,
      JSON.stringify(forecast.drivers), JSON.stringify(forecast.features), JSON.stringify(forecast),
      new Date().toISOString(),
    ).run();
  return { created: Boolean(result.meta.changes), id: result.meta.changes ? id : null, evaluated };
}

export async function findForecastRecordId(
  symbol: string,
  timeframe: Timeframe,
  asofTime: number,
  modelVersion = SCENARIO_MODEL_VERSION,
) {
  const db = await ensureForecastSchema();
  const row = await db.prepare(`SELECT id FROM forecast_journal
    WHERE model_version = ? AND symbol = ? AND timeframe = ? AND asof_time = ? LIMIT 1`)
    .bind(modelVersion, symbol, timeframe, asofTime).first<{ id: string }>();
  return row?.id ?? null;
}


function directionFromMove(move: number, threshold: number): ForecastDirection {
  if (move > threshold) return "BULL";
  if (move < -threshold) return "BEAR";
  return "SIDEWAYS";
}

function directionFromWindow(record: PendingRow, candles: Candle[], finalClose: number): ForecastDirection {
  const upper = record.current_price + record.atr * 1.05;
  const lower = record.current_price - record.atr * 1.05;
  for (const candle of candles) {
    const bullHit = candle.high >= upper;
    const bearHit = candle.low <= lower;
    if (bullHit && bearHit) return "SIDEWAYS";
    if (bullHit) return "BULL";
    if (bearHit) return "BEAR";
  }
  const threshold = Math.max(record.atr * 0.42, record.current_price * 0.0005);
  return directionFromMove(finalClose - record.current_price, threshold);
}

function touches(record: PendingRow, candle: Candle) {
  const targetAbove = record.target_price >= record.current_price;
  const invalidationAbove = record.invalidation_price >= record.current_price;
  return {
    target: targetAbove ? candle.high >= record.target_price : candle.low <= record.target_price,
    invalidation: invalidationAbove ? candle.high >= record.invalidation_price : candle.low <= record.invalidation_price,
  };
}

function evaluateStrategyTrials(forecastJson: string, fallbackCandles: Candle[], preciseCandles: Candle[]) {
  try {
    const forecast = JSON.parse(forecastJson) as ForecastProjection;
    let changed = false;
    forecast.strategyMatches = (forecast.strategyMatches ?? []).map((match) => {
      const trial = match.trial;
      if (!trial || trial.result) return match;
      const source = trial.executionResolutionMinutes <= 5 && preciseCandles.length ? preciseCandles : fallbackCandles;
      const window = source.filter((candle) => candle.closed !== false && candle.time > trial.signalTime && candle.time <= trial.expiresAt)
        .sort((left, right) => left.time - right.time);
      const intervals = window.slice(1).map((candle, index) => candle.time - window[index].time).filter((value) => value > 0).sort((left, right) => left - right);
      const candleDuration = intervals[Math.floor(intervals.length / 2)] ?? trial.executionResolutionMinutes * 60_000;
      if (!window.length || (window.at(-1)?.time ?? 0) + candleDuration < trial.expiresAt) return match;
      const direction = trial.side === "LONG" ? 1 : -1;
      let exitReason: "TARGET" | "STOP" | "EXPIRY" | "AMBIGUOUS" = "EXPIRY";
      let exitPrice = window.at(-1)!.close;
      let exitTime = window.at(-1)!.time;
      for (const candle of window) {
        const targetHit = trial.side === "LONG" ? candle.high >= trial.targetPrice : candle.low <= trial.targetPrice;
        const stopHit = trial.side === "LONG" ? candle.low <= trial.stopPrice : candle.high >= trial.stopPrice;
        if (targetHit && stopHit) {
          exitReason = "AMBIGUOUS";
          exitPrice = trial.stopPrice;
          exitTime = candle.time;
          break;
        }
        if (targetHit) {
          exitReason = "TARGET";
          exitPrice = trial.targetPrice;
          exitTime = candle.time;
          break;
        }
        if (stopHit) {
          exitReason = "STOP";
          exitPrice = trial.stopPrice;
          exitTime = candle.time;
          break;
        }
      }
      const returnPct = ((exitPrice / trial.entryPrice) - 1) * 100 * direction;
      const favorablePrices = window.map((candle) => trial.side === "LONG" ? candle.high : candle.low);
      const adversePrices = window.map((candle) => trial.side === "LONG" ? candle.low : candle.high);
      const maxFavorablePct = trial.side === "LONG"
        ? ((Math.max(...favorablePrices) / trial.entryPrice) - 1) * 100
        : ((trial.entryPrice / Math.min(...favorablePrices)) - 1) * 100;
      const maxAdversePct = trial.side === "LONG"
        ? ((Math.min(...adversePrices) / trial.entryPrice) - 1) * 100
        : ((trial.entryPrice / Math.max(...adversePrices)) - 1) * 100;
      const outcome = exitReason === "TARGET" ? "WIN"
        : exitReason === "STOP" || exitReason === "AMBIGUOUS" ? "LOSS"
          : returnPct > 0.05 ? "WIN" : returnPct < -0.05 ? "LOSS" : "FLAT";
      changed = true;
      return { ...match, trial: { ...trial, result: { outcome, exitReason, exitTime, exitPrice, returnPct, maxFavorablePct, maxAdversePct } } };
    });
    return { changed, forecastJson: JSON.stringify(forecast) };
  } catch {
    return { changed: false, forecastJson };
  }
}

export async function evaluatePendingWithCandles(db: D1, symbol: string, timeframe: Timeframe, candles: Candle[], preciseCandles: Candle[] = []) {
  const closed = candles.filter((candle) => candle.closed !== false).sort((a, b) => a.time - b.time);
  const latestTime = closed.at(-1)?.time;
  if (!latestTime) return 0;
  const pending = await db.prepare(`SELECT id, symbol, market, timeframe, asof_time, due_time, primary_direction,
    current_price, target_price, invalidation_price, atr, forecast_json
    FROM forecast_journal WHERE status = 'PENDING' AND symbol = ? AND timeframe = ? AND due_time <= ?`)
    .bind(symbol, timeframe, latestTime).all<PendingRow>();
  const updates: Array<ReturnType<D1["prepare"]>> = [];
  let evaluated = 0;

  for (const record of pending.results ?? []) {
    const evaluationCandle = closed.find((candle) => candle.time >= record.due_time);
    if (!evaluationCandle) continue;
    const evaluationWindow = closed.filter((candle) => candle.time > record.asof_time && candle.time <= evaluationCandle.time);
    if (!evaluationWindow.length) continue;
    const actualReturnPct = ((evaluationCandle.close / record.current_price) - 1) * 100;
    const actualDirection = directionFromWindow(record, evaluationWindow, evaluationCandle.close);
    const maxHigh = Math.max(...evaluationWindow.map((candle) => candle.high));
    const minLow = Math.min(...evaluationWindow.map((candle) => candle.low));
    let firstTouch: NonNullable<JournalRow["first_touch"]> = "NONE";
    let targetHit = false;
    let invalidationHit = false;
    for (const candle of evaluationWindow) {
      const hit = touches(record, candle);
      targetHit ||= hit.target;
      invalidationHit ||= hit.invalidation;
      if (firstTouch === "NONE" && hit.target && hit.invalidation) firstTouch = "AMBIGUOUS";
      else if (firstTouch === "NONE" && hit.target) firstTouch = "TARGET";
      else if (firstTouch === "NONE" && hit.invalidation) firstTouch = "INVALIDATION";
    }
    const strategyEvaluation = evaluateStrategyTrials(record.forecast_json, evaluationWindow, preciseCandles);
    updates.push(db.prepare(`UPDATE forecast_journal SET
      status = 'EVALUATED', evaluated_at = ?, evaluation_time = ?, actual_close = ?, actual_direction = ?,
      actual_return_pct = ?, correct = ?, target_hit = ?, invalidation_hit = ?, first_touch = ?,
      max_up_pct = ?, max_down_pct = ?, target_error_pct = ?, forecast_json = ? WHERE id = ?`)
      .bind(
        Date.now(), evaluationCandle.time, evaluationCandle.close, actualDirection, actualReturnPct,
        actualDirection === record.primary_direction ? 1 : 0, targetHit ? 1 : 0, invalidationHit ? 1 : 0,
        firstTouch, ((maxHigh / record.current_price) - 1) * 100, ((minLow / record.current_price) - 1) * 100,
        (Math.abs(evaluationCandle.close - record.target_price) / record.current_price) * 100,
        strategyEvaluation.forecastJson, record.id,
      ));
    evaluated += 1;
  }
  if (updates.length) await db.batch(updates);
  return evaluated;
}

export async function evaluateDueForecasts() {
  const db = await ensureForecastSchema();
  const groups = await db.prepare(`SELECT symbol, market, timeframe,
      MAX(CASE WHEN forecast_json LIKE '%"executionResolutionMinutes":1%' OR forecast_json LIKE '%"executionResolutionMinutes":5%' THEN 1 ELSE 0 END) AS needs_precise
    FROM forecast_journal
    WHERE status = 'PENDING' AND due_time <= ? GROUP BY symbol, market, timeframe ORDER BY MIN(due_time) LIMIT 12`)
    .bind(Date.now()).all<{ symbol: string; market: Market; timeframe: Timeframe; needs_precise: number }>();
  let evaluated = 0;
  for (const group of groups.results ?? []) {
    try {
      const data = await getMarketData(group.symbol, group.market, group.timeframe);
      let preciseCandles: Candle[] = [];
      if (group.needs_precise || group.market === "stocks" && group.timeframe === "15m") {
        try { preciseCandles = (await getExecutionMarketData(group.symbol, group.market)).candles; } catch { preciseCandles = []; }
      }
      evaluated += await evaluatePendingWithCandles(db, group.symbol, group.timeframe, data.candles, preciseCandles);
    } catch {
      // A temporary market-data failure leaves the forecast pending for the next pass.
    }
  }
  return evaluated;
}

function parseDrivers(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseForecastMetadata(value: string): {
  edgeMargin: number;
  decision: ForecastDecision;
  decisionReasons: string[];
  regime: MarketRegime;
  regimeLabel: string;
  strategyMatches: ForecastStrategyMatch[];
  vpa?: VpaSnapshot;
  levelAction?: LevelActionSnapshot;
} {
  try {
    const forecast = JSON.parse(value) as Partial<ForecastProjection>;
    return {
      edgeMargin: Number(forecast.edgeMargin ?? 0),
      decision: forecast.decision ?? "NO_TRADE",
      decisionReasons: Array.isArray(forecast.decisionReasons) ? forecast.decisionReasons.map(String) : [],
      regime: forecast.regime ?? "TRANSITION",
      regimeLabel: forecast.regimeLabel ?? "Старая версия режима",
      strategyMatches: Array.isArray(forecast.strategyMatches)
        ? forecast.strategyMatches.filter((item): item is ForecastStrategyMatch => Boolean(item?.id && item?.label && item?.tone))
        : [{ id: "scenario-forecast", label: "Сценарный прогноз", shortLabel: "СЦЕНАРИЙ", tone: "slate", state: "SUPPORTING", direction: forecast.primary ?? "SIDEWAYS", summary: "Запись создана до разделения стратегий" }],
      vpa: forecast.vpa && forecast.vpa.version === "vpa-v1" ? forecast.vpa : undefined,
      levelAction: forecast.levelAction && forecast.levelAction.version === "level-action-v1" ? forecast.levelAction : undefined,
    };
  } catch {
    return { edgeMargin: 0, decision: "NO_TRADE", decisionReasons: ["Метаданные решения недоступны"], regime: "TRANSITION", regimeLabel: "Не определён", strategyMatches: [], vpa: undefined, levelAction: undefined };
  }
}

function mapRow(row: JournalRow): ForecastJournalRecord {
  const metadata = parseForecastMetadata(row.forecast_json);
  return {
    id: row.id,
    modelVersion: row.model_version,
    symbol: row.symbol,
    market: row.market,
    timeframe: row.timeframe,
    asofTime: row.asof_time,
    dueTime: row.due_time,
    status: row.status,
    primaryDirection: row.primary_direction,
    primaryWeight: row.primary_weight,
    edgeMargin: metadata.edgeMargin,
    decision: metadata.decision,
    decisionReasons: metadata.decisionReasons,
    regime: metadata.regime,
    regimeLabel: metadata.regimeLabel,
    bullWeight: row.bull_weight,
    sidewaysWeight: row.sideways_weight,
    bearWeight: row.bear_weight,
    currentPrice: row.current_price,
    targetPrice: row.target_price,
    invalidationPrice: row.invalidation_price,
    horizonBars: row.horizon_bars,
    biasScore: row.bias_score,
    historicalSamples: row.historical_samples,
    similarOutcomeRate: row.similar_outcome_rate,
    createdAt: row.created_at,
    evaluatedAt: row.evaluated_at,
    evaluationTime: row.evaluation_time,
    actualClose: row.actual_close,
    actualDirection: row.actual_direction,
    actualReturnPct: row.actual_return_pct,
    correct: row.correct == null ? null : Boolean(row.correct),
    targetHit: row.target_hit == null ? null : Boolean(row.target_hit),
    invalidationHit: row.invalidation_hit == null ? null : Boolean(row.invalidation_hit),
    firstTouch: row.first_touch,
    maxUpPct: row.max_up_pct,
    maxDownPct: row.max_down_pct,
    targetErrorPct: row.target_error_pct,
    drivers: parseDrivers(row.drivers_json),
    strategyMatches: metadata.strategyMatches,
    vpa: metadata.vpa,
    levelAction: metadata.levelAction,
  };
}

export async function readForecastJournal(limit = 200): Promise<ForecastJournalPayload> {
  const db = await ensureForecastSchema();
  const [rows, summary, timeframeRows, symbolRows] = await Promise.all([
    db.prepare("SELECT * FROM forecast_journal WHERE model_version = ? ORDER BY asof_time DESC, created_at DESC LIMIT ?").bind(SCENARIO_MODEL_VERSION, Math.min(500, Math.max(1, limit))).all<JournalRow>(),
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'EVALUATED' THEN 1 ELSE 0 END) AS evaluated,
      SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
      AVG(CASE WHEN status = 'EVALUATED' THEN correct * 100.0 END) AS accuracy_pct,
      AVG(CASE WHEN status = 'EVALUATED' THEN (
        (bull_weight / 100.0 - CASE WHEN actual_direction = 'BULL' THEN 1 ELSE 0 END) * (bull_weight / 100.0 - CASE WHEN actual_direction = 'BULL' THEN 1 ELSE 0 END) +
        (sideways_weight / 100.0 - CASE WHEN actual_direction = 'SIDEWAYS' THEN 1 ELSE 0 END) * (sideways_weight / 100.0 - CASE WHEN actual_direction = 'SIDEWAYS' THEN 1 ELSE 0 END) +
        (bear_weight / 100.0 - CASE WHEN actual_direction = 'BEAR' THEN 1 ELSE 0 END) * (bear_weight / 100.0 - CASE WHEN actual_direction = 'BEAR' THEN 1 ELSE 0 END)
      ) / 3.0 END) AS brier_score,
      AVG(CASE WHEN status = 'EVALUATED' THEN target_error_pct END) AS avg_target_error_pct
      FROM forecast_journal WHERE model_version = ?`).bind(SCENARIO_MODEL_VERSION).first<Record<string, number | null>>(),
    db.prepare(`SELECT timeframe, COUNT(*) AS total,
      SUM(CASE WHEN status = 'EVALUATED' THEN 1 ELSE 0 END) AS evaluated,
      AVG(CASE WHEN status = 'EVALUATED' THEN correct * 100.0 END) AS accuracy_pct
      FROM forecast_journal WHERE model_version = ? GROUP BY timeframe ORDER BY total DESC`).bind(SCENARIO_MODEL_VERSION).all<{ timeframe: Timeframe; total: number; evaluated: number; accuracy_pct: number | null }>(),
    db.prepare(`SELECT symbol, COUNT(*) AS total,
      SUM(CASE WHEN status = 'EVALUATED' THEN 1 ELSE 0 END) AS evaluated,
      AVG(CASE WHEN status = 'EVALUATED' THEN correct * 100.0 END) AS accuracy_pct
      FROM forecast_journal WHERE model_version = ? GROUP BY symbol ORDER BY evaluated DESC, total DESC LIMIT 25`).bind(SCENARIO_MODEL_VERSION).all<{ symbol: string; total: number; evaluated: number; accuracy_pct: number | null }>(),
  ]);
  const stats = summary ?? {};
  const mappedRecords: ForecastJournalRecord[] = (rows.results ?? []).map((row: JournalRow) => mapRow(row));
  const readyRecords = mappedRecords.filter((record) => record.decision === "READY");
  const evaluatedReady = readyRecords.filter((record) => record.status === "EVALUATED");
  const readyCorrect = evaluatedReady.filter((record) => record.correct).length;
  const strategyMap = new Map<ForecastStrategyId, {
    id: ForecastStrategyId;
    label: string;
    tone: ForecastStrategyTone;
    total: number;
    evaluated: number;
    correct: number;
    confirmed: number;
    trialEvaluated: number;
    trialWins: number;
    trialLosses: number;
    trialReturnTotal: number;
  }>();
  mappedRecords.forEach((record) => record.strategyMatches.forEach((match) => {
    const current = strategyMap.get(match.id) ?? {
      id: match.id, label: match.label, tone: match.tone, total: 0, evaluated: 0, correct: 0,
      confirmed: 0, trialEvaluated: 0, trialWins: 0, trialLosses: 0, trialReturnTotal: 0,
    };
    current.total += 1;
    if (match.state === "CONFIRMED") current.confirmed += 1;
    if (record.status === "EVALUATED") {
      current.evaluated += 1;
      if (record.actualDirection === match.direction) current.correct += 1;
    }
    if (match.trial?.result) {
      current.trialEvaluated += 1;
      current.trialReturnTotal += match.trial.result.returnPct;
      if (match.trial.result.outcome === "WIN") current.trialWins += 1;
      if (match.trial.result.outcome === "LOSS" || match.trial.result.outcome === "AMBIGUOUS") current.trialLosses += 1;
    }
    strategyMap.set(match.id, current);
  }));
  return {
    summary: {
      total: Number(stats.total ?? 0),
      pending: Number(stats.pending ?? 0),
      evaluated: Number(stats.evaluated ?? 0),
      correct: Number(stats.correct ?? 0),
      accuracyPct: stats.accuracy_pct == null ? null : Number(stats.accuracy_pct),
      brierScore: stats.brier_score == null ? null : Number(stats.brier_score),
      avgTargetErrorPct: stats.avg_target_error_pct == null ? null : Number(stats.avg_target_error_pct),
      ready: readyRecords.length,
      waitingConfirmation: mappedRecords.filter((record) => record.decision === "WAIT_CONFIRMATION").length,
      noTrade: mappedRecords.filter((record) => record.decision === "NO_TRADE").length,
      readyEvaluated: evaluatedReady.length,
      readyCorrect,
      readyAccuracyPct: evaluatedReady.length ? (readyCorrect / evaluatedReady.length) * 100 : null,
    },
    records: mappedRecords,
    byTimeframe: (timeframeRows.results ?? []).map((row: { timeframe: Timeframe; total: number; evaluated: number; accuracy_pct: number | null }) => ({
      timeframe: row.timeframe as Timeframe,
      total: Number(row.total ?? 0),
      evaluated: Number(row.evaluated ?? 0),
      accuracyPct: row.accuracy_pct == null ? null : Number(row.accuracy_pct),
    })),
    bySymbol: (symbolRows.results ?? []).map((row: { symbol: string; total: number; evaluated: number; accuracy_pct: number | null }) => ({
      symbol: String(row.symbol),
      total: Number(row.total ?? 0),
      evaluated: Number(row.evaluated ?? 0),
      accuracyPct: row.accuracy_pct == null ? null : Number(row.accuracy_pct),
    })),
    byStrategy: [...strategyMap.values()].map(({ trialReturnTotal, ...item }) => ({
      ...item,
      accuracyPct: item.evaluated ? item.correct / item.evaluated * 100 : null,
      trialWinRatePct: item.trialEvaluated ? item.trialWins / item.trialEvaluated * 100 : null,
      avgTrialReturnPct: item.trialEvaluated ? trialReturnTotal / item.trialEvaluated : null,
    })).sort((left, right) => right.total - left.total),
    updatedAt: new Date().toISOString(),
  };
}
