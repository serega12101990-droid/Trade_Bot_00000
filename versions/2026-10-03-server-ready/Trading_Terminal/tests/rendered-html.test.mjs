import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  if (typeof worker === "function") return worker(new Request("http://localhost/", { headers: { accept: "text/html" } }));
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Trading Terminal shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Northstar Trading Terminal<\/title>/i);
  assert.match(html, /Собираю терминал и локальные данные/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("snapshot contains the requested crypto, US and MOEX universe", async () => {
  const raw = await readFile(new URL("../public/data/terminal_snapshot.json", import.meta.url), "utf8");
  const snapshot = JSON.parse(raw);
  assert.equal(snapshot.mode, "LOCAL_READ_ONLY");
  assert.equal(snapshot.assetCount, 85);
  assert.equal(snapshot.assets.filter((item) => item.market === "crypto").length, 5);
  assert.equal(snapshot.assets.filter((item) => item.market === "stocks").length, 20);
  assert.equal(snapshot.assets.filter((item) => item.market === "moex").length, 60);
  assert.equal(new Set(snapshot.assets.map((item) => `${item.market}:${item.symbol}`)).size, 85);
  assert.ok(snapshot.assets.some((item) => item.market === "moex" && item.symbol === "SBER" && item.name === "Сбербанк"));
  assert.ok(snapshot.assets.some((item) => item.market === "moex" && item.symbol === "WUSH"));
  assert.equal(snapshot.sources.ordersEnabled, false);
  assert.ok(snapshot.strategies.length >= 7);
  assert.ok(snapshot.strategies.some((item) => item.id === "ema-corridor" && item.shortName === "EMA ОКНО"));
  assert.ok(snapshot.strategies.some((item) => item.id === "scenario-forecast" && item.enabled));
});

test("starter preview is removed", async () => {
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(page, /<TradingTerminal \/>/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("forecast journal has durable D1 storage and a checked-in migration", async () => {
  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../drizzle/0000_wet_killer_shrike.sql", import.meta.url), "utf8");
  assert.equal(hosting.d1, "DB");
  assert.match(migration, /CREATE TABLE `forecast_journal`/);
  assert.match(migration, /idx_forecast_unique/);
  assert.match(migration, /idx_forecast_pending_due/);
});

test("ticker news has durable cache and a local secret template", async () => {
  const migration = await readFile(new URL("../drizzle/0001_sweet_namor.sql", import.meta.url), "utf8");
  const secretTemplate = await readFile(new URL("../.dev.vars.example", import.meta.url), "utf8");
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `market_news`/);
  assert.match(migration, /idx_market_news_symbol_published/);
  assert.match(secretTemplate, /^ALPHA_VANTAGE_API_KEY=/m);
  assert.match(terminal, />Новости<\/button>/);
});

test("local forecast automation runs independently from the browser and keeps a manual fallback", async () => {
  const launcher = await readFile(new URL("../scripts/start_terminal.py", import.meta.url), "utf8");
  const daemon = await readFile(new URL("../scripts/automation_daemon.mjs", import.meta.url), "utf8");
  const scanRoute = await readFile(new URL("../app/api/automation/scan/route.ts", import.meta.url), "utf8");
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  assert.match(launcher, /start_automation_daemon/);
  assert.match(daemon, /api\/automation\/scan/);
  assert.match(daemon, /api\/paper-trades\?evaluate=1/);
  assert.match(scanRoute, /authorizeAutomationRequest/);
  assert.match(terminal, /Создать прогнозы/);
  assert.match(terminal, /Автосканер работает/);
});

test("terminal includes a separate safe scalping workspace", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../app/scalping-workspace.tsx", import.meta.url), "utf8");
  const engine = await readFile(new URL("../app/scalping-engine.ts", import.meta.url), "utf8");
  assert.match(terminal, />Скальпинг<\/button>/);
  assert.match(terminal, /<ScalpingWorkspace \/>/);
  assert.match(workspace, /wss:\/\/stream\.bybit\.com\/v5\/public\/linear/);
  assert.match(workspace, /Реальные ордера не отправляются/);
  assert.match(workspace, /Микроструктура: плотности и импульсные пробои/);
  assert.match(workspace, /assessMicrostructureSignal/);
  assert.match(workspace, /EMA\/MACD.*теневой контроль/);
  assert.match(workspace, /Стоп-лимит:/);
  assert.match(workspace, /isScalpTradeQuoteCompatible/);
  assert.match(engine, /scalpRiskState/);
  assert.match(workspace, /BTCUSDT.*ETHUSDT.*SOLUSDT.*TRXUSDT.*XRPUSDT/);
  assert.match(workspace, /scalpSymbols\.flatMap/);
  assert.match(workspace, /api\/scalping-universe/);
  assert.match(workspace, /backgroundQuotes/);
  assert.match(workspace, /markScalpTrade/);
  assert.match(workspace, /Выход \/ длительность/);
  assert.match(workspace, /durationMinutes/);
  assert.match(terminal, /hidden=\{activeTab !== "scalping"\}/);
});

test("scalping journal is durable and new trades keep an auditable signal snapshot", async () => {
  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../drizzle/0006_tiny_maelstrom.sql", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/scalping-trades/route.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../app/scalping-store.ts", import.meta.url), "utf8");
  const engine = await readFile(new URL("../app/scalping-engine.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../app/scalping-workspace.tsx", import.meta.url), "utf8");
  assert.equal(hosting.d1, "DB");
  assert.match(migration, /CREATE TABLE `scalping_trades`/);
  assert.match(migration, /idx_scalping_validity_closed/);
  assert.match(schema, /scalping_trades/);
  assert.match(schema, /signal_snapshot_json/);
  assert.match(route, /upsertScalpingTrades/);
  assert.match(store, /auditScalpTrades/);
  assert.match(workspace, /makeSignalSnapshot/);
  assert.match(workspace, /maxDurationMinutes/);
  assert.match(workspace, /Старая комиссия восстановлена расчётно/);
  assert.match(workspace, /Taker, б\.п\./);
  assert.match(workspace, /SCALP_ENTRIES_PAUSED/);
  assert.match(workspace, /SCALP_STRATEGY_POLICIES/);
  assert.match(workspace, /liquidityMissingSince/);
  assert.match(workspace, /ОТСКОК ОТ ПЛОТНОСТИ/);
  assert.match(workspace, /ИМПУЛЬСНЫЙ ПРОБОЙ/);
  assert.match(workspace, /SCALP_STRATEGY_VERSION/);
  assert.match(workspace, /scalpPerformanceStats/);
  assert.match(workspace, /Последние 20/);
  assert.match(engine, /EMA и MACD 15м/);
});

test("current strategies use live 15m context with 1m and 5m entry confirmations", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const forecast = await readFile(new URL("../app/terminal-forecast.ts", import.meta.url), "utf8");
  const experimental = await readFile(new URL("../app/experimental-strategies.ts", import.meta.url), "utf8");
  assert.match(terminal, /\[batchTimeframe, \.\.\.TOP_DOWN_MACD_EMA_TIMEFRAMES, "1m"\]/);
  assert.match(experimental, /\["5m", "15m", "30m", "1h", "4h", "1d"\]/);
  assert.match(forecast, /detectLegacyMacdStrategy/);
  assert.match(forecast, /detectNisonStrategy/);
  assert.match(forecast, /detectMtfEntryStrategy/);
  assert.match(forecast, /scenario-v1\.6\.0/);
});

test("EMA-window channel is visible, journaled, audited separately, and stays shadow-only", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const forecast = await readFile(new URL("../app/terminal-forecast.ts", import.meta.url), "utf8");
  const confluence = await readFile(new URL("../app/forecast-confluence.ts", import.meta.url), "utf8");
  const attribution = await readFile(new URL("../app/paper-trading-store.ts", import.meta.url), "utf8");
  const audit = await readFile(new URL("../scripts/audit_confluence.mjs", import.meta.url), "utf8");
  assert.match(terminal, /ema-window-channel/);
  assert.match(forecast, /detectEmaWindowChannelShadow/);
  assert.doesNotMatch(confluence, /"ema-window-channel"/);
  assert.doesNotMatch(attribution.match(/ATTRIBUTABLE_STRATEGIES[\s\S]*?\]\);/)?.[0] ?? "", /ema-window-channel/);
  assert.match(audit, /emaWindowChannelShadow/);
  assert.match(audit, /SHADOW_ONLY/);
});

test("forecast journal symbols open the matching chart and timeframe", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  assert.match(terminal, /className="journal-symbol-link"/);
  assert.match(terminal, /setSelectedSymbol\(record\.symbol\); setTimeframe\(record\.timeframe\); setActiveTab\("chart"\)/);
});

test("forecast journal separates strategy families with visible color labels", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const forecast = await readFile(new URL("../app/terminal-forecast.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(forecast, /EMA‑окно/);
  assert.match(forecast, /mtfTimeframesChecked/);
  assert.match(terminal, /strategy-color-legend/);
  assert.match(terminal, /Осторожный TP/);
  assert.match(styles, /strategy-chip\.violet/);
});

test("terminal restores the last section, ticker, timeframe, and paper journal view after refresh", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  assert.match(terminal, /TERMINAL_VIEW_STORAGE_KEY/);
  assert.match(terminal, /readSavedTerminalView/);
  assert.match(terminal, /activeTab, selectedSymbol, timeframe, paperTradeView/);
  assert.match(terminal, /setActiveTab\(saved\.activeTab\)/);
  assert.match(terminal, /setPaperTradeView\(saved\.paperTradeView\)/);
});

test("forecast journal columns can be resized and fitted to a small monitor", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(terminal, /JOURNAL_COLUMN_STORAGE_KEY/);
  assert.match(terminal, /ColumnResizeHandle/);
  assert.match(terminal, /Уместить на экране/);
  assert.match(terminal, /role="separator"/);
  assert.match(styles, /journal-column-resizer/);
  assert.doesNotMatch(styles, /\.journal-table \{ min-width: 1380px; \}/);
});

test("paper trading has durable tables, a dedicated API, and cannot place real orders", async () => {
  const migration = await readFile(new URL("../drizzle/0002_wooden_ser_duncan.sql", import.meta.url), "utf8");
  const controlsMigration = await readFile(new URL("../drizzle/0003_low_amazoness.sql", import.meta.url), "utf8");
  const scaleInMigration = await readFile(new URL("../drizzle/0004_white_maddog.sql", import.meta.url), "utf8");
  const executionTimeMigration = await readFile(new URL("../drizzle/0005_slow_hemingway.sql", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/paper-trades/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../app/paper-trading-store.ts", import.meta.url), "utf8");
  const marketData = await readFile(new URL("../app/market-data-service.ts", import.meta.url), "utf8");
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `paper_accounts`/);
  assert.match(migration, /CREATE TABLE `paper_trades`/);
  assert.match(migration, /idx_paper_trade_forecast/);
  assert.match(controlsMigration, /entry_mode/);
  assert.match(controlsMigration, /rub_per_usdt/);
  assert.match(controlsMigration, /realized_pnl_native/);
  assert.match(scaleInMigration, /first_entry_time/);
  assert.match(scaleInMigration, /scale_in_count/);
  assert.match(executionTimeMigration, /entry_time_source/);
  assert.match(executionTimeMigration, /exit_time_source/);
  assert.match(route, /readPaperTrading/);
  assert.match(route, /openPaperRecommendation/);
  assert.match(route, /closePaperTrade/);
  assert.match(terminal, /Открыть по рекомендации/);
  assert.match(terminal, /Открыть вручную · ЖДЁМ/);
  assert.match(terminal, /Ручной вход · ЖДЁМ/);
  assert.match(service, /MANUAL_WAIT/);
  assert.match(service, /MANUAL_ADD/);
  assert.match(service, /mergePaperPosition/);
  assert.match(route, /allowAddToPosition/);
  assert.match(service, /mode === "MANUAL"/);
  assert.match(terminal, /Автоматический/);
  assert.match(terminal, /Активные/);
  assert.match(terminal, /Завершённые/);
  assert.match(terminal, /Архив/);
  assert.match(terminal, /Сумма сделки/);
  assert.match(terminal, /Закрыть позицию/);
  assert.match(terminal, /paper-equity-equation/);
  assert.match(service, /MANUAL_CLOSE/);
  assert.match(service, /calculateManualPaperClose/);
  assert.match(service, /calculateManualPaperEntry/);
  assert.match(service, /openManualCandidateNow/);
  assert.match(terminal, /Открыть виртуальную сделку СЕЙЧАС/);
  assert.match(terminal, /открыта сразу по/);
  assert.match(terminal, /Время входа/);
  assert.match(terminal, /Время выхода ↓/);
  assert.match(terminal, /последние закрытые сделки сверху/);
  assert.match(terminal, /left\.exitTime \?\? left\.updatedAt/);
  assert.match(marketData, /getExecutionMarketData/);
  assert.match(service, /ONE_MINUTE_CANDLE/);
  assert.match(terminal, /касание цены · точность 1 мин/);
  assert.match(terminal, /по свече ТФ · время приблизительное/);
  assert.match(terminal, /journal-group-toggle/);
  assert.match(terminal, /старший ТФ · ещё/);
  assert.match(terminal, /Архив без сделок/);
  assert.match(terminal, /Сохранён для анализа/);
  assert.match(service, /calculateShadowForecastResult/);
  assert.match(service, /evaluateDueForecasts/);
  assert.match(terminal, /Возможный винрейт/);
  assert.match(terminal, /статистика без влияния на баланс/);
  assert.match(terminal, /консервативно засчитан SL/);
  assert.match(terminal, /const displayedPnl = rubTrade \? nativePnl : pnl/);
  assert.match(terminal, /эквивалент.*USDT/);
  assert.match(terminal, /trade\.feesNative/);
  assert.doesNotMatch(service, /createOrder|placeOrder|apiSecret|apiKey/i);
});

test("an open paper position is visible on the selected chart and below it", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const chart = await readFile(new URL("../app/market-chart.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(terminal, /selectedOpenPositions/);
  assert.match(terminal, /open-position-board/);
  assert.match(terminal, /trade\.status === "OPEN"/);
  assert.match(chart, /ПОЗИЦИЯ .*ВХОД/);
  assert.match(chart, /ПОЗИЦИЯ · TP/);
  assert.match(chart, /ПОЗИЦИЯ · SL/);
  assert.match(chart, /entryIndex/);
  assert.match(styles, /\.open-position-card/);
});

test("forecast confluence is visible and distinguishes confirmed conflicts from missing data", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const confluence = await readFile(new URL("../app/forecast-confluence.ts", import.meta.url), "utf8");
  assert.match(terminal, /ConfluenceStrip/);
  assert.match(terminal, /Подтверждённый встречный сигнал блокирует вход/);
  assert.match(confluence, /ema-corridor/);
  assert.match(confluence, /legacy-macd/);
  assert.match(confluence, /entryConfirmations/);
});

test("paper journal exposes proportional strategy attribution", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const store = await readFile(new URL("../app/paper-trading-store.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(terminal, /Вклад стратегий в сделки/);
  assert.match(store, /strategyAttribution/);
  assert.match(styles, /paper-strategy-attribution/);
});

test("strategy research separates paper shadow history combinations and context", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const paperStore = await readFile(new URL("../app/paper-trading-store.ts", import.meta.url), "utf8");
  const journalStore = await readFile(new URL("../app/forecast-journal-store.ts", import.meta.url), "utf8");
  const journalRoute = await readFile(new URL("../app/api/forecast-journal/route.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(terminal, /ТЕКУЩАЯ PAPER-ВЕРСИЯ/);
  assert.match(terminal, /ТЕНЕВЫЕ ИДЕИ/);
  assert.match(terminal, /Лаборатория входа и защиты/);
  assert.match(terminal, /risk-lab-v4/);
  assert.match(terminal, /Пересчитать EMA-окна/);
  assert.match(terminal, /ИСТОРИЧЕСКИЙ ТЕСТ/);
  assert.match(terminal, /ЦЕПОЧКИ И КОНФЛИКТЫ/);
  assert.match(terminal, /MFE \/ MAE/);
  assert.match(paperStore, /paperCombinationStats/);
  assert.match(paperStore, /paperContextStats/);
  assert.match(journalStore, /trialProfitFactor/);
  assert.match(journalRoute, /backfillEvaluatedStrategyTrials/);
  assert.match(journalRoute, /backfill/);
  assert.match(styles, /research-layer-summary/);
});

test("VPA is visible, journaled, and explicitly remains a shadow diagnostic", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const forecast = await readFile(new URL("../app/terminal-forecast.ts", import.meta.url), "utf8");
  const journal = await readFile(new URL("../app/forecast-journal-store.ts", import.meta.url), "utf8");
  const chart = await readFile(new URL("../app/market-chart.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const snapshotBuilder = await readFile(new URL("../scripts/build_snapshot.py", import.meta.url), "utf8");
  assert.match(forecast, /analyzeVolumePrice/);
  assert.match(forecast, /strategyPolicy\.eligible \? pilot : null/);
  assert.match(journal, /vpa: metadata\.vpa/);
  assert.match(terminal, /VPA пока только собирает статистику/);
  assert.match(terminal, /journal-vpa/);
  assert.match(chart, /forecast\.vpa\.event !== "NEUTRAL"/);
  assert.match(styles, /strategy-chip\.lime/);
  assert.match(snapshotBuilder, /"id": "vpa"/);
});

test("Gerchik level action is visible, journaled, and excluded from trade permission", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const forecast = await readFile(new URL("../app/terminal-forecast.ts", import.meta.url), "utf8");
  const journal = await readFile(new URL("../app/forecast-journal-store.ts", import.meta.url), "utf8");
  const chart = await readFile(new URL("../app/market-chart.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const snapshotBuilder = await readFile(new URL("../scripts/build_snapshot.py", import.meta.url), "utf8");
  assert.match(forecast, /analyzeLevelAction/);
  assert.match(forecast, /selectivePolicy: true/);
  assert.match(forecast, /levelAction\.quality === "TRADEABLE"/);
  assert.match(journal, /levelAction: metadata\.levelAction/);
  assert.match(terminal, /УРОВНИ ГЕРЧИКА/);
  assert.match(terminal, /journal-level-action/);
  assert.match(chart, /forecast\?\.levelAction/);
  assert.match(styles, /strategy-chip\.gold/);
  assert.match(snapshotBuilder, /"id": "level-action"/);
});

test("top-down MACD+EMA is collected as an isolated shadow strategy", async () => {
  const terminal = await readFile(new URL("../app/trading-terminal.tsx", import.meta.url), "utf8");
  const forecast = await readFile(new URL("../app/terminal-forecast.ts", import.meta.url), "utf8");
  const strategies = await readFile(new URL("../app/experimental-strategies.ts", import.meta.url), "utf8");
  const agreement = await readFile(new URL("../app/forecast-confluence.ts", import.meta.url), "utf8");
  const attribution = await readFile(new URL("../app/paper-trading-store.ts", import.meta.url), "utf8");
  assert.match(strategies, /detectTopDownMacdEmaShadow/);
  assert.match(strategies, /STRICT_CLOSED_TF/);
  assert.match(terminal, /MACD\+EMA · сверху вниз/);
  assert.match(forecast, /strategyMatches\.filter\(\(match\) => match\.id === "ema-macd-selective" \|\| match\.id === "vpa"\)/);
  assert.doesNotMatch(agreement.match(/DECISION_STRATEGIES[\s\S]*?\]\);/)?.[0] ?? "", /macd-ema-topdown/);
  assert.doesNotMatch(attribution.match(/ATTRIBUTABLE_STRATEGIES[\s\S]*?\]\);/)?.[0] ?? "", /macd-ema-topdown/);
});

test("weekly audit contains confluence and three shadow exit rules", async () => {
  const audit = await readFile(new URL("../scripts/audit_confluence.mjs", import.meta.url), "utf8");
  assert.match(audit, /BREAK_EVEN_1/);
  assert.match(audit, /TRAIL_1_AFTER_2/);
  assert.match(audit, /KEEP_HALF_AFTER_1/);
  assert.match(audit, /excludedByTwoConfirmationRule/);
  assert.match(audit, /stopPlacementAudit/);
  assert.match(audit, /fixedStopShadow/);
  assert.match(audit, /emaWindowShadow/);
  assert.match(audit, /topDownMacdEmaShadow/);
  assert.match(audit, /bySourceBoundary/);
  assert.match(audit, /pendingDataQuality/);
  assert.match(audit, /shadowVariantSummary/);
});
