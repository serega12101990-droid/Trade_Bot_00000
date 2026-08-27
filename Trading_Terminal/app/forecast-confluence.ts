import type { ForecastDirection, ForecastStrategyMatch } from "./terminal-types";

export type ConfluenceState = "CONFIRMED" | "SUPPORTING" | "WAIT" | "CONFLICT" | "UNAVAILABLE";

export type ConfluenceItem = {
  id: "ema" | "macd" | "nison" | "5m" | "1m";
  label: string;
  state: ConfluenceState;
  detail: string;
};

export type ForecastConfluence = {
  items: ConfluenceItem[];
  confirmed: number;
  supporting: number;
  conflicts: number;
  available: number;
  grade: "STRONG" | "MODERATE" | "MIXED" | "WEAK" | "INSUFFICIENT";
  label: string;
};

export type StrategyAgreement = {
  alignedConfirmed: ForecastStrategyMatch[];
  alignedSupporting: ForecastStrategyMatch[];
  confirmedConflicts: ForecastStrategyMatch[];
  weakOpposition: ForecastStrategyMatch[];
  unavailable: ForecastStrategyMatch[];
  blocked: boolean;
  reasons: string[];
};

const DECISION_STRATEGIES = new Set<ForecastStrategyMatch["id"]>([
  "ema-corridor",
  "legacy-macd",
  "macd-exhaustion",
  "opening-range-3",
  "nison",
  "vpa",
  "level-action",
]);

export function strategyAgreement(
  direction: ForecastDirection,
  matches: ForecastStrategyMatch[],
): StrategyAgreement {
  const evidence = matches.filter((match) => DECISION_STRATEGIES.has(match.id));
  const aligned = evidence.filter((match) => match.direction === direction);
  const opposite = evidence.filter((match) => match.direction !== direction && match.direction !== "SIDEWAYS");
  const alignedConfirmed = aligned.filter((match) => match.state === "CONFIRMED");
  const alignedSupporting = aligned.filter((match) => match.state === "SUPPORTING");
  const confirmedConflicts = opposite.filter((match) => match.state === "CONFIRMED");
  const weakOpposition = opposite.filter((match) => match.state === "SUPPORTING");
  const unavailable = evidence.filter((match) => match.direction === "SIDEWAYS" || match.state === "WATCH");
  return {
    alignedConfirmed,
    alignedSupporting,
    confirmedConflicts,
    weakOpposition,
    unavailable,
    blocked: confirmedConflicts.length > 0,
    reasons: confirmedConflicts.map((match) => `${match.shortLabel}: подтверждённый сигнал в противоположную сторону`),
  };
}

function strategyState(
  match: ForecastStrategyMatch | undefined,
  direction: ForecastDirection,
): Pick<ConfluenceItem, "state" | "detail"> {
  if (!match) return { state: "UNAVAILABLE", detail: "Сигнал не найден" };
  if (match.direction !== direction && match.direction !== "SIDEWAYS") {
    if (match.state === "CONFIRMED") return { state: "CONFLICT", detail: match.summary };
    if (match.state === "SUPPORTING") return { state: "WAIT", detail: `Слабый встречный сигнал, вход не блокирует: ${match.summary}` };
    return { state: "UNAVAILABLE", detail: `Недостаточно данных, вход не блокирует: ${match.summary}` };
  }
  if (match.state === "CONFIRMED") return { state: "CONFIRMED", detail: match.summary };
  if (match.state === "SUPPORTING") return { state: "SUPPORTING", detail: match.summary };
  return { state: "WAIT", detail: match.summary };
}

function entryState(
  mtf: ForecastStrategyMatch | undefined,
  timeframe: "5m" | "1m",
  direction: ForecastDirection,
): Pick<ConfluenceItem, "state" | "detail"> {
  if (!mtf) return { state: "UNAVAILABLE", detail: `Нет данных ${timeframe}` };
  if (mtf.direction !== direction && mtf.direction !== "SIDEWAYS") {
    return { state: "CONFLICT", detail: mtf.summary };
  }
  const entry = mtf.entryConfirmations?.find((item) => item.timeframe === timeframe);
  if (!entry || entry.state === "UNAVAILABLE") return { state: "UNAVAILABLE", detail: `Нет данных ${timeframe}` };
  if (entry.state === "CONFIRMED") return { state: "CONFIRMED", detail: entry.summary };
  return { state: "SUPPORTING", detail: entry.summary };
}

export function forecastConfluence(
  direction: ForecastDirection,
  matches: ForecastStrategyMatch[],
): ForecastConfluence {
  const ema = matches.find((match) => match.id === "ema-corridor");
  const macd = matches.find((match) => match.id === "legacy-macd");
  const nison = matches.find((match) => match.id === "nison");
  const mtf = matches.find((match) => match.id === "mtf-entry");
  const items: ConfluenceItem[] = [
    { id: "ema", label: "EMA", ...strategyState(ema, direction) },
    { id: "macd", label: "MACD", ...strategyState(macd, direction) },
    { id: "nison", label: "Нисон", ...strategyState(nison, direction) },
    { id: "5m", label: "5м", ...entryState(mtf, "5m", direction) },
    { id: "1m", label: "1м", ...entryState(mtf, "1m", direction) },
  ];
  const confirmed = items.filter((item) => item.state === "CONFIRMED").length;
  const supporting = items.filter((item) => item.state === "SUPPORTING").length;
  const conflicts = items.filter((item) => item.state === "CONFLICT").length;
  const available = items.filter((item) => item.state !== "UNAVAILABLE").length;
  const grade = available < 2
    ? "INSUFFICIENT"
    : conflicts > 0
      ? "MIXED"
      : confirmed >= 3
        ? "STRONG"
        : confirmed + supporting >= 3
          ? "MODERATE"
          : "WEAK";
  const label = grade === "STRONG"
    ? "Сильная согласованность"
    : grade === "MODERATE"
      ? "Умеренная согласованность"
      : grade === "MIXED"
        ? "Есть противоречие"
        : grade === "WEAK"
          ? "Слабая согласованность"
          : "Недостаточно данных";
  return { items, confirmed, supporting, conflicts, available, grade, label };
}
