#!/usr/bin/env python3
"""
scalp_bot.py — отдельный скальп-режим поверх trade_bot_macd.

Запуск:
    cd в папку trade_bot_MACD
    .venv\Scripts\python scalp_bot.py

    (путь: Project X / Trade_DEMO_bot / trade_bot_MACD / scalp_bot.py)

Что делает:
  - Включает CONFIG["SCALP_MODE"] = True -> применяется SCALP_CONFIG (пресет).
  - Только 15m/30m/60m, рыночный вход сразу, тейк 0.35–1.0%, трейлинг 0.15%.
  - SCALE-OUT: закрывает 50% у +0.35%, остаток защищает безубытком/трейлингом.
  - ICT/Нисон фильтры ВЫКЛЮЧЕНЫ (для скальпа слишком редкие).
  - DRY_RUN = True (из пресета) -> ордера НЕ отправляются, только симуляция в логе.
    Чтобы торговать реально — в SCALP_CONFIG поставьте "DRY_RUN": False (только с разрешения).

Всё ядро (MACD, WS, трейлинг, resync) — из trade_bot_macd, не дублируется.
"""

import trade_bot_macd as B

# Включаем скальп-пресет ДО импорта main_loop (CONFIG уже применён при импорте модуля,
# поэтому явно переapply-им пресет здесь).
B.CONFIG["SCALP_MODE"] = False
_sc = B.CONFIG.get("SCALP_CONFIG", {})
for _k, _v in _sc.items():
    B.CONFIG[_k] = _v

# Пересчитываем все производные настройки после применения пресета.
B.refresh_runtime_config()

if __name__ == "__main__":
    B.logger.info("=" * 60)
    B.logger.info(" SСАЛЬП-БОТ ЗАПУЩЕН (SCALP_MODE=True)")
    B.logger.info(f" DRY_RUN={B.DRY_RUN} | ТФ={B.CONFIG['MACD_CROSS_CASCADE_TFS']} | ICT={B.CONFIG['USE_ICT_MODEL']}")
    B.logger.info(f" SCALE-OUT={B.CONFIG.get('SCALP_SCALE_OUT')} | первый тейк +{B.CONFIG.get('SCALP_FIRST_TP_PCT')}% | буфер SL {B.CONFIG['IMPULSE_TRAIL_BUFFER']}%")
    B.logger.info("=" * 60)
    B.run_bot()
