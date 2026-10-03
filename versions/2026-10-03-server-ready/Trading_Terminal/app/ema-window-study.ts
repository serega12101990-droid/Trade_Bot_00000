import { indicators } from "./terminal-math";
import { marketCandleCloseTime, nextMarketBarTime } from "./market-calendar";
import type { Candle, ForecastStrategyMatch, ForecastStrategyTrial, Market, Timeframe } from "./terminal-types";

export const WINDOW_STUDY_VERSION = "window-obstacles-v1" as const;
const MINUTE = 60_000;
const MAP_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "4h", "1d"];
export const WINDOW_EXITS = [
  { id: "BASELINE", label: "Прежний TP/SL" },
  { id: "TP1", label: "100% перед первой преградой" },
  { id: "PARTIAL", label: "50% TP1 + продолжение и отмена" },
  { id: "TRAIL", label: "50% TP1 + продолжение, отмена и трейлинг" },
] as const;
export type WindowExitId = typeof WINDOW_EXITS[number]["id"];
export type WindowObstacle = {
  id: string;
  kind: "SWING" | "CONSOLIDATION" | "IMPULSE_BASE" | "EMA";
  timeframe: Timeframe;
  low: number;
  high: number;
  price: number;
  knownAt: number;
  label: string;
};
export type WindowExitResult = {
  id: WindowExitId;
  label: string;
  grossReturnPct: number;
  netReturnPct: number;
  ambiguous: boolean;
  exitReason: "TARGET" | "STOP" | "CANCEL" | "TRAIL" | "EXPIRY" | "AMBIGUOUS";
  exitTime: number;
  fills: Array<{ time: number; price: number; fraction: number; reason: string }>;
};
export type WindowStudyEvaluation = {
  status: "WAITING" | "PENDING_DATA" | "UNAVAILABLE" | "EVALUATED";
  reason: string;
  resolutionMinutes: 1 | 5 | null;
  evaluatedThrough?: number;
  // These are path observations over the whole horizon, NOT trade win rates.
  directionCorrect?: boolean;
  firstTargetTouched?: boolean;
  fullWindowTouched?: boolean;
  cancelledAt?: number;
  cancellationReason?: string;
  unlockedObstacles?: number;
  variants: WindowExitResult[];
};
export type EmaWindowStudy = {
  version: typeof WINDOW_STUDY_VERSION;
  mode: "SHADOW";
  asOf: number;
  anchorTimeframe: Timeframe;
  market: Market;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  baselineTarget: number;
  firstTarget: number | null;
  fullTarget: number;
  fullTargetLabel?: string;
  firstObstacleId: string | null;
  breakoutLevel: number;
  buffer: number;
  trailDistance: number;
  obstacles: WindowObstacle[];
  missingTimeframes: Timeframe[];
  controlSeed: Candle[];
  feeBpsPerSide: number;
  slippageBpsPerSide: number;
  evaluation?: WindowStudyEvaluation;
};

export type WindowStudyCohort = {
  strategyId: string; label: string; version: string; observations: number; duplicates: number;
  overlapping: number; episodes: number; evaluated: number; waiting: number; pendingData: number;
  unavailable: number; incompleteMaps: number; tightSpace: number; directionCorrect: number;
  firstTargetTouched: number; firstTargetKnown: number; fullWindowTouched: number; cancellations: number;
  directionRatePct: number | null; firstTargetTouchRatePct: number | null; fullWindowTouchRatePct: number | null;
  variants: Array<{ id: string; label: string; evaluated: number; ambiguous: number; wins: number; losses: number;
    flats: number; paired: number; avoidedLosses: number; missedWinners: number; worsenedWinners: number;
    winRatePct: number | null; avgNetReturnPct: number | null; profitFactor: number | null;
    expectancyR: number | null; avgDeltaVsBaselinePct: number | null; sampleSufficient: boolean }>;
};

function validCandle(c: Candle) {
  return [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
    && c.low > 0 && c.high >= Math.max(c.open, c.close, c.low)
    && c.low <= Math.min(c.open, c.close) && c.volume >= 0;
}

function closedAt(source: Candle[], timeframe: Timeframe, market: Market, asOf: number) {
  const unique = new Map<number, Candle>();
  for (const c of source) {
    if (c.closed !== false && validCandle(c) && marketCandleCloseTime(c.time, timeframe, market) <= asOf) unique.set(c.time, c);
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

function atr(candles: Candle[]) {
  const sample = candles.slice(-15);
  const ranges = sample.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - sample[i].close), Math.abs(c.low - sample[i].close)));
  return ranges.reduce((sum, n) => sum + n, 0) / Math.max(1, ranges.length);
}

/** Immutable pre-signal map. No changes to readiness, original trials, targets or paper policy. */
export function attachWindowStudy(
  match: ForecastStrategyMatch, timeframe: Timeframe, allTimeframes: Partial<Record<Timeframe, Candle[]>>,
  asOf: number, market: Market,
): ForecastStrategyMatch {
  if (!["ema-corridor", "ema-window-channel"].includes(match.id) || !match.trial || match.windowStudy) return match;
  const trial = match.trial;
  const side = trial.side;
  const direction = side === "LONG" ? 1 : -1;
  if (!(direction * (trial.targetPrice - trial.entryPrice) > 0) || !(direction * (trial.entryPrice - trial.stopPrice) > 0)) return match;
  const anchor = closedAt(allTimeframes[timeframe] ?? [], timeframe, market, asOf);
  const currentAtr = Math.max(atr(anchor), trial.entryPrice * 0.001);
  const buffer = Math.max(currentAtr * 0.08, trial.entryPrice * 0.0003);
  const obstacles: WindowObstacle[] = [];
  const missingTimeframes: Timeframe[] = [];
  for (const tf of MAP_TIMEFRAMES) {
    const series = closedAt(allTimeframes[tf] ?? [], tf, market, asOf).slice(-1000);
    const last = series.at(-1);
    // An old fallback is not a current MTF level. Account for closed exchange sessions.
    const nextClose = last ? marketCandleCloseTime(nextMarketBarTime(last.time, tf, market), tf, market) : 0;
    if (series.length < 50 || nextClose < asOf) { missingTimeframes.push(tf); continue; }
    if (series.length < 200) missingTimeframes.push(tf); // EMA200 unavailable, not a free corridor.
    const localAtr = Math.max(atr(series), trial.entryPrice * 0.0005);
    const halfZone = localAtr * 0.08;
    const add = (kind: WindowObstacle["kind"], low: number, high: number, knownAt: number, label: string) => {
      if (!(low > 0 && high >= low)) return;
      const price = (low + high) / 2;
      // Only barriers ahead of the entry, not the protective side of the trade.
      if (direction * (price - trial.entryPrice) <= 0) return;
      obstacles.push({ id: `${tf}:${kind}:${knownAt}:${price.toFixed(8)}`, kind, timeframe: tf, low, high, price, knownAt, label });
    };
    const pack = indicators(series);
    for (const period of [20, 50, 200] as const) {
      const value = (period === 20 ? pack.ema20 : period === 50 ? pack.ema50 : pack.ema200).at(-1);
      if (value != null) add("EMA", value - halfZone, value + halfZone, marketCandleCloseTime(last!.time, tf, market), `${tf} EMA${period} Close`);
    }
    const first = Math.max(3, series.length - 120);
    for (let i = first; i < series.length - 2; i++) {
      const c = series[i];
      const neighbors = series.slice(i - 2, i + 3);
      const pivot = side === "SHORT" ? c.low : c.high;
      const isPivot = neighbors.every(b => side === "SHORT" ? b.low >= pivot : b.high <= pivot)
        && neighbors.some(b => side === "SHORT" ? b.low > pivot : b.high < pivot);
      if (isPivot) add("SWING", pivot - halfZone, pivot + halfZone, marketCandleCloseTime(series[i + 2].time, tf, market), `${tf}: подтверждённый экстремум`);
      const prior = series.slice(Math.max(0, i - 14), i);
      const priorAtr = Math.max(atr(prior), trial.entryPrice * 0.0005);
      const body = Math.abs(c.close - c.open);
      const supportiveImpulse = side === "SHORT" ? c.close > c.open : c.close < c.open;
      if (supportiveImpulse && body >= priorAtr * 1.5) {
        add("IMPULSE_BASE", Math.min(c.open, side === "SHORT" ? c.low : c.high), Math.max(c.open, side === "SHORT" ? c.low : c.high), marketCandleCloseTime(c.time, tf, market), `${tf}: основание импульса`);
      }
      // A base is known only after a directional departure, not from future reaction.
      const base = series.slice(i - 5, i);
      const low = Math.min(...base.map(b => b.low));
      const high = Math.max(...base.map(b => b.high));
      const departed = side === "SHORT" ? c.close > high + priorAtr * 0.2 : c.close < low - priorAtr * 0.2;
      if (high - low <= priorAtr * 2 && departed) add("CONSOLIDATION", low, high, marketCandleCloseTime(c.time, tf, market), `${tf}: база перед выходом`);
    }
  }
  const distance = (o: WindowObstacle) => direction * ((side === "LONG" ? o.low : o.high) - trial.entryPrice);
  obstacles.sort((a, b) => distance(a) - distance(b));
  // Keep overlapping zones as explicit confluence; remove only exact same-source duplicates.
  const map = obstacles.filter((o, i) => !obstacles.slice(0, i).some(p => p.kind === o.kind && p.timeframe === o.timeframe && Math.abs(p.price - o.price) < buffer * 0.5));
  const farthestRoute = match.routeStages?.at(-1)?.price;
  const anchorPack = indicators(anchor);
  const anchorDestination = ([20, 50, 200] as const).map(period => ({ period, price: (period === 20 ? anchorPack.ema20 : period === 50 ? anchorPack.ema50 : anchorPack.ema200).at(-1) }))
    .filter((item): item is { period: 20 | 50 | 200; price: number } => item.price != null && direction * (item.price - trial.entryPrice) > buffer)
    .sort((a, b) => Math.abs(a.price - trial.entryPrice) - Math.abs(b.price - trial.entryPrice))[0];
  const fullTarget = match.id === "ema-corridor" && anchorDestination ? anchorDestination.price
    : farthestRoute != null && direction * (farthestRoute - trial.targetPrice) > 0 ? farthestRoute : trial.targetPrice;
  // The history lookback is bounded above; never truncate its discovered barriers.
  // Otherwise the continuation could be unlocked while an omitted barrier remains.
  const route = map.filter(o => direction * (o.price - fullTarget) <= buffer);
  const nearest = route[0];
  const candidateTarget = nearest ? (side === "LONG" ? nearest.low - buffer : nearest.high + buffer) : fullTarget;
  const targetBeforeZone = trial.entryPrice + direction * Math.min(direction * (candidateTarget - trial.entryPrice), direction * (fullTarget - trial.entryPrice));
  const firstTarget = direction * (targetBeforeZone - trial.entryPrice) > 0 ? targetBeforeZone : null;
  const controlSeed = closedAt(allTimeframes["5m"] ?? [], "5m", market, asOf).slice(-200);
  const study: EmaWindowStudy = {
    version: WINDOW_STUDY_VERSION, mode: "SHADOW", asOf, anchorTimeframe: timeframe, market, side,
    entryPrice: trial.entryPrice, stopPrice: trial.stopPrice, baselineTarget: trial.targetPrice,
    firstTarget, fullTarget, firstObstacleId: nearest?.id ?? null,
    fullTargetLabel: match.id === "ema-corridor" && anchorDestination ? `${timeframe} EMA${anchorDestination.period} Close` : "Дальняя цель исходного маршрута",
    breakoutLevel: match.sourcePrice ?? trial.entryPrice, buffer,
    trailDistance: Math.max(atr(controlSeed) * 1.5, trial.entryPrice * 0.001),
    obstacles: route, missingTimeframes: [...new Set(missingTimeframes)], controlSeed,
    // Explicit, versioned research assumptions, not a venue fee quote or account setting.
    feeBpsPerSide: 5, slippageBpsPerSide: 5,
  };
  return { ...match, windowStudy: study };
}

function fiveMinuteBars(candles: Candle[], resolution: 1 | 5) {
  if (resolution === 5) return candles;
  const groups = new Map<number, Candle[]>();
  for (const c of candles) {
    const time = Math.floor(c.time / (5 * MINUTE)) * 5 * MINUTE;
    groups.set(time, [...(groups.get(time) ?? []), c]);
  }
  return [...groups.entries()].filter(([time, bars]) => bars.length === 5 && bars.every((b, i) => b.time === time + i * MINUTE)).map(([time, bars]) => ({
    time, open: bars[0].open, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)),
    close: bars[4].close, volume: bars.reduce((sum, b) => sum + b.volume, 0), closed: true,
  }));
}

export function evaluateWindowStudy(study: EmaWindowStudy, trial: ForecastStrategyTrial, source: Candle[], resolution: 1 | 5 | null, now = Date.now()): WindowStudyEvaluation {
  const unavailable = (reason: string, terminal = false): WindowStudyEvaluation => ({ status: terminal || now - trial.expiresAt > 7 * 86400_000 ? "UNAVAILABLE" : "PENDING_DATA", reason, resolutionMinutes: resolution, variants: [] });
  if (study.version !== WINDOW_STUDY_VERSION) return unavailable("Неизвестная версия карты", true);
  if (now < trial.expiresAt) return { status: "WAITING", reason: "Горизонт наблюдения ещё не завершён", resolutionMinutes: resolution, variants: [] };
  if (!Number.isFinite(trial.availableAt) || trial.availableAt! < study.asOf || trial.availableAt! >= trial.expiresAt) return unavailable("Нет корректного времени доступности сигнала", true);
  if (!resolution) return unavailable("Нужна настоящая история 1м или 5м");
  const duration = resolution * MINUTE;
  const start = Math.ceil(trial.availableAt! / duration) * duration;
  const unique = new Map<number, Candle>();
  for (const c of source) {
    if (c.closed === false || c.time >= trial.expiresAt || c.time + duration > now) continue;
    if (!validCandle(c) || c.time % duration !== 0) return unavailable("Некорректная младшая свеча");
    const previous = unique.get(c.time);
    if (previous && ["open", "high", "low", "close", "volume"].some(k => previous[k as keyof Candle] !== c[k as keyof Candle])) return unavailable("Конфликтующие свечи одного времени");
    unique.set(c.time, c);
  }
  const all = [...unique.values()].sort((a, b) => a.time - b.time);
  const bars = all.filter(c => c.time >= start && c.time + duration <= trial.expiresAt);
  const tf = resolution === 1 ? "1m" : "5m";
  let expected = nextMarketBarTime(start - duration, tf, study.market);
  for (const c of bars) {
    if (c.time !== expected) return unavailable("Пропуск младших свечей: исход не дорисован");
    expected = nextMarketBarTime(c.time, tf, study.market);
  }
  if (!bars.length || bars.at(-1)!.time + duration !== trial.expiresAt) return unavailable("Нет полного младшего окна до срока идеи");

  const controlMap = new Map<number, Candle>();
  for (const c of study.controlSeed) if (validCandle(c) && c.closed !== false && c.time + 5 * MINUTE <= study.asOf) controlMap.set(c.time, c);
  for (const c of fiveMinuteBars(all, resolution)) controlMap.set(c.time, c);
  const controls = [...controlMap.values()].sort((a, b) => a.time - b.time);
  const controlReady = controls.filter(c => c.time + 5 * MINUTE <= start).length >= 60;
  const controlContinuous = controls.every((c, i) => !i || nextMarketBarTime(controls[i - 1].time, "5m", study.market) === c.time);
  if (!controlReady || !controlContinuous) return unavailable("Для одинакового сравнения выходов нужна непрерывная 5м история и минимум 60 свечей прогрева");
  const pack = indicators(controls);
  const byClose = new Map(controls.map((c, i) => [c.time + 5 * MINUTE, { c, i }]));
  const direction = study.side === "LONG" ? 1 : -1;
  const reached = (c: Candle, price: number) => study.side === "LONG" ? c.high >= price : c.low <= price;
  const adverse = (c: Candle, price: number) => study.side === "LONG" ? c.low <= price : c.high >= price;
  const gates = study.obstacles.filter(o => direction * (o.price - study.fullTarget) < -study.buffer);
  let unlocked = 0;
  const gateCloses = gates.map(() => 0);
  let reclaimCloses = 0;
  let cancelledAt: number | undefined;
  let cancellationReason: string | undefined;
  const states = WINDOW_EXITS.map(def => ({ ...def, remaining: 1, stop: study.stopPrice, partial: false, ambiguous: false, exitReason: "EXPIRY" as WindowExitResult["exitReason"], fills: [] as WindowExitResult["fills"] }));
  const fill = (state: typeof states[number], fraction: number, price: number, time: number, reason: WindowExitResult["exitReason"]) => {
    const amount = Math.min(state.remaining, fraction);
    state.fills.push({ fraction: amount, price, time, reason }); state.remaining -= amount; state.exitReason = reason;
  };
  for (const c of bars) {
    // All active stops/gates here were fixed BEFORE this candle, never from its high/low.
    for (const state of states) {
      if (!state.remaining) continue;
      const staged = state.id === "PARTIAL" || state.id === "TRAIL";
      if (study.firstTarget == null && state.id !== "BASELINE") continue;
      const target = state.id === "BASELINE" ? study.baselineTarget : state.id === "TP1" || !state.partial ? study.firstTarget! : unlocked === gates.length ? study.fullTarget : null;
      const stopHit = adverse(c, state.stop);
      const targetHit = target != null && reached(c, target);
      if (stopHit) {
        state.ambiguous ||= targetHit;
        const price = study.side === "LONG" ? Math.min(c.open, state.stop) : Math.max(c.open, state.stop);
        fill(state, state.remaining, price, c.time, targetHit ? "AMBIGUOUS" : state.id === "TRAIL" && state.partial && state.stop !== study.stopPrice ? "TRAIL" : "STOP");
        continue;
      }
      if (targetHit) {
        fill(state, staged && !state.partial ? 0.5 : state.remaining, target!, c.time, "TARGET");
        if (staged) state.partial = true;
      }
    }
    const control = byClose.get(c.time + duration);
    if (!control || control.c.time < start) continue;
    const { c: bar, i } = control;
    gates.forEach((gate, index) => {
      const beyond = direction * (bar.close - (study.side === "LONG" ? gate.high : gate.low)) > study.buffer;
      gateCloses[index] = beyond ? gateCloses[index] + 1 : 0;
    });
    while (unlocked < gates.length && gateCloses[unlocked] >= 2) unlocked++;
    const reclaimed = direction * (bar.close - study.breakoutLevel) < -study.buffer;
    reclaimCloses = reclaimed ? reclaimCloses + 1 : 0;
    const e20 = pack.ema20[i], e50 = pack.ema50[i], hist = pack.histogram[i];
    const recent = controls.slice(Math.max(0, i - 2), i + 1);
    const structureAgainst = recent.length === 3 && recent.slice(1).every((b, j) => study.side === "SHORT" ? b.low > recent[j].low : b.high < recent[j].high);
    const emaMacdAgainst = e20 != null && e50 != null && hist != null && direction * hist < 0
      && direction * (bar.close - e20) < 0 && direction * (bar.close - e50) < 0;
    if (cancelledAt == null && (reclaimCloses >= 2 || structureAgainst && emaMacdAgainst)) {
      cancelledAt = bar.time + 5 * MINUTE;
      cancellationReason = reclaimCloses >= 2 ? "Два 5м закрытия вернулись за пробитую границу" : "Три встречных экстремума + восстановление EMA20/50 и MACD 5м";
    }
    for (const state of states.filter(s => s.id === "PARTIAL" || s.id === "TRAIL")) {
      if (!state.remaining || study.firstTarget == null) continue;
      if (cancelledAt != null) fill(state, state.remaining, bar.close, bar.time + 5 * MINUTE, "CANCEL");
      else if (state.id === "TRAIL" && state.partial) {
        const proposed = bar.close - direction * study.trailDistance;
        state.stop = study.side === "LONG" ? Math.max(state.stop, proposed) : Math.min(state.stop, proposed);
      }
    }
  }
  const last = bars.at(-1)!;
  for (const state of states) if (state.remaining) fill(state, state.remaining, last.close, trial.expiresAt, "EXPIRY");
  const variants = states.filter(s => s.id === "BASELINE" || study.firstTarget != null).map((state): WindowExitResult => {
    const grossReturnPct = state.fills.reduce((sum, f) => sum + f.fraction * direction * (f.price / study.entryPrice - 1) * 100, 0);
    const costs = state.fills.reduce((sum, f) => sum + f.fraction * (study.feeBpsPerSide + study.slippageBpsPerSide) / 100 * (1 + f.price / study.entryPrice), 0);
    return { id: state.id, label: state.label, grossReturnPct, netReturnPct: grossReturnPct - costs, ambiguous: state.ambiguous, exitReason: state.exitReason, exitTime: state.fills.at(-1)!.time, fills: state.fills };
  });
  return {
    status: "EVALUATED", reason: study.firstTarget == null ? "Первая преграда слишком близко: новые выходы не моделируются; базовый исход сохранён" : "Сравнение на одинаковых свечах; неоднозначные исходы исключаются из оценки преимущества",
    resolutionMinutes: resolution, evaluatedThrough: trial.expiresAt,
    directionCorrect: direction * (last.close - study.entryPrice) > 0,
    firstTargetTouched: study.firstTarget == null ? undefined : bars.some(c => reached(c, study.firstTarget!)),
    fullWindowTouched: bars.some(c => reached(c, study.fullTarget)), cancelledAt, cancellationReason,
    unlockedObstacles: unlocked, variants,
  };
}
