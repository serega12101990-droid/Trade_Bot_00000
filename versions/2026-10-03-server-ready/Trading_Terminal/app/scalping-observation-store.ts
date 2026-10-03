import type { ScalpSignalSnapshot } from "./scalping-engine";
import { scalpEntryPermission, SCALP_STRATEGY_POLICIES } from "./scalping-policy";

export type ScalpShadowObservation = {
  symbol: string;
  signalKey: string;
  capturedAt: number;
  policyVersion: string;
  entryAllowed: boolean;
  entryBlockReason: string | null;
  snapshot: ScalpSignalSnapshot;
};

async function binding() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("База наблюдений скальпинга недоступна");
  return env.DB;
}

export function validatedScalpObservations(values: unknown[], now = Date.now()): ScalpShadowObservation[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as ScalpShadowObservation;
    if (!/^[A-Z0-9]{2,25}$/.test(item.symbol ?? "") || typeof item.signalKey !== "string" || !item.signalKey || item.signalKey.length > 200
      || !Number.isFinite(item.capturedAt) || item.capturedAt > now + 60_000 || item.capturedAt < 0
      || !item.snapshot || item.snapshot.version !== 2 || item.snapshot.signalKey !== item.signalKey
      || item.snapshot.capturedAt !== item.capturedAt || item.snapshot.status !== "READY"
      || !["LONG", "SHORT"].includes(item.snapshot.direction ?? "")
      || !Number.isFinite(item.snapshot.price) || item.snapshot.price <= 0
      || !SCALP_STRATEGY_POLICIES.some((policy) => policy.strategyId === item.snapshot.strategyId)
      || JSON.stringify(item.snapshot).length > 20_000) return [];
    const permission = scalpEntryPermission(item.snapshot.strategyId);
    return [{ symbol: item.symbol, signalKey: item.signalKey, capturedAt: item.capturedAt, snapshot: item.snapshot,
      policyVersion: permission.version, entryAllowed: permission.allowed,
      entryBlockReason: permission.allowed ? null : permission.reason }];
  });
}

export async function readScalpObservationCount(db?: D1Database) {
  const connection = db ?? await binding();
  const row = await connection.prepare("SELECT COUNT(*) AS total FROM scalping_observations").first<{ total: number }>();
  return { total: Number(row?.total ?? 0) };
}

export async function saveScalpObservations(values: unknown[], db?: D1Database) {
  const connection = db ?? await binding();
  const observations = validatedScalpObservations(values);
  if (observations.length) {
    await connection.batch(observations.map((item) => connection.prepare(`INSERT INTO scalping_observations
      (signal_key, symbol, captured_at, policy_version, observation_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(signal_key) DO NOTHING`).bind(item.signalKey, item.symbol, item.capturedAt, item.policyVersion, JSON.stringify(item))));
  }
  return { ...await readScalpObservationCount(connection), acceptedKeys: observations.map((item) => item.signalKey) };
}
