import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { summarizeWindowStudies } from "../app/ema-window-study-stats.mjs";

const databaseDirectory = join(process.cwd(), ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const databaseFile = process.env.NORTHSTAR_DB_PATH ? null : readdirSync(databaseDirectory)
  .find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");

if (!databaseFile && !process.env.NORTHSTAR_DB_PATH) throw new Error("Локальная база терминала не найдена. Сначала запустите терминал.");

const db = new DatabaseSync(process.env.NORTHSTAR_DB_PATH || join(databaseDirectory, databaseFile), { readOnly: true });
const bullishPatterns = new Set(["Бычье поглощение", "Бычья харами", "Молот", "Перевёрнутый молот"]);
const bearishPatterns = new Set(["Медвежье поглощение", "Медвежья харами", "Падающая звезда", "Повешенный"]);
const intradayTimeframeMs = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

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

function strategyTrialCompleteness(rows, asOf) {
  const groups = new Map();
  for (const row of rows) {
    for (const match of parseForecast(row.forecast_json).strategyMatches ?? []) {
      const trial = match.trial;
      if (!trial) continue;
      const item = groups.get(match.id) ?? {
        trials: 0, evaluated: 0, pending: 0, overdue: 0, orphanedInEvaluatedParent: 0,
        invalidNegativeMfe: 0, invalidPositiveMae: 0,
      };
      groups.set(match.id, item);
      item.trials += 1;
      if (trial.result && Number.isFinite(Number(trial.result.returnPct)) && trial.result.returnPct != null) {
        item.evaluated += 1;
        if (Number(trial.result.maxFavorablePct) < 0) item.invalidNegativeMfe += 1;
        if (Number(trial.result.maxAdversePct) > 0) item.invalidPositiveMae += 1;
      } else {
        item.pending += 1;
        if (trial.expiresAt != null && Number(trial.expiresAt) <= asOf) {
          item.overdue += 1;
          if (row.status === "EVALUATED") item.orphanedInEvaluatedParent += 1;
        }
      }
    }
  }
  return {
    counting: "RAW_TRIAL_ROWS",
    note: "Это полнота исходных записей до дедупликации. Просроченные trials без исхода и некорректные MFE/MAE могут смещать статистику оценённых идей.",
    byStrategy: Object.fromEntries(groups),
  };
}

function percentile(values, quantile) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function timestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function performance(rows, pnlField = "realized_pnl") {
  const total = rows.length;
  const wins = rows.filter((row) => Number(row[pnlField] ?? 0) > 0).length;
  return {
    total,
    wins,
    losses: total - wins,
    winRatePct: total ? wins / total * 100 : null,
    pnl: rows.reduce((sum, row) => sum + Number(row[pnlField] ?? 0), 0),
    returnSum: rows.reduce((sum, row) => sum + Number(row.pnl_pct ?? 0), 0),
  };
}

function confirmedStrategyIds(row) {
  const forecast = parseForecast(row.forecast_json);
  return (forecast.strategyMatches ?? [])
    .filter((match) => match.state === "CONFIRMED" && match.direction === row.primary_direction)
    .map((match) => match.id);
}

function isPrematureIntradayForecast(row) {
  const durationMs = intradayTimeframeMs[row.timeframe];
  const signalTime = timestamp(row.signal_time);
  const createdAt = timestamp(row.forecast_created_at);
  return durationMs != null && signalTime != null && createdAt != null && createdAt < signalTime + durationMs;
}

function semanticScalpDuplicates(rows) {
  const duplicateIds = new Set();
  const previousBySetup = new Map();
  const chronological = [...rows].sort((left, right) => left.opened_at - right.opened_at);
  for (const row of chronological) {
    const setupKey = [row.symbol, row.side, row.strategy_version ?? "UNKNOWN", row.strategy_id ?? "UNKNOWN"].join(":");
    const previous = previousBySetup.get(setupKey);
    if (!previous) {
      previousBySetup.set(setupKey, row);
      continue;
    }
    const nearSimultaneous = row.opened_at - previous.opened_at <= 2_000;
    const samePrice = Number(previous.entry_price) > 0
      && Math.abs(Number(row.entry_price) / Number(previous.entry_price) - 1) * 10_000 <= 2;
    if (nearSimultaneous && samePrice) duplicateIds.add(row.id);
    else previousBySetup.set(setupKey, row);
  }
  return duplicateIds;
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

function topDownMacdEmaAudit(rows, currentVersion) {
  const observations = rows.flatMap((row) => {
    const forecast = parseForecast(row.forecast_json);
    const match = (forecast.strategyMatches ?? []).find((item) => item.id === "macd-ema-topdown");
    return match ? [{ ...row, forecast, match, result: match.trial?.result ?? null }] : [];
  });
  const trials = observations.filter((row) => row.match.trial);
  const evaluated = trials.filter((row) => row.result);
  const unique = new Map();
  evaluated.forEach((row) => {
    const key = `${row.market}:${row.symbol}:${row.match.trial.signalTime}`;
    if (!unique.has(key)) unique.set(key, row);
  });
  const independent = [...unique.values()];
  const current = independent.filter((row) => row.model_version === currentVersion);
  const trigger = (row) => row.match.topDownMacdEma?.fiveMinuteTrigger ?? "UNKNOWN";
  return {
    mode: "SHADOW_ONLY",
    version: "macd-ema-topdown-v1",
    observations: observations.length,
    stateCounts: {
      confirmed: observations.filter((row) => row.match.state === "CONFIRMED").length,
      supporting: observations.filter((row) => row.match.state === "SUPPORTING").length,
      watch: observations.filter((row) => row.match.state === "WATCH").length,
    },
    strictHigherTimeframesAligned: observations.filter((row) => row.match.topDownMacdEma?.strictHigherTimeframesAligned).length,
    trialsOpened: trials.length,
    trialsPending: trials.length - evaluated.length,
    duplicateTrialRows: evaluated.length - independent.length,
    allIndependent: strategyTrialPerformance(independent),
    currentVersion: {
      version: currentVersion,
      ...strategyTrialPerformance(current),
    },
    byMarket: groupedStrategyTrials(independent, (row) => row.market),
    byDirection: groupedStrategyTrials(independent, (row) => row.match.direction),
    byTrigger: groupedStrategyTrials(independent, trigger),
    byRegime: groupedStrategyTrials(independent, (row) => row.forecast.regime),
    sampleNote: independent.length < 30
      ? `Малая выборка: оценено ${independent.length} из рекомендуемых минимум 30 независимых выходов. Стратегия остаётся только в тени.`
      : "Минимальный порог 30 оценённых выходов достигнут; требуется проверка устойчивости по рынкам и режимам.",
  };
}

function strategyTrialPerformance(rows) {
  const decisive = rows.filter((row) => ["WIN", "LOSS", "AMBIGUOUS"].includes(row.result?.outcome));
  const wins = decisive.filter((row) => row.result.outcome === "WIN");
  const losses = decisive.filter((row) => row.result.outcome === "LOSS" || row.result.outcome === "AMBIGUOUS");
  const grossProfit = rows.reduce((sum, row) => sum + Math.max(0, Number(row.result?.returnPct ?? 0)), 0);
  const grossLoss = Math.abs(rows.reduce((sum, row) => sum + Math.min(0, Number(row.result?.returnPct ?? 0)), 0));
  const average = (items, selector) => items.length
    ? items.reduce((sum, row) => sum + Number(selector(row) ?? 0), 0) / items.length
    : null;
  return {
    total: rows.length,
    wins: wins.length,
    losses: losses.length,
    flat: rows.filter((row) => row.result?.outcome === "FLAT").length,
    winRatePct: decisive.length ? wins.length / decisive.length * 100 : null,
    returnSumPct: rows.reduce((sum, row) => sum + Number(row.result?.returnPct ?? 0), 0),
    averageReturnPct: average(rows, (row) => row.result?.returnPct),
    averageWinPct: average(wins, (row) => row.result?.returnPct),
    averageLossPct: average(losses, (row) => row.result?.returnPct),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageMfePct: average(rows, (row) => row.result?.maxFavorablePct),
    averageMaePct: average(rows, (row) => row.result?.maxAdversePct),
    invalidNegativeMfe: rows.filter((row) => Number(row.result?.maxFavorablePct ?? 0) < 0).length,
    invalidPositiveMae: rows.filter((row) => Number(row.result?.maxAdversePct ?? 0) > 0).length,
    smallSample: rows.length < 30,
  };
}

function groupedStrategyTrials(rows, selector) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = String(selector(row) ?? "UNKNOWN");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  return Object.fromEntries([...groups.entries()]
    .map(([key, values]) => [key, strategyTrialPerformance(values)])
    .sort((left, right) => right[1].total - left[1].total));
}

function shadowVariantSummary(rows, labVersion = null) {
  const groups = new Map();
  rows.forEach((row) => (row.match.trial?.shadowVariants ?? []).filter((variant) => !labVersion || variant.labVersion === labVersion).forEach((variant) => {
    const key = `${variant.labVersion ?? "UNVERSIONED"}:${variant.id ?? "UNKNOWN"}`;
    const current = groups.get(key) ?? {
      labVersion: variant.labVersion ?? "UNVERSIONED",
      id: variant.id ?? "UNKNOWN",
      label: variant.label ?? variant.id ?? "UNKNOWN",
      observations: 0,
      eligible: 0,
      evaluated: 0,
      triggered: 0,
      notTriggered: 0,
      unavailable: 0,
      pendingData: 0,
      paired: 0,
      deltaVsBaselineTotal: 0,
      executedPaired: 0,
      executedDeltaVsBaselineTotal: 0,
      avoidedLosses: 0,
      missedWinners: 0,
      worsenedWinners: 0,
      resultRows: [],
      resolution: {},
    };
    current.observations += 1;
    if (variant.eligible) current.eligible += 1;
    const triggered = variant.triggered ?? (
      variant.id === "RETEST_CONFIRM_5M"
        ? variant.status === "EVALUATED"
        : variant.id === "EMA20_CANCEL_5M"
          ? variant.result?.exitReason === "EMA20_CANCEL"
          : variant.result?.exitReason === "BREAKEVEN"
    );
    if (triggered) current.triggered += 1;
    const baselineReturn = Number(variant.baselineReturnPct);
    const hasBaseline = Number.isFinite(baselineReturn);
    if (variant.status === "EVALUATED" && variant.result) {
      current.evaluated += 1;
      current.resultRows.push({ ...row, result: variant.result });
      if (hasBaseline) {
        current.paired += 1;
        current.deltaVsBaselineTotal += Number(variant.result.returnPct) - baselineReturn;
        current.executedPaired += 1;
        current.executedDeltaVsBaselineTotal += Number(variant.result.returnPct) - baselineReturn;
        if (baselineReturn < -0.05 && Number(variant.result.returnPct) >= -0.05) current.avoidedLosses += 1;
        if (baselineReturn > 0.05 && Number(variant.result.returnPct) < baselineReturn - 1e-9) current.worsenedWinners += 1;
      }
    }
    if (variant.status === "NOT_TRIGGERED") {
      current.notTriggered += 1;
      if (hasBaseline) {
        current.paired += 1;
        current.deltaVsBaselineTotal -= baselineReturn;
      }
      if (hasBaseline && baselineReturn < -0.05) current.avoidedLosses += 1;
      if (hasBaseline && baselineReturn > 0.05) current.missedWinners += 1;
    }
    if (variant.status === "UNAVAILABLE") current.unavailable += 1;
    if (variant.status === "PENDING_DATA") current.pendingData += 1;
    const resolution = variant.dataResolutionMinutes == null ? "NONE" : `${variant.dataResolutionMinutes}m`;
    current.resolution[resolution] = (current.resolution[resolution] ?? 0) + 1;
    groups.set(key, current);
  }));
  return [...groups.values()].map(({ resultRows, ...item }) => ({
    ...item,
    triggerRatePct: item.eligible ? item.triggered / item.eligible * 100 : null,
    averageDeltaVsBaselinePct: item.paired ? item.deltaVsBaselineTotal / item.paired : null,
    averageExecutedDeltaVsBaselinePct: item.executedPaired ? item.executedDeltaVsBaselineTotal / item.executedPaired : null,
    performance: strategyTrialPerformance(resultRows),
  })).sort((left, right) => right.observations - left.observations);
}

function emaWindowAudit(rows, currentVersion) {
  const observations = rows.flatMap((row) => {
    const forecast = parseForecast(row.forecast_json);
    const match = (forecast.strategyMatches ?? []).find((item) => item.id === "ema-corridor");
    return match ? [{ ...row, forecast, match, result: match.trial?.result ?? null }] : [];
  });
  const trials = observations.filter((row) => row.match.trial);
  const evaluated = trials.filter((row) => row.result);
  const pending = trials.filter((row) => !row.result);
  const overdue = pending.filter((row) => Number(row.match.trial.expiresAt ?? Infinity) <= Date.now());
  const unique = new Map();
  evaluated.forEach((row) => {
    const key = `${row.market}:${row.symbol}:${row.match.trial.signalTime}`;
    if (!unique.has(key)) unique.set(key, row);
  });
  const independent = [...unique.values()];
  const currentUnique = new Map();
  evaluated.filter((row) => row.model_version === currentVersion).forEach((row) => {
    const key = `${row.market}:${row.symbol}:${row.match.trial.signalTime}`;
    if (!currentUnique.has(key)) currentUnique.set(key, row);
  });
  const current = [...currentUnique.values()];
  const sourceKey = (row) => `${row.match.sourceTimeframe ?? "?"}-EMA${row.match.sourceEma ?? "?"}`;
  const targetKey = (row) => `${row.match.targetTimeframe ?? "?"}-EMA${row.match.targetEma ?? "?"}`;
  const confirmationKey = (row) => {
    const states = Object.fromEntries((row.match.entryConfirmations ?? []).map((item) => [item.timeframe, item.state]));
    return `5m=${states["5m"] ?? "NONE"};1m=${states["1m"] ?? "NONE"}`;
  };
  const riskRewardBucket = (row) => {
    const ratio = Number(row.match.trial?.riskReward ?? 0);
    if (ratio < 0.5) return "R:R < 0.5";
    if (ratio < 1) return "R:R 0.5–0.99";
    return "R:R >= 1";
  };
  const compactRow = (row) => ({
    symbol: row.symbol,
    market: row.market,
    timeframe: row.timeframe,
    modelVersion: row.model_version,
    regime: row.forecast.regime ?? "UNKNOWN",
    direction: row.match.direction,
    source: sourceKey(row),
    target: targetKey(row),
    riskReward: row.match.trial?.riskReward ?? null,
    exitReason: row.result?.exitReason ?? null,
    returnPct: row.result?.returnPct ?? null,
    mfePct: row.result?.maxFavorablePct ?? null,
    maePct: row.result?.maxAdversePct ?? null,
    fiveMinute: row.match.entryConfirmations?.find((item) => item.timeframe === "5m")?.state ?? "NONE",
    oneMinute: row.match.entryConfirmations?.find((item) => item.timeframe === "1m")?.state ?? "NONE",
    trendHeldBeforeBreak: row.match.trendHeldBeforeBreak ?? null,
    momentumExhaustion: row.match.momentumExhaustion ?? null,
  });
  return {
    mode: "SHADOW_ONLY",
    strategy: "ema-corridor",
    observations: observations.length,
    trialsOpened: trials.length,
    trialsPending: trials.length - evaluated.length,
    pendingDataQuality: {
      overdue: overdue.length,
      orphanedInsideEvaluatedForecast: overdue.filter((row) => row.status === "EVALUATED").length,
      parentStillPending: pending.filter((row) => row.status === "PENDING").length,
      currentVersionOverdue: overdue.filter((row) => row.model_version === currentVersion).length,
    },
    evaluatedRows: evaluated.length,
    duplicateTrialRows: evaluated.length - independent.length,
    allIndependent: strategyTrialPerformance(independent),
    currentVersion: {
      version: currentVersion,
      ...strategyTrialPerformance(current),
    },
    byExitReason: groupedStrategyTrials(independent, (row) => row.result.exitReason),
    byMarket: groupedStrategyTrials(independent, (row) => row.market),
    byTimeframe: groupedStrategyTrials(independent, (row) => row.timeframe),
    byRegime: groupedStrategyTrials(independent, (row) => row.forecast.regime),
    byDirection: groupedStrategyTrials(independent, (row) => row.match.direction),
    bySourceBoundary: groupedStrategyTrials(independent, sourceKey),
    byTargetBoundary: groupedStrategyTrials(independent, targetKey),
    byEntryConfirmation: groupedStrategyTrials(independent, confirmationKey),
    byRiskReward: groupedStrategyTrials(independent, riskRewardBucket),
    byMomentumExhaustion: groupedStrategyTrials(independent, (row) => row.match.momentumExhaustion),
    riskLab: {
      activeVersion: "risk-lab-v4",
      allIndependent: shadowVariantSummary(independent, "risk-lab-v4"),
      currentVersion: shadowVariantSummary(current, "risk-lab-v4"),
      invalidatedPriorRows: independent.filter((row) => ["risk-lab-v1", "risk-lab-v2", "risk-lab-v3"].includes(row.match.trial?.shadowLabVersion)).length,
      currentVersionMissingMigration: current.filter((row) => row.match.trial?.shadowLabVersion !== "risk-lab-v4").length,
      note: "risk-lab-v1/v2/v3 исключены: исправлены доступность сигнала, предварительные касания уровней и парное сравнение на одинаковом разрешении свечей.",
    },
    best: [...independent].sort((left, right) => Number(right.result.returnPct) - Number(left.result.returnPct)).slice(0, 5).map(compactRow),
    worst: [...independent].sort((left, right) => Number(left.result.returnPct) - Number(right.result.returnPct)).slice(0, 5).map(compactRow),
    note: "Это автономные статистические trials EMA-окна. Они не меняют баланс и не доказывают качество реального исполнения без полной минутной истории.",
  };
}

const evaluated = db.prepare(`SELECT primary_direction, correct, actual_return_pct, forecast_json
  FROM forecast_journal WHERE status = 'EVALUATED'`).all();
const allForecasts = db.prepare(`SELECT symbol, market, timeframe, model_version, asof_time, status, actual_direction, forecast_json
  FROM forecast_journal ORDER BY asof_time`).all();
const closedTrades = db.prepare(`SELECT p.id, p.symbol, p.market, p.timeframe, p.side, p.model_version,
  p.signal_time, p.entry_time, p.exit_time, p.created_at AS trade_created_at,
  p.entry_source, p.entry_time_source, p.realized_pnl, p.pnl_pct,
  p.max_favorable_pct, p.max_adverse_pct, p.exit_reason,
  f.created_at AS forecast_created_at, f.primary_direction, f.forecast_json
  FROM paper_trades p JOIN forecast_journal f ON f.id = p.forecast_id
  WHERE p.status = 'CLOSED' ORDER BY p.exit_time`).all();
const allClosedScalps = db.prepare(`SELECT id, symbol, side, opened_at, entry_price, pnl, pnl_pct,
  max_favorable_pct, max_adverse_pct, exit_reason, validity, invalid_reason,
  json_extract(signal_snapshot_json, '$.strategyVersion') AS strategy_version,
  json_extract(signal_snapshot_json, '$.strategyId') AS strategy_id
  FROM scalping_trades WHERE status = 'CLOSED' ORDER BY closed_at`).all();
const closedScalps = allClosedScalps.filter((row) => row.validity !== "INVALID_LEGACY");

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
const baseline = performance(tradeRows);
const twoConfirmations = tradeRows.filter((row) => row.score >= 2);
const rejected = tradeRows.filter((row) => row.score < 2);
const expiredWinners = tradeRows.filter((row) => row.exit_reason === "EXPIRED" && Number(row.realized_pnl) > 0);
const latestExitTime = Math.max(...tradeRows.map((row) => timestamp(row.exit_time) ?? 0), 0);
const currentModelVersion = [...tradeRows].reverse().find((row) => row.model_version)?.model_version ?? null;
const latestForecastVersion = [...allForecasts].reverse().find((row) => row.model_version)?.model_version ?? currentModelVersion;
const currentVersionRows = tradeRows.filter((row) => row.model_version === currentModelVersion);
const currentOnlyMtf = currentVersionRows.filter((row) => {
  const ids = confirmedStrategyIds(row);
  return ids.length === 1 && ids[0] === "mtf-entry";
});
const currentMultiConfirmed = currentVersionRows.filter((row) => confirmedStrategyIds(row).length >= 2);
const currentTransition = currentVersionRows.filter((row) => parseForecast(row.forecast_json).regime === "TRANSITION");
const prematureMoexIntraday = tradeRows.filter((row) => row.market === "moex" && isPrematureIntradayForecast(row));
const signalPriceEntries = tradeRows.filter((row) => row.entry_time_source === "SIGNAL_PRICE");
const createdAfterExit = signalPriceEntries.filter((row) => {
  const createdAt = timestamp(row.trade_created_at);
  const exitTime = timestamp(row.exit_time);
  return createdAt != null && exitTime != null && createdAt > exitTime;
});
const scalpDuplicateIds = semanticScalpDuplicates(closedScalps);
const uniqueScalps = closedScalps.filter((row) => !scalpDuplicateIds.has(row.id));
const archivedScalpDuplicates = allClosedScalps.filter((row) => row.invalid_reason === "Технический дубль одного автоматического сигнала");
const latestScalpVersion = [...closedScalps].reverse().find((row) => row.strategy_version)?.strategy_version ?? null;
const currentScalps = uniqueScalps.filter((row) => row.strategy_version === latestScalpVersion);
const shadowRules = [
  ["BREAK_EVEN_1", "Оптимистическая оценка по итоговому MFE: порог 0% после +1%"],
  ["TRAIL_1_AFTER_2", "Оптимистическая оценка по итоговому MFE: пик минус 1 п.п. после +2%"],
  ["KEEP_HALF_AFTER_1", "Оптимистическая оценка по итоговому MFE: половина пика после +1%"],
].map(([id, label]) => ({
  id,
  label,
  methodology: "OPTIMISTIC_CEILING_NOT_BACKTEST",
  forwardValidated: false,
  limitation: "Используется итоговый MFE и max(фактический исход, расчётный порог): прибыльные сделки не могут ухудшиться по определению. Порядок касаний, ранний выход и гэпы не моделируются; это не основание для включения сопровождения.",
  allReturnSum: tradeRows.reduce((sum, row) => sum + shadowReturn(row, id), 0),
  expiredWinnerReturnSum: expiredWinners.reduce((sum, row) => sum + shadowReturn(row, id), 0),
  improvedTrades: tradeRows.filter((row) => shadowReturn(row, id) > Number(row.pnl_pct ?? 0) + 1e-9).length,
}));

const result = {
  generatedAt: new Date().toISOString(),
  limitations: [
    "Архив старых моделей не содержит полного набора 1м/5м свечей, поэтому MTF для них чаще недоступен.",
    "shadowExitRules: OPTIMISTIC_CEILING_NOT_BACKTEST. Итоговый MFE известен только после завершения сделки; max(фактический исход, порог) завышает результат и не моделирует ранние выходы, гэпы или порядок касаний. Это не бэктест и не рекомендация включить сопровождение.",
    "Теневой тест узкого SL использует MAE: он показывает, каких победителей выбило бы, но без тиков не доказывает точный порядок движения внутри свечи.",
    "EMA‑окно · канал учитывается отдельно и не участвует в разрешении, блокировке или атрибуции реальных и виртуальных сделок.",
    "Сделки из незакрытой внутридневной свечи и технические дубли показаны отдельными когортами; архивные строки не удаляются.",
    "Восстановленные сделки SIGNAL_PRICE входят в единый баланс, но отдельно отмечены для контроля операционного качества исполнения.",
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
    atLeastTwoConfirmations: performance(twoConfirmations),
    excludedByTwoConfirmationRule: {
      ...performance(rejected),
      avoidedLosses: rejected.filter((row) => Number(row.realized_pnl) <= 0).length,
      missedWinners: rejected.filter((row) => Number(row.realized_pnl) > 0).length,
    },
    recent: {
      last4: performance(tradeRows.slice(-4)),
      last10: performance(tradeRows.slice(-10)),
      last7Days: performance(tradeRows.filter((row) => (timestamp(row.exit_time) ?? 0) >= latestExitTime - 7 * 86_400_000)),
      last14Days: performance(tradeRows.filter((row) => (timestamp(row.exit_time) ?? 0) >= latestExitTime - 14 * 86_400_000)),
    },
    currentModelVersion: {
      version: currentModelVersion,
      all: performance(currentVersionRows),
      onlyMtfConfirmed: performance(currentOnlyMtf),
      multipleConfirmedStrategies: performance(currentMultiConfirmed),
      transitionRegime: performance(currentTransition),
      smallSample: currentVersionRows.length < 30,
    },
  },
  executionDataQuality: {
    prematureMoexIntraday: {
      ...performance(prematureMoexIntraday),
      rows: prematureMoexIntraday.map((row) => ({
        symbol: row.symbol,
        timeframe: row.timeframe,
        minutesIntoBar: ((timestamp(row.forecast_created_at) ?? 0) - (timestamp(row.signal_time) ?? 0)) / 60_000,
        volumeRatio: parseForecast(row.forecast_json).features?.volumeRatio ?? null,
        pnl: row.realized_pnl,
      })),
    },
    signalPriceRecovery: {
      ...performance(signalPriceEntries),
      createdAfterHistoricalExit: createdAfterExit.length,
      createdAfterHistoricalExitRows: createdAfterExit.map((row) => row.symbol),
    },
    note: "Эти когорты нужны для контроля качества данных и исполнения, а не для автоматического изменения торговых правил.",
  },
  scalpingDataQuality: {
    raw: performance(closedScalps, "pnl"),
    archivedSemanticDuplicates: archivedScalpDuplicates.length,
    newlyDetectedSemanticDuplicates: scalpDuplicateIds.size,
    withoutSemanticDuplicates: performance(uniqueScalps, "pnl"),
    currentStrategyVersion: {
      version: latestScalpVersion,
      ...performance(currentScalps, "pnl"),
      smallSample: currentScalps.length < 30,
    },
    duplicateRows: closedScalps.filter((row) => scalpDuplicateIds.has(row.id)).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      openedAt: row.opened_at,
      strategyId: row.strategy_id,
    })),
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
  strategyTrialCompleteness: {
    all: strategyTrialCompleteness(allForecasts, Date.now()),
    currentVersion: strategyTrialCompleteness(allForecasts.filter((row) => row.model_version === latestForecastVersion), Date.now()),
  },
  emaWindowShadow: emaWindowAudit(allForecasts, latestForecastVersion),
  emaWindowChannelShadow: priceChannelAudit(allForecasts),
  emaWindowObstacleStudy: {
    note: "Отдельный перспективный тест: старым идеям карты не достраиваются. Первые непересекающиеся эпизоды; неоднозначные сделки исключены из WR/PF и парного сравнения. Касания TP1/полного окна за весь горизонт — не винрейт. Издержки: модель 5 б.п. комиссии + 5 б.п. проскальзывания на сторону. Это не тариф биржи.",
    cohorts: summarizeWindowStudies(allForecasts.map(row => ({ symbol: row.symbol, market: row.market, timeframe: row.timeframe, asofTime: row.asof_time, matches: parseForecast(row.forecast_json).strategyMatches ?? [] }))),
  },
  topDownMacdEmaShadow: topDownMacdEmaAudit(allForecasts, latestForecastVersion),
  stopPlacementAudit: {
    paper: stopPlacementSample(tradeRows),
    scalpingCurrentVersion: stopPlacementSample(closedScalps.filter((row) => row.strategy_version === "scalp-micro-v4.1")),
  },
};

console.log(JSON.stringify(result, null, 2));
