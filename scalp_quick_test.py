import trade_bot_macd as B

B.CONFIG["SCALP_MODE"] = True
for k, v in B.CONFIG["SCALP_CONFIG"].items():
    B.CONFIG[k] = v
B.CONFIG["SYMBOLS"] = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "XRPUSDT", "ADAUSDT", "BNBUSDT"]
B.CONFIG["DRY_RUN"] = True
B.refresh_runtime_config()


if __name__ == "__main__":
    B.logger.info("SCALP quick-test: 6 symbols, DRY_RUN=True")
    B.run_bot()
