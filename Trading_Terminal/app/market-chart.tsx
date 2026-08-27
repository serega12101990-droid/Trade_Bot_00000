"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { findImpulse, formatCompact, formatPrice, indicators } from "./terminal-math";
import type { Candle, CandlestickPattern, ForecastProjection, ForecastScenario, SignalIdea, TradeMarker } from "./terminal-types";
import { estimateVolumeBalance } from "./volume-balance";

type Props = {
  candles: Candle[];
  enabled: Set<string>;
  signal?: SignalIdea | null;
  signalIsStale?: boolean;
  forecast?: ForecastProjection | null;
  pattern?: CandlestickPattern | null;
  possiblePattern?: CandlestickPattern | null;
  trades: TradeMarker[];
  timezone: string;
};

const DEFAULT_VISIBLE_CANDLES = 128;
const DEFAULT_MACD_HEIGHT = 98;
const MIN_MACD_HEIGHT = 56;
const MAX_MACD_HEIGHT = 280;

function futureLimitFor(count: number) {
  return Math.max(0, count - 1);
}

function defaultFutureSlots(count = DEFAULT_VISIBLE_CANDLES) {
  return Math.max(24, Math.round(count * 0.28));
}

export function panViewport(offset: number, futureSlots: number, bars: number, count: number, candleCount: number) {
  const position = offset - futureSlots + bars;
  if (position < 0) {
    return { offset: 0, futureSlots: Math.min(-position, futureLimitFor(count)) };
  }
  return {
    offset: Math.min(position, Math.max(0, candleCount - count)),
    futureSlots: 0,
  };
}

export type ForecastVisualCandle = {
  index: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export function buildForecastCandles(
  scenario: ForecastScenario,
  atr: number,
  bandLow: number[] = [],
  bandHigh: number[] = [],
): ForecastVisualCandle[] {
  const phase = scenario.id === "bull" ? 0.45 : scenario.id === "bear" ? 2.35 : 1.3;
  let previousVisualClose = scenario.path[0] ?? scenario.target;
  return scenario.path.slice(1).map((centerClose, offset) => {
    const index = offset + 1;
    const progress = index / Math.max(1, scenario.path.length - 1);
    const upperLimit = bandHigh[index];
    const lowerLimit = bandLow[index];
    const centerWave = index === scenario.path.length - 1
      ? 0
      : Math.sin(index * 2.17 + phase) * Math.abs(atr) * 0.085 * (1 - progress * 0.45);
    const rawClose = centerClose + centerWave;
    const close = Number.isFinite(upperLimit) && Number.isFinite(lowerLimit)
      ? Math.min(upperLimit, Math.max(lowerLimit, rawClose))
      : rawClose;
    const open = previousVisualClose;
    previousVisualClose = close;
    const body = Math.abs(close - open);
    const volatility = Math.max(Math.abs(atr) * (0.055 + index * 0.004), body * 0.38, Math.abs(close) * 0.00008);
    const upperWick = volatility * (0.62 + Math.abs(Math.sin(index * 1.73 + phase)) * 0.5);
    const lowerWick = volatility * (0.62 + Math.abs(Math.cos(index * 1.37 + phase)) * 0.5);
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const high = Math.max(bodyHigh, Number.isFinite(upperLimit) ? Math.min(bodyHigh + upperWick, upperLimit) : bodyHigh + upperWick);
    const low = Math.min(bodyLow, Number.isFinite(lowerLimit) ? Math.max(bodyLow - lowerWick, lowerLimit) : bodyLow - lowerWick);
    return { index, open, high, low, close };
  });
}

type DragMode = "pan" | "volume-select" | "price-scale" | "macd-scale" | "time-scale" | "pane-resize" | "future-resize";

type DragState = {
  mode: DragMode;
  pointerId: number;
  x: number;
  y: number;
  offset: number;
  priceShift: number;
  priceScale: number;
  macdScale: number;
  visibleCount: number;
  macdHeight: number;
  futureSlots: number;
  selectionAnchor?: number;
};

const COLORS = {
  grid: "rgba(151, 166, 186, .11)",
  text: "#8793a8",
  bull: "#38d39f",
  bear: "#ff5d73",
  ema20: "#5de08c",
  ema50: "#9178ff",
  ema200: "#ff6c6c",
  macd: "#4ddfbd",
  signal: "#ff9b54",
};

function drawTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: "left" | "right" = "right",
) {
  ctx.font = "600 11px Inter, Segoe UI, sans-serif";
  const width = ctx.measureText(text).width + 12;
  const left = align === "right" ? x - width : x;
  ctx.fillStyle = color;
  ctx.fillRect(left, y - 9, width, 18);
  ctx.fillStyle = "#07110f";
  ctx.textAlign = "left";
  ctx.fillText(text, left + 6, y + 4);
}

export function MarketChart({ candles, enabled, signal, signalIsStale = false, forecast, pattern, possiblePattern, trades, timezone }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 960, height: 540 });
  const [hover, setHover] = useState<number | null>(null);
  const [cursorPoint, setCursorPoint] = useState<{ x: number; y: number; slotIndex: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_CANDLES);
  const [rightOffset, setRightOffset] = useState(0);
  const [futureSlots, setFutureSlots] = useState(() => forecast ? defaultFutureSlots() : 0);
  const [scenarioSpaceVisible, setScenarioSpaceVisible] = useState(Boolean(forecast));
  const [priceShift, setPriceShift] = useState(0);
  const [priceScale, setPriceScale] = useState(1);
  const [macdScale, setMacdScale] = useState(1);
  const [macdHeight, setMacdHeight] = useState(DEFAULT_MACD_HEIGHT);
  const [showPatternLabels, setShowPatternLabels] = useState(false);
  const [volumeSelectMode, setVolumeSelectMode] = useState(false);
  const [volumeSelection, setVolumeSelection] = useState<{ start: number; end: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [cursorMode, setCursorMode] = useState<DragMode>("pan");
  const dragRef = useRef<DragState | null>(null);
  const pack = useMemo(() => indicators(candles), [candles]);
  const selectedVolumeBalance = useMemo(() => {
    if (!volumeSelection) return null;
    const start = Math.max(0, Math.min(volumeSelection.start, volumeSelection.end));
    const end = Math.min(candles.length - 1, Math.max(volumeSelection.start, volumeSelection.end));
    return estimateVolumeBalance(candles.slice(start, end + 1));
  }, [candles, volumeSelection]);
  const viewport = useMemo(() => {
    const count = Math.min(Math.max(30, visibleCount), Math.max(1, candles.length));
    const maxFuture = futureLimitFor(count);
    const reservedFuture = Math.min(Math.max(0, futureSlots), maxFuture);
    const dataCapacity = Math.max(1, count - reservedFuture);
    const maxOffset = Math.max(0, candles.length - dataCapacity);
    const offset = Math.min(Math.max(0, rightOffset), maxOffset);
    const end = Math.max(0, candles.length - offset);
    const start = Math.max(0, end - dataCapacity);
    return { start, end, count, dataCount: end - start, futureSlots: reservedFuture, offset, maxOffset, maxFuture };
  }, [candles.length, futureSlots, rightOffset, visibleCount]);
  const geometry = useMemo(() => {
    const macdBottom = size.height - 26;
    const macdTop = macdBottom - macdHeight;
    const separator = macdTop - 17;
    return {
      left: 12,
      right: size.width - 68,
      priceTop: 18,
      priceBottom: macdTop - 34,
      volumeTop: Math.max(110, macdTop - 106),
      macdTop,
      macdBottom,
      separator,
    };
  }, [macdHeight, size.height, size.width]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.max(520, Math.floor(entry.contentRect.width)), height: 540 });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !candles.length) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);

    const width = size.width;
    const height = size.height;
    const { priceTop, priceBottom, volumeTop, macdTop, macdBottom, left, right, separator } = geometry;
    const { count, start, end } = viewport;
    const visible = candles.slice(start, end);
    const slot = (right - left) / Math.max(1, count);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0a1018";
    ctx.fillRect(0, 0, width, height);

    const priceValues = visible.flatMap((item) => [item.high, item.low]);
    const signalMarkerValues = viewport.offset === 0 && !signalIsStale
      ? [signal?.entryLow, signal?.entryHigh, signal?.target1, signal?.invalidation].filter(
          (value): value is number => typeof value === "number" && Number.isFinite(value),
        )
      : [];
    const forecastMarkerValues = viewport.offset === 0 && scenarioSpaceVisible && forecast
      ? [...forecast.bandLow, ...forecast.bandHigh, ...forecast.scenarios.flatMap((scenario) => scenario.path)]
      : [];
    const openPositionValues = viewport.offset === 0
      ? trades
        .filter((trade) => trade.status === "OPEN")
        .flatMap((trade) => [trade.entry, trade.target, trade.stop])
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    const rawMin = Math.min(...priceValues, ...signalMarkerValues, ...forecastMarkerValues, ...openPositionValues);
    const rawMax = Math.max(...priceValues, ...signalMarkerValues, ...forecastMarkerValues, ...openPositionValues);
    const padding = Math.max((rawMax - rawMin) * 0.08, rawMax * 0.002);
    const autoMin = rawMin - padding;
    const autoMax = rawMax + padding;
    const autoRange = Math.max(autoMax - autoMin, Number.EPSILON);
    const center = (autoMin + autoMax) / 2 + priceShift * autoRange;
    const priceRange = autoRange * priceScale;
    const minPrice = center - priceRange / 2;
    const maxPrice = center + priceRange / 2;
    const priceY = (value: number) =>
      priceBottom - ((value - minPrice) / Math.max(maxPrice - minPrice, Number.EPSILON)) * (priceBottom - priceTop);
    const candleX = (index: number) => left + (index - start + 0.5) * slot;
    const fallbackInterval = end >= 2
      ? Math.max(60_000, candles[end - 1].time - candles[end - 2].time)
      : 60 * 60 * 1000;
    const timeAtSlot = (slotIndex: number) => {
      if (slotIndex < visible.length) return visible[slotIndex]?.time ?? 0;
      if (forecast?.projectedTimes?.length && viewport.futureSlots > 0) {
        const futureIndex = slotIndex - visible.length + 1;
        const projectionIndex = Math.min(
          forecast.horizonBars,
          Math.max(1, Math.ceil((futureIndex / viewport.futureSlots) * forecast.horizonBars)),
        );
        return forecast.projectedTimes[projectionIndex] ?? forecast.projectedTimes.at(-1) ?? forecast.asofTime;
      }
      const lastTime = visible.at(-1)?.time ?? candles.at(-1)?.time ?? 0;
      return lastTime + (slotIndex - visible.length + 1) * fallbackInterval;
    };

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.font = "11px Inter, Segoe UI, sans-serif";
    ctx.fillStyle = COLORS.text;
    for (let line = 0; line <= 5; line += 1) {
      const y = priceTop + ((priceBottom - priceTop) / 5) * line;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      const value = maxPrice - ((maxPrice - minPrice) / 5) * line;
      ctx.textAlign = "left";
      ctx.fillText(formatPrice(value), right + 10, y + 4);
    }
    for (let line = 0; line <= 6; line += 1) {
      const x = left + ((right - left) / 6) * line;
      ctx.beginPath();
      ctx.moveTo(x, priceTop);
      ctx.lineTo(x, macdBottom);
      ctx.stroke();
      const slotIndex = Math.min(count - 1, Math.floor((count / 6) * line));
      const date = new Date(timeAtSlot(slotIndex));
      ctx.textAlign = line === 6 ? "right" : "center";
      ctx.fillText(
        date.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", timeZone: timezone }),
        line === 6 ? right : x,
        height - 6,
      );
    }

    if (viewport.futureSlots > 0 && scenarioSpaceVisible) {
      const futureX = Math.max(left, right - viewport.futureSlots * slot);
      ctx.fillStyle = "rgba(100, 200, 255, .025)";
      ctx.fillRect(futureX, priceTop, right - futureX, macdBottom - priceTop);
      ctx.strokeStyle = "rgba(100, 200, 255, .22)";
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(futureX, priceTop);
      ctx.lineTo(futureX, macdBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(117, 167, 198, .72)";
      ctx.textAlign = "left";
      ctx.font = "9px Inter, Segoe UI, sans-serif";
      ctx.fillText("ПРОГНОЗНЫЕ СВЕЧИ · МОДЕЛЬ, НЕ КОТИРОВКИ", Math.min(right - 245, futureX + 8), priceTop + 15);
      if (forecast) {
        ctx.fillStyle = forecast.decision === "READY" ? "rgba(56, 211, 159, .9)" : forecast.decision === "WAIT_CONFIRMATION" ? "rgba(242, 184, 75, .9)" : "rgba(255, 143, 158, .86)";
        ctx.font = "600 9px Inter, Segoe UI, sans-serif";
        const direction = forecast.primary === "BULL" ? "РОСТ" : forecast.primary === "BEAR" ? "СНИЖЕНИЕ" : "БОКОВИК";
        const decision = forecast.decision === "READY" ? "КАНДИДАТ" : forecast.decision === "WAIT_CONFIRMATION" ? "ЖДЁМ ПОДТВЕРЖДЕНИЕ" : "БЕЗ СДЕЛКИ";
        ctx.fillText(`${decision}: ${direction} · ${forecast.primaryWeight}% · Δ ${forecast.edgeMargin} п.п.`, Math.min(right - 280, futureX + 8), priceTop + 31);
      }
      if (signal && signalIsStale) {
        ctx.fillStyle = "rgba(242, 184, 75, .82)";
        ctx.font = "600 9px Inter, Segoe UI, sans-serif";
        ctx.fillText("УСТАРЕВШИЕ ENTRY / TP / SL СКРЫТЫ", Math.min(right - 210, futureX + 8), priceTop + (forecast ? 47 : 31));
      } else if (signal && enabled.has("mtf-entry")) {
        ctx.fillStyle = "rgba(100, 200, 255, .72)";
        ctx.font = "600 9px Inter, Segoe UI, sans-serif";
        ctx.fillText(`УРОВНИ ${signal.direction ?? "WATCH"} · НЕ ОТКРЫТАЯ СДЕЛКА`, Math.min(right - 230, futureX + 8), priceTop + (forecast ? 47 : 31));
      }
    }

    const separatorActive = cursorMode === "pane-resize" || dragRef.current?.mode === "pane-resize";
    ctx.fillStyle = separatorActive ? "rgba(77, 223, 189, .12)" : "rgba(135, 147, 168, .035)";
    ctx.fillRect(left, separator - 7, right - left, 14);
    ctx.strokeStyle = separatorActive ? "rgba(77, 223, 189, .72)" : "rgba(135, 147, 168, .34)";
    ctx.beginPath();
    ctx.moveTo(left, separator);
    ctx.lineTo(right, separator);
    ctx.stroke();
    const separatorHandleWidth = 58;
    const separatorHandleLeft = (left + right - separatorHandleWidth) / 2;
    ctx.fillStyle = separatorActive ? "rgba(77, 223, 189, .88)" : "rgba(135, 147, 168, .72)";
    ctx.fillRect(separatorHandleLeft, separator - 2, separatorHandleWidth, 4);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, priceTop, right - left, priceBottom - priceTop);
    ctx.clip();

    if (volumeSelection) {
      const selectionStart = Math.max(start, Math.min(volumeSelection.start, volumeSelection.end));
      const selectionEnd = Math.min(end - 1, Math.max(volumeSelection.start, volumeSelection.end));
      if (selectionStart <= selectionEnd) {
        const selectionLeft = Math.max(left, candleX(selectionStart) - slot * 0.48);
        const selectionRight = Math.min(right, candleX(selectionEnd) + slot * 0.48);
        ctx.fillStyle = "rgba(100, 200, 255, .085)";
        ctx.fillRect(selectionLeft, priceTop, selectionRight - selectionLeft, priceBottom - priceTop);
        ctx.strokeStyle = "rgba(100, 200, 255, .72)";
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(selectionLeft, priceTop + 1, selectionRight - selectionLeft, priceBottom - priceTop - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(100, 200, 255, .92)";
        ctx.font = "700 9px Inter, Segoe UI, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`${Math.abs(volumeSelection.end - volumeSelection.start) + 1} свеч. · баланс объёма`, selectionLeft + 6, priceTop + 14);
      }
    }

    const maxVolume = Math.max(...visible.map((item) => item.volume), 1);
    visible.forEach((item, localIndex) => {
      const x = left + (localIndex + 0.5) * slot;
      const openY = priceY(item.open);
      const closeY = priceY(item.close);
      const highY = priceY(item.high);
      const lowY = priceY(item.low);
      const color = item.close >= item.open ? COLORS.bull : COLORS.bear;
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1.4, Math.abs(closeY - openY));
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();
      ctx.fillRect(x - Math.max(1, slot * 0.31), bodyTop, Math.max(2, slot * 0.62), bodyHeight);

      const volumeHeight = (item.volume / maxVolume) * (priceBottom - volumeTop);
      ctx.globalAlpha = 0.22;
      ctx.fillRect(x - Math.max(1, slot * 0.34), priceBottom - volumeHeight, Math.max(2, slot * 0.68), volumeHeight);
      ctx.globalAlpha = 1;
    });

    if (forecast?.vpa && forecast.vpa.event !== "NEUTRAL") {
      const vpaIndex = candles.findIndex((candle) => candle.time === forecast.vpa?.asofTime);
      if (vpaIndex >= start && vpaIndex < end) {
        const candle = candles[vpaIndex];
        const x = candleX(vpaIndex);
        const top = Math.max(priceTop + 3, priceY(candle.high) - 9);
        const bottom = Math.min(priceBottom - 2, priceY(candle.low) + 9);
        const color = forecast.vpa.alignment === "CONFIRMS" ? "#9ee66f" : forecast.vpa.alignment === "CONFLICTS" ? "#ff8193" : "#8ba0b7";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(x - Math.max(4, slot * 0.43), top, Math.max(8, slot * 0.86), Math.max(12, bottom - top));
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.78;
        ctx.font = "700 8px Inter, Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("VPA", x, Math.max(priceTop + 9, top - 3));
        ctx.globalAlpha = 1;
      }
    }

    [pattern, possiblePattern].filter((item): item is CandlestickPattern => Boolean(item)).forEach((visiblePattern) => {
      const patternStartIndex = candles.findIndex((candle) => candle.time === visiblePattern.startTime);
      const patternEndIndex = candles.findIndex((candle) => candle.time === visiblePattern.endTime);
      if (patternStartIndex >= start && patternEndIndex >= patternStartIndex && patternEndIndex < end) {
        const pair = candles.slice(patternStartIndex, patternEndIndex + 1);
        const patternHigh = Math.max(...pair.map((candle) => candle.high));
        const patternLow = Math.min(...pair.map((candle) => candle.low));
        const leftX = candleX(patternStartIndex) - slot * 0.46;
        const rightX = candleX(patternEndIndex) + slot * 0.46;
        const topY = Math.max(priceTop + 3, priceY(patternHigh) - 12);
        const bottomY = Math.min(priceBottom - 2, priceY(patternLow) + 9);
        const patternColor = visiblePattern === possiblePattern
          ? "#67c7ff"
          : visiblePattern.status === "CONFIRMED"
          ? COLORS.bull
          : visiblePattern.status === "INVALIDATED"
            ? COLORS.bear
            : "#f2b84b";
        ctx.fillStyle = visiblePattern === possiblePattern ? "rgba(103,199,255,.07)" : visiblePattern.status === "CONFIRMED" ? "rgba(56,211,159,.08)" : visiblePattern.status === "INVALIDATED" ? "rgba(255,93,115,.07)" : "rgba(242,184,75,.08)";
        ctx.fillRect(leftX, topY, Math.max(slot, rightX - leftX), Math.max(12, bottomY - topY));
        ctx.strokeStyle = patternColor;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(leftX, topY, Math.max(slot, rightX - leftX), Math.max(12, bottomY - topY));
        ctx.setLineDash([]);
        if (showPatternLabels) {
          ctx.fillStyle = patternColor;
          ctx.globalAlpha = 0.58;
          ctx.font = "700 9px Inter, Segoe UI, sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(visiblePattern.label.toUpperCase(), leftX + 4, Math.min(bottomY - 3, topY + 11));
          ctx.globalAlpha = 1;
        }

        if (visiblePattern.confirmationTime) {
          const confirmationIndex = candles.findIndex((candle) => candle.time === visiblePattern.confirmationTime);
          if (confirmationIndex >= start && confirmationIndex < end) {
            const confirmationCandle = candles[confirmationIndex];
            const x = candleX(confirmationIndex);
            const y = visiblePattern.direction === "BEARISH" ? priceY(confirmationCandle.low) + 8 : priceY(confirmationCandle.high) - 8;
            ctx.fillStyle = patternColor;
            ctx.beginPath();
            ctx.arc(x, y, 3.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    });

    const drawSeries = (series: Array<number | null>, color: string, widthPx: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = widthPx;
      ctx.beginPath();
      let started = false;
      for (let index = start; index < end; index += 1) {
        const value = series[index];
        if (value == null) continue;
        const x = candleX(index);
        const y = priceY(value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    };
    drawSeries(pack.ema20, COLORS.ema20, 1.35);
    drawSeries(pack.ema50, COLORS.ema50, 1.25);
    drawSeries(pack.ema200, COLORS.ema200, 1.2);

    if (scenarioSpaceVisible && forecast && viewport.offset === 0 && viewport.futureSlots > 0) {
      const lastDataX = left + Math.max(0.5, visible.length - 0.5) * slot;
      const projectionRight = right - slot * 0.5;
      const projectionX = (index: number, length: number) => lastDataX + (index / Math.max(1, length - 1)) * (projectionRight - lastDataX);
      const bandLength = Math.min(forecast.bandLow.length, forecast.bandHigh.length);

      ctx.beginPath();
      forecast.bandHigh.slice(0, bandLength).forEach((value, index) => {
        const x = projectionX(index, bandLength);
        const y = priceY(value);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      [...forecast.bandLow.slice(0, bandLength)].reverse().forEach((value, reverseIndex) => {
        const index = bandLength - reverseIndex - 1;
        ctx.lineTo(projectionX(index, bandLength), priceY(value));
      });
      ctx.closePath();
      ctx.fillStyle = forecast.decision === "NO_TRADE" ? "rgba(135, 147, 168, .045)" : "rgba(100, 200, 255, .075)";
      ctx.fill();

      const scenarioColors = { bull: COLORS.bull, sideways: COLORS.signal, bear: COLORS.bear } as const;
      const orderedScenarios = [...forecast.scenarios].sort((leftScenario, rightScenario) => {
        const leftPrimary = leftScenario.direction === forecast.primary ? 1 : 0;
        const rightPrimary = rightScenario.direction === forecast.primary ? 1 : 0;
        return leftPrimary - rightPrimary;
      });
      orderedScenarios.forEach((scenario) => {
        const primary = scenario.direction === forecast.primary;
        const emphasized = primary && forecast.decision !== "NO_TRADE";
        const projectedCandles = buildForecastCandles(
          scenario,
          forecast.atr,
          primary ? forecast.bandLow : [],
          primary ? forecast.bandHigh : [],
        );
        const candleStep = (projectionRight - lastDataX) / Math.max(1, projectedCandles.length);
        const bodyWidth = Math.max(2, Math.min(emphasized ? 10 : 7, candleStep * (emphasized ? 0.58 : 0.38)));
        ctx.globalAlpha = emphasized ? (forecast.decision === "READY" ? 0.94 : 0.82) : forecast.decision === "NO_TRADE" ? 0.16 : 0.24;
        projectedCandles.forEach((projectedCandle, candleIndex) => {
          const x = lastDataX + (candleIndex + 0.5) * candleStep;
          const bullishCandle = projectedCandle.close >= projectedCandle.open;
          const candleColor = bullishCandle ? COLORS.bull : COLORS.bear;
          const wickTop = priceY(projectedCandle.high);
          const wickBottom = priceY(projectedCandle.low);
          const openY = priceY(projectedCandle.open);
          const closeY = priceY(projectedCandle.close);
          const bodyTop = Math.min(openY, closeY);
          const bodyHeight = Math.max(1.3, Math.abs(closeY - openY));
          ctx.strokeStyle = primary ? candleColor : scenarioColors[scenario.id];
          ctx.lineWidth = emphasized ? 1.2 : 0.8;
          ctx.beginPath();
          ctx.moveTo(x, wickTop);
          ctx.lineTo(x, wickBottom);
          ctx.stroke();
          ctx.fillStyle = primary ? candleColor : scenarioColors[scenario.id];
          if (primary) {
            ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
          } else {
            ctx.strokeRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
          }
        });
        const lastProjected = projectedCandles.at(-1);
        if (lastProjected) {
          const endY = priceY(lastProjected.close);
          ctx.fillStyle = scenarioColors[scenario.id];
          ctx.font = `${emphasized ? "700" : "500"} 9px Inter, Segoe UI, sans-serif`;
          ctx.textAlign = "right";
          ctx.fillText(`${primary ? "ОСНОВНОЙ · " : ""}${scenario.label} ${scenario.weight}%`, projectionRight - 4, endY - 7);
        }
        ctx.globalAlpha = 1;
      });
      ctx.lineWidth = 1;
    }

    if (enabled.has("ema-corridor")) {
      const latestIndex = end - 1;
      const values = [
        { label: "EMA20", value: pack.ema20[latestIndex] },
        { label: "EMA50", value: pack.ema50[latestIndex] },
        { label: "EMA200", value: pack.ema200[latestIndex] },
      ].filter((item): item is { label: string; value: number } => item.value != null);
      let gap: { a: typeof values[number]; b: typeof values[number] } | null = null;
      values.forEach((a, index) => {
        values.slice(index + 1).forEach((b) => {
          if (!gap || Math.abs(a.value - b.value) > Math.abs(gap.a.value - gap.b.value)) gap = { a, b };
        });
      });
      if (gap) {
        const resolvedGap = gap as { a: { label: string; value: number }; b: { label: string; value: number } };
        const top = priceY(Math.max(resolvedGap.a.value, resolvedGap.b.value));
        const bottom = priceY(Math.min(resolvedGap.a.value, resolvedGap.b.value));
        const actualRight = Math.min(right, left + visible.length * slot);
        const corridorLeft = Math.max(left, actualRight - slot * 32);
        const corridorWidth = Math.max(0, actualRight - corridorLeft);
        ctx.fillStyle = "rgba(56, 211, 159, .07)";
        ctx.fillRect(corridorLeft, top, corridorWidth, bottom - top);
        ctx.strokeStyle = "rgba(56, 211, 159, .34)";
        ctx.setLineDash([4, 5]);
        ctx.strokeRect(corridorLeft, top, corridorWidth, bottom - top);
        ctx.setLineDash([]);
        ctx.fillStyle = "#75dcb8";
        ctx.textAlign = "left";
        ctx.fillText(`${resolvedGap.a.label} ↔ ${resolvedGap.b.label}`, corridorLeft + 5, top + 15);
      }
    }

    if (enabled.has("impulse-zone")) {
      const impulse = findImpulse(candles.slice(0, end));
      if (impulse && impulse.index >= start) {
        const x = candleX(impulse.index);
        const y = priceY(impulse.midpoint);
        ctx.strokeStyle = impulse.direction === "up" ? "rgba(56,211,159,.75)" : "rgba(255,93,115,.75)";
        ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255, 211, 103, .9)";
        ctx.fillText("50% импульсной свечи", Math.min(right - 140, x + 8), y - 7);
      }
    }

    const horizontalMarker = (value: number | undefined, label: string, color: string) => {
      if (value == null || value < minPrice || value > maxPrice) return;
      const y = priceY(value);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.max(left, right - slot * 46), y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      drawTag(ctx, `${label} ${formatPrice(value)}`, right, y, color);
    };
    if (enabled.has("mtf-entry") && signal && !signalIsStale && viewport.offset === 0) {
      horizontalMarker(signal.entryLow, `ВХОД ${signal.direction ?? ""}`.trim(), "#64c8ff");
      horizontalMarker(signal.target1, "ЦЕЛЬ TP1", COLORS.bull);
      horizontalMarker(signal.invalidation, "ОТМЕНА SL", COLORS.bear);
    }
    if (enabled.has("ema-corridor") && forecast && viewport.offset === 0) {
      const route = forecast.strategyMatches.find((match) => match.id === "ema-corridor");
      route?.routeStages?.slice(0, 3).forEach((stage) => {
        const timeframe = stage.timeframe === "1m" ? "1м" : stage.timeframe === "5m" ? "5м" : stage.timeframe === "15m" ? "15м" : stage.timeframe === "30m" ? "30м" : stage.timeframe === "1h" ? "1ч" : stage.timeframe === "4h" ? "4ч" : stage.timeframe === "1d" ? "1д" : "1н";
        horizontalMarker(stage.suggestedTarget, `TP${stage.order} · ${timeframe} EMA${stage.ema}${stage.status === "LOCKED" ? " · ждёт пробой" : ""}`, stage.status === "ACTIVE" ? "#45d6ae" : "#7887a1");
      });
    }
    if (enabled.has("level-action") && forecast?.levelAction && viewport.offset === 0) {
      const levelAction = forecast.levelAction;
      const timeframe = levelAction.primaryLevel.timeframe === "1m" ? "1м" : levelAction.primaryLevel.timeframe === "5m" ? "5м" : levelAction.primaryLevel.timeframe === "15m" ? "15м" : levelAction.primaryLevel.timeframe === "30m" ? "30м" : levelAction.primaryLevel.timeframe === "1h" ? "1ч" : levelAction.primaryLevel.timeframe === "4h" ? "4ч" : levelAction.primaryLevel.timeframe === "1d" ? "1д" : "1н";
      horizontalMarker(levelAction.primaryLevel.price, `УРОВЕНЬ · ${timeframe} · ${levelAction.primaryLevel.strength}/100`, "#f0bd53");
      if (levelAction.nextObstacle) horizontalMarker(levelAction.nextObstacle.price, "СЛЕДУЮЩАЯ ПРЕГРАДА", "#b6924d");
      if (levelAction.quality !== "OBSERVE") {
        horizontalMarker(levelAction.targetPrice ?? undefined, "ТЕНЕВОЙ TP", "#d6ab51");
        horizontalMarker(levelAction.stopPrice ?? undefined, "ТЕНЕВОЙ SL", "#ad6672");
      }
    }

    if (viewport.offset === 0) {
      trades
        .filter((trade) => trade.status === "OPEN" && trade.entry != null)
        .forEach((trade) => {
          const entry = Number(trade.entry);
          if (!Number.isFinite(entry)) return;
          const longSide = /LONG|BUY/i.test(String(trade.side));
          const sideColor = longSide ? COLORS.bull : COLORS.bear;
          horizontalMarker(entry, `ПОЗИЦИЯ ${longSide ? "LONG" : "SHORT"} · ВХОД`, sideColor);
          horizontalMarker(trade.target, "ПОЗИЦИЯ · TP", COLORS.bull);
          horizontalMarker(trade.stop, "ПОЗИЦИЯ · SL", COLORS.bear);

          if (trade.time == null) return;
          let entryIndex = candles.findIndex((candle, index) => {
            const nextTime = candles[index + 1]?.time ?? Number.POSITIVE_INFINITY;
            return trade.time! >= candle.time && trade.time! < nextTime;
          });
          if (entryIndex < 0 && candles.length) {
            entryIndex = candles.reduce((nearest, candle, index) => (
              Math.abs(candle.time - trade.time!) < Math.abs(candles[nearest].time - trade.time!) ? index : nearest
            ), 0);
          }
          if (entryIndex < start || entryIndex >= end || entry < minPrice || entry > maxPrice) return;

          const x = candleX(entryIndex);
          const y = priceY(entry);
          ctx.strokeStyle = sideColor;
          ctx.globalAlpha = 0.72;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(x, priceTop);
          ctx.lineTo(x, priceBottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.fillStyle = sideColor;
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#07110f";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.lineWidth = 1;
          const entryTimeLabel = new Intl.DateTimeFormat("ru-RU", {
            timeZone: timezone,
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(trade.time));
          const entryLabel = `ВХОД ${longSide ? "LONG" : "SHORT"} · ${entryTimeLabel}`;
          const labelGoesLeft = x > right - 250;
          drawTag(
            ctx,
            entryLabel,
            labelGoesLeft ? x - 8 : x + 8,
            Math.max(priceTop + 13, y - 14),
            sideColor,
            labelGoesLeft ? "right" : "left",
          );
        });
    }

    trades
      .filter((trade) => trade.entry != null && trade.status !== "OPEN")
      .slice(-12)
      .forEach((trade) => {
        const value = Number(trade.entry);
        if (!Number.isFinite(value) || value < minPrice || value > maxPrice) return;
        const y = priceY(value);
        ctx.fillStyle = /LONG|BUY/i.test(String(trade.side)) ? COLORS.bull : COLORS.bear;
        ctx.beginPath();
        ctx.moveTo(right - 17, y);
        ctx.lineTo(right - 5, y - 6);
        ctx.lineTo(right - 5, y + 6);
        ctx.closePath();
        ctx.fill();
      });

    const rightmost = candles[end - 1];
    if (rightmost) {
      const latestY = priceY(rightmost.close);
      if (latestY >= priceTop && latestY <= priceBottom) {
        ctx.strokeStyle = "rgba(223, 232, 246, .28)";
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(left, latestY);
        ctx.lineTo(right, latestY);
        ctx.stroke();
        ctx.setLineDash([]);
        drawTag(ctx, `C ${formatPrice(rightmost.close)}`, right, latestY, "#dfe8f6");
      }
    }

    ctx.restore();

    const macdValues = pack.macd.slice(start, end).filter((value): value is number => value != null);
    const signalValues = pack.signal.slice(start, end).filter((value): value is number => value != null);
    const histValues = pack.histogram.slice(start, end).filter((value): value is number => value != null);
    const macdExtent = Math.max(...[...macdValues, ...signalValues, ...histValues].map(Math.abs), 0.0001);
    const displayedMacdExtent = macdExtent / macdScale;
    const macdY = (value: number) => (macdTop + macdBottom) / 2 - (value / displayedMacdExtent) * ((macdBottom - macdTop) * 0.43);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(left, macdY(0));
    ctx.lineTo(right, macdY(0));
    ctx.stroke();
    ctx.font = "10px Inter, Segoe UI, sans-serif";
    let macdLegendX = left;
    const macdTitle = "MACD 12 / 26 / 9";
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.fillText(macdTitle, macdLegendX, macdTop - 8);
    macdLegendX += ctx.measureText(macdTitle).width + 8;
    const macdLegendIndex = hover != null ? hover : end - 1;
    const latestMacd = pack.macd[macdLegendIndex];
    const latestSignal = pack.signal[macdLegendIndex];
    const latestHistogram = pack.histogram[macdLegendIndex];
    ([
      [latestMacd, COLORS.macd],
      [latestSignal, COLORS.signal],
      [latestHistogram, latestHistogram != null && latestHistogram < 0 ? COLORS.bear : COLORS.bull],
    ] as const).forEach(([value, color]) => {
      if (value == null) return;
      const label = formatPrice(value);
      ctx.fillStyle = color;
      ctx.fillText(label, macdLegendX, macdTop - 8);
      macdLegendX += ctx.measureText(label).width + 7;
    });
    [displayedMacdExtent, 0, -displayedMacdExtent].forEach((value) => {
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = "left";
      ctx.fillText(formatPrice(value), right + 10, macdY(value) + 4);
    });
    for (let index = start; index < end; index += 1) {
      const value = pack.histogram[index];
      if (value == null) continue;
      const x = candleX(index);
      const zero = macdY(0);
      const y = macdY(value);
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = value >= 0 ? COLORS.macd : COLORS.bear;
      ctx.fillRect(x - Math.max(1, slot * 0.31), Math.min(zero, y), Math.max(2, slot * 0.62), Math.max(1, Math.abs(zero - y)));
      ctx.globalAlpha = 1;
    }
    const drawMacdSeries = (series: Array<number | null>, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let started = false;
      for (let index = start; index < end; index += 1) {
        const value = series[index];
        if (value == null) continue;
        const x = candleX(index);
        const y = macdY(value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawMacdSeries(pack.macd, COLORS.macd);
    drawMacdSeries(pack.signal, COLORS.signal);

    if (cursorPoint) {
      const cursorX = Math.min(Math.max(left, cursorPoint.x), right);
      const cursorY = Math.min(Math.max(priceTop, cursorPoint.y), macdBottom);
      ctx.strokeStyle = "rgba(215,224,238,.48)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(cursorX, priceTop);
      ctx.lineTo(cursorX, macdBottom);
      if (cursorY <= priceBottom) {
        ctx.moveTo(left, cursorY);
        ctx.lineTo(right, cursorY);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (cursorY <= priceBottom) {
        const cursorPrice = maxPrice - ((cursorY - priceTop) / Math.max(1, priceBottom - priceTop)) * (maxPrice - minPrice);
        drawTag(ctx, formatPrice(cursorPrice), right, cursorY, "#c6d0dc");
      }

      const cursorTime = timeAtSlot(Math.min(count - 1, Math.max(0, cursorPoint.slotIndex)));
      const timeLabel = new Intl.DateTimeFormat("ru-RU", {
        timeZone: timezone,
        day: "2-digit",
        month: "short",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(cursorTime));
      ctx.font = "600 10px Inter, Segoe UI, sans-serif";
      const labelWidth = ctx.measureText(timeLabel).width + 14;
      const labelLeft = Math.min(Math.max(left, cursorX - labelWidth / 2), right - labelWidth);
      ctx.fillStyle = "#667487";
      ctx.fillRect(labelLeft, height - 24, labelWidth, 20);
      ctx.fillStyle = "#f2f5f8";
      ctx.textAlign = "left";
      ctx.fillText(timeLabel, labelLeft + 7, height - 10);
    }

  }, [candles, cursorMode, cursorPoint, enabled, forecast, geometry, hover, macdScale, pack, pattern, possiblePattern, priceScale, priceShift, scenarioSpaceVisible, showPatternLabels, signal, signalIsStale, size, timezone, trades, viewport, volumeSelection]);

  const activeIndex = hover != null ? hover : viewport.end - 1;
  const active = candles[activeIndex];
  const activeTime = active
    ? new Intl.DateTimeFormat("ru-RU", {
        timeZone: timezone,
        day: "2-digit",
        month: "short",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(active.time))
    : "—";
  const clampFuture = (value: number, count = viewport.count) =>
    Math.min(Math.max(0, value), futureLimitFor(count));
  const clampOffset = (value: number, count = viewport.count, reservedFuture = viewport.futureSlots) =>
    Math.min(Math.max(0, value), Math.max(0, candles.length - Math.max(1, count - reservedFuture)));
  const clampVisibleCount = (value: number) =>
    Math.min(Math.max(30, value), Math.min(260, Math.max(30, candles.length)));
  const clampPriceScale = (value: number) => Math.min(Math.max(0.25, value), 8);
  const hitTest = (x: number, y: number): DragMode => {
    const futureBoundary = geometry.right - viewport.futureSlots * ((geometry.right - geometry.left) / Math.max(1, viewport.count));
    if (viewport.futureSlots > 0 && Math.abs(x - futureBoundary) <= 9 && y <= geometry.macdBottom) return "future-resize";
    if (Math.abs(y - geometry.separator) <= 12 && x <= geometry.right) return "pane-resize";
    if (x >= geometry.right && y <= geometry.priceBottom) return "price-scale";
    if (x >= geometry.right && y >= geometry.macdTop && y < geometry.macdBottom) return "macd-scale";
    if (y >= geometry.macdBottom) return "time-scale";
    return volumeSelectMode && y >= geometry.priceTop && y <= geometry.priceBottom ? "volume-select" : "pan";
  };
  const candleIndexAtX = (x: number) => {
    if (x < geometry.left || x > geometry.right) return null;
    const chartX = Math.min(Math.max(x - geometry.left, 0), Math.max(1, geometry.right - geometry.left));
    const local = Math.min(viewport.count - 1, Math.max(0, Math.floor((chartX / Math.max(1, geometry.right - geometry.left)) * viewport.count)));
    return local < viewport.dataCount ? viewport.start + local : null;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (drag.mode === "volume-select") {
        const index = candleIndexAtX(x);
        if (index != null && drag.selectionAnchor != null) {
          setVolumeSelection({ start: drag.selectionAnchor, end: index });
          setHover(index);
          const local = index - viewport.start;
          setCursorPoint({
            x: geometry.left + (local + 0.5) * ((geometry.right - geometry.left) / Math.max(1, viewport.count)),
            y,
            slotIndex: local,
          });
        }
      } else if (drag.mode === "pan") {
        const count = Math.min(drag.visibleCount, Math.max(1, candles.length));
        const slot = Math.max(1, (geometry.right - geometry.left) / Math.max(1, count));
        const bars = Math.round(dx / slot);
        const next = panViewport(drag.offset, drag.futureSlots, bars, count, candles.length);
        setRightOffset(next.offset);
        setFutureSlots(next.futureSlots);
        if (drag.y - rect.top <= geometry.priceBottom) {
          const paneHeight = Math.max(1, geometry.priceBottom - geometry.priceTop);
          setPriceShift(drag.priceShift + (dy / paneHeight) * drag.priceScale);
        }
      } else if (drag.mode === "price-scale") {
        setPriceScale(clampPriceScale(drag.priceScale * Math.exp(dy / 180)));
      } else if (drag.mode === "macd-scale") {
        setMacdScale(Math.min(Math.max(0.25, drag.macdScale * Math.exp(-dy / 180)), 8));
      } else if (drag.mode === "time-scale") {
        const nextCount = clampVisibleCount(drag.visibleCount + Math.round(dx / 3));
        const nextFuture = clampFuture(drag.futureSlots, nextCount);
        setVisibleCount(nextCount);
        setFutureSlots(nextFuture);
        setRightOffset((value) => clampOffset(value, nextCount, nextFuture));
      } else if (drag.mode === "pane-resize") {
        setMacdHeight(Math.min(Math.max(MIN_MACD_HEIGHT, drag.macdHeight - dy), MAX_MACD_HEIGHT));
      } else {
        const count = Math.min(drag.visibleCount, Math.max(1, candles.length));
        const slot = Math.max(1, (geometry.right - geometry.left) / Math.max(1, count));
        const nextFuture = clampFuture(drag.futureSlots - Math.round(dx / slot), count);
        setFutureSlots(nextFuture);
      }
      if (drag.mode !== "volume-select") {
        setHover(null);
        setCursorPoint(null);
      }
      return;
    }
    const mode = hitTest(x, y);
    setCursorMode(mode);
    if (mode !== "pan" || x < geometry.left || x > geometry.right || y < geometry.priceTop || y > geometry.macdBottom) {
      setHover(null);
      setCursorPoint(null);
      return;
    }
    const chartX = Math.min(Math.max(x - geometry.left, 0), Math.max(1, geometry.right - geometry.left));
    const local = Math.min(viewport.count - 1, Math.max(0, Math.floor((chartX / Math.max(1, geometry.right - geometry.left)) * viewport.count)));
    setCursorPoint({ x, y, slotIndex: local });
    setHover(local < viewport.dataCount ? viewport.start + local : null);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let mode = hitTest(x, y);
    if (event.shiftKey && mode === "pan" && y >= geometry.priceTop && y <= geometry.priceBottom) mode = "volume-select";
    const selectionAnchor = mode === "volume-select" ? candleIndexAtX(x) : null;
    if (mode === "volume-select" && selectionAnchor == null) return;
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offset: viewport.offset,
      priceShift,
      priceScale,
      macdScale,
      visibleCount,
      macdHeight,
      futureSlots: viewport.futureSlots,
      selectionAnchor: selectionAnchor ?? undefined,
    };
    if (mode === "volume-select" && selectionAnchor != null) {
      setVolumeSelection({ start: selectionAnchor, end: selectionAnchor });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setCursorMode(mode);
    setIsDragging(true);
    if (mode !== "volume-select") {
      setHover(null);
      setCursorPoint(null);
    }
  };

  const endPointerDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag && event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const mode = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (mode === "pane-resize") setMacdHeight(DEFAULT_MACD_HEIGHT);
    if (mode === "macd-scale") setMacdScale(1);
    if (mode === "price-scale") { setPriceShift(0); setPriceScale(1); }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (event.ctrlKey || (x >= geometry.right && y <= geometry.priceBottom)) {
        const direction = event.deltaY > 0 ? 1.12 : 1 / 1.12;
        setPriceScale((value) => Math.min(Math.max(0.25, value * direction), 8));
        return;
      }
      if (x >= geometry.right && y >= geometry.macdTop && y < geometry.macdBottom) {
        const direction = event.deltaY > 0 ? 1 / 1.12 : 1.12;
        setMacdScale((value) => Math.min(Math.max(0.25, value * direction), 8));
        return;
      }
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
      if (horizontal) {
        const direction = Math.sign(event.deltaX || event.deltaY);
        const step = direction * Math.max(2, Math.round(viewport.count / 12));
        const next = panViewport(viewport.offset, viewport.futureSlots, step, viewport.count, candles.length);
        setRightOffset(next.offset);
        setFutureSlots(next.futureSlots);
        return;
      }
      const change = event.deltaY > 0 ? 16 : -16;
      const nextCount = Math.min(Math.max(30, visibleCount + change), Math.min(260, Math.max(30, candles.length)));
      const nextFuture = Math.min(Math.max(0, viewport.futureSlots), futureLimitFor(nextCount));
      setVisibleCount(nextCount);
      setFutureSlots(nextFuture);
      setRightOffset((value) => Math.min(
        Math.max(0, value),
        Math.max(0, candles.length - Math.max(1, nextCount - nextFuture)),
      ));
    };
    canvas.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onNativeWheel);
  }, [candles.length, geometry.macdBottom, geometry.macdTop, geometry.priceBottom, geometry.right, viewport.count, viewport.futureSlots, viewport.offset, visibleCount]);

  const shiftViewport = (bars: number) => {
    const next = panViewport(viewport.offset, viewport.futureSlots, bars, viewport.count, candles.length);
    setRightOffset(next.offset);
    setFutureSlots(next.futureSlots);
  };
  const zoomViewport = (change: number) => {
    const nextCount = clampVisibleCount(visibleCount + change);
    const nextFuture = clampFuture(viewport.futureSlots, nextCount);
    setVisibleCount(nextCount);
    setFutureSlots(nextFuture);
    setRightOffset((value) => clampOffset(value, nextCount, nextFuture));
  };
  const resizeFuture = (change: number) => {
    const nextFuture = clampFuture(viewport.futureSlots + change);
    setFutureSlots(nextFuture);
    setRightOffset((value) => clampOffset(value, viewport.count, nextFuture));
  };
  const toggleScenarioSpace = () => {
    setScenarioSpaceVisible((visible) => !visible);
  };
  const resizeMacd = (change: number) => {
    setMacdHeight((value) => Math.min(Math.max(MIN_MACD_HEIGHT, value + change), MAX_MACD_HEIGHT));
  };
  const resetView = () => {
    setVisibleCount(DEFAULT_VISIBLE_CANDLES);
    setRightOffset(0);
    setFutureSlots(forecast ? defaultFutureSlots() : 0);
    setScenarioSpaceVisible(Boolean(forecast));
    setPriceShift(0);
    setPriceScale(1);
    setMacdScale(1);
    setMacdHeight(DEFAULT_MACD_HEIGHT);
    setVolumeSelectMode(false);
    setVolumeSelection(null);
  };
  const volumeBias = selectedVolumeBalance
    ? selectedVolumeBalance.deltaPercent >= 15
      ? { label: "Сильнее покупатели", className: "buyers" }
      : selectedVolumeBalance.deltaPercent >= 5
        ? { label: "Небольшой перевес покупателей", className: "buyers" }
        : selectedVolumeBalance.deltaPercent <= -15
          ? { label: "Сильнее продавцы", className: "sellers" }
          : selectedVolumeBalance.deltaPercent <= -5
            ? { label: "Небольшой перевес продавцов", className: "sellers" }
            : { label: "Баланс сторон", className: "balanced" }
    : null;
  const formatRangeTime = (time: number) => new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));

  return (
    <div className="chart-shell" ref={hostRef}>
      <div className="chart-toolbar">
        <div className="ohlc-strip" aria-live="polite">
          <span className="candle-time">{hover != null ? "Курсор" : viewport.offset > 0 ? "Край окна" : active?.closed === false ? "Формируется" : "Последняя"} · <b>{activeTime}</b></span>
          <span>O <b>{formatPrice(active?.open)}</b></span>
          <span>H <b>{formatPrice(active?.high)}</b></span>
          <span>L <b>{formatPrice(active?.low)}</b></span>
          <span>C <b className={active && active.close >= active.open ? "positive" : "negative"}>{formatPrice(active?.close)}</b></span>
          <span>V <b>{active ? formatCompact(active.volume) : "—"}</b></span>
        </div>
        <div className="chart-navigation" aria-label="Навигация по графику">
          <button
            className={volumeSelectMode ? "active" : ""}
            aria-pressed={volumeSelectMode}
            onClick={() => setVolumeSelectMode((active) => !active)}
            title="Включите и протяните ЛКМ по свечам. Быстрый способ без кнопки: Shift + ЛКМ"
          >Баланс объёма</button>
          <button onClick={() => setVolumeSelection(null)} disabled={!volumeSelection} title="Убрать выделенный диапазон свечей">Снять</button>
          <button onClick={() => shiftViewport(Math.max(6, Math.round(viewport.count / 3)))} disabled={viewport.futureSlots === 0 && viewport.offset >= viewport.maxOffset}>← Раньше</button>
          <button onClick={() => shiftViewport(-Math.max(6, Math.round(viewport.count / 3)))} disabled={viewport.futureSlots >= viewport.maxFuture}>Позже →</button>
          <button className={scenarioSpaceVisible ? "active" : ""} aria-pressed={scenarioSpaceVisible} onClick={toggleScenarioSpace}>{scenarioSpaceVisible ? "Сценарий: вкл" : "Сценарий: выкл"}</button>
          <button onClick={() => resizeFuture(Math.max(6, Math.round(viewport.count / 8)))} disabled={viewport.futureSlots >= viewport.maxFuture} title="Расширить свободное пространство справа">Будущее +</button>
          <button onClick={() => resizeFuture(-Math.max(6, Math.round(viewport.count / 8)))} disabled={viewport.futureSlots === 0} title="Сузить свободное пространство справа">Будущее −</button>
          <button onClick={() => zoomViewport(18)} title="Показать больше свечей">−</button>
          <button onClick={() => zoomViewport(-18)} title="Увеличить свечи">＋</button>
          <button onClick={() => { setPriceShift(0); setPriceScale(1); }} title="Автоматический масштаб цены">Авто Y</button>
          <button onClick={() => resizeMacd(28)} disabled={macdHeight >= MAX_MACD_HEIGHT} title="Увеличить область MACD">MACD +</button>
          <button onClick={() => resizeMacd(-28)} disabled={macdHeight <= MIN_MACD_HEIGHT} title="Уменьшить область MACD">MACD −</button>
          <button onClick={() => setMacdScale(1)} disabled={macdScale === 1} title="Автоматический масштаб линий MACD">MACD авто</button>
          <button className={showPatternLabels ? "active" : ""} aria-pressed={showPatternLabels} onClick={() => setShowPatternLabels((visible) => !visible)} title="Показать или скрыть названия свечных моделей">Текст моделей: {showPatternLabels ? "вкл" : "выкл"}</button>
          <button onClick={() => { setRightOffset(0); setFutureSlots(0); }} disabled={viewport.offset === 0 && viewport.futureSlots === 0}>К последним</button>
          <button onClick={resetView} title="Вернуть исходный масштаб и размеры зон">Сброс вида</button>
        </div>
      </div>
      {(volumeSelectMode || selectedVolumeBalance) && (
        <section className="volume-balance-panel" aria-live="polite">
          {selectedVolumeBalance && volumeBias ? (
            <>
              <div className="volume-balance-summary">
                <span>РАСЧЁТНЫЙ БАЛАНС OHLCV</span>
                <strong className={volumeBias.className}>{volumeBias.label}</strong>
                <small>{selectedVolumeBalance.candleCount} свеч. · {formatRangeTime(selectedVolumeBalance.startTime)} → {formatRangeTime(selectedVolumeBalance.endTime)}</small>
              </div>
              <div className="volume-balance-metric buyers"><span>Покупки</span><b>{formatCompact(selectedVolumeBalance.buyVolume)}</b><small>{selectedVolumeBalance.buyPercent.toFixed(1)}%</small></div>
              <div className="volume-balance-metric sellers"><span>Продажи</span><b>{formatCompact(selectedVolumeBalance.sellVolume)}</b><small>{selectedVolumeBalance.sellPercent.toFixed(1)}%</small></div>
              <div className={`volume-balance-metric ${selectedVolumeBalance.delta >= 0 ? "buyers" : "sellers"}`}><span>Дельта</span><b>{selectedVolumeBalance.delta >= 0 ? "+" : ""}{formatCompact(selectedVolumeBalance.delta)}</b><small>{selectedVolumeBalance.deltaPercent >= 0 ? "+" : ""}{selectedVolumeBalance.deltaPercent.toFixed(1)}%</small></div>
              <div className={`volume-balance-metric ${selectedVolumeBalance.priceChangePercent >= 0 ? "buyers" : "sellers"}`}><span>Цена</span><b>{selectedVolumeBalance.priceChangePercent >= 0 ? "+" : ""}{selectedVolumeBalance.priceChangePercent.toFixed(2)}%</b><small>за диапазон</small></div>
              <div className="volume-balance-metric"><span>Общий объём</span><b>{formatCompact(selectedVolumeBalance.totalVolume)}</b><small>средний {formatCompact(selectedVolumeBalance.averageVolume)}</small></div>
              <p className="volume-balance-note">Оценка по положению закрытия внутри свечи, а не точный поток сделок Bid/Ask.</p>
            </>
          ) : (
            <div className="volume-balance-empty">Протяните ЛКМ по нужным свечам · либо удерживайте Shift при обычном режиме графика</div>
          )}
        </section>
      )}
      <canvas
        ref={canvasRef}
        className={`market-canvas interaction-${cursorMode} ${isDragging ? "dragging" : ""}`}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={endPointerDrag}
        onPointerCancel={endPointerDrag}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => { if (!dragRef.current) { setHover(null); setCursorPoint(null); setCursorMode("pan"); } }}
        aria-label="Интерактивный свечной график: перетаскивание, выделение свечей для баланса объёма, масштаб цены и времени, изменение высоты и шкалы MACD"
      />
      <div className="chart-help">Баланс объёма: кнопка или Shift + ЛКМ · MACD: тяните разделитель ↕ и правую шкалу · свободное будущее и сценарий регулируются отдельно</div>
    </div>
  );
}
