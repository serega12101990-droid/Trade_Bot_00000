"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatPrice, indicators, latestPatternDetails } from "./terminal-math";
import type { Candle, CandlestickPattern, IndicatorPack } from "./terminal-types";
import {
  analyzeBreakoutLevel,
  assessMicrostructureSignal,
  assessScalpSignal,
  auditScalpTrades,
  bookImbalance,
  calculateScalpEntry,
  calculateMicrostructureScalpEntry,
  estimatedMissingScalpFees,
  evaluateScalpTrade,
  feeAdjustedScalpPnl,
  findBookDensity,
  isScalpTradeQuoteCompatible,
  markScalpTrade,
  minimumTargetPctForNetRewardRisk,
  scalpNetRewardRisk,
  scalpPerformanceStats,
  scalpReentryAllowed,
  scalpRiskState,
  scalpTradeDurationMinutes,
  SCALP_STRATEGY_VERSION,
  tapeStats,
  type ScalpBookLevel,
  type ScalpContext,
  type ScalpDensity,
  type ScalpPaperTrade,
  type ScalpSignal,
  type ScalpSignalSnapshot,
  type ScalpSide,
  type ScalpTapeTrade,
} from "./scalping-engine";

const CORE_SCALP_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "TRXUSDT", "XRPUSDT"] as const;
const STORAGE_KEY = "northstar-scalping-paper-v1";
const SETTINGS_KEY = "northstar-scalping-settings-v1";
const INITIAL_BALANCE = 10_000;

type ConnectionState = "CONNECTING" | "LIVE" | "RECONNECTING" | "OFFLINE";
type ScalpSymbol = string;
type ScalpActivity = { turnover24h: number | null; price24hPct: number | null; openInterestValue: number | null };
type BackgroundQuote = { bid: number; ask: number; last: number; updatedAt: number } & ScalpActivity;
type ScalpSettings = {
  riskPct: number;
  stopPct: number;
  targetPct: number;
  feeBps: number;
  maxNotionalPct: number;
  maxDurationMinutes: number;
  autoTrading: boolean;
  riskLockEnabled: boolean;
};

const DEFAULT_SETTINGS: ScalpSettings = {
  riskPct: 0.1,
  stopPct: 0.15,
  targetPct: 0.51,
  feeBps: 5.5,
  maxNotionalPct: 20,
  maxDurationMinutes: 30,
  autoTrading: false,
  riskLockEnabled: false,
};

function fmtNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

function fmtTime(value: number) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

function fmtCompact(value: number) {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function scalpStrategyLabel(strategyId: ScalpSignalSnapshot["strategyId"]) {
  if (strategyId === "DENSITY_BOUNCE") return "ОТСКОК ОТ ПЛОТНОСТИ";
  if (strategyId === "IMPULSE_BREAKOUT") return "ИМПУЛЬСНЫЙ ПРОБОЙ";
  if (strategyId === "MTF_SHADOW") return "MTF · ТЕНЬ";
  if (strategyId === "MANUAL") return "РУЧНОЙ ВХОД";
  return "СТАРАЯ ЛОГИКА";
}

function lastValue(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] != null) return Number(values[index]);
  }
  return null;
}

function previousValue(values: Array<number | null>) {
  let found = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] == null) continue;
    found += 1;
    if (found === 2) return Number(values[index]);
  }
  return null;
}

function loadTrades(): ScalpPaperTrade[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as ScalpPaperTrade[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadSettings(): ScalpSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<ScalpSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    // Рыночный вход исполняется как taker. Нулевая комиссия в старой версии
    // создавала завышенную статистику, поэтому восстанавливаем безопасный базовый тариф.
    if (!Number.isFinite(merged.feeBps) || merged.feeBps <= 0) merged.feeBps = DEFAULT_SETTINGS.feeBps;
    const minimumTarget = minimumTargetPctForNetRewardRisk(merged.stopPct, merged.feeBps, 1.5);
    if (!Number.isFinite(merged.targetPct) || merged.targetPct < minimumTarget) {
      merged.targetPct = Math.ceil(minimumTarget * 100) / 100;
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function normalizeOpenTradeEconomics(trade: ScalpPaperTrade, settings: ScalpSettings) {
  if (trade.status !== "OPEN") return trade;
  const savedFeeBps = trade.signalSnapshot?.feeBps;
  if ((savedFeeBps != null && savedFeeBps > 0) || trade.entryFee > 0) return trade;
  const stopPct = trade.signalSnapshot?.stopPct
    ?? Math.abs(trade.stopPrice / trade.entryPrice - 1) * 100;
  const requestedTargetPct = trade.signalSnapshot?.requestedTargetPct ?? settings.targetPct;
  const effectiveTargetPct = Math.max(
    requestedTargetPct,
    minimumTargetPctForNetRewardRisk(stopPct, settings.feeBps, 1.5),
  );
  const economics = scalpNetRewardRisk(stopPct, effectiveTargetPct, settings.feeBps);
  const targetPrice = trade.side === "LONG"
    ? trade.entryPrice * (1 + effectiveTargetPct / 100)
    : trade.entryPrice * (1 - effectiveTargetPct / 100);
  return {
    ...trade,
    targetPrice,
    entryFee: trade.notional * settings.feeBps / 10_000,
    signalSnapshot: trade.signalSnapshot ? {
      ...trade.signalSnapshot,
      feeBps: settings.feeBps,
      effectiveTargetPct,
      netRewardRisk: economics.ratio,
    } : undefined,
    updatedAt: Date.now(),
  };
}

function mergeScalpTrades(localTrades: ScalpPaperTrade[], remoteTrades: ScalpPaperTrade[]) {
  const byId = new Map<string, ScalpPaperTrade>();
  [...remoteTrades, ...localTrades].forEach((trade) => {
    const previous = byId.get(trade.id);
    if (!previous) {
      byId.set(trade.id, trade);
      return;
    }
    if (previous.status !== trade.status) {
      byId.set(trade.id, trade.status === "CLOSED" ? trade : previous);
      return;
    }
    const previousTime = previous.updatedAt ?? previous.closedAt ?? previous.openedAt;
    const nextTime = trade.updatedAt ?? trade.closedAt ?? trade.openedAt;
    byId.set(trade.id, nextTime >= previousTime ? trade : previous);
  });
  return auditScalpTrades([...byId.values()]).audited.sort((a, b) => b.openedAt - a.openedAt);
}

function scalpTradesRevision(trades: ScalpPaperTrade[]) {
  return trades
    .map((trade) => `${trade.id}:${trade.status}:${trade.updatedAt ?? trade.closedAt ?? trade.openedAt}:${trade.pnl ?? ""}`)
    .sort()
    .join("|");
}

function makeSignalSnapshot(input: {
  now: number;
  signalKey: string;
  signal: ScalpSignal;
  context: ScalpContext;
  settings: ScalpSettings;
  effectiveTargetPct: number;
  netRewardRisk: number;
  pack15m: IndicatorPack;
  pattern: CandlestickPattern | null;
  shadowSignal?: ScalpSignal | null;
}): ScalpSignalSnapshot {
  const { now, signalKey, signal, context, settings, effectiveTargetPct, netRewardRisk, pack15m, pattern, shadowSignal } = input;
  const ema20_15m = lastValue(pack15m.ema20);
  const ema50_15m = lastValue(pack15m.ema50);
  const histogram15m = lastValue(pack15m.histogram);
  const context15mAligned = signal.direction == null || ema20_15m == null || ema50_15m == null
    ? null
    : signal.direction === "LONG" ? context.price >= ema20_15m && ema20_15m >= ema50_15m : context.price <= ema20_15m && ema20_15m <= ema50_15m;
  const patternAligned = signal.direction == null || !pattern || pattern.status !== "CONFIRMED"
    ? null
    : signal.direction === "LONG" ? pattern.direction === "BULLISH" : pattern.direction === "BEARISH";
  return {
    version: 2,
    strategyVersion: SCALP_STRATEGY_VERSION,
    strategyId: signal.strategyId ?? "MANUAL",
    capturedAt: now,
    signalKey,
    status: signal.status,
    direction: signal.direction,
    score: signal.score,
    reasons: signal.reasons,
    price: context.price,
    spreadBps: context.spreadBps,
    imbalance: context.imbalance,
    deltaPct: context.deltaPct,
    tradesPerSecond: context.tradesPerSecond,
    ema20_1m: context.ema20_1m,
    histogram1m: context.histogram1m,
    previousHistogram1m: context.previousHistogram1m,
    ema20_5m: context.ema20_5m,
    ema50_5m: context.ema50_5m,
    histogram5m: context.histogram5m,
    previousHistogram5m: context.previousHistogram5m,
    ema20_15m,
    ema50_15m,
    histogram15m,
    pattern1m: pattern?.label ?? null,
    patternDirection1m: pattern?.direction ?? null,
    patternStatus1m: pattern?.status ?? null,
    patternAligned,
    context15mAligned,
    riskPct: settings.riskPct,
    stopPct: settings.stopPct,
    requestedTargetPct: settings.targetPct,
    effectiveTargetPct,
    feeBps: settings.feeBps,
    maxNotionalPct: settings.maxNotionalPct,
    maxDurationMinutes: settings.maxDurationMinutes,
    netRewardRisk,
    referencePrice: signal.referencePrice ?? null,
    densityRatio: signal.density?.ratio ?? null,
    densityAgeMs: signal.density?.ageMs ?? null,
    breakoutTouches: signal.breakout?.touches ?? null,
    breakoutVolumeRatio: signal.breakout?.volumeRatio ?? null,
    shadowMtfScore: shadowSignal?.score ?? null,
    turnover24h: context.turnover24h ?? null,
    price24hPct: context.price24hPct ?? null,
  };
}

export function ScalpingWorkspace() {
  const [symbol, setSymbol] = useState<ScalpSymbol>("BTCUSDT");
  const [scalpSymbols, setScalpSymbols] = useState<ScalpSymbol[]>([...CORE_SCALP_SYMBOLS]);
  const [universeStatus, setUniverseStatus] = useState<"LOADING" | "LIVE" | "FALLBACK">("LOADING");
  const [connection, setConnection] = useState<ConnectionState>("CONNECTING");
  const [feedSymbol, setFeedSymbol] = useState<string | null>(null);
  const [bids, setBids] = useState<ScalpBookLevel[]>([]);
  const [asks, setAsks] = useState<ScalpBookLevel[]>([]);
  const [tape, setTape] = useState<ScalpTapeTrade[]>([]);
  const [lastPrice, setLastPrice] = useState(0);
  const [activity, setActivity] = useState<ScalpActivity>({ turnover24h: null, price24hPct: null, openInterestValue: null });
  const [candles1m, setCandles1m] = useState<Candle[]>([]);
  const [candles5m, setCandles5m] = useState<Candle[]>([]);
  const [candles15m, setCandles15m] = useState<Candle[]>([]);
  const [candleError, setCandleError] = useState<string | null>(null);
  const [trades, setTrades] = useState<ScalpPaperTrade[]>([]);
  const [settings, setSettings] = useState<ScalpSettings>(DEFAULT_SETTINGS);
  const [journalView, setJournalView] = useState<"active" | "closed">("active");
  const [notice, setNotice] = useState<string | null>(null);
  const [backgroundConnection, setBackgroundConnection] = useState<ConnectionState>("CONNECTING");
  const [backgroundQuotes, setBackgroundQuotes] = useState<Partial<Record<string, BackgroundQuote>>>({});
  const [journalStorage, setJournalStorage] = useState<"LOADING" | "D1" | "LOCAL">("LOADING");
  const hydrated = useRef(false);
  const lastAutoEntry = useRef<Record<string, number>>({});
  const liquidityMissingSince = useRef<Record<string, number>>({});
  const settingsRef = useRef<ScalpSettings>(DEFAULT_SETTINGS);
  const selectedDensityBidRef = useRef<ScalpDensity | null>(null);
  const selectedDensityAskRef = useRef<ScalpDensity | null>(null);
  const [selectedDensityBid, setSelectedDensityBid] = useState<ScalpDensity | null>(null);
  const [selectedDensityAsk, setSelectedDensityAsk] = useState<ScalpDensity | null>(null);

  useEffect(() => {
    let disposed = false;
    const hydrateJournal = async () => {
      const localAudit = auditScalpTrades(loadTrades());
      const loadedSettings = loadSettings();
      setSettings(loadedSettings);
      try {
        const response = await fetch("/api/scalping-trades?limit=2000", { cache: "no-store" });
        const payload = await response.json() as { trades?: ScalpPaperTrade[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "База скальпинга не ответила");
        const mergedRaw = mergeScalpTrades(localAudit.audited, payload.trades ?? []);
        let upgradedOpenTrades = 0;
        const merged = mergedRaw.map((trade) => {
          const normalized = normalizeOpenTradeEconomics(trade, loadedSettings);
          if (normalized !== trade) upgradedOpenTrades += 1;
          return normalized;
        });
        const saved = await fetch("/api/scalping-trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trades: merged }),
        });
        if (!saved.ok) throw new Error("Перенос локального журнала не завершён");
        if (disposed) return;
        hydrated.current = true;
        setTrades(merged);
        setJournalStorage("D1");
        if (localAudit.audited.length || upgradedOpenTrades) {
          const parts = [`перенесено локальных записей — ${localAudit.audited.length}`];
          if (upgradedOpenTrades) parts.push(`исправлена комиссия открытых сделок — ${upgradedOpenTrades}`);
          setNotice(`Журнал синхронизирован: ${parts.join(" · ")}`);
        }
      } catch {
        if (disposed) return;
        hydrated.current = true;
        setTrades(localAudit.audited);
        setJournalStorage("LOCAL");
        setNotice("Постоянная база временно недоступна — журнал сохранён локально и повторит синхронизацию");
      }
    };
    void hydrateJournal();
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
    const timer = setTimeout(() => {
      void fetch("/api/scalping-trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trades }),
      }).then((response) => {
        if (response.ok) setJournalStorage("D1");
        else setJournalStorage("LOCAL");
      }).catch(() => setJournalStorage("LOCAL"));
    }, 400);
    return () => clearTimeout(timer);
  }, [trades]);

  useEffect(() => {
    if (journalStorage !== "D1") return;
    let disposed = false;
    const refreshJournal = async () => {
      try {
        const response = await fetch("/api/scalping-trades?limit=2000", { cache: "no-store" });
        const payload = await response.json() as { trades?: ScalpPaperTrade[] };
        if (!response.ok || disposed || !Array.isArray(payload.trades)) return;
        setTrades((current) => {
          const merged = mergeScalpTrades(current, payload.trades ?? []);
          return scalpTradesRevision(merged) === scalpTradesRevision(current) ? current : merged;
        });
      } catch {
        // Локальный движок продолжает работу; следующая сверка повторится автоматически.
      }
    };
    const timer = window.setInterval(() => { void refreshJournal(); }, 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [journalStorage]);

  useEffect(() => {
    if (!hydrated.current) return;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    const scan = async () => {
      try {
        const response = await fetch("/api/scalping-universe", { cache: "no-store" });
        const payload = await response.json() as { instruments?: Array<{ symbol?: string }> };
        if (!response.ok || !Array.isArray(payload.instruments)) throw new Error("scanner unavailable");
        const dynamic = payload.instruments.map((row) => String(row.symbol ?? "")).filter((item) => /^[A-Z0-9]{2,16}USDT$/.test(item));
        const merged = [...new Set([...CORE_SCALP_SYMBOLS, ...dynamic])].slice(0, 13);
        if (!disposed) {
          setScalpSymbols((current) => current.join(",") === merged.join(",") ? current : merged);
          setUniverseStatus("LIVE");
        }
      } catch {
        if (!disposed) setUniverseStatus("FALLBACK");
      }
    };
    void scan();
    const timer = window.setInterval(() => { void scan(); }, 5 * 60_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const openSymbols = trades.filter((trade) => trade.status === "OPEN").map((trade) => trade.symbol);
    if (!openSymbols.length) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      setScalpSymbols((current) => {
        const merged = [...new Set([...current, ...openSymbols])];
        return merged.length === current.length ? current : merged;
      });
    });
    return () => { disposed = true; };
  }, [trades]);

  useEffect(() => {
    type BackgroundState = {
      bidMap: Map<number, number>;
      askMap: Map<number, number>;
      tape: ScalpTapeTrade[];
      candles1m: Candle[];
      candles5m: Candle[];
      candles15m: Candle[];
      lastPrice: number;
      lastProcess: number;
      densityBid: ScalpDensity | null;
      densityAsk: ScalpDensity | null;
      activity: ScalpActivity;
    };
    const states = new Map<ScalpSymbol, BackgroundState>(scalpSymbols.map((item) => [item, {
      bidMap: new Map(), askMap: new Map(), tape: [], candles1m: [], candles5m: [], candles15m: [], lastPrice: 0, lastProcess: 0,
      densityBid: null, densityAsk: null,
      activity: { turnover24h: null, price24hPct: null, openInterestValue: null },
    }]));
    const signalTrackers = new Map<ScalpSymbol, { key: string | null; direction: "LONG" | "SHORT" | null; strategyId: string | null; readySince: number; opened: boolean }>(
      scalpSymbols.map((item) => [item, { key: null, direction: null, strategyId: null, readySince: 0, opened: false }]),
    );
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let candleTimer: ReturnType<typeof setInterval> | null = null;

    const applyLevels = (target: Map<number, number>, levels: unknown) => {
      if (!Array.isArray(levels)) return;
      levels.forEach((raw) => {
        if (!Array.isArray(raw)) return;
        const price = Number(raw[0]);
        const size = Number(raw[1]);
        if (!Number.isFinite(price) || !Number.isFinite(size)) return;
        if (size === 0) target.delete(price);
        else target.set(price, size);
      });
    };

    const processSymbol = (item: ScalpSymbol) => {
      const state = states.get(item);
      if (!state) return;
      const now = Date.now();
      if (now - state.lastProcess < 500) return;
      const bids = Array.from(state.bidMap, ([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price).slice(0, 25);
      const asks = Array.from(state.askMap, ([price, size]) => ({ price, size })).sort((a, b) => a.price - b.price).slice(0, 25);
      const bid = bids[0]?.price ?? 0;
      const ask = asks[0]?.price ?? 0;
      if (!bid || !ask) return;
      state.lastProcess = now;
      const last = state.lastPrice || (bid + ask) / 2;
      setBackgroundQuotes((current) => ({ ...current, [item]: { bid, ask, last, updatedAt: now, ...state.activity } }));

      const mid = (bid + ask) / 2;
      const stats = tapeStats(state.tape, now, 30_000);
      const closed1m = state.candles1m.filter((candle) => candle.closed !== false);
      const closed5m = state.candles5m.filter((candle) => candle.closed !== false);
      const closed15m = state.candles15m.filter((candle) => candle.closed !== false);
      const pack1 = indicators(closed1m);
      const pack5 = indicators(closed5m);
      const pack15 = indicators(closed15m);
      const signalContext: ScalpContext = {
        price: mid,
        bid,
        ask,
        spreadBps: (ask - bid) / mid * 10_000,
        imbalance: bookImbalance(bids, asks, 10),
        deltaPct: stats.deltaPct,
        tradesPerSecond: stats.tradesPerSecond,
        turnover24h: state.activity.turnover24h,
        price24hPct: state.activity.price24hPct,
        ema20_5m: lastValue(pack5.ema20),
        ema50_5m: lastValue(pack5.ema50),
        histogram5m: lastValue(pack5.histogram),
        previousHistogram5m: previousValue(pack5.histogram),
        ema20_15m: lastValue(pack15.ema20),
        ema50_15m: lastValue(pack15.ema50),
        histogram15m: lastValue(pack15.histogram),
        ema20_1m: lastValue(pack1.ema20),
        histogram1m: lastValue(pack1.histogram),
        previousHistogram1m: previousValue(pack1.histogram),
      };
      const shadowSignal = assessScalpSignal(signalContext);
      state.densityBid = findBookDensity(bids, mid, "BID", state.densityBid ?? {}, now);
      state.densityAsk = findBookDensity(asks, mid, "ASK", state.densityAsk ?? {}, now);
      const breakoutLong = analyzeBreakoutLevel(closed1m, mid, "LONG");
      const breakoutShort = analyzeBreakoutLevel(closed1m, mid, "SHORT");
      const pattern = latestPatternDetails(closed1m);
      const scalpSignal = assessMicrostructureSignal({
        price: mid, bid, ask, spreadBps: signalContext.spreadBps,
        imbalance: signalContext.imbalance, deltaPct: stats.deltaPct, tradesPerSecond: stats.tradesPerSecond,
        turnover24h: state.activity.turnover24h, price24hPct: state.activity.price24hPct,
        densityBid: state.densityBid, densityAsk: state.densityAsk, breakoutLong, breakoutShort,
        ema20_15m: signalContext.ema20_15m, ema50_15m: signalContext.ema50_15m, histogram15m: signalContext.histogram15m,
        patternDirection1m: pattern?.direction ?? null, patternStatus1m: pattern?.status ?? null,
      });
      const tracker = signalTrackers.get(item);
      if (tracker) {
        if (scalpSignal.status !== "READY") {
          tracker.key = null;
          tracker.direction = null;
          tracker.strategyId = null;
          tracker.readySince = 0;
          tracker.opened = false;
        } else if (!tracker.key || tracker.direction !== scalpSignal.direction || tracker.strategyId !== scalpSignal.strategyId) {
          tracker.key = `${item}:${scalpSignal.strategyId}:${scalpSignal.direction}:${now}`;
          tracker.direction = scalpSignal.direction;
          tracker.strategyId = scalpSignal.strategyId ?? null;
          tracker.readySince = now;
          tracker.opened = false;
        }
      }
      const signalKey = tracker?.key ?? `${item}:${scalpSignal.direction ?? "NONE"}:${now}`;

      setTrades((current) => {
        const activeSettings = settingsRef.current;
        let changed = false;
        let next = current.map((trade) => {
          if (!isScalpTradeQuoteCompatible(trade, item)) return trade;
          const tradeFeeBps = trade.signalSnapshot?.feeBps ?? activeSettings.feeBps;
          const tradeDuration = trade.signalSnapshot?.maxDurationMinutes ?? activeSettings.maxDurationMinutes;
          let liquidityLost = false;
          if (trade.signalSnapshot?.strategyId === "DENSITY_BOUNCE") {
            const liveDensity = trade.side === "LONG" ? state.densityBid : state.densityAsk;
            const reference = Number(trade.signalSnapshot.referencePrice ?? 0);
            const densityAlive = Boolean(liveDensity && reference > 0
              && Math.abs(liveDensity.price / reference - 1) * 10_000 <= 2
              && liveDensity.retention >= 0.5);
            if (densityAlive) delete liquidityMissingSince.current[trade.id];
            else {
              liquidityMissingSince.current[trade.id] ??= now;
              liquidityLost = now - liquidityMissingSince.current[trade.id] >= 3_000;
            }
          }
          const evaluated = evaluateScalpTrade(trade, bid, ask, now, tradeFeeBps, { maxDurationMinutes: tradeDuration, liquidityLost });
          if (evaluated.status === "CLOSED") delete liquidityMissingSince.current[trade.id];
          if (evaluated !== trade) changed = true;
          return evaluated;
        });
        if (!activeSettings.autoTrading || scalpSignal.status !== "READY" || !scalpSignal.direction) return changed ? next : current;
        if (!tracker || tracker.opened || now - tracker.readySince < 3_000) return changed ? next : current;
        if (now - (lastAutoEntry.current[item] ?? 0) < 120_000) return changed ? next : current;
        const open = next.filter((trade) => trade.status === "OPEN");
        if (open.length >= 3 || open.some((trade) => trade.symbol === item)) return changed ? next : current;
        const currentRisk = scalpRiskState(next, INITIAL_BALANCE, 1, activeSettings.feeBps);
        if (activeSettings.riskLockEnabled && currentRisk.locked) return changed ? next : current;
        const currentBalance = INITIAL_BALANCE + next
          .filter((trade) => trade.status === "CLOSED" && trade.validity !== "INVALID_LEGACY")
          .reduce((sum, trade) => sum + feeAdjustedScalpPnl(trade, activeSettings.feeBps), 0);
        if (!scalpSignal.referencePrice) return changed ? next : current;
        if (!scalpReentryAllowed(next, item, scalpSignal.direction, scalpSignal.referencePrice, now)) return changed ? next : current;
        const entry = calculateMicrostructureScalpEntry({
          side: scalpSignal.direction, bid, ask, referencePrice: scalpSignal.referencePrice,
          balance: currentBalance, riskPct: activeSettings.riskPct, targetPct: activeSettings.targetPct,
          feeBps: activeSettings.feeBps, maxNotionalPct: activeSettings.maxNotionalPct,
          bufferBps: Math.max(2, signalContext.spreadBps * 1.5),
        });
        if (!entry) return changed ? next : current;
        const signalSnapshot = makeSignalSnapshot({
          now,
          signalKey,
          signal: scalpSignal,
          context: signalContext,
          settings: activeSettings,
          effectiveTargetPct: entry.effectiveTargetPct,
          netRewardRisk: entry.netRewardRisk,
          pack15m: pack15,
          pattern,
          shadowSignal,
        });
        const trade: ScalpPaperTrade = {
          id: `SCALP-${item}-${now}`,
          symbol: item,
          side: scalpSignal.direction,
          status: "OPEN",
          ...entry,
          openedAt: now,
          entryMode: "AUTO",
          validity: "VALID",
          signalKey,
          signalSnapshot,
          updatedAt: now,
        };
        lastAutoEntry.current[item] = now;
        tracker.opened = true;
        next = [trade, ...next];
        return next;
      });
    };

    const loadCandles = async () => {
      await Promise.all(scalpSymbols.map(async (item) => {
        try {
          const fetchFrame = async (timeframe: "1m" | "5m" | "15m") => {
            const params = new URLSearchParams({ symbol: item, market: "crypto", timeframe });
            const response = await fetch(`/api/market-data?${params}`, { cache: "no-store" });
            const payload = await response.json() as { candles?: Candle[] };
            return response.ok && payload.candles?.length ? payload.candles : [];
          };
          const [one, five, fifteen] = await Promise.all([fetchFrame("1m"), fetchFrame("5m"), fetchFrame("15m")]);
          if (disposed) return;
          const state = states.get(item);
          if (state) {
            if (one.length) state.candles1m = one;
            if (five.length) state.candles5m = five;
            if (fifteen.length) state.candles15m = fifteen;
          }
          processSymbol(item);
        } catch {
          // Остальные инструменты продолжают работать, если один источник свечей временно недоступен.
        }
      }));
    };

    const connect = () => {
      if (disposed) return;
      setBackgroundConnection((current) => current === "CONNECTING" ? current : "RECONNECTING");
      socket = new WebSocket("wss://stream.bybit.com/v5/public/linear");
      socket.onopen = () => {
        if (disposed || !socket) return;
        setBackgroundConnection("LIVE");
        const topics = scalpSymbols.flatMap((item) => [
          `orderbook.50.${item}`, `publicTrade.${item}`, `tickers.${item}`,
        ]);
        for (let index = 0; index < topics.length; index += 10) {
          socket.send(JSON.stringify({ op: "subscribe", args: topics.slice(index, index + 10) }));
        }
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
        }, 20_000);
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { topic?: string; type?: string; data?: unknown };
          const topicSymbol = message.topic?.split(".").at(-1) as ScalpSymbol | undefined;
          if (!topicSymbol || !scalpSymbols.includes(topicSymbol)) return;
          const state = states.get(topicSymbol);
          if (!state) return;
          if (message.topic?.startsWith("orderbook.")) {
            const data = message.data as { b?: unknown; a?: unknown };
            if (message.type === "snapshot") { state.bidMap.clear(); state.askMap.clear(); }
            applyLevels(state.bidMap, data?.b);
            applyLevels(state.askMap, data?.a);
          } else if (message.topic?.startsWith("publicTrade.")) {
            const rows = Array.isArray(message.data) ? message.data as Array<Record<string, string>> : [];
            const incoming = rows.map((row) => ({
              id: String(row.i ?? `${row.T}-${row.p}-${row.v}`),
              time: Number(row.T), price: Number(row.p), size: Number(row.v),
              side: row.S === "Sell" ? "Sell" as const : "Buy" as const,
            })).filter((trade) => Number.isFinite(trade.time) && Number.isFinite(trade.price) && Number.isFinite(trade.size));
            if (incoming.length) {
              state.lastPrice = incoming.reduce((newest, trade) => trade.time > newest.time ? trade : newest, incoming[0]).price;
              state.tape = [...incoming.reverse(), ...state.tape].slice(0, 240);
            }
          } else if (message.topic?.startsWith("tickers.")) {
            const ticker = message.data as { lastPrice?: string; turnover24h?: string; price24hPcnt?: string; openInterestValue?: string };
            const next = Number(ticker?.lastPrice);
            if (Number.isFinite(next) && next > 0) state.lastPrice = next;
            const turnover = Number(ticker?.turnover24h);
            const change = Number(ticker?.price24hPcnt);
            const oi = Number(ticker?.openInterestValue);
            if (Number.isFinite(turnover)) state.activity.turnover24h = turnover;
            if (Number.isFinite(change)) state.activity.price24hPct = change * 100;
            if (Number.isFinite(oi)) state.activity.openInterestValue = oi;
          }
          processSymbol(topicSymbol);
        } catch {
          // Следующее корректное сообщение восстановит состояние потока.
        }
      };
      socket.onerror = () => setBackgroundConnection("RECONNECTING");
      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (disposed) return;
        setBackgroundConnection("RECONNECTING");
        reconnectTimer = setTimeout(connect, 2_000);
      };
    };

    void loadCandles();
    candleTimer = setInterval(() => { void loadCandles(); }, 60_000);
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (candleTimer) clearInterval(candleTimer);
      socket?.close();
    };
  }, [scalpSymbols]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    const bidMap = new Map<number, number>();
    const askMap = new Map<number, number>();
    let lastBookPublish = 0;
    let lastTapePublish = 0;
    let tapeBuffer: ScalpTapeTrade[] = [];

    queueMicrotask(() => {
      if (disposed) return;
      setBids([]);
      setAsks([]);
      setTape([]);
      setLastPrice(0);
      setActivity({ turnover24h: null, price24hPct: null, openInterestValue: null });
      setFeedSymbol(null);
      setConnection("CONNECTING");
    });

    const publishBook = () => {
      const now = Date.now();
      if (now - lastBookPublish < 80) return;
      lastBookPublish = now;
      setBids(Array.from(bidMap, ([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price).slice(0, 25));
      setAsks(Array.from(askMap, ([price, size]) => ({ price, size })).sort((a, b) => a.price - b.price).slice(0, 25));
      setFeedSymbol(symbol);
    };

    const applyLevels = (target: Map<number, number>, levels: unknown) => {
      if (!Array.isArray(levels)) return;
      levels.forEach((raw) => {
        if (!Array.isArray(raw)) return;
        const price = Number(raw[0]);
        const size = Number(raw[1]);
        if (!Number.isFinite(price) || !Number.isFinite(size)) return;
        if (size === 0) target.delete(price);
        else target.set(price, size);
      });
    };

    const connect = () => {
      if (disposed) return;
      setConnection((current) => current === "CONNECTING" ? current : "RECONNECTING");
      socket = new WebSocket("wss://stream.bybit.com/v5/public/linear");
      socket.onopen = () => {
        if (disposed || !socket) return;
        setConnection("LIVE");
        socket.send(JSON.stringify({ op: "subscribe", args: [`orderbook.50.${symbol}`, `publicTrade.${symbol}`, `tickers.${symbol}`] }));
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
        }, 20_000);
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { topic?: string; type?: string; data?: unknown };
          if (message.topic?.startsWith("orderbook.")) {
            const data = message.data as { b?: unknown; a?: unknown };
            if (message.type === "snapshot") {
              bidMap.clear();
              askMap.clear();
            }
            applyLevels(bidMap, data?.b);
            applyLevels(askMap, data?.a);
            publishBook();
          } else if (message.topic?.startsWith("publicTrade.")) {
            const rows = Array.isArray(message.data) ? message.data as Array<Record<string, string>> : [];
            const incoming = rows.map((row) => ({
              id: String(row.i ?? `${row.T}-${row.p}-${row.v}`),
              time: Number(row.T),
              price: Number(row.p),
              size: Number(row.v),
              side: row.S === "Sell" ? "Sell" as const : "Buy" as const,
            })).filter((trade) => Number.isFinite(trade.time) && Number.isFinite(trade.price) && Number.isFinite(trade.size));
            if (incoming.length) {
              const newestPrice = incoming.reduce((newest, trade) => trade.time > newest.time ? trade : newest, incoming[0]).price;
              tapeBuffer = [...incoming.reverse(), ...tapeBuffer].slice(0, 240);
              setLastPrice(newestPrice);
              const now = Date.now();
              if (now - lastTapePublish >= 100) {
                lastTapePublish = now;
                setTape(tapeBuffer);
              }
            }
          } else if (message.topic?.startsWith("tickers.")) {
            const data = message.data as { lastPrice?: string; turnover24h?: string; price24hPcnt?: string; openInterestValue?: string };
            const next = Number(data?.lastPrice);
            if (Number.isFinite(next) && next > 0) setLastPrice(next);
            setActivity((current) => ({
              turnover24h: Number.isFinite(Number(data.turnover24h)) ? Number(data.turnover24h) : current.turnover24h,
              price24hPct: Number.isFinite(Number(data.price24hPcnt)) ? Number(data.price24hPcnt) * 100 : current.price24hPct,
              openInterestValue: Number.isFinite(Number(data.openInterestValue)) ? Number(data.openInterestValue) : current.openInterestValue,
            }));
          }
        } catch {
          // Повреждённое сетевое сообщение пропускается; следующий снимок восстановит стакан.
        }
      };
      socket.onerror = () => setConnection("RECONNECTING");
      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (disposed) return;
        setConnection("RECONNECTING");
        reconnectTimer = setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      socket?.close();
    };
  }, [symbol]);

  useEffect(() => {
    let disposed = false;
    const loadCandles = async () => {
      try {
        const fetchFrame = async (timeframe: "1m" | "5m" | "15m") => {
          const params = new URLSearchParams({ symbol, market: "crypto", timeframe });
          const response = await fetch(`/api/market-data?${params}`, { cache: "no-store" });
          const payload = await response.json() as { candles?: Candle[]; error?: string };
          if (!response.ok || !payload.candles?.length) throw new Error(payload.error ?? `Нет свечей ${timeframe}`);
          return payload.candles;
        };
        const [one, five, fifteen] = await Promise.all([fetchFrame("1m"), fetchFrame("5m"), fetchFrame("15m")]);
        if (!disposed) {
          setCandles1m(one);
          setCandles5m(five);
          setCandles15m(fifteen);
          setCandleError(null);
        }
      } catch (error) {
        if (!disposed) setCandleError(error instanceof Error ? error.message : "Свечи недоступны");
      }
    };
    void loadCandles();
    const timer = setInterval(loadCandles, 60_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [symbol]);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : lastPrice;
  const spreadBps = midPrice > 0 ? (bestAsk - bestBid) / midPrice * 10_000 : 0;
  const imbalance = useMemo(() => bookImbalance(bids, asks, 10), [bids, asks]);
  const tapeWindow = useMemo(() => tapeStats(tape, Date.now(), 30_000), [tape]);
  const pack1m = useMemo(() => indicators(candles1m.filter((candle) => candle.closed !== false)), [candles1m]);
  const pack5m = useMemo(() => indicators(candles5m.filter((candle) => candle.closed !== false)), [candles5m]);
  const pack15m = useMemo(() => indicators(candles15m.filter((candle) => candle.closed !== false)), [candles15m]);
  useEffect(() => {
    if (!midPrice || bids.length < 5 || asks.length < 5) return;
    const now = Date.now();
    const nextBid = findBookDensity(bids, midPrice, "BID", selectedDensityBidRef.current ?? {}, now);
    const nextAsk = findBookDensity(asks, midPrice, "ASK", selectedDensityAskRef.current ?? {}, now);
    selectedDensityBidRef.current = nextBid;
    selectedDensityAskRef.current = nextAsk;
    setSelectedDensityBid(nextBid);
    setSelectedDensityAsk(nextAsk);
  }, [asks, bids, midPrice]);
  const signalContext = useMemo<ScalpContext>(() => ({
    price: midPrice,
    bid: bestBid,
    ask: bestAsk,
    spreadBps,
    imbalance,
    deltaPct: tapeWindow.deltaPct,
    tradesPerSecond: tapeWindow.tradesPerSecond,
    turnover24h: activity.turnover24h,
    price24hPct: activity.price24hPct,
    ema20_5m: lastValue(pack5m.ema20),
    ema50_5m: lastValue(pack5m.ema50),
    histogram5m: lastValue(pack5m.histogram),
    previousHistogram5m: previousValue(pack5m.histogram),
    ema20_15m: lastValue(pack15m.ema20),
    ema50_15m: lastValue(pack15m.ema50),
    histogram15m: lastValue(pack15m.histogram),
    ema20_1m: lastValue(pack1m.ema20),
    histogram1m: lastValue(pack1m.histogram),
    previousHistogram1m: previousValue(pack1m.histogram),
  }), [activity.price24hPct, activity.turnover24h, bestAsk, bestBid, imbalance, midPrice, pack1m, pack5m, pack15m, spreadBps, tapeWindow]);
  const shadowSignal = useMemo(() => assessScalpSignal(signalContext), [signalContext]);
  const breakoutLong = useMemo(() => analyzeBreakoutLevel(candles1m.filter((candle) => candle.closed !== false), midPrice, "LONG"), [candles1m, midPrice]);
  const breakoutShort = useMemo(() => analyzeBreakoutLevel(candles1m.filter((candle) => candle.closed !== false), midPrice, "SHORT"), [candles1m, midPrice]);
  const candlePattern = useMemo(() => latestPatternDetails(candles1m.filter((candle) => candle.closed !== false)), [candles1m]);
  const signal = useMemo(() => assessMicrostructureSignal({
    price: midPrice, bid: bestBid, ask: bestAsk, spreadBps, imbalance,
    deltaPct: tapeWindow.deltaPct, tradesPerSecond: tapeWindow.tradesPerSecond,
    turnover24h: activity.turnover24h, price24hPct: activity.price24hPct,
    densityBid: selectedDensityBid, densityAsk: selectedDensityAsk, breakoutLong, breakoutShort,
    ema20_15m: signalContext.ema20_15m, ema50_15m: signalContext.ema50_15m, histogram15m: signalContext.histogram15m,
    patternDirection1m: candlePattern?.direction ?? null, patternStatus1m: candlePattern?.status ?? null,
  }), [activity.price24hPct, activity.turnover24h, bestAsk, bestBid, breakoutLong, breakoutShort, candlePattern, imbalance, midPrice, selectedDensityAsk, selectedDensityBid, signalContext.ema20_15m, signalContext.ema50_15m, signalContext.histogram15m, spreadBps, tapeWindow.deltaPct, tapeWindow.tradesPerSecond]);
  const closedTradesAll = useMemo(() => trades.filter((trade) => trade.status === "CLOSED").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)), [trades]);
  const closedTrades = useMemo(() => closedTradesAll.filter((trade) => trade.validity !== "INVALID_LEGACY"), [closedTradesAll]);
  const invalidTrades = useMemo(() => trades.filter((trade) => trade.validity === "INVALID_LEGACY"), [trades]);
  const activeTrades = useMemo(() => trades.filter((trade) => trade.status === "OPEN").sort((a, b) => b.openedAt - a.openedAt), [trades]);
  const legacyFeeTrades = closedTrades.filter((trade) => estimatedMissingScalpFees(trade, settings.feeBps) > 0);
  const missingLegacyFees = legacyFeeTrades.reduce((sum, trade) => sum + estimatedMissingScalpFees(trade, settings.feeBps), 0);
  const realizedPnl = closedTrades.reduce((sum, trade) => sum + feeAdjustedScalpPnl(trade, settings.feeBps), 0);
  const balance = INITIAL_BALANCE + realizedPnl;
  const risk = useMemo(() => scalpRiskState(trades.filter((trade) => trade.validity !== "INVALID_LEGACY"), INITIAL_BALANCE, 1, settings.feeBps), [settings.feeBps, trades]);
  const riskLocked = settings.riskLockEnabled && risk.locked;
  const performance = useMemo(() => scalpPerformanceStats(trades, settings.feeBps), [settings.feeBps, trades]);
  const snapshotTrades = closedTrades.filter((trade) => trade.signalSnapshot);
  const aligned15mTrades = snapshotTrades.filter((trade) => trade.signalSnapshot?.context15mAligned === true);
  const alignedNisonTrades = snapshotTrades.filter((trade) => trade.signalSnapshot?.patternAligned === true);
  const withinDurationTrades = closedTrades.filter((trade) => scalpTradeDurationMinutes(trade) <= (trade.signalSnapshot?.maxDurationMinutes ?? settings.maxDurationMinutes));
  const diagnosticWinRate = (sample: ScalpPaperTrade[]) => sample.length
    ? sample.filter((trade) => feeAdjustedScalpPnl(trade, settings.feeBps) > 0).length / sample.length * 100
    : null;
  const minimumTargetPct = minimumTargetPctForNetRewardRisk(settings.stopPct, settings.feeBps, 1.5);
  const tradeEconomics = scalpNetRewardRisk(settings.stopPct, Math.max(settings.targetPct, minimumTargetPct), settings.feeBps);

  const openPosition = useCallback((side: ScalpSide, mode: "AUTO" | "MANUAL" = "MANUAL") => {
    if (riskLocked) {
      setNotice(risk.reason ?? "Торговля остановлена лимитом риска");
      return false;
    }
    if (connection !== "LIVE" || feedSymbol !== symbol || !bestBid || !bestAsk) {
      setNotice("Ждём живой стакан Bybit");
      return false;
    }
    if (activeTrades.length >= 3) {
      setNotice("Достигнут лимит: одновременно не более трёх позиций");
      return false;
    }
    if (activeTrades.some((trade) => trade.symbol === symbol)) {
      setNotice(`По ${symbol} позиция уже открыта`);
      return false;
    }
    const entry = calculateScalpEntry({ side, bid: bestBid, ask: bestAsk, balance, ...settings });
    if (!entry) {
      setNotice("Не удалось рассчитать размер позиции");
      return false;
    }
    const now = Date.now();
    const closed1m = candles1m.filter((candle) => candle.closed !== false);
    const closed5m = candles5m.filter((candle) => candle.closed !== false);
    const signalKey = `${symbol}:${signal.direction ?? side}:${closed1m.at(-1)?.time ?? 0}:${closed5m.at(-1)?.time ?? 0}:MANUAL`;
    const signalSnapshot = makeSignalSnapshot({
      now,
      signalKey,
      signal: mode === "MANUAL" ? { ...signal, strategyId: "MANUAL" } : signal,
      context: signalContext,
      settings,
      effectiveTargetPct: entry.effectiveTargetPct,
      netRewardRisk: entry.netRewardRisk,
      pack15m,
      pattern: candlePattern,
      shadowSignal,
    });
    const trade: ScalpPaperTrade = {
      id: `SCALP-${symbol}-${now}`,
      symbol,
      side,
      status: "OPEN",
      ...entry,
      openedAt: now,
      entryMode: mode,
      validity: "VALID",
      signalKey,
      signalSnapshot,
      updatedAt: now,
    };
    setTrades((current) => [trade, ...current]);
    lastAutoEntry.current[symbol] = now;
    setNotice(`${mode === "AUTO" ? "Авто" : "Ручной"} вход ${side} открыт виртуально по ${formatPrice(entry.entryPrice)}`);
    return true;
  }, [activeTrades, balance, bestAsk, bestBid, candlePattern, candles1m, candles5m, connection, feedSymbol, pack15m, risk, riskLocked, settings, shadowSignal, signal, signalContext, symbol]);

  const closePosition = (id: string) => {
    const selectedTrade = trades.find((trade) => trade.id === id);
    if (!selectedTrade) return;
    const backgroundQuote = backgroundQuotes[selectedTrade.symbol as ScalpSymbol];
    if (backgroundQuote?.bid && backgroundQuote?.ask && Date.now() - backgroundQuote.updatedAt < 10_000) {
      setTrades((current) => current.map((trade) => trade.id === id
        ? evaluateScalpTrade(trade, backgroundQuote.bid, backgroundQuote.ask, Date.now(), trade.signalSnapshot?.feeBps ?? settings.feeBps, { manual: true })
        : trade));
      setNotice(`Позиция ${selectedTrade.symbol} закрыта по текущей исполнимой цене`);
      return;
    }
    if (selectedTrade.symbol !== symbol || feedSymbol !== symbol) {
      if (scalpSymbols.includes(selectedTrade.symbol)) {
        setSymbol(selectedTrade.symbol);
        setNotice(`Переключились на ${selectedTrade.symbol}. Дождитесь BYBIT LIVE и подтвердите закрытие ещё раз.`);
      }
      return;
    }
    if (!bestBid || !bestAsk) return;
    setTrades((current) => current.map((trade) => trade.id === id
      ? evaluateScalpTrade(trade, bestBid, bestAsk, Date.now(), trade.signalSnapshot?.feeBps ?? settings.feeBps, { manual: true })
      : trade));
    setNotice("Позиция закрыта вручную по текущей цене стакана");
  };

  const visibleJournal = journalView === "active" ? activeTrades : closedTradesAll;
  const maxDepth = Math.max(...bids.slice(0, 10).map((level) => level.size), ...asks.slice(0, 10).map((level) => level.size), 1);
  const backgroundLiveSymbols = scalpSymbols.filter((item) => Date.now() - (backgroundQuotes[item]?.updatedAt ?? 0) < 10_000).length;

  return (
    <div className="scalp-workspace">
      <section className="scalp-header">
        <div>
          <p className="eyebrow">СКАЛЬПИНГ · ВИРТУАЛЬНЫЙ КОНТУР</p>
          <h1>Микроструктура: плотности и импульсные пробои</h1>
          <p>Входы по стакану, ленте и активности InPlay. EMA/MACD 15м / 5м / 1м сохранены только как теневой контроль.</p>
        </div>
        <div className="scalp-symbols" aria-label="Инструмент скальпинга">
          {scalpSymbols.map((item) => <button key={item} className={symbol === item ? "selected" : ""} onClick={() => setSymbol(item)}>{item.replace("USDT", "")}</button>)}
        </div>
        <span className={`scalp-connection ${connection.toLowerCase()}`}><i />{connection === "LIVE" ? "BYBIT LIVE" : connection === "CONNECTING" ? "ПОДКЛЮЧЕНИЕ" : connection === "RECONNECTING" ? "ПЕРЕПОДКЛЮЧЕНИЕ" : "НЕТ СВЯЗИ"}</span>
        <span className={`scalp-background-status ${backgroundConnection.toLowerCase()}`}><i />ФОН: {backgroundLiveSymbols}/{scalpSymbols.length}{settings.autoTrading ? " · АВТО ВСЕ" : " · НАБЛЮДЕНИЕ"} · СКАНЕР {universeStatus === "LIVE" ? "LIVE" : universeStatus === "LOADING" ? "…" : "БАЗОВЫЕ"}</span>
      </section>

      <section className="scalp-metrics">
        <article><small>Последняя цена</small><strong>{formatPrice(midPrice)}</strong><span>{symbol}</span></article>
        <article><small>Спред</small><strong>{fmtNumber(spreadBps, 2)} б.п.</strong><span className={spreadBps <= 6 ? "positive" : "negative"}>{spreadBps <= 6 ? "допустим" : "вход запрещён"}</span></article>
        <article><small>Баланс стакана</small><strong className={imbalance >= 0 ? "positive" : "negative"}>{imbalance >= 0 ? "+" : ""}{fmtNumber(imbalance * 100, 1)}%</strong><span>{imbalance >= 0 ? "покупатели" : "продавцы"}</span></article>
        <article><small>Дельта ленты · 30с</small><strong className={tapeWindow.deltaPct >= 0 ? "positive" : "negative"}>{tapeWindow.deltaPct >= 0 ? "+" : ""}{fmtNumber(tapeWindow.deltaPct * 100, 1)}%</strong><span>{fmtNumber(tapeWindow.tradesPerSecond, 1)} сделок/с</span></article>
        <article><small>Активность · 24ч</small><strong>{activity.price24hPct == null ? "—" : `${activity.price24hPct >= 0 ? "+" : ""}${fmtNumber(activity.price24hPct, 1)}%`}</strong><span>{activity.turnover24h == null ? "ждём тикер" : `${fmtCompact(activity.turnover24h)} USDT · ${activity.turnover24h >= 100_000_000 && Math.abs(activity.price24hPct ?? 0) >= 5 ? "InPlay" : "вне фильтра"}`}</span></article>
        <article><small>Виртуальный баланс</small><strong className={realizedPnl >= 0 ? "positive" : "negative"}>{fmtNumber(balance)} USDT</strong><span>PnL {realizedPnl >= 0 ? "+" : ""}{fmtNumber(realizedPnl)}</span></article>
      </section>

      <div className="scalp-main-grid">
        <section className="scalp-signal-panel">
          <div className="scalp-panel-heading"><div><p className="eyebrow">ФИЛЬТР МИКРОСТРУКТУРЫ</p><h2>Решение системы</h2></div><span className={`scalp-signal-status ${signal.status.toLowerCase()}`}>{signal.status === "READY" ? "ГОТОВ" : signal.status === "WAIT" ? "ЖДЁМ" : "БЕЗ СДЕЛКИ"}</span></div>
          <div className="scalp-score"><strong>{signal.direction ?? "—"}</strong><span>{scalpStrategyLabel(signal.strategyId)} · оценка {signal.score}/100</span></div>
          <ul>{signal.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <div className="scalp-context-grid">
            <span><small>Плотность BID</small><b>{selectedDensityBid ? `×${fmtNumber(selectedDensityBid.ratio, 1)} · ${fmtNumber(selectedDensityBid.ageMs / 1000, 1)}с · ${formatPrice(selectedDensityBid.price)}` : "нет аномалии"}</b></span>
            <span><small>Плотность ASK</small><b>{selectedDensityAsk ? `×${fmtNumber(selectedDensityAsk.ratio, 1)} · ${fmtNumber(selectedDensityAsk.ageMs / 1000, 1)}с · ${formatPrice(selectedDensityAsk.price)}` : "нет аномалии"}</b></span>
            <span><small>Пробой 1м</small><b>{signal.breakout ? `${signal.breakout.side} · ${signal.breakout.touches} кас. · объём ×${fmtNumber(signal.breakout.volumeRatio, 1)}` : "структура не готова"}</b></span>
            <span><small>MTF · тень</small><b>{shadowSignal.direction ?? "—"} · {shadowSignal.status} · {shadowSignal.score}/100</b></span>
          </div>
          {candleError && <p className="scalp-warning">Свечной контекст: {candleError}</p>}
        </section>

        <section className="scalp-orderbook">
          <div className="scalp-panel-heading"><div><p className="eyebrow">ORDER BOOK</p><h2>Стакан · 10 уровней</h2></div><span>объём в монетах</span></div>
          <div className="book-head"><span>Цена</span><span>Размер</span><span>Сумма</span></div>
          <div className="book-asks">
            {asks.slice(0, 10).reverse().map((level) => <div key={`a-${level.price}`} className="book-row ask" style={{ "--depth": `${level.size / maxDepth * 100}%` } as React.CSSProperties}><span>{formatPrice(level.price)}</span><span>{fmtNumber(level.size, 4)}</span><span>{fmtCompact(level.price * level.size)}</span></div>)}
          </div>
          <div className="book-mid"><strong>{formatPrice(midPrice)}</strong><span>спред {fmtNumber(bestAsk - bestBid, 3)}</span></div>
          <div className="book-bids">
            {bids.slice(0, 10).map((level) => <div key={`b-${level.price}`} className="book-row bid" style={{ "--depth": `${level.size / maxDepth * 100}%` } as React.CSSProperties}><span>{formatPrice(level.price)}</span><span>{fmtNumber(level.size, 4)}</span><span>{fmtCompact(level.price * level.size)}</span></div>)}
          </div>
        </section>

        <section className="scalp-tape">
          <div className="scalp-panel-heading"><div><p className="eyebrow">TIME & SALES</p><h2>Лента сделок</h2></div><span>{tapeWindow.tradeCount} за 30с</span></div>
          <div className="tape-head"><span>Время</span><span>Цена</span><span>Размер</span></div>
          <div className="tape-list">
            {tape.slice(0, 40).map((trade) => <div key={trade.id} className={`tape-row ${trade.side.toLowerCase()}`}><span>{new Date(trade.time).toLocaleTimeString("ru-RU", { hour12: false })}</span><span>{formatPrice(trade.price)}</span><span>{fmtNumber(trade.size, 4)}</span></div>)}
            {!tape.length && <div className="scalp-empty">Ждём сделки Bybit…</div>}
          </div>
        </section>
      </div>

      <section className="scalp-control-panel">
        <div className="scalp-panel-heading"><div><p className="eyebrow">PAPER TRADING</p><h2>Виртуальное исполнение</h2></div><div className="scalp-control-toggles"><button className={`auto-scalp-toggle ${settings.riskLockEnabled ? "enabled" : ""}`} onClick={() => setSettings((current) => ({ ...current, riskLockEnabled: !current.riskLockEnabled }))}>Стоп-лимит: {settings.riskLockEnabled ? "ВКЛ" : "ВЫКЛ"}</button><button className={`auto-scalp-toggle ${settings.autoTrading ? "enabled" : ""}`} onClick={() => setSettings((current) => ({ ...current, autoTrading: !current.autoTrading }))}>Авто: {settings.autoTrading ? "ВКЛ" : "ВЫКЛ"}</button></div></div>
        <div className="scalp-settings">
          <label><span>Риск на сделку, %</span><input type="number" min="0.02" max="0.5" step="0.01" value={settings.riskPct} onChange={(event) => setSettings((current) => ({ ...current, riskPct: Number(event.target.value) }))} /></label>
          <label><span>Стоп, %</span><input type="number" min="0.05" max="1" step="0.01" value={settings.stopPct} onChange={(event) => setSettings((current) => ({ ...current, stopPct: Number(event.target.value) }))} /></label>
          <label><span>Цель, %</span><input type="number" min="0.05" max="2" step="0.01" value={settings.targetPct} onChange={(event) => setSettings((current) => ({ ...current, targetPct: Number(event.target.value) }))} /></label>
          <label title="Рыночное исполнение: комиссия taker с каждой стороны"><span>Taker, б.п.</span><input type="number" min="0.1" max="20" step="0.1" value={settings.feeBps} onChange={(event) => setSettings((current) => ({ ...current, feeBps: Math.max(0.1, Number(event.target.value) || DEFAULT_SETTINGS.feeBps) }))} /></label>
          <label><span>Макс. время, мин</span><input type="number" min="5" max="240" step="5" value={settings.maxDurationMinutes} onChange={(event) => setSettings((current) => ({ ...current, maxDurationMinutes: Number(event.target.value) }))} /></label>
        </div>
        <div className="scalp-actions"><button className="long" disabled={riskLocked || connection !== "LIVE" || feedSymbol !== symbol} onClick={() => openPosition("LONG")}>Открыть LONG</button><button className="short" disabled={riskLocked || connection !== "LIVE" || feedSymbol !== symbol} onClick={() => openPosition("SHORT")}>Открыть SHORT</button><span>Чистое прибыль/риск ≈ {fmtNumber(tradeEconomics.ratio, 2)}:1 · безубыточность {fmtNumber(tradeEconomics.breakEvenWinRate, 1)}% · минимальная цель {fmtNumber(minimumTargetPct, 2)}%.</span></div>
        {riskLocked && <p className="scalp-risk-lock">СТОП ТОРГОВЛИ: {risk.reason}</p>}
        {notice && <p className="scalp-notice">{notice}<button onClick={() => setNotice(null)}>×</button></p>}
      </section>

      <section className="scalp-journal">
        <div className="scalp-journal-summary">
          <div><p className="eyebrow">ЖУРНАЛ СКАЛЬПИНГА · {journalStorage === "D1" ? "БАЗА" : journalStorage === "LOCAL" ? "ЛОКАЛЬНО" : "СИНХРОНИЗАЦИЯ"}</p><h2>Отдельная статистика стратегии</h2>{legacyFeeTrades.length > 0 && <small>Старая комиссия восстановлена расчётно: −{fmtNumber(missingLegacyFees)} USDT в {legacyFeeTrades.length} сделках</small>}</div>
          <span title="Только автоматические сделки новой микроструктурной логики"><small>Микро v4.1</small><b>{performance.currentVersion.winRatePct == null ? "Ждём" : `${fmtNumber(performance.currentVersion.winRatePct, 1)}%`}</b><small>{performance.currentVersion.wins}W / {performance.currentVersion.losses}L</small></span>
          <span title="Отдельная статистика отскоков от устойчивой плотности"><small>Плотность</small><b>{performance.byStrategy.densityBounce.winRatePct == null ? "Ждём" : `${fmtNumber(performance.byStrategy.densityBounce.winRatePct, 1)}%`}</b><small>{performance.byStrategy.densityBounce.wins}W / {performance.byStrategy.densityBounce.losses}L</small></span>
          <span title="Отдельная статистика импульсных пробоев"><small>Пробой</small><b>{performance.byStrategy.impulseBreakout.winRatePct == null ? "Ждём" : `${fmtNumber(performance.byStrategy.impulseBreakout.winRatePct, 1)}%`}</b><small>{performance.byStrategy.impulseBreakout.wins}W / {performance.byStrategy.impulseBreakout.losses}L</small></span>
          <span title="Скользящее окно обновляется после каждой закрытой автоматической сделки"><small>Последние 20</small><b>{performance.recent.winRatePct == null ? "—" : `${fmtNumber(performance.recent.winRatePct, 1)}%`}</b><small>{performance.recent.wins}W / {performance.recent.losses}L</small></span>
          <span><small>Вся история</small><b>{performance.allTime.winRatePct == null ? "—" : `${fmtNumber(performance.allTime.winRatePct, 1)}%`}</b><small>{performance.allTime.wins}W / {performance.allTime.losses}L · авто</small></span>
          <span><small>PnL v4.1</small><b className={performance.currentVersion.pnl >= 0 ? "positive" : "negative"}>{performance.currentVersion.pnl >= 0 ? "+" : ""}{fmtNumber(performance.currentVersion.pnl)} USDT</b><small>PF {performance.currentVersion.profitFactor === Infinity ? "∞" : performance.currentVersion.profitFactor == null ? "—" : fmtNumber(performance.currentVersion.profitFactor, 2)}</small></span>
          <span><small>Сегодня · авто</small><b className={performance.today.pnl >= 0 ? "positive" : "negative"}>{performance.today.pnl >= 0 ? "+" : ""}{fmtNumber(performance.today.pnl)} USDT</b><small>{performance.today.winRatePct == null ? "нет закрытий" : `${fmtNumber(performance.today.winRatePct, 1)}% · ${performance.today.total} сделок`}</small></span>
          <div className="scalp-journal-tabs"><button className={journalView === "active" ? "selected" : ""} onClick={() => setJournalView("active")}>Активные {activeTrades.length}</button><button className={journalView === "closed" ? "selected" : ""} onClick={() => setJournalView("closed")}>Завершённые {closedTradesAll.length}</button></div>
        </div>
        <div className="scalp-journal-table">
          <div className="scalp-journal-row head"><span>Инструмент</span><span>Вход</span><span>Размер</span><span>TP / SL</span><span>PnL / факт</span><span>Выход / длительность</span><span>Действие</span></div>
          {visibleJournal.map((trade) => {
            const quote = backgroundQuotes[trade.symbol as ScalpSymbol];
            const tradeFeeBps = trade.signalSnapshot?.feeBps ?? settings.feeBps;
            const liveMark = quote?.bid && quote?.ask ? markScalpTrade(trade, quote.bid, quote.ask, tradeFeeBps) : null;
            const displayedPnl = trade.status === "OPEN" ? liveMark?.pnl ?? null : feeAdjustedScalpPnl(trade, settings.feeBps);
            const displayedPct = trade.status === "OPEN" ? liveMark?.pnlPct ?? null : trade.pnlPct ?? null;
            const missingFee = estimatedMissingScalpFees(trade, settings.feeBps);
            const durationMinutes = scalpTradeDurationMinutes(trade);
            const exitOrMark = trade.status === "CLOSED" ? trade.exitPrice : liveMark?.markPrice;
            return <div className={`scalp-journal-row ${trade.validity === "INVALID_LEGACY" ? "invalid" : ""}`} key={trade.id} title={trade.invalidReason}>
              <span><strong>{trade.symbol}</strong><small>{trade.side} · {trade.entryMode === "AUTO" ? "авто" : "вручную"}{trade.validity === "INVALID_LEGACY" ? " · ОШИБКА" : ""}</small><small>{scalpStrategyLabel(trade.signalSnapshot?.strategyId)}</small></span>
              <span><strong>{formatPrice(trade.entryPrice)}</strong><small>{fmtTime(trade.openedAt)}</small></span>
              <span><strong>{fmtNumber(trade.notional)} USDT</strong><small>{fmtNumber(trade.quantity, 5)} мон.</small></span>
              <span><strong className="positive">{formatPrice(trade.targetPrice)}</strong><small className="negative">{formatPrice(trade.stopPrice)}</small></span>
              <span><strong className={Number(displayedPnl ?? 0) >= 0 ? "positive" : "negative"}>{displayedPnl == null ? "Ждём цену" : `${displayedPnl >= 0 ? "+" : ""}${fmtNumber(displayedPnl)} USDT`}</strong><small>{trade.validity === "INVALID_LEGACY" ? "не входит в статистику" : missingFee > 0 ? `≈ с taker · записано ${Number(trade.pnl ?? 0) >= 0 ? "+" : ""}${fmtNumber(Number(trade.pnl ?? 0))}` : displayedPct == null ? "—" : `${displayedPct >= 0 ? "+" : ""}${fmtNumber(displayedPct, 2)}%`}</small></span>
              <span><strong>{formatPrice(exitOrMark)}</strong><small>{trade.status === "CLOSED" ? `Выход ${fmtTime(trade.closedAt ?? 0)}` : "текущий bid/ask"} · {durationMinutes} мин</small></span>
              <span>{trade.status === "OPEN" ? <button onClick={() => closePosition(trade.id)}>Закрыть</button> : <><b>{trade.exitReason ?? "—"}</b><small>{trade.signalSnapshot ? `RR ${fmtNumber(trade.signalSnapshot.netRewardRisk, 2)} · ${trade.signalSnapshot.pattern1m ?? "без модели"}` : "старая запись"}</small>{trade.maxFavorablePct != null && trade.maxAdversePct != null && <small>MFE +{fmtNumber(trade.maxFavorablePct, 2)}% · MAE {fmtNumber(trade.maxAdversePct, 2)}%</small>}</>}</span>
            </div>;
          })}
          {!visibleJournal.length && <div className="scalp-empty">{journalView === "active" ? "Активных скальп‑позиций нет" : "Завершённых скальп‑сделок пока нет"}</div>}
        </div>
        <div className="scalp-diagnostics">
          <article><small>Проверяемый снимок</small><strong>{snapshotTrades.length} / {closedTrades.length}</strong><span>параметры сигнала сохранены · ошибок исключено {invalidTrades.length}</span></article>
          <article><small>15м согласован · тень</small><strong>{diagnosticWinRate(aligned15mTrades) == null ? "нужна выборка" : `${fmtNumber(diagnosticWinRate(aligned15mTrades) ?? 0, 1)}%`}</strong><span>{aligned15mTrades.length} сделок</span></article>
          <article><small>Нисон согласован · тень</small><strong>{diagnosticWinRate(alignedNisonTrades) == null ? "нужна выборка" : `${fmtNumber(diagnosticWinRate(alignedNisonTrades) ?? 0, 1)}%`}</strong><span>{alignedNisonTrades.length} сделок</span></article>
          <article><small>В лимите времени</small><strong>{closedTrades.length ? `${fmtNumber(withinDurationTrades.length / closedTrades.length * 100, 1)}%` : "—"}</strong><span>{withinDurationTrades.length} из {closedTrades.length}</span></article>
        </div>
        <p className="scalp-footnote">Фоновый PAPER‑движок контролирует {scalpSymbols.length} инструментов по живому bid/ask. Автовход v4.1 разрешён только от устойчивой крупной плотности при согласованном 15м контексте и без встречной подтверждённой модели Нисона; импульсный пробой временно оставлен в тени. Исчезновение плотности закрывает позицию, повторный вход после SL блокируется. Реальные ордера не отправляются.</p>
      </section>
    </div>
  );
}
