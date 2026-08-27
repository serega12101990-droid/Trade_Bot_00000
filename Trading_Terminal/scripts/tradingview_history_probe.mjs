import { fetchTradingViewHistory } from "./tradingview-history-client.mjs";

const symbol = process.argv[2] ?? "SBERP";
const timeframe = process.argv[3] ?? "15m";
const bars = await fetchTradingViewHistory(symbol, timeframe, 500);
console.log(JSON.stringify({ symbol, timeframe, count: bars.length, first: bars[0], last: bars.at(-1) }));
