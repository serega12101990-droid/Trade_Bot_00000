import type { ScalpPaperTrade, ScalpStrategyId } from "./scalping-engine";

export const SCALP_ENTRY_POLICY_VERSION = "scalp-risk-review-2026-09-07-v1";
export const SCALP_ENTRY_POLICY_EFFECTIVE_AT = Date.UTC(2026, 8, 7, 20, 0);
export const SCALP_OBSERVATIONS_STORAGE_KEY = "northstar-scalping-shadow-observations-v1";

export type ScalpStrategyPolicy = {
  strategyId: ScalpStrategyId;
  status: "ACTIVE" | "DISABLED" | "SHADOW_ONLY";
  label: string;
  reason: string;
};

// Versioned and reversible: changing execution permission does not remove detectors or history.
export const SCALP_STRATEGY_POLICIES: readonly ScalpStrategyPolicy[] = [
  {
    strategyId: "DENSITY_BOUNCE", status: "DISABLED", label: "Отскок от плотности",
    reason: "Аудит v4.1: 2 прибыльные из 13, PnL −32,15 USDT после комиссий. Новые входы отключены до проверки исправлений.",
  },
  {
    strategyId: "IMPULSE_BREAKOUT", status: "SHADOW_ONLY", label: "Импульсный пробой",
    reason: "Недостаточно независимых завершённых примеров с положительным результатом после издержек.",
  },
  {
    strategyId: "MTF_SHADOW", status: "SHADOW_ONLY", label: "EMA / MACD · MTF",
    reason: "Контрольная гипотеза: разрешено наблюдение, исполнение не допущено.",
  },
  {
    strategyId: "MANUAL", status: "SHADOW_ONLY", label: "Ручной вход",
    reason: "Пауза новых скальп-сделок распространяется и на ручные входы; сопровождение открытых позиций продолжается.",
  },
];

export const SCALP_ENTRIES_PAUSED = !SCALP_STRATEGY_POLICIES.some((policy) => policy.status === "ACTIVE");

export function scalpEntryPermission(strategyId: ScalpStrategyId | undefined) {
  const policy = SCALP_STRATEGY_POLICIES.find((item) => item.strategyId === strategyId);
  return {
    allowed: policy?.status === "ACTIVE",
    version: SCALP_ENTRY_POLICY_VERSION,
    status: policy?.status ?? "DISABLED",
    reason: policy?.reason ?? "Стратегия не указана или не допущена к новым входам.",
  };
}

export function scalpTradePersistencePermission(trade: ScalpPaperTrade, existing?: ScalpPaperTrade) {
  if (existing) {
    const sameEntry = (["id", "symbol", "side", "entryPrice", "quantity", "notional", "openedAt", "entryMode", "signalKey"] as const)
      .every((key) => existing[key] === trade[key]);
    if (!sameEntry) return { allowed: false, reason: "Нельзя заменить исходный вход существующей сделки." };
    if (existing.status === "CLOSED" && trade.status === "OPEN") {
      return { allowed: false, reason: "Закрытую сделку нельзя открыть повторно синхронизацией." };
    }
    return { allowed: true, reason: "Сопровождение и закрытие ранее сохранённой позиции разрешены." };
  }
  // Permit importing completed history from before this policy, never an unknown OPEN entry.
  if (trade.status === "CLOSED" && trade.openedAt < SCALP_ENTRY_POLICY_EFFECTIVE_AT
      && Number.isFinite(trade.closedAt) && Number(trade.closedAt) >= trade.openedAt
      && Number(trade.closedAt) < SCALP_ENTRY_POLICY_EFFECTIVE_AT) {
    return { allowed: true, reason: "Перенос завершённой истории до введения политики." };
  }
  return scalpEntryPermission(trade.signalSnapshot?.strategyId);
}
