import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// Read-only audit. --as-of makes recent windows and overdue counts reproducible.
// Example: node scripts/audit_strategy_policy.mjs --database backups/example.sqlite --as-of 2026-09-07T20:30:00Z
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  if (!["--database", "--as-of", "--version"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error("Usage: node scripts/audit_strategy_policy.mjs [--database PATH] [--as-of ISO_DATE] [--version MODEL_VERSION]");
  }
  options[name] = args[index + 1];
}
const asOf = options["--as-of"] == null ? Date.now() : Date.parse(options["--as-of"]);
if (!Number.isFinite(asOf)) throw new Error("--as-of must be a valid ISO date");
let databasePath = options["--database"] || process.env.NORTHSTAR_DB_PATH;
if (!databasePath) {
  const directory = join(process.cwd(), ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  const candidates = readdirSync(directory).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (candidates.length !== 1) throw new Error("Expected one local SQLite database; specify --database explicitly");
  databasePath = join(directory, candidates[0]);
}

function parse(value) {
  try { return JSON.parse(value); } catch { return {}; }
}
function number(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}
function time(value) {
  const numeric = number(value);
  if (numeric != null) return numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function rounded(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}
function nativeR(row) {
  const risk = number(row.risk_amount);
  if (risk == null || risk <= 0) return null;
  const nativePnl = number(row.realized_pnl_native);
  if (nativePnl != null) return nativePnl / risk;
  const rate = number(row.fx_rate);
  return rate != null && rate > 0 ? number(row.realized_pnl) * rate / risk : null;
}
function performance(rows) {
  const valid = rows.filter((row) => number(row.realized_pnl) != null);
  const returnsR = valid.map(nativeR).filter((value) => value != null);
  const profit = valid.reduce((sum, row) => sum + Math.max(0, Number(row.realized_pnl)), 0);
  const loss = valid.reduce((sum, row) => sum - Math.min(0, Number(row.realized_pnl)), 0);
  const wins = valid.filter((row) => Number(row.realized_pnl) > 0).length;
  const fees = valid.reduce((sum, row) => sum + Number(row.fees ?? 0), 0);
  return {
    total: rows.length,
    validPnl: valid.length,
    wins,
    losses: valid.filter((row) => Number(row.realized_pnl) < 0).length,
    flat: valid.filter((row) => Number(row.realized_pnl) === 0).length,
    winRatePct: rounded(valid.length ? wins / valid.length * 100 : null),
    netPnlUsdt: rounded(profit - loss),
    feesUsdt: rounded(fees),
    grossPnlBeforeFeesUsdt: rounded(profit - loss + fees),
    profitFactor: loss ? rounded(profit / loss) : null,
    expectancyR: rounded(returnsR.length ? returnsR.reduce((sum, value) => sum + value, 0) / returnsR.length : null),
    validRiskSamples: returnsR.length,
    smallSample: valid.length < 30,
  };
}
function features(row) {
  const f = row.forecast.features ?? {};
  const direction = row.primary_direction === "BULL" ? 1 : row.primary_direction === "BEAR" ? -1 : 0;
  const emaKnown = [f.close, f.ema20, f.ema50].every((value) => number(value) != null);
  const macdKnown = [f.macd, f.macdSignal, f.histogram].every((value) => number(value) != null);
  const matches = (row.forecast.strategyMatches ?? []).filter((match) => match.direction === row.primary_direction);
  const confirmed = (timeframe) => matches.some((match) => match.entryConfirmations?.some((entry) => entry.timeframe === timeframe && entry.state === "CONFIRMED"));
  return {
    ema: direction !== 0 && emaKnown && (f.close - f.ema20) * direction >= 0 && (f.ema20 - f.ema50) * direction >= 0,
    macdSide: direction !== 0 && macdKnown && (f.macd - f.macdSignal) * direction > 0 && f.histogram * direction > 0,
    histogramExpanding: direction !== 0 && macdKnown && number(f.previousHistogram) != null && (f.histogram - f.previousHistogram) * direction >= 0,
    fiveMinute: confirmed("5m"),
    oneMinute: confirmed("1m"),
    missingEmaOrMacd: !emaKnown || !macdKnown,
  };
}
const policyPredicates = {
  EMA_MACD_SIGN_5M: (row) => row.conditions.ema && row.conditions.macdSide && row.conditions.fiveMinute,
  EMA_MACD_SIGN_5M_1M: (row) => row.conditions.ema && row.conditions.macdSide && row.conditions.fiveMinute && row.conditions.oneMinute,
  EMA_MACD_EXPANDING_5M: (row) => row.conditions.ema && row.conditions.macdSide && row.conditions.histogramExpanding && row.conditions.fiveMinute,
  EMA_MACD_EXPANDING_5M_1M: (row) => row.conditions.ema && row.conditions.macdSide && row.conditions.histogramExpanding && row.conditions.fiveMinute && row.conditions.oneMinute,
};
function paperAudit(rows) {
  return {
    baseline: performance(rows),
    missingEmaOrMacd: rows.filter((row) => row.conditions.missingEmaOrMacd).length,
    signalPriceRecovered: performance(rows.filter((row) => row.entry_time_source === "SIGNAL_PRICE")),
    candidates: Object.fromEntries(Object.entries(policyPredicates).map(([id, predicate]) => {
      const selected = rows.filter(predicate);
      const excluded = rows.filter((row) => !predicate(row));
      return [id, {
        selected: performance(selected),
        excluded: performance(excluded),
        avoidedLosses: excluded.filter((row) => Number(row.realized_pnl) < 0).length,
        missedWinners: excluded.filter((row) => Number(row.realized_pnl) > 0).length,
      }];
    })),
  };
}
function shadowAudit(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const match of row.forecast.strategyMatches ?? []) {
      const item = groups.get(match.id) ?? {
        observations: 0, rawTrials: 0, rawEvaluated: 0, pending: 0, overdue: 0, orphanedInEvaluatedParent: 0,
        missingExpiry: 0, invalidResult: 0, evaluatedWithCoarseResolution: 0, evaluatedResolutionUnknown: 0,
        ambiguousExit: 0, negativeMfe: 0, positiveMae: 0, missingSignalTime: 0, conflictingDuplicateResults: 0, independentSignals: new Map(),
      };
      groups.set(match.id, item);
      item.observations += 1;
      const trial = match.trial;
      if (!trial) continue;
      item.rawTrials += 1;
      const result = trial.result;
      if (result && number(result.returnPct) != null) {
        item.rawEvaluated += 1;
        const resolution = number(trial.executionResolutionMinutes);
        if (resolution == null) item.evaluatedResolutionUnknown += 1;
        else if (resolution > 5) item.evaluatedWithCoarseResolution += 1;
        if (String(result.exitReason ?? "").includes("AMBIGUOUS")) item.ambiguousExit += 1;
        if (number(result.maxFavorablePct) != null && result.maxFavorablePct < 0) item.negativeMfe += 1;
        if (number(result.maxAdversePct) != null && result.maxAdversePct > 0) item.positiveMae += 1;
        const signalTime = time(trial.signalTime);
        if (signalTime == null) item.missingSignalTime += 1;
        const key = [row.market, row.symbol, match.id, signalTime ?? row.id, trial.side ?? match.direction].join(":");
        // Keep the first archived evaluated observation; never choose the more profitable duplicate.
        const previous = item.independentSignals.get(key);
        if (previous == null) item.independentSignals.set(key, Number(result.returnPct));
        else if (Math.abs(previous - Number(result.returnPct)) > 1e-9) item.conflictingDuplicateResults += 1;
      } else {
        if (result) item.invalidResult += 1;
        item.pending += 1;
        const expiry = time(trial.expiresAt);
        if (expiry == null) item.missingExpiry += 1;
        else if (expiry <= asOf) {
          item.overdue += 1;
          if (row.status === "EVALUATED") item.orphanedInEvaluatedParent += 1;
        }
      }
    }
  }
  return Object.fromEntries([...groups].map(([id, { independentSignals, ...item }]) => {
    const returns = [...independentSignals.values()];
    const wins = returns.filter((value) => value > 0.05).length;
    const losses = returns.filter((value) => value < -0.05).length;
    const profit = returns.reduce((sum, value) => sum + Math.max(0, value), 0);
    const loss = returns.reduce((sum, value) => sum - Math.min(0, value), 0);
    return [id, {
      ...item,
      completionPct: rounded(item.rawTrials ? item.rawEvaluated / item.rawTrials * 100 : null),
      evaluatedSignals: returns.length,
      duplicateEvaluatedRows: item.rawEvaluated - returns.length,
      wins, losses, flatWithin005Pct: returns.length - wins - losses,
      decisiveWinRatePct: rounded(wins + losses ? wins / (wins + losses) * 100 : null),
      grossReturnSumPct: rounded(profit - loss),
      grossProfitFactor: loss ? rounded(profit / loss) : null,
      smallSample: returns.length < 30,
    }];
  }));
}

const db = new DatabaseSync(resolve(databasePath), { readOnly: true });
try {
  const forecasts = db.prepare("SELECT id, symbol, market, model_version, asof_time, status, forecast_json FROM forecast_journal ORDER BY asof_time, created_at, id")
    .all().map((row) => ({ ...row, forecast: parse(row.forecast_json) }));
  const trades = db.prepare(`SELECT p.symbol, p.model_version, p.entry_time_source, p.exit_time, p.realized_pnl,
      p.realized_pnl_native, p.risk_amount, p.fx_rate, p.fees, f.primary_direction, f.forecast_json
      FROM paper_trades p LEFT JOIN forecast_journal f ON f.id = p.forecast_id
      WHERE p.status = 'CLOSED' ORDER BY p.exit_time, p.id`)
    .all().map((row) => {
      const value = { ...row, forecast: parse(row.forecast_json) };
      return { ...value, conditions: features(value) };
    });
  const currentVersion = options["--version"] ?? forecasts.at(-1)?.model_version ?? trades.at(-1)?.model_version ?? null;
  const latestExit = Math.max(...trades.map((row) => time(row.exit_time) ?? 0), 0);
  const recent = (days) => trades.filter((row) => {
    const exit = time(row.exit_time);
    return exit != null && exit >= asOf - days * 86_400_000 && exit <= asOf;
  });
  console.log(JSON.stringify({
    audit: "strategy-policy-v1",
    mode: "READ_ONLY",
    database: basename(databasePath),
    asOfUtc: new Date(asOf).toISOString(),
    currentVersion,
    latestClosedTradeUtc: latestExit ? new Date(latestExit).toISOString() : null,
    definitions: {
      macdSign: "LONG: MACD > signal and histogram > 0; SHORT: inverse. This does not require a fresh cross.",
      ema: "LONG: close >= EMA20 >= EMA50; SHORT: inverse.",
      entryConfirmation: "CONFIRMED 5m/1m in a strategy match aligned with the forecast direction; missing confirmation does not pass.",
      r: "realized_pnl_native / risk_amount, with FX conversion fallback; never divide USDT PnL by native-currency risk.",
      recent: "Trailing UTC windows ending at asOfUtc, not at the latest available trade.",
    },
    limitations: [
      "Archive-selected cohorts are exploratory and include selection bias. Positive subsets are not proof of a profitable strategy.",
      "A model_version can span changes in execution and therefore is not necessarily a homogeneous implementation cohort.",
      "Shadow return sums are gross percentage points, not balance returns or USDT PnL; they do not include paper commissions.",
      "Duplicate shadow signals are collapsed by market/symbol/strategy/signalTime/side, preserving the first archived evaluated result and reporting conflicts. Overlapping trades and correlated assets are not independent evidence.",
      "Pending and orphaned shadow trials can bias evaluated-only results; coarse candles cannot establish the order of intrabar TP/SL touches.",
      "Shadow wins/losses use a +/-0.05% neutral band; profit factor uses every positive/negative return including small values.",
      "Paper feature cohorts do not identify causal standalone strategy contributions; they do not model changed trade sizing after filtering.",
    ],
    paper: {
      all: paperAudit(trades),
      current: paperAudit(trades.filter((row) => row.model_version === currentVersion)),
      last7Days: paperAudit(recent(7)),
      last14Days: paperAudit(recent(14)),
    },
    shadow: {
      all: shadowAudit(forecasts),
      current: shadowAudit(forecasts.filter((row) => row.model_version === currentVersion)),
    },
  }));
} finally {
  db.close();
}
