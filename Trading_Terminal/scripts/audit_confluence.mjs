import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const databaseDirectory = join(process.cwd(), ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const databaseFile = readdirSync(databaseDirectory)
  .find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");

if (!databaseFile) throw new Error("Локальная база терминала не найдена. Сначала запустите терминал.");

const db = new DatabaseSync(join(databaseDirectory, databaseFile), { readOnly: true });
const bullishPatterns = new Set(["Бычье поглощение", "Бычья харами", "Молот", "Перевёрнутый молот"]);
const bearishPatterns = new Set(["Медвежье поглощение", "Медвежья харами", "Падающая звезда", "Повешенный"]);

function parseForecast(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

function archiveConfluence(forecast, direction) {
  const features = forecast.features ?? {};
  const matches = forecast.strategyMatches ?? [];
  const { close, ema20, ema50, macd, macdSignal, histogram, previousHistogram, volumeRatio } = features;
  const ema = [close, ema20, ema50].every(Number.isFinite)
    && (direction === "BULL" ? close >= ema20 && ema20 >= ema50 : close <= ema20 && ema20 <= ema50);
  const macdAligned = [macd, macdSignal, histogram, previousHistogram].every(Number.isFinite)
    && (direction === "BULL"
      ? macd > macdSignal && histogram >= previousHistogram
      : macd < macdSignal && histogram <= previousHistogram);
  const patternSet = direction === "BULL" ? bullishPatterns : bearishPatterns;
  const nison = (features.candlePatterns ?? []).some((pattern) => patternSet.has(pattern));
  const volume = Number(volumeRatio ?? 0) >= 1;
  const mtf = matches.some((match) => match.id === "mtf-entry" && match.state === "CONFIRMED" && match.direction === direction);
  const components = { ema, macd: macdAligned, nison, volume, mtf };
  return { components, score: Object.values(components).filter(Boolean).length };
}

function shadowReturn(row, rule) {
  const actual = Number(row.pnl_pct ?? 0);
  const favorable = Number(row.max_favorable_pct ?? 0);
  if (rule === "BREAK_EVEN_1" && favorable >= 1) return Math.max(actual, 0);
  if (rule === "TRAIL_1_AFTER_2" && favorable >= 2) return Math.max(actual, favorable - 1);
  if (rule === "KEEP_HALF_AFTER_1" && favorable >= 1) return Math.max(actual, favorable * 0.5);
  return actual;
}

function percentile(values, quantile) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function stopPlacementSample(rows) {
  const winners = rows.filter((row) => Number(row.realized_pnl ?? row.pnl ?? 0) > 0);
  const winnerMae = winners.map((row) => Math.abs(Math.min(0, Number(row.max_adverse_pct ?? 0))));
  return {
    winners: winners.length,
    maePct: {
      median: percentile(winnerMae, 0.5),
      p75: percentile(winnerMae, 0.75),
      p90: percentile(winnerMae, 0.9),
      maximum: percentile(winnerMae, 1),
    },
    fixedStopShadow: [0.25, 0.5, 0.75, 1, 1.5, 2].map((stopPct) => ({
      stopPct,
      stoppedWinners: winnerMae.filter((mae) => mae >= stopPct).length,
      preservedWinners: winnerMae.filter((mae) => mae < stopPct).length,
    })),
  };
}

function priceChannelAudit(rows) {
  const observations = rows.flatMap((row) => {
    const forecast = parseForecast(row.forecast_json);
    const match = (forecast.strategyMatches ?? []).find((item) => item.id === "ema-window-channel");
    return match ? [{ ...row, match, channel: match.priceChannel ?? {} }] : [];
  });
  const setupKeys = new Set(observations.map((row) => `${row.market}:${row.symbol}:${row.channel.startTime ?? row.match.trial?.signalTime ?? "unknown"}`));
  const directional = observations.filter((row) => row.status === "EVALUATED" && row.match.direction !== "SIDEWAYS" && row.actual_direction);
  const trialRows = observations.filter((row) => row.match.trial);
  const evaluatedTrials = trialRows.filter((row) => row.match.trial?.result);
  const wins = evaluatedTrials.filter((row) => row.match.trial.result.outcome === "WIN");
  const losses = evaluatedTrials.filter((row) => row.match.trial.result.outcome === "LOSS" || row.match.trial.result.outcome === "AMBIGUOUS");
  const phaseCounts = new Map();
  const marketCounts = new Map();
  observations.forEach((row) => {
    const phase = row.channel.phase ?? "UNKNOWN";
    phaseCounts.set(phase, (phaseCounts.get(phase) ?? 0) + 1);
    marketCounts.set(row.market, (marketCounts.get(row.market) ?? 0) + 1);
  });
  const average = (selector) => evaluatedTrials.length
    ? evaluatedTrials.reduce((sum, row) => sum + Number(selector(row) ?? 0), 0) / evaluatedTrials.length
    : null;
  return {
    mode: "SHADOW_ONLY",
    version: "ema-window-channel-v1",
    observations: observations.length,
    independentSetupsApprox: setupKeys.size,
    pendingObservations: observations.filter((row) => row.status === "PENDING").length,
    evaluatedObservations: observations.filter((row) => row.status === "EVALUATED").length,
    confirmedBreakouts: observations.filter((row) => row.channel.phase === "BREAKOUT_DOWN").length,
    contextDirectionAccuracyPct: directional.length
      ? directional.filter((row) => row.actual_direction === row.match.direction).length / directional.length * 100
      : null,
    trials: {
      opened: trialRows.length,
      pending: trialRows.length - evaluatedTrials.length,
      evaluated: evaluatedTrials.length,
      wins: wins.length,
      losses: losses.length,
      flat: evaluatedTrials.filter((row) => row.match.trial.result.outcome === "FLAT").length,
      winRatePct: evaluatedTrials.length ? wins.length / evaluatedTrials.length * 100 : null,
      averageReturnPct: average((row) => row.match.trial.result.returnPct),
      averageMfePct: average((row) => row.match.trial.result.maxFavorablePct),
      averageMaePct: average((row) => row.match.trial.result.maxAdversePct),
    },
    byPhase: Object.fromEntries([...phaseCounts.entries()].sort((left, right) => right[1] - left[1])),
    byMarket: Object.fromEntries([...marketCounts.entries()].sort((left, right) => right[1] - left[1])),
    smallSample: evaluatedTrials.length < 30,
    sampleNote: evaluatedTrials.length < 30
      ? `Малая выборка: оценено ${evaluatedTrials.length} из рекомендуемых минимум 30 независимых выходов. Правила торговли менять рано.`
      : "Минимальный порог 30 оценённых выходов достигнут; результат всё ещё требует проверки на независимой выборке.",
  };
}

const evaluated = db.prepare(`SELECT primary_direction, correct, actual_return_pct, forecast_json
  FROM forecast_journal WHERE status = 'EVALUATED'`).all();
const allForecasts = db.prepare(`SELECT symbol, market, timeframe, status, actual_direction, forecast_json
  FROM forecast_journal ORDER BY asof_time`).all();
const closedTrades = db.prepare(`SELECT p.symbol, p.timeframe, p.side, p.entry_source, p.realized_pnl, p.pnl_pct,
  p.max_favorable_pct, p.max_adverse_pct, p.exit_reason, f.primary_direction, f.forecast_json
  FROM paper_trades p JOIN forecast_journal f ON f.id = p.forecast_id
  WHERE p.status = 'CLOSED' ORDER BY p.exit_time`).all();
const closedScalps = db.prepare(`SELECT symbol, pnl, pnl_pct, max_favorable_pct, max_adverse_pct, exit_reason,
  json_extract(signal_snapshot_json, '$.strategyVersion') AS strategy_version
  FROM scalping_trades WHERE status = 'CLOSED' AND validity <> 'INVALID_LEGACY' ORDER BY closed_at`).all();

const forecastBuckets = new Map();
for (const row of evaluated) {
  const forecast = parseForecast(row.forecast_json);
  const confluence = archiveConfluence(forecast, row.primary_direction);
  const bucket = forecastBuckets.get(confluence.score) ?? { total: 0, correct: 0, returnTotal: 0 };
  bucket.total += 1;
  bucket.correct += row.correct ? 1 : 0;
  bucket.returnTotal += Number(row.actual_return_pct ?? 0);
  forecastBuckets.set(confluence.score, bucket);
}

const tradeRows = closedTrades.map((row) => {
  const confluence = archiveConfluence(parseForecast(row.forecast_json), row.primary_direction);
  return { ...row, ...confluence };
});
const baseline = {
  total: tradeRows.length,
  wins: tradeRows.filter((row) => Number(row.realized_pnl) > 0).length,
  pnl: tradeRows.reduce((sum, row) => sum + Number(row.realized_pnl ?? 0), 0),
  returnSum: tradeRows.reduce((sum, row) => sum + Number(row.pnl_pct ?? 0), 0),
};
const twoConfirmations = tradeRows.filter((row) => row.score >= 2);
const rejected = tradeRows.filter((row) => row.score < 2);
const expiredWinners = tradeRows.filter((row) => row.exit_reason === "EXPIRED" && Number(row.realized_pnl) > 0);
const shadowRules = [
  ["BREAK_EVEN_1", "Безубыток после +1%"],
  ["TRAIL_1_AFTER_2", "Трейлинг 1 п.п. после +2%"],
  ["KEEP_HALF_AFTER_1", "Сохранять 50% пика после +1%"],
].map(([id, label]) => ({
  id,
  label,
  allReturnSum: tradeRows.reduce((sum, row) => sum + shadowReturn(row, id), 0),
  expiredWinnerReturnSum: expiredWinners.reduce((sum, row) => sum + shadowReturn(row, id), 0),
  improvedTrades: tradeRows.filter((row) => shadowReturn(row, id) > Number(row.pnl_pct ?? 0) + 1e-9).length,
}));

const result = {
  generatedAt: new Date().toISOString(),
  limitations: [
    "Архив старых моделей не содержит полного набора 1м/5м свечей, поэтому MTF для них чаще недоступен.",
    "Теневой тест сопровождения использует фактический максимум прибыли и не моделирует гэпы и внутрисвечной порядок касаний.",
    "Теневой тест узкого SL использует MAE: он показывает, каких победителей выбило бы, но без тиков не доказывает точный порядок движения внутри свечи.",
    "EMA‑окно · канал учитывается отдельно и не участвует в разрешении, блокировке или атрибуции реальных и виртуальных сделок.",
    "Выборка закрытых сделок мала; результаты нельзя превращать в обязательный фильтр без новых наблюдений.",
  ],
  forecastsByConfluence: [...forecastBuckets.entries()].sort((a, b) => a[0] - b[0]).map(([score, bucket]) => ({
    score,
    total: bucket.total,
    accuracyPct: bucket.total ? bucket.correct / bucket.total * 100 : null,
    averageReturnPct: bucket.total ? bucket.returnTotal / bucket.total : null,
  })),
  closedTrades: {
    baseline,
    atLeastTwoConfirmations: {
      total: twoConfirmations.length,
      wins: twoConfirmations.filter((row) => Number(row.realized_pnl) > 0).length,
      pnl: twoConfirmations.reduce((sum, row) => sum + Number(row.realized_pnl ?? 0), 0),
      returnSum: twoConfirmations.reduce((sum, row) => sum + Number(row.pnl_pct ?? 0), 0),
    },
    excludedByTwoConfirmationRule: {
      total: rejected.length,
      avoidedLosses: rejected.filter((row) => Number(row.realized_pnl) <= 0).length,
      missedWinners: rejected.filter((row) => Number(row.realized_pnl) > 0).length,
      pnl: rejected.reduce((sum, row) => sum + Number(row.realized_pnl ?? 0), 0),
    },
  },
  expiredWinners: {
    total: expiredWinners.length,
    realizedReturnSum: expiredWinners.reduce((sum, row) => sum + Number(row.pnl_pct ?? 0), 0),
    maximumFavorableReturnSum: expiredWinners.reduce((sum, row) => sum + Number(row.max_favorable_pct ?? 0), 0),
    rows: expiredWinners.map((row) => ({
      symbol: row.symbol,
      timeframe: row.timeframe,
      realizedPct: row.pnl_pct,
      maximumFavorablePct: row.max_favorable_pct,
      returnedFromPeakPct: Number(row.max_favorable_pct ?? 0) - Number(row.pnl_pct ?? 0),
    })),
  },
  shadowExitRules: shadowRules,
  emaWindowChannelShadow: priceChannelAudit(allForecasts),
  stopPlacementAudit: {
    paper: stopPlacementSample(tradeRows),
    scalpingCurrentVersion: stopPlacementSample(closedScalps.filter((row) => row.strategy_version === "scalp-micro-v4.1")),
  },
};

console.log(JSON.stringify(result, null, 2));
