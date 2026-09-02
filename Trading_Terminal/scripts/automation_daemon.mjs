import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKET_NAMES = new Set(["crypto", "stocks", "moex", "forex", "commodities"]);

export function positiveInteger(value, fallback, minimum = 1, maximum = 86_400) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function normalizeAsset(value) {
  if (!value || typeof value !== "object") return null;
  const symbol = String(value.symbol ?? "").trim().toUpperCase().replace("/", "");
  const market = String(value.market ?? "");
  if (!/^[A-Z0-9._-]{2,15}$/.test(symbol) || !MARKET_NAMES.has(market)) return null;
  return {
    symbol,
    market,
    displaySymbol: String(value.displaySymbol ?? symbol).slice(0, 30),
    name: String(value.name ?? symbol).slice(0, 80),
    signal: value.signal && typeof value.signal === "object" ? value.signal : null,
  };
}

export function mergeAssets(...groups) {
  const unique = new Map();
  groups.flat().forEach((value) => {
    const asset = normalizeAsset(value);
    if (asset) unique.set(`${asset.market}:${asset.symbol}`, asset);
  });
  return [...unique.values()];
}

export function summarizeScanResults(results, total, startedAt, timeframe, id = crypto.randomUUID()) {
  const summary = {
    id,
    status: "COMPLETED",
    trigger: "LOCAL_DAEMON",
    timeframe,
    startedAt,
    finishedAt: Date.now(),
    total,
    completed: results.length,
    created: 0,
    existing: 0,
    failed: 0,
    ready: 0,
    waiting: 0,
    noTrade: 0,
    errors: [],
  };
  results.forEach((result) => {
    if (!result.ok) {
      summary.failed += 1;
      if (summary.errors.length < 20) summary.errors.push({ symbol: result.symbol, message: result.error });
      return;
    }
    if (result.payload.created) summary.created += 1;
    else summary.existing += 1;
    if (result.payload.decision === "READY") summary.ready += 1;
    if (result.payload.decision === "WAIT_CONFIRMATION") summary.waiting += 1;
    if (result.payload.decision === "NO_TRADE") summary.noTrade += 1;
  });
  if (summary.failed === total && total > 0) summary.status = "FAILED";
  return summary;
}

export async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function readJson(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

function headers(token, hasBody = false) {
  return {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "User-Agent": "Northstar-Local-Automation/1.0",
  };
}

async function requestJson(baseUrl, path, token, init = {}, timeoutMs = 70_000) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { ...headers(token, Boolean(init.body)), ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error ?? `HTTP ${response.status}`));
  return payload;
}

async function fallbackAssets(config) {
  const snapshot = await readJson(resolve(ROOT, "public", "data", "terminal_snapshot.json"), { assets: [] });
  return mergeAssets(snapshot.assets ?? [], config.fallbackAssets ?? []);
}

async function currentWatchlist(baseUrl, token, config) {
  try {
    const state = await requestJson(baseUrl, "/api/automation/status", token, {}, 10_000);
    if (Array.isArray(state.watchlist) && state.watchlist.length) return mergeAssets(state.watchlist);
  } catch {
    // The fallback remains complete enough to start before the browser synchronizes its local additions.
  }
  return fallbackAssets(config);
}

async function recordRun(baseUrl, token, run) {
  try {
    await requestJson(baseUrl, "/api/automation/status", token, {
      method: "POST",
      body: JSON.stringify({ action: "record-run", run }),
    }, 10_000);
  } catch {
    // The durable local JSONL log below remains available if the status endpoint restarts.
  }
  const outputDirectory = resolve(ROOT, "outputs");
  await mkdir(outputDirectory, { recursive: true });
  await appendFile(resolve(outputDirectory, "automation_runs.jsonl"), `${JSON.stringify(run)}\n`, "utf8");
}

async function heartbeat(baseUrl, token) {
  await requestJson(baseUrl, "/api/automation/status", token, {
    method: "POST",
    body: JSON.stringify({ action: "heartbeat", at: Date.now() }),
  }, 10_000);
}

async function evaluatePaper(baseUrl, token) {
  return requestJson(baseUrl, "/api/paper-trades?evaluate=1", token, {}, 70_000);
}

async function scanAll(baseUrl, token, config) {
  const assets = await currentWatchlist(baseUrl, token, config);
  const markets = String(process.env.NORTHSTAR_AUTOMATION_MARKETS ?? "")
    .split(",").map((value) => value.trim()).filter((value) => MARKET_NAMES.has(value));
  const selected = markets.length ? assets.filter((asset) => markets.includes(asset.market)) : assets;
  const timeframe = String(process.env.NORTHSTAR_AUTOMATION_TIMEFRAME ?? config.timeframe ?? "4h");
  const concurrency = positiveInteger(process.env.NORTHSTAR_AUTOMATION_CONCURRENCY, config.concurrency ?? 3, 1, 8);
  const startedAt = Date.now();
  const results = await runWithConcurrency(selected, concurrency, async (asset) => {
    try {
      const payload = await requestJson(baseUrl, "/api/automation/scan", token, {
        method: "POST",
        body: JSON.stringify({ symbol: asset.symbol, market: asset.market, timeframe, signal: asset.signal }),
      }, 120_000);
      return { ok: true, symbol: asset.symbol, payload };
    } catch (error) {
      return { ok: false, symbol: asset.symbol, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const summary = summarizeScanResults(results, selected.length, startedAt, timeframe);
  await recordRun(baseUrl, token, summary);
  process.stdout.write(`[${new Date().toISOString()}] scan ${summary.status}: ${summary.completed}/${summary.total}, new ${summary.created}, existing ${summary.existing}, errors ${summary.failed}\n`);
  return summary;
}

async function acquireLock(baseUrl) {
  const port = new URL(baseUrl).port || "default";
  const outputDirectory = resolve(ROOT, "outputs");
  await mkdir(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, `automation_${port}.lock`);
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
    return path;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const pid = Number((await readFile(path, "utf8").catch(() => "0")).trim());
    try {
      if (pid > 0) process.kill(pid, 0);
      return null;
    } catch {
      await rm(path, { force: true });
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return path;
    }
  }
}

async function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main() {
  const argument = process.argv.find((value) => value.startsWith("--base-url="));
  const baseUrl = (argument?.slice("--base-url=".length) || process.env.NORTHSTAR_TERMINAL_URL || "http://127.0.0.1:3000/").replace(/\/?$/, "/");
  const token = String(process.env.NORTHSTAR_AUTOMATION_TOKEN ?? "").trim();
  const config = await readJson(resolve(ROOT, "config", "automation.json"));
  const once = process.argv.includes("--once");
  const lockPath = await acquireLock(baseUrl);
  if (!lockPath) {
    process.stdout.write("Northstar automation is already running for this terminal.\n");
    return;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const startupDelay = once ? 0 : positiveInteger(process.env.NORTHSTAR_AUTOMATION_STARTUP_DELAY_SECONDS, config.startupDelaySeconds ?? 8, 0, 300);
    if (startupDelay) await sleep(startupDelay * 1000);
    await heartbeat(baseUrl, token);
    await evaluatePaper(baseUrl, token).catch((error) => process.stderr.write(`paper evaluation: ${error.message}\n`));
    await scanAll(baseUrl, token, config);
    await evaluatePaper(baseUrl, token).catch((error) => process.stderr.write(`paper evaluation after scan: ${error.message}\n`));
    if (once) return;
    const scanInterval = positiveInteger(process.env.NORTHSTAR_AUTOMATION_SCAN_INTERVAL_SECONDS, config.scanIntervalSeconds ?? 900, 60, 86_400) * 1000;
    const evaluationInterval = positiveInteger(process.env.NORTHSTAR_AUTOMATION_EVALUATION_INTERVAL_SECONDS, config.evaluationIntervalSeconds ?? 60, 15, 3_600) * 1000;
    let nextScanAt = Date.now() + scanInterval;
    let nextEvaluationAt = Date.now() + evaluationInterval;
    let nextHeartbeatAt = Date.now() + 30_000;
    while (!stopping) {
      const now = Date.now();
      if (now >= nextHeartbeatAt) {
        await heartbeat(baseUrl, token).catch(() => undefined);
        nextHeartbeatAt = now + 30_000;
      }
      if (now >= nextEvaluationAt) {
        await evaluatePaper(baseUrl, token).catch((error) => process.stderr.write(`paper evaluation: ${error.message}\n`));
        nextEvaluationAt = Date.now() + evaluationInterval;
      }
      if (now >= nextScanAt) {
        await scanAll(baseUrl, token, config).catch((error) => process.stderr.write(`forecast scan: ${error.message}\n`));
        await evaluatePaper(baseUrl, token).catch((error) => process.stderr.write(`paper evaluation after scan: ${error.message}\n`));
        nextScanAt = Date.now() + scanInterval;
      }
      await sleep(1_000);
    }
  } finally {
    await rm(lockPath, { force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
