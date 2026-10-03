import type { Metadata } from "next";
import { TradingTerminal } from "./trading-terminal";

export const metadata: Metadata = {
  title: "Northstar Trading Terminal",
  description: "Локальный терминал визуального анализа EMA, MACD, свечных моделей и торговых журналов.",
};

export default function Home() {
  return <TradingTerminal />;
}
