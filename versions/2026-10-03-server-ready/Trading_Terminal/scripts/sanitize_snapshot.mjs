import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
// Release packaging only. Never run this against an active installation.
const source = resolve(process.argv[2] ?? '');
const target = resolve('public/data/terminal_snapshot.json');
if (!process.argv[2] || source === target) throw new Error('Pass a DIFFERENT source snapshot; active snapshot must not be overwritten');
const original = JSON.parse(await readFile(source, 'utf8'));
const assets = original.assets.map(({ symbol, displaySymbol, name, market }) => ({ symbol, displaySymbol, name, market, quote: { price: null, changePct: null, high: null, low: null }, data: {}, signal: null }));
const strategies = original.strategies.map(({ id, name, shortName, status, statusLabel, description, enabled }) => ({ id, name, shortName, status, statusLabel, description, enabled, winRate: null, expectancy: null }));
const clean = { version: original.version, mode: 'LOCAL_READ_ONLY', generatedAt: new Date().toISOString(), marketDataSavedAt: null, assetCount: assets.length, assets, strategies,
  tradeSummary: { count: 0, wins: 0, losses: 0, netPnlPct: 0, recent: [] }, sources: { tradingProject: 'Public source distribution; no private history', widget: 'No private widget data', ordersEnabled: false } };
await writeFile(target, JSON.stringify(clean, null, 2) + '\n');
// Tests use frozen PUBLIC OHLCV only, not the user's balances, signals or journal.
await mkdir('tests/fixtures', { recursive: true });
const fixture = { assets: original.assets.map(({ symbol, market, data }) => ({ symbol, market, data: Object.fromEntries(Object.entries(data).map(([tf, bars]) => [tf, bars.map(({ time, open, high, low, close, volume, closed }) => ({ time, open, high, low, close, volume, ...(closed == null ? {} : { closed }) }))])) })) };
await writeFile('tests/fixtures/market-candles.json', JSON.stringify(fixture) + '\n');
console.log(`Sanitized release seed: ${assets.length} instruments, no trades, prices, signals, private paths or performance stats.`);
