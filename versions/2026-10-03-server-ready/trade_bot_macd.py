import time
import os
import sys
import math
import csv
import logging
import threading
import random
import uuid
from decimal import Decimal, ROUND_DOWN, ROUND_UP
from collections import deque
from datetime import datetime, timedelta

# ============================================================
# API-КЛЮЧИ BYBIT
# Секреты хранятся только в .env и никогда не вставляются в исходник.
# ============================================================
# python-dotenv опционален: если установлен, загружаем локальный .env.
try:
    from dotenv import load_dotenv
    _ENV_FILE = (os.getenv("BYBIT_ENV_FILE", "") or "").strip()
    load_dotenv(_ENV_FILE or None)
    _ENV_KEY = (os.getenv("BYBIT_API_KEY", "") or "").strip()
    _ENV_SECRET = (os.getenv("BYBIT_API_SECRET", "") or "").strip()
except Exception:
    _ENV_KEY = ""
    _ENV_SECRET = ""

# Единственный штатный источник секретов — .env.
_API_KEY = _ENV_KEY
_API_SECRET = _ENV_SECRET

import requests
from pybit.unified_trading import HTTP, WebSocket  # WebSocket — публичный рыночный стрим (только чтение)

# ============================================================
# НАСТРОЙКИ (единый словарь)
# ============================================================
CONFIG = {
    # ---- Ключи из локального .env ----
    "API_KEY": _API_KEY,
    "API_SECRET": _API_SECRET,
    "CATEGORY": "linear",
    "POSITION_IDX": 0,          # 0 = one-way; для hedge mode используйте 1 (Buy) / 2 (Sell)
    "DEMO_MODE": True,           # True -> api-demo.bybit.com (ваш ключ ОТТУДА работает, retCode 0).
                                  # Подтверждено проверкой check_env.py: на api-demo retCode 0,
                                  # на api.bybit.com (mainnet) -> 10003 (ключ не оттуда).
    # DRY_RUN: True -> НЕ отправляет реальные ордера, симулирует вход/выход по TP/SL.
    # Безопасный режим для проверки логики. Поставьте False только когда уверены.
    "DRY_RUN": True,

    # ---- Инструменты и таймфреймы ----
    "SYMBOLS": [
        "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT",
        "BNBUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT",
    ],
    "TIMEFRAMES": [15, 30, 60, 240, 1440, 10080],
    "ENTRY_TF": 15,
    "TRAILING_TF": 5,           # 5-минутный ТФ для трейлинга

    # ---- Паттерны ----
    "DOJI_THRESHOLD": 0.1,
    "HAMMER_THRESHOLD": 0.3,
    "PINBAR_THRESHOLD": 0.3,

    # ---- MACD ----
    "MACD_FAST": 12,
    "MACD_SLOW": 26,
    "MACD_SIGNAL": 9,

    # ---- Скоринг ----
    "WEIGHT_MAP": {15: 1.0, 30: 1.5, 60: 2.0, 240: 3.0, 1440: 8.0, 10080: 10.0},
    "THRESHOLD_SCORE": 5.0,
    "PENALTY_FOR_MACD_CONFLICT": 5,

    # ---- Риск-менеджмент ----
    "COMMISSION": 0.00055,
    "MAX_SPREAD_PCT": 0.08,
    "RISK_PER_TRADE": 0.5,
    "DRY_RUN_BALANCE_USDT": 10000.0,
    "USE_LIMIT_ORDERS": True,
    "LIMIT_OFFSET_PERCENT": 0.15,
    "ORDER_TIMEOUT": 180,
    "RE_ENTRY_AFTER_SL": 3,           # в "свечах" ENTRY_TF (3*15м = 45 мин пауза)
    "ENTER_CONFIRM_BARS": 1,          # подтверждение сигнала через N свечей входа

    # === ГИБРИДНЫЙ ВХОД (Вариант 2): импульс -> рынок сразу, спокойно -> лимит на откат ===
    # Если за время ожидания подтверждения цена ушла >= IMPULSE_ENTRY_PCT в сторону сигнала,
    # считаем это ИМПУЛЬСОМ и входим ПО РЫНКУ сразу (не ждём отката, не проверяем slippage).
    # Иначе -> обычная лимитная логика (вход на 0.85% ниже TP, как раньше).
    "IMPULSE_ENTRY_PCT": 0.30,        # % движения за время подтверждения = импульс
    "IMPULSE_MARKET_ENTRY": True,     # True -> при импульсе входим по рынку
    # Ограничение одновременных сделок (защита депо от 5 SL разом)
    "MAX_OPEN_TRADES": 2,             # крипто-пары коррелируют: ограничиваем совокупный риск
    "POSITION_POLL_INTERVAL": 15,     # приватный API не опрашиваем каждые 5 секунд

    # === БЫСТРЫЙ TP по 5m (для импульсных сделок на младших ТФ 15/30m) ===
    # Если цена У EMA200(5m) [выше для Buy / ниже для Sell] -> TP = ближайший экстремум 5m
    #   в сторону сделки (ловим импульс до следующего макс/миним на 5m).
    # Если цена ПРОТИВ EMA200(5m) -> TP = EMA200(5m) как безопасный ближайший уровень.
    "USE_TP_5M_FOR_FAST_TF": True,        # TP по 5m для trigger_tf <= TP_5M_MAX_TF
    "TP_5M_MAX_TF": 30,                   # применяем 5m-TP для ТФ сигнала <= 30m (15/30m)
    "TP_5M_BUFFER": 0.1,                  # % недобора до 5m-экстремума / EMA200 (цена часто не доходит)
    "TP_5M_LOOKBACK": 60,                 # сколько свечей 5m смотрим назад для ближайшего экстремума
    "TP_5M_MIN_PCT": 0.35,                # мин. дистанция TP (чтобы окупить комиссию ~0.11% + запас)

    # === ICT-МОДЕЛЬ: Фибо + OTE + FVG (приоритет старших ТФ 4h/1d) ===
    # Контекст (бычий/медвежий) определяется по EMA200 на 4h и 1d.
    # Фибо строится на 15m от ноги (Low->High бычий / High->Low медвежий).
    # OTE = 0.62-0.79 от ноги. Вход ТОЛЬКО если OTE пересекается с FVG (жёсткий фильтр).
    # TP (вариант В) = ближайший ликвидный уровень (хай/лоу ноги). SL = за FVG + буфер.
    # Управление (вариант А) = жёсткий трейлинг при развороте MACD (уже реализован).
    "USE_ICT_MODEL": True,                # включить ICT-фильтр входа (приоритет старших ТФ)
    "ICT_ENTRY_BUFFER": 0.15,             # % допуска цены к зоне OTE∩FVG при входе
    "ICT_LEG_WINDOW": 100,                # свечей 15m для поиска импульсной ноги
    "ICT_MIN_LEG_ATR": 2.0,               # нога должна быть не меньше двух ATR
    "ICT_FVG_WINDOW": 50,                 # свечей 15m для поиска FVG (недавние гэпы)
    "ICT_CONTEXT_TFS": [1440, 240],       # старшие ТФ для контекста (1d, 4h); 1d — приоритет
    "ICT_CONTEXT_TF": 240,                 # ТОЛЬКО 4h как контекст (1d НЕ блокирует вход — ослаблено для частоты)

    # === СВЕЧНЫЕ ПАТТЕРНЫ НИСОНА (фильтр разворота на OTE∩FVG, 15m) ===
    # Жёсткий фильтр: вход только если в зоне ICT (OTE∩FVG + контекст) есть свечной
    # паттерн-разворот нужной стороны (Молот/Поглощение/Звезда и т.п. по С. Нисону).
    "USE_NISON_PATTERNS": True,          # включить свечной фильтр Нисона
    "NISON_SHADOW_MULT": 2.0,            # хвост >= 2x тела для Молота/Звезды
    "NISON_MIN_BODY_RATIO": 0.1,         # тело >= 10% от диапазона (не считать доджи молотом)
    "NISON_LOOKBACK": 3,                  # сколько последних свечей 15m смотрим (для звезды нужно 3)
    # TP/SL берутся от локального Max/Min (свинга) последних N свечей ТОГО ЖЕ ТФ, где перекрёст.
    # SL ставим С ЗАПАСОМ ЗА уровнем ликвидности (за Max/Min) -> "охота за стопами" нас не задевает.
    # TP ставим С НЕДОБОРОМ (чуть ниже Max) -> цена часто не доходит до самого пика.
    "STRUCT_LOOKBACK": 50,            # сколько свечей ТФ сигнала сканируем на подтверждённые pivot-уровни
    "STRUCT_SWING": 12,               # сначала ищем уровни среди недавних свечей
    "STRUCT_PIVOT_RADIUS": 2,         # pivot подтверждают две свечи слева и справа
    "SL_STRUCT_BUFFER": 0.40,         # % запаса ЗА структурным уровнем (не достаёт до нашего SL)
    "TP_STRUCT_BUFFER": 0.25,         # % недобора ДО структурного максимума (цена часто не доходит)
    "TP_ATR_MULTIPLIER": 1.5,         # TP на базе ATR, если рядом нет экстремума (ликвидные BTC/ETH/SOL)
    "MIN_TP_PERCENT": 0.30,           # мин. дистанция TP от входа (не микро-TP)
    "MAX_TP_PERCENT": 5.0,            # макс. дистанция TP (выше -> не берём, TP недостижим)
    "SL_ATR_MULTIPLIER": 2.0,         # запас SL за структурным уровнем (x ATR ТФ сигнала)
    # Выход по окончанию импульса (вариант 1): 100% закрытие, если на EXIT_IMPULSE_TF импульс развернулся
    "EXIT_IMPULSE_TF": 15,            # ТФ для отслеживания окончания импульса
    "EXIT_IMPULSE_PCT": 0.30,         # откат от пика/впадины сделки на % -> фиксируем (шум-фильтр)
    "EXIT_ZERO_CROSS": True,          # TRUE -> пересечение MACD через 0 (смена знака) тоже = конец импульса
                                     # (срабатывает РАНЬШЕ пересечения signal_line, точнее ловит конец импульса)
    # УСКОРЕННОЕ закрытие КОНТР-ТРЕНДОВЫХ сделок (цена против EMA200 на 1d):
    # режем чувствительнее — малейший разворот импульса -> выход, т.к. отскок в даунтренде короткий.
    "EXIT_IMPULSE_PCT_CT": 0.15,      # порог отката для контр-тренда (в 2 раза чувствительнее)
    "EXIT_ZERO_CROSS_CT": True,       # для контр-тренда пересечение нуля MACD -> выход сразу (без отката)
    "EXIT_TREND_TF": 60,              # ТФ для проверки "тренд против" (1h): если там MACD против -> усилить выход

    "MIN_SL_PERCENT": 0.01,
    "MAX_POSITION_USDT": 10000,
    "EMA_CLOSE_PROXIMITY": 0.015,
    "MIN_RISK_REWARD_RATIO": 1.20,

    # Структурный SL (из TESTTT)
    "STRUCTURAL_SL_LOOKBACK": 10,
    "STRUCTURAL_SL_BUFFER": 0.002,

    "MAX_ENTRY_SLIPPAGE": 0.005,
    "FILTER_MINOR_TF_MACD": True,
    "MIN_ATR_PERCENT": 0.002,

    # ============================================================
    # СТРАТЕГИЯ: EMA-step pullback + каскад подтверждений (свечи=MACD=EMA на каждом ТФ)
    # Суть (от трейдера): ищем разворот на 5m, цель = СЛЕДУЮЩАЯ EMA по иерархии
    # (20->50->200), без перескоков. Подтверждение ищем каскадом ТФ 5->15->30->...
    # чем старше ТФ подтвердил, тем сильнее сигнал. Вход по пробою подтверждения
    # с буфером (после пробоя цена часто не рвётся сразу). Учитываем "стену" —
    # EMA старшего ТФ, стоящую на пути против сделки.
    # ============================================================
    "CONFIRM_TFS": [5, 15, 30, 60, 240, 1440, 10080],  # каскад подтверждений (5m первый)
    # === НОВАЯ МОДЕЛЬ: MACD-cross на 15m + каскад подтверждений ===
    "MACD_CROSS_CASCADE_TFS": [15, 30, 60, 240, 1440, 10080],  # все ТФ кроме 5m (5m = шум)
    "TF_WEIGHTS": {15: 1.0, 30: 1.5, 60: 2.0, 240: 3.0, 1440: 4.0, 10080: 5.0},  # старше ТФ = сильнее
    "MIN_CONFIRM_STRENGTH": 2.0,  # мин. сила каскада: нужно хотя бы 15m + ещё 1 ТФ подтвердил (или сильный 15m)
    "MIN_NET_PROFIT_PCT": 0.30,   # комиссия + проскальзывание + минимальный запас ожидания
    "BASE_TF": 15,                  # ТФ для детекта перекреста MACD и EMA для SL/TP
    "EMA_STEPS": [20, 50, 200],     # иерархия EMA: цель импульса = ближайшая EMA в сторону сделки
    "EMA_ENTRY_BUFFER_PCT": 0.85,   # окно входа: лимит чуть ниже/выше цели (буфер ~0.85%)
    "SL_BUFFER_PCT": 0.40,          # отступ SL за ближайшей EMA
    "MIN_ATR_PERCENT": 0.002,       # фильтр низкой волатильности (0.2%)
    "MIN_RISK_REWARD_RATIO": 1.20,

    # ---- Трейлинг ----
    "TRAILING_STOP_ENABLED": True,
    # ЖЁСТКИЙ ТРЕЙЛИНГ при окончании импульса (ловим импульс -> фиксируем прибыль у SL вплотную к цене)
    "IMPULSE_TRAIL_ENABLED": True,       # при окончании импульса подтягивать SL к текущей цене, а не закрывать сразу
    "IMPULSE_TRAIL_BUFFER": 0.15,        # % буфера: SL = цена ∓ буфер (защита от разворота в минус)
    "IMPULSE_TRAIL_CLOSE_IF_LOSS": 0.3,  # если в минусе глубже этого %, закрываем сразу (не ждём касания SL)
    # Трейлинг (подтягивание SL за ценой ВО ВРЕМЯ импульса): убираем порог прибыли, чтобы работал сразу
    "TRAILING_STOP_ENABLED": True,
    "TRAILING_METHOD": "ATR",
    "TRAILING_MIN_PROFIT_PCT": 0.25,     # не душим новую сделку трейлингом в первые секунды
    "TRAILING_STEP_PCT": 0.1,            # мин. шаг перестановки SL (чтобы не дёргать каждый тик)
    "TRAILING_USE_EMA50": True,
    "TRAILING_OFFSET_PCT": 0.5,
    "TRAILING_ATR_MULTIPLIER": 1.5,

    # ---- Лоты ----
    "LOT_INFO": {
        "BTCUSDT": {"min": 0.001, "max": 100, "step": 0.001},
        "ETHUSDT": {"min": 0.01, "max": 1000, "step": 0.01},
        "SOLUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "XRPUSDT": {"min": 1.0, "max": 100000, "step": 1.0},
        "BNBUSDT": {"min": 0.01, "max": 1000, "step": 0.01},
        "ADAUSDT": {"min": 1.0, "max": 100000, "step": 1.0},
        "DOGEUSDT": {"min": 1.0, "max": 100000, "step": 1.0},
        "DOTUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "LINKUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "AVAXUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "ATOMUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "UNIUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "LTCUSDT": {"min": 0.01, "max": 1000, "step": 0.01},
        "BCHUSDT": {"min": 0.01, "max": 1000, "step": 0.01},
        "NEARUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "ALGOUSDT": {"min": 1.0, "max": 100000, "step": 1.0},
        "ATOMUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "ICPUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
        "ETCUSDT": {"min": 0.01, "max": 1000, "step": 0.01},
        "XLMUSDT": {"min": 1.0, "max": 100000, "step": 1.0},
        "AAVEUSDT": {"min": 0.01, "max": 1000, "step": 0.01},
        "CRVUSDT": {"min": 0.1, "max": 10000, "step": 0.1},
    },

    # ============================================================
    # СКАЛЬП-РЕЖИМ (SCALP_MODE=True): отдельный пресет поверх базы.
    # Запускается через scalp_bot.py. Только 15m/30m, тейк 0.2-0.5%,
    # жёсткий трейлинг + scale-out (частичное закрытие 50% у первого тейка).
    # ============================================================
    "SCALP_MODE": False,                # True -> применяем SCALP_CONFIG (включается из scalp_bot.py)
    "SCALP_CONFIG": {
        "DRY_RUN": True,                # скальп-тест ВСЕГДА в симуляции (не рискуем реалом без вас)
        "SYMBOLS": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT"],
        "USE_ICT_MODEL": False,         # скальп не ждёт OTE∩FVG+Нисон — слишком редко для скальпа
        "USE_NISON_PATTERNS": False,
        "MACD_CROSS_CASCADE_TFS": [15, 30, 60],   # только быстрые ТФ
        "MIN_CONFIRM_STRENGTH": 2.5,    # вход только с подтверждением ещё одного ТФ
        "MIN_RISK_REWARD_RATIO": 1.30,
        "MIN_NET_PROFIT_PCT": 0.30,
        "RISK_PER_TRADE": 0.35,
        "SL_ATR_MULTIPLIER": 1.2,
        "SL_STRUCT_BUFFER": 0.15,
        "TP_STRUCT_BUFFER": 0.05,
        "MIN_TP_PERCENT": 0.35,         # запас над комиссией и обычным проскальзыванием
        "MAX_TP_PERCENT": 1.0,          # не держим больше 1% — это скальп
        "TP_5M_MIN_PCT": 0.35,
        "TP_5M_MAX_TF": 30,             # 5m-TP для 15/30m
        "USE_TP_5M_FOR_FAST_TF": True,
        "IMPULSE_MARKET_ENTRY": True,   # рыночный вход сразу (без лимита/отката)
        "EXIT_IMPULSE_TF": 15,
        "EXIT_IMPULSE_PCT": 0.25,
        "EXIT_IMPULSE_PCT_CT": 0.15,
        "EXIT_ZERO_CROSS": True,
        "IMPULSE_TRAIL_ENABLED": True,
        "IMPULSE_TRAIL_BUFFER": 0.15,
        "IMPULSE_TRAIL_CLOSE_IF_LOSS": 0.25,
        "MAX_OPEN_TRADES": 2,
        "MAX_POSITION_USDT": 300,
        "MIN_ATR_PERCENT": 0.002,
        # --- SCALE-OUT (частичное закрытие) ---
        "SCALP_SCALE_OUT": True,        # закрыть 50% у первого тейка, остальное тащить трейлингом
        "SCALP_FIRST_TP_PCT": 0.35,
        "SCALP_SCALE_OUT_RATIO": 0.5,   # доля закрываемая на первом тейке
        # --- СПРЕД-ФИЛЬТР (не входим, если спред широкий) ---
        "MAX_SPREAD_PCT": 0.05,
    },
}

# Применение скальп-пресета (если SCALP_MODE=True, включается из scalp_bot.py)
if CONFIG.get("SCALP_MODE", False):
    _sc = CONFIG.get("SCALP_CONFIG", {})
    for _k, _v in _sc.items():
        CONFIG[_k] = _v

# Производные константы (для совместимости с телом кода)
SYMBOLS = CONFIG["SYMBOLS"]
TIMEFRAMES = CONFIG["TIMEFRAMES"]
ENTRY_TF = CONFIG["ENTRY_TF"]
TRAILING_TF = CONFIG["TRAILING_TF"]

DOJI_THRESHOLD = CONFIG["DOJI_THRESHOLD"]
HAMMER_THRESHOLD = CONFIG["HAMMER_THRESHOLD"]
PINBAR_THRESHOLD = CONFIG["PINBAR_THRESHOLD"]
MACD_FAST = CONFIG["MACD_FAST"]
MACD_SLOW = CONFIG["MACD_SLOW"]
MACD_SIGNAL = CONFIG["MACD_SIGNAL"]
WEIGHT_MAP = CONFIG["WEIGHT_MAP"]
THRESHOLD_SCORE = CONFIG["THRESHOLD_SCORE"]

CATEGORY = CONFIG["CATEGORY"]
COMMISSION = CONFIG["COMMISSION"]
RISK_PER_TRADE = CONFIG["RISK_PER_TRADE"]
USE_LIMIT_ORDERS = CONFIG["USE_LIMIT_ORDERS"]
LIMIT_OFFSET_PERCENT = CONFIG["LIMIT_OFFSET_PERCENT"]
ORDER_TIMEOUT = CONFIG["ORDER_TIMEOUT"]
RE_ENTRY_AFTER_SL = CONFIG["RE_ENTRY_AFTER_SL"]
IMPULSE_ENTRY_PCT = CONFIG["IMPULSE_ENTRY_PCT"]
IMPULSE_MARKET_ENTRY = CONFIG["IMPULSE_MARKET_ENTRY"]
MAX_OPEN_TRADES = CONFIG["MAX_OPEN_TRADES"]
MIN_SL_PERCENT = CONFIG["MIN_SL_PERCENT"]
SL_ATR_MULTIPLIER = CONFIG["SL_ATR_MULTIPLIER"]
MAX_TP_PERCENT = CONFIG["MAX_TP_PERCENT"]
MAX_POSITION_USDT = CONFIG["MAX_POSITION_USDT"]
EMA_CLOSE_PROXIMITY = CONFIG["EMA_CLOSE_PROXIMITY"]
PENALTY_FOR_MACD_CONFLICT = CONFIG["PENALTY_FOR_MACD_CONFLICT"]
MIN_RISK_REWARD_RATIO = CONFIG["MIN_RISK_REWARD_RATIO"]
FILTER_MINOR_TF_MACD = CONFIG["FILTER_MINOR_TF_MACD"]
LOT_INFO = CONFIG["LOT_INFO"]
TRAILING_STOP_ENABLED = CONFIG["TRAILING_STOP_ENABLED"]
TRAILING_MIN_PROFIT_PCT = CONFIG["TRAILING_MIN_PROFIT_PCT"]
TRAILING_STEP_PCT = CONFIG["TRAILING_STEP_PCT"]
TRAILING_USE_EMA50 = CONFIG["TRAILING_USE_EMA50"]
TRAILING_OFFSET_PCT = CONFIG["TRAILING_OFFSET_PCT"]


def refresh_runtime_config():
    """Обновляет производные настройки после применения пресета."""
    global SYMBOLS, TIMEFRAMES, ENTRY_TF, TRAILING_TF
    global MACD_FAST, MACD_SLOW, MACD_SIGNAL
    global CATEGORY, COMMISSION, RISK_PER_TRADE, USE_LIMIT_ORDERS
    global LIMIT_OFFSET_PERCENT, ORDER_TIMEOUT, RE_ENTRY_AFTER_SL
    global IMPULSE_ENTRY_PCT, IMPULSE_MARKET_ENTRY, MAX_OPEN_TRADES
    global MIN_SL_PERCENT, SL_ATR_MULTIPLIER, MAX_TP_PERCENT
    global MAX_POSITION_USDT, EMA_CLOSE_PROXIMITY, PENALTY_FOR_MACD_CONFLICT
    global MIN_RISK_REWARD_RATIO, FILTER_MINOR_TF_MACD, LOT_INFO
    global TRAILING_STOP_ENABLED, TRAILING_MIN_PROFIT_PCT
    global TRAILING_STEP_PCT, TRAILING_USE_EMA50, TRAILING_OFFSET_PCT
    global DRY_RUN

    SYMBOLS = CONFIG["SYMBOLS"]
    TIMEFRAMES = CONFIG["TIMEFRAMES"]
    ENTRY_TF = CONFIG["ENTRY_TF"]
    TRAILING_TF = CONFIG["TRAILING_TF"]
    MACD_FAST = CONFIG["MACD_FAST"]
    MACD_SLOW = CONFIG["MACD_SLOW"]
    MACD_SIGNAL = CONFIG["MACD_SIGNAL"]
    CATEGORY = CONFIG["CATEGORY"]
    COMMISSION = CONFIG["COMMISSION"]
    RISK_PER_TRADE = CONFIG["RISK_PER_TRADE"]
    USE_LIMIT_ORDERS = CONFIG["USE_LIMIT_ORDERS"]
    LIMIT_OFFSET_PERCENT = CONFIG["LIMIT_OFFSET_PERCENT"]
    ORDER_TIMEOUT = CONFIG["ORDER_TIMEOUT"]
    RE_ENTRY_AFTER_SL = CONFIG["RE_ENTRY_AFTER_SL"]
    IMPULSE_ENTRY_PCT = CONFIG["IMPULSE_ENTRY_PCT"]
    IMPULSE_MARKET_ENTRY = CONFIG["IMPULSE_MARKET_ENTRY"]
    MAX_OPEN_TRADES = CONFIG["MAX_OPEN_TRADES"]
    MIN_SL_PERCENT = CONFIG["MIN_SL_PERCENT"]
    SL_ATR_MULTIPLIER = CONFIG["SL_ATR_MULTIPLIER"]
    MAX_TP_PERCENT = CONFIG["MAX_TP_PERCENT"]
    MAX_POSITION_USDT = CONFIG["MAX_POSITION_USDT"]
    EMA_CLOSE_PROXIMITY = CONFIG["EMA_CLOSE_PROXIMITY"]
    PENALTY_FOR_MACD_CONFLICT = CONFIG["PENALTY_FOR_MACD_CONFLICT"]
    MIN_RISK_REWARD_RATIO = CONFIG["MIN_RISK_REWARD_RATIO"]
    FILTER_MINOR_TF_MACD = CONFIG["FILTER_MINOR_TF_MACD"]
    LOT_INFO = CONFIG["LOT_INFO"]
    TRAILING_STOP_ENABLED = CONFIG["TRAILING_STOP_ENABLED"]
    TRAILING_MIN_PROFIT_PCT = CONFIG["TRAILING_MIN_PROFIT_PCT"]
    TRAILING_STEP_PCT = CONFIG["TRAILING_STEP_PCT"]
    TRAILING_USE_EMA50 = CONFIG["TRAILING_USE_EMA50"]
    TRAILING_OFFSET_PCT = CONFIG["TRAILING_OFFSET_PCT"]
    DRY_RUN = CONFIG["DRY_RUN"]

# ============================================================
# ЛОГИ (в подпапку logs/ внутри проекта — меньше блокировок OneDrive)
# ============================================================
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
RUN_ID = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, "demo_trader_v7.log"), encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)
trade_logger = logging.getLogger("trade")
trade_logger.setLevel(logging.INFO)
trade_handler = logging.FileHandler(os.path.join(LOG_DIR, "trades_v7.log"), encoding='utf-8')
trade_handler.setFormatter(logging.Formatter('%(asctime)s - %(message)s'))
trade_logger.addHandler(trade_handler)

logger.info(f"Логи сохраняются в: {LOG_DIR}")

STATS_CSV = os.path.join(LOG_DIR, "trades_stats_v7.csv")
INSTANCE_LOCK_PATH = os.path.join(LOG_DIR, "trade_bot.lock")
_instance_lock_handle = None
STATS_HEADERS = [
    "run_id",
    "timestamp_open", "symbol", "side", "entry_price", "qty",
    "timestamp_close", "exit_price", "gross_pnl_pct", "result",
    "commission_usdt", "net_pnl_pct",
    "score", "trigger_tf", "confirmation_tf", "setup", "pattern",
    "planned_rr", "counter_trend", "scaled_out",
    "ema20_entry", "ema50_entry", "ema200_entry",
    "macd_entry", "signal_entry",
    "sl", "tp", "expected_gain_pct", "expected_loss_pct",
    "duration_minutes", "gross_pnl_usdt", "net_pnl_usdt",
    "entry_order_id", "exit_order_id",
    "entry_execution_confirmed", "exit_execution_confirmed",
    "exit_reason"
]

def init_stats_csv():
    if os.path.exists(STATS_CSV):
        with open(STATS_CSV, 'r', newline='', encoding='utf-8') as f:
            reader = csv.reader(f, delimiter=';')
            headers = next(reader, [])
        if headers == STATS_HEADERS:
            return
        backup = os.path.join(
            LOG_DIR,
            f"stats_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.csv",
        )
        os.rename(STATS_CSV, backup)
        logger.info(f"Старый файл статистики сохранён в {backup}")
    with open(STATS_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f, delimiter=';')
        writer.writerow(STATS_HEADERS)
init_stats_csv()


def acquire_instance_lock():
    """Не позволяет двум копиям бота одновременно управлять одним аккаунтом."""
    global _instance_lock_handle
    try:
        import msvcrt

        handle = open(INSTANCE_LOCK_PATH, "a+", encoding="utf-8")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(" ")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        handle.seek(0)
        handle.write(f"{os.getpid()} {RUN_ID}".ljust(80))
        handle.flush()
        _instance_lock_handle = handle
        return True
    except Exception as e:
        logger.critical(f"Другая копия бота уже запущена или lock недоступен: {e}")
        return False


# ============================================================
# ПОСТОЯННАЯ СЕССИЯ ДЛЯ REST (из TESTTT: retry + единый сокет)
# ============================================================
public_session = requests.Session()
public_session.headers.update({'User-Agent': 'Mozilla/5.0'})

class SafeSession:
    def __init__(self, api_key, api_secret, demo=True):
        self.session = HTTP(testnet=False, demo=demo, api_key=api_key,
                            api_secret=api_secret, recv_window=30000)

    def _call(self, func, *args, retries=3, **kwargs):
        for attempt in range(retries):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                message = str(e)
                # Повторять детерминированные ошибки параметров/прав бессмысленно и опасно
                # для place_order: задерживает цикл и может скрыть ошибку конфигурации.
                non_retryable = any(code in message for code in (
                    "ErrCode: 10001",  # invalid parameter / qty
                    "ErrCode: 10003",  # invalid key
                    "ErrCode: 10005",  # permission denied
                    "ErrCode: 110001", # order does not exist
                    "ErrCode: 110003", # price outside range
                    "ErrCode: 110007", # insufficient balance
                ))
                logger.warning(f"API error: {e}, attempt {attempt+1}/{retries}")
                if non_retryable:
                    raise
                time.sleep(2 ** attempt)
        raise Exception(f"API call failed after {retries} attempts")

    def get_wallet_balance(self, **kwargs):
        return self._call(self.session.get_wallet_balance, **kwargs)

    def get_positions(self, **kwargs):
        return self._call(self.session.get_positions, **kwargs)

    def place_order(self, **kwargs):
        return self._call(self.session.place_order, **kwargs)

    def set_trading_stop(self, **kwargs):
        return self._call(self.session.set_trading_stop, **kwargs)

    def get_open_orders(self, **kwargs):
        return self._call(self.session.get_open_orders, **kwargs)

    def get_order_history(self, **kwargs):
        return self._call(self.session.get_order_history, **kwargs)

    def cancel_order(self, **kwargs):
        return self._call(self.session.cancel_order, **kwargs)

    def get_executions(self, **kwargs):
        return self._call(self.session.get_executions, **kwargs)

    def get_instruments_info(self, **kwargs):
        return self._call(self.session.get_instruments_info, **kwargs)

    def get_tickers(self, **kwargs):
        return self._call(self.session.get_tickers, **kwargs)

# единый экземпляр (demo=True везде, как в v6)
session = SafeSession(CONFIG["API_KEY"], CONFIG["API_SECRET"], demo=CONFIG["DEMO_MODE"])

# Глобальный флаг сухого прогона
DRY_RUN = CONFIG["DRY_RUN"]

# ============================================================
# ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
# ============================================================
open_trades = {}
last_sl_time = {}

current_params = {
    'threshold_score': THRESHOLD_SCORE,
    'weights': WEIGHT_MAP.copy(),
    'doji_threshold': DOJI_THRESHOLD,
    'hammer_threshold': HAMMER_THRESHOLD,
    'pinbar_threshold': PINBAR_THRESHOLD,
}

histories = {tf: {sym: {
    'timestamp': deque(maxlen=250),
    'open': deque(maxlen=250),
    'high': deque(maxlen=250),
    'low': deque(maxlen=250),
    'close': deque(maxlen=250),
    'volume': deque(maxlen=250)
} for sym in SYMBOLS} for tf in TIMEFRAMES}

histories_5m = {sym: {
    'timestamp': deque(maxlen=250),
    'open': deque(maxlen=250),
    'high': deque(maxlen=250),
    'low': deque(maxlen=250),
    'close': deque(maxlen=250),
    'volume': deque(maxlen=250)
} for sym in SYMBOLS}

prev_macd = {tf: {sym: {'macd': None, 'signal': None} for sym in SYMBOLS} for tf in TIMEFRAMES}
prev_macd_5m = {sym: {'macd': None, 'signal': None} for sym in SYMBOLS}
last_completed_price = {}
live_prices = {}
ws_last_message_at = {"ts": 0.0}
signal_context = {}
history_lock = threading.RLock()

def upsert_completed_candle(history, candle):
    """Добавляет/обновляет только завершённую свечу с дедупликацией по timestamp."""
    with history_lock:
        ts = int(candle[0])
        values = {
            "open": float(candle[1]),
            "high": float(candle[2]),
            "low": float(candle[3]),
            "close": float(candle[4]),
            "volume": float(candle[5]),
        }
        timestamps = history["timestamp"]
        if timestamps:
            if ts < timestamps[-1]:
                return False
            if ts == timestamps[-1]:
                for key, value in values.items():
                    history[key][-1] = value
                return False
        timestamps.append(ts)
        for key, value in values.items():
            history[key].append(value)
        return True

# ============================================================
# WEBSOCKET-СЛОЙ (realtime-цена и завершённые младшие свечи)
# ВАЖНО: подключаемся к рыночным данным api.bybit.com (testnet=False),
# это ТА ЖЕ среда, что и demo-REST. Баг оригинала TESTTT (WS->testnet,
# REST->demo) здесь исправлен: данные решений и исполнения совпадают.
# В histories попадают только сообщения confirm=True; REST делает начальную
# загрузку и редкий backfill. Дедупликация выполняется по timestamp.
# ============================================================
WS_WATCH_TFS = [5, 15, 30, 60]          # младшие ТФ тянем через WS (без лимита публичного REST)
ws_new_candle = {tf: {sym: False for sym in SYMBOLS} for tf in WS_WATCH_TFS}
# Детект закрытия 5m-свечи ПО ВРЕМЕНИ (надёжно, без зависимости от WS-доставки):
# будильник next_5m_time[sym] = время начала ТЕКУЩЕЙ 5m-свечи; когда оно меняется -> предыдущая закрылась.
last_5m_start = {sym: 0 for sym in SYMBOLS}
ws_last_candle_time = {tf: {sym: None for sym in SYMBOLS} for tf in WS_WATCH_TFS}
ws_last_candle_time_5m = {sym: None for sym in SYMBOLS}
# last_candle_time — для дедупа REST-polling старших ТФ (4h/D/W) и 15m-backfill
last_candle_time = {tf: {sym: None for sym in SYMBOLS} for tf in TIMEFRAMES + [240, 1440, 10080]}

# ============================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================
def calculate_ema(series, period):
    if len(series) < period:
        return None
    k = 2 / (period + 1)
    ema = series[0]
    for price in series[1:]:
        ema = price * k + ema * (1 - k)
    return ema

# Глобальный rate-limiter для публичного REST Bybit (лимит ~120 запросов / 10с).
# Токен-бакет: не более MAX_PER_SEC запросов в секунду + ожидание на 429.
import threading as _thr
_public_rest_lock = _thr.Lock()
_public_rest_tokens = {"n": 10.0, "ts": time.time()}

def _throttle_public_rest():
    with _public_rest_lock:
        now = time.time()
        dt = now - _public_rest_tokens["ts"]
        _public_rest_tokens["n"] = min(10.0, _public_rest_tokens["n"] + dt * 10.0)  # 10 токенов/сек
        _public_rest_tokens["ts"] = now
        if _public_rest_tokens["n"] < 1.0:
            wait = (1.0 - _public_rest_tokens["n"]) / 10.0 + 0.05
            time.sleep(wait)
            _public_rest_tokens["n"] = 0.0
            _public_rest_tokens["ts"] = time.time()
        else:
            _public_rest_tokens["n"] -= 1.0

# Кэш недоступности Bybit REST: если хост мёртв (DNS/таймаут), не пингуем его ~60с,
# сразу идём в OKX-fallback (укладываемся в цикл 5с).
_bybit_dead_until = {"ts": 0.0}          # глобальный: connection-level сбой (DNS/хост мёртв)
_BYBIT_DEAD_TTL = 60.0
_bybit_dead_syms = {}                        # персимвольный: какой символ пропускать Bybit до timestamp
_BYBIT_SYM_TTL = 1800.0                       # 30 мин пропускаем Bybit для "медленного" символа (ReadTimeout)
_BYBIT_CONN_ERRS = (requests.exceptions.ConnectTimeout,
                    requests.exceptions.ConnectionError,
                    requests.exceptions.ReadTimeout)
# Ban-лист: символы, стабильно тормозящие на demo-API Bybit (ReadTimeout) -> сразу OKX, без попыток Bybit.
BYBIT_BAN_SYMBOLS = set(CONFIG.get("BYBIT_BAN_SYMBOLS", ["BCHUSDT", "LINKUSDT"]))
_last_bybit_err = {}                          # symbol -> последняя сетевая ошибка (тип)

def fetch_klines_completed(symbol, interval, limit, retries=3, fast=False):
    # ГЛОБАЛЬНЫЙ обход: если хост мёртв (connection-level) -> сразу OKX для ВСЕХ.
    now = time.time()
    # BAN-ЛИСТ: стабильно тормозящие символы (BCHUSDT/LINKUSDT) -> сразу OKX без попытки Bybit.
    if symbol in BYBIT_BAN_SYMBOLS:
        okx_data = _fetch_klines_okx(symbol, interval, limit)
        if okx_data:
            return okx_data
        return []
    if now < _bybit_dead_until["ts"]:
        okx_data = _fetch_klines_okx(symbol, interval, limit)
        if okx_data:
            return okx_data
        return []
    # ПЕРСИМВОЛЬНЫЙ обход: если конкретный символ недавно падал с таймаутом -> сразу OKX для него.
    if symbol in _bybit_dead_syms and now < _bybit_dead_syms[symbol]:
        okx_data = _fetch_klines_okx(symbol, interval, limit)
        if okx_data:
            return okx_data
        return []
    # 1) Пробуем родной Bybit REST (если сеть не заблокирована)
    # Если символ уже помечен "медленным" -> 1 быстрая попытка (иначе 3x15с зависания).
    _retries = 1 if (symbol in _bybit_dead_syms and now < _bybit_dead_syms[symbol]) else retries
    bybit_data = _fetch_klines_bybit(symbol, interval, limit, _retries, fast)
    if bybit_data:
        _bybit_dead_until["ts"] = 0.0  # хост жив -> сбрасываем глобальный кэш
        _bybit_dead_syms.pop(symbol, None)  # символ жив -> убираем из персимвольного
        return bybit_data
    # Отметить недоступность.
    # Connection-level (DNS/хост) -> глобально (все символы).
    # ReadTimeout (медленный символ типа BCHUSDT/LINKUSDT) -> только этот символ.
    if _last_bybit_err.get(symbol) in _BYBIT_CONN_ERRS:
        _bybit_dead_until["ts"] = now + _BYBIT_DEAD_TTL
    else:
        _bybit_dead_syms[symbol] = now + _BYBIT_SYM_TTL
    # 2) Fallback: история из OKX (не заблокирован в вашей сети), живые данные — Bybit WS
    okx_data = _fetch_klines_okx(symbol, interval, limit)
    if okx_data:
        logger.info(f"История {symbol} ({interval}) взята из OKX (Bybit REST недоступен)")
        return okx_data
    return []

def _fetch_klines_bybit(symbol, interval, limit, retries=3, fast=False):
    if interval == 1440:
        interval_str = "D"
    elif interval == 10080:
        interval_str = "W"
    else:
        interval_str = str(interval)
    # Хост зависит от DEMO_MODE: demo-среда -> api-demo.bybit.com, иначе mainnet.
    host = "https://api-demo.bybit.com" if CONFIG.get("DEMO_MODE", True) else "https://api.bybit.com"
    url = f"{host}/v5/market/kline"
    params = {"category": "linear", "symbol": symbol, "interval": interval_str, "limit": limit + 1}
    attempts = 1 if fast else retries
    req_timeout = 5 if fast else 15
    last_net_err = False
    for attempt in range(attempts):
        try:
            _throttle_public_rest()
            resp = public_session.get(url, params=params, timeout=req_timeout)
            if resp.status_code == 429:
                logger.warning(f"Rate limit (429) {symbol} ({interval}), пауза 10с")
                time.sleep(10)
                continue
            if resp.status_code != 200:
                time.sleep(2 * (attempt + 1))
                continue
            data = resp.json()
            if data['retCode'] == 0:
                klines = data['result']['list']
                klines.reverse()
                if not klines:
                    logger.warning(f"Нет свечей для {symbol} ({interval})")
                    return []
                interval_ms = interval * 60 * 1000 if interval < 1440 else (24 * 60 * 60 * 1000 if interval == 1440 else 7 * 24 * 60 * 60 * 1000)
                now_ms = int(time.time() * 1000)
                last_candle_time = int(klines[-1][0])
                if now_ms >= last_candle_time + interval_ms:
                    if len(klines) > limit:
                        klines = klines[-limit:]
                    return klines
                else:
                    if len(klines) > limit:
                        klines = klines[-limit-1:-1]
                    else:
                        klines = klines[:-1]
                    return klines
            else:
                logger.error(f"Ошибка {symbol} ({interval}): {data['retMsg']}")
                return []
        except Exception as e:
            # Сетевая ошибка (таймаут/DNS) -> помечаем, чтобы caller сразу ушёл в fallback.
            _last_bybit_err[symbol] = e
            logger.warning(f"Ошибка {symbol} ({interval}), попытка {attempt+1}/{attempts}: {e}")
            last_net_err = True
            time.sleep(2 * (attempt + 1))
    return []

# Fallback-загрузчик истории бессрочного USDT-контракта OKX.
# Спот не используем: его уровни и гэпы могут отличаться от дериватива Bybit.
_OKX_BAR = {5: "5m", 15: "15m", 30: "30m", 60: "1H", 240: "4H", 1440: "1D", 10080: "1W"}
def _fetch_klines_okx(symbol, interval, limit):
    if interval not in _OKX_BAR:
        return []
    base = symbol[:-4] if symbol.endswith("USDT") else symbol
    inst = f"{base}-USDT-SWAP"  # BTCUSDT -> BTC-USDT-SWAP
    bar = _OKX_BAR[interval]
    url = "https://www.okx.com/api/v5/market/candles"
    params = {"instId": inst, "bar": bar, "limit": limit + 1}
    try:
        _throttle_public_rest()
        resp = public_session.get(url, params=params, timeout=15)
        if resp.status_code != 200:
            return []
        data = resp.json()
        if data.get("code") != "0" or "data" not in data:
            return []
        rows = data["data"]  # OKX возвращает НОВЫЕ свечи ПЕРВЫМИ -> реверсим
        rows.reverse()
        out = []
        for r in rows:
            # OKX: [ts, o, h, l, c, vol, ...] — приводим к формату Bybit [ts,o,h,l,c,vol]
            out.append([r[0], r[1], r[2], r[3], r[4], r[5]])
        # отсекаем незавершённую последнюю свечу, если она ещё формируется
        return out[:-1] if len(out) > 1 else out
    except Exception as e:
        logger.warning(f"OKX fallback ошибка {symbol} ({interval}): {e}")
        return []

def detect_doji(open_price, close_price, high, low, threshold=DOJI_THRESHOLD):
    if high == low:
        return False
    body = abs(open_price - close_price)
    range_ = high - low
    return body <= threshold * range_

def detect_hammer(open_price, close_price, high, low, threshold=HAMMER_THRESHOLD):
    if high == low:
        return False
    body = abs(open_price - close_price)
    range_ = high - low
    lower_shadow = min(open_price, close_price) - low
    upper_shadow = high - max(open_price, close_price)
    return lower_shadow > threshold * body and upper_shadow < 0.3 * body

def detect_pinbar(open_price, close_price, high, low, threshold=PINBAR_THRESHOLD):
    if high == low:
        return False
    body = abs(open_price - close_price)
    range_ = high - low
    lower_shadow = min(open_price, close_price) - low
    upper_shadow = high - max(open_price, close_price)
    return lower_shadow > threshold * body and upper_shadow < 0.3 * body

def detect_bullish_engulfing(prev_open, prev_close, open_price, close_price):
    """Бычье поглощение: пред. свеча медвежья, текущая бычья и перекрывает тело."""
    if prev_close >= prev_open:
        return False
    if close_price <= open_price:
        return False
    return close_price > prev_open and open_price < prev_close

def detect_bearish_engulfing(prev_open, prev_close, open_price, close_price):
    if prev_close <= prev_open:
        return False
    if close_price >= open_price:
        return False
    return open_price > prev_close and close_price < prev_open

def detect_morning_star(prev2_close, prev_open, prev_close, open_price, close_price):
    """Упрощённая модель разворота вверх: длинная медвежья -> маленькое тело -> бычья."""
    return prev2_close < prev_open and abs(prev_close - prev_open) < abs(prev2_close - prev_open) * 0.4 \
        and close_price > open_price

def detect_evening_star(prev2_close, prev_open, prev_close, open_price, close_price):
    return prev2_close > prev_open and abs(prev_close - prev_open) < abs(prev2_close - prev_open) * 0.4 \
        and close_price < open_price

def calculate_macd(close_list, fast=MACD_FAST, slow=MACD_SLOW, signal=MACD_SIGNAL, return_arrays=False):
    if len(close_list) < slow:
        if return_arrays:
            return [], [], []
        return None, None, None
    macd_values = []
    for i in range(slow - 1, len(close_list)):
        f = calculate_ema(close_list[:i+1], fast)
        s = calculate_ema(close_list[:i+1], slow)
        if f is not None and s is not None:
            macd_values.append(f - s)
    if len(macd_values) < signal:
        if return_arrays:
            return [], [], []
        return None, None, None
    if return_arrays:
        signal_values = []
        for i in range(signal, len(macd_values) + 1):
            signal_values.append(calculate_ema(macd_values[:i], signal))
        # signal_values[i] соответствует macd_values[i+signal-1]
        return macd_values, signal_values, []
    signal_line = calculate_ema(macd_values, signal)
    if signal_line is None:
        if return_arrays:
            return [], [], []
        return None, None, None
    macd_line = macd_values[-1]
    hist = macd_line - signal_line
    return macd_line, signal_line, hist

def analyze_timeframe(symbol, tf, params, use_5m=False):
    if use_5m:
        data = histories_5m[symbol]
    else:
        data = histories[tf][symbol]

    closes = list(data['close'])
    # Для MACD(12,26,9) нужно не менее 35 завершённых свечей.
    if len(closes) < MACD_SLOW + MACD_SIGNAL:
        return None
    open_price = list(data['open'])[-1]
    high = list(data['high'])[-1]
    low = list(data['low'])[-1]
    close = closes[-1]
    # предыдущие свечи для моделей разворота
    po, ph, pl, pc = list(data['open'])[-2], list(data['high'])[-2], list(data['low'])[-2], closes[-2]
    ppo, pph, ppl, ppc = list(data['open'])[-3], list(data['high'])[-3], list(data['low'])[-3], closes[-3]

    close_list = closes  # полный массив (включая последнюю свечу)
    if len(close_list) < 26:
        return None

    ema20 = calculate_ema(close_list, 20)
    ema50 = calculate_ema(close_list, 50)
    ema200 = calculate_ema(close_list, 200)

    # ПОЛНЫЕ массивы MACD/сигнал — крест детектим по ДВУМ ПОСЛЕДНИМ свечам, БЕЗ глобального prev.
    macd_arr, signal_arr, _ = calculate_macd(close_list, MACD_FAST, MACD_SLOW, MACD_SIGNAL, return_arrays=True)
    if not macd_arr or not signal_arr:
        return None
    macd_line = macd_arr[-1]
    signal_line = signal_arr[-1]
    hist = macd_line - signal_line

    # Детект перекрёста: сравниваем macd[-2] vs signal[-2] и macd[-1] vs signal[-1].
    # Пересечение ДОЛЖНО произойти именно между последними двумя свечами (без разрывов).
    cross = None
    if len(macd_arr) >= 2 and len(signal_arr) >= 2:
        m_prev, m_now = macd_arr[-2], macd_arr[-1]
        s_prev, s_now = signal_arr[-2], signal_arr[-1]
        if m_prev <= s_prev and m_now > s_now:
            cross = "bullish"
        elif m_prev >= s_prev and m_now < s_now:
            cross = "bearish"

    doji = detect_doji(open_price, close, high, low, params.get('doji_threshold', DOJI_THRESHOLD))
    hammer = detect_hammer(open_price, close, high, low, params.get('hammer_threshold', HAMMER_THRESHOLD))
    pinbar = detect_pinbar(open_price, close, high, low, params.get('pinbar_threshold', PINBAR_THRESHOLD))
    bull_eng = detect_bullish_engulfing(po, pc, open_price, close)
    bear_eng = detect_bearish_engulfing(po, pc, open_price, close)
    morn_star = detect_morning_star(ppc, ppo, pc, open_price, close)
    eve_star = detect_evening_star(ppc, ppo, pc, open_price, close)
    # свечный разворот в нужную сторону
    candle_reversal_bull = hammer or bull_eng or morn_star or (doji and close > open_price)
    candle_reversal_bear = pinbar or bear_eng or eve_star or (doji and close < open_price)

    return {
        'ema20': ema20, 'ema50': ema50, 'ema200': ema200,
        'macd_line': macd_line, 'signal_line': signal_line, 'histogram': hist,
        'cross': cross, 'doji': doji, 'hammer': hammer, 'pinbar': pinbar,
        'bull_eng': bull_eng, 'bear_eng': bear_eng,
        'candle_reversal_bull': candle_reversal_bull,
        'candle_reversal_bear': candle_reversal_bear,
        'open': open_price, 'high': high, 'low': low, 'close': close
    }

def get_5m_data(symbol, params):
    return analyze_timeframe(symbol, 5, params, use_5m=True)

def calculate_atr_for_tf(symbol, period=14, tf=15, use_5m=False):
    if use_5m:
        data = histories_5m[symbol]
    else:
        data = histories[tf][symbol]
    highs = list(data['high'])
    lows = list(data['low'])
    closes = list(data['close'])
    if len(closes) < period + 1:
        return None
    tr_list = []
    for i in range(1, len(closes)):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i-1])
        lc = abs(lows[i] - closes[i-1])
        tr = max(hl, hc, lc)
        tr_list.append(tr)
    if len(tr_list) >= period:
        return sum(tr_list[-period:]) / period
    return None

# ============================================================
# ГЕНЕРАЦИЯ СИГНАЛА — МОДЕЛЬ: MACD-cross на ЛЮБОМ ТФ (кроме 5m)
#   Перекрёст линий MACD (macd_line пересекает signal_line) на ТФ trigger_tf.
#   5m НЕ используется (шум). Чем СТАРШЕ ТФ перекрёста — тем сильнее сигнал
#   (вес TF_WEIGHTS: 15m=1.0, 30m=1.5, 1h=2.0, 4h=3.0, 1d=4.0, 1w=5.0).
#   SL/TP считаются по структуре рынка либо ICT-зоне.
#   Фильтры и вход оцениваются от фактической рыночной цены.
# ============================================================
def calc_struct_levels(symbol, tf, price, direction, lookback, sl_atr_mult):
    """Структурные уровни TP/SL от локального Max/Min (свинга) ТФ `tf`.

    BUY:  TP = ближайший локальный Max ВЫШЕ цены минус TP_STRUCT_BUFFER (недобор).
          SL = за ближайшим локальным Min НИЖЕ цены минус SL_STRUCT_BUFFER (запас за ликвидностью).
    SELL: TP = ближайший локальный Min НИЖЕ цены плюс TP_STRUCT_BUFFER.
          SL = за ближайшим локальным Max ВЫШЕ цены плюс SL_STRUCT_BUFFER.

    Локальный свинг ищем в окне STRUCT_SWING свечей (узкий SL), а не глобальный экстремум
    за весь lookback (чтобы RR был нормальным, а не 0.2).
    Возвращает (tp, sl) или (None, None).
    """
    data = histories[tf][symbol] if tf in histories else histories_5m.get(symbol)
    if data is None:
        return None, None
    highs = list(data['high']); lows = list(data['low'])
    if len(highs) < 5:
        return None, None
    SWING = CONFIG["STRUCT_SWING"]
    LOOKBACK = lookback
    PIVOT_RADIUS = max(1, int(CONFIG.get("STRUCT_PIVOT_RADIUS", 2)))
    SL_BUF = CONFIG["SL_STRUCT_BUFFER"] / 100
    TP_BUF = CONFIG["TP_STRUCT_BUFFER"] / 100
    TP_ATR = CONFIG.get("TP_ATR_MULTIPLIER", 1.5)
    # ATR ТФ сигнала — минимальный запас SL/TP
    atr = calculate_atr_for_tf(symbol, 14, tf)
    atr_pad = atr * sl_atr_mult if atr else price * 0.002
    tp_atr_pad = atr * TP_ATR if atr else price * 0.005

    def confirmed_pivots(values, kind):
        # Последнюю свечу не используем: справа от неё ещё нет подтверждения.
        series = values[:-1]
        start = max(PIVOT_RADIUS, len(series) - LOOKBACK)
        stop = len(series) - PIVOT_RADIUS
        points = []
        for i in range(start, stop):
            neighbourhood = series[i - PIVOT_RADIUS:i + PIVOT_RADIUS + 1]
            value = series[i]
            if kind == "high":
                confirmed = value == max(neighbourhood) and any(
                    value > other
                    for j, other in enumerate(neighbourhood)
                    if j != PIVOT_RADIUS
                )
            else:
                confirmed = value == min(neighbourhood) and any(
                    value < other
                    for j, other in enumerate(neighbourhood)
                    if j != PIVOT_RADIUS
                )
            if confirmed:
                points.append((i, value))
        return points

    high_pivots = confirmed_pivots(highs, "high")
    low_pivots = confirmed_pivots(lows, "low")

    def recent_first(points, predicate):
        recent_from = max(0, len(highs) - 1 - SWING)
        recent = [
            value for index, value in points
            if index >= recent_from and predicate(value)
        ]
        if recent:
            return recent
        return [value for _, value in points if predicate(value)]

    if direction == "BUY":
        adverse = recent_first(low_pivots, lambda value: value < price)
        min_lvl = max(adverse) if adverse else None
        if min_lvl is None:
            sl = price - max(atr_pad, price * SL_BUF)
        else:
            sl = min_lvl * (1 - SL_BUF)
            if (price - sl) / price < (atr_pad / price):
                sl = price - atr_pad
        risk_distance = price - sl
        required_reward = max(
            price * CONFIG["MIN_TP_PERCENT"] / 100,
            price * CONFIG.get("MIN_NET_PROFIT_PCT", 0.30) / 100,
            risk_distance * CONFIG["MIN_RISK_REWARD_RATIO"],
        )
        favourable = recent_first(
            high_pivots,
            lambda value: value * (1 - TP_BUF) >= price + required_reward,
        )
        tp = (
            min(value * (1 - TP_BUF) for value in favourable)
            if favourable
            else price + max(tp_atr_pad, required_reward)
        )
    else:  # SELL
        adverse = recent_first(high_pivots, lambda value: value > price)
        max_lvl = min(adverse) if adverse else None
        if max_lvl is None:
            sl = price + max(atr_pad, price * SL_BUF)
        else:
            sl = max_lvl * (1 + SL_BUF)
            if (sl - price) / price < (atr_pad / price):
                sl = price + atr_pad
        risk_distance = sl - price
        required_reward = max(
            price * CONFIG["MIN_TP_PERCENT"] / 100,
            price * CONFIG.get("MIN_NET_PROFIT_PCT", 0.30) / 100,
            risk_distance * CONFIG["MIN_RISK_REWARD_RATIO"],
        )
        favourable = recent_first(
            low_pivots,
            lambda value: value * (1 + TP_BUF) <= price - required_reward,
        )
        tp = (
            max(value * (1 + TP_BUF) for value in favourable)
            if favourable
            else price - max(tp_atr_pad, required_reward)
        )
    return tp, sl


def calc_tp_5m(symbol, price, direction):
    """БЫСТРЫЙ TP по 5m (для импульсных сделок на младших ТФ).

    Логика трейдера:
      - Цена У EMA200(5m) [Buy: цена > EMA200; Sell: цена < EMA200] -> импульс в тренде ->
        TP = ближайший локальный экстремум 5m в сторону сделки (Max выше для Buy / Min ниже для Sell)
        минус/плюс небольшой буфер (цена часто не доходит до самого пика).
      - Цена ПРОТИВ EMA200(5m) [Buy: цена < EMA200; Sell: цена > EMA200] -> TP = EMA200(5m)
        как безопасный ближайший уровень (если он в нужную сторону от цены), иначе экстремум 5m.
    Возвращает tp (float) или None.
    """
    if symbol not in histories_5m:
        return None
    data = histories_5m[symbol]
    highs = list(data['high']); lows = list(data['low']); close = list(data['close'])
    if len(close) < 200:
        return None
    ema200_5m = calculate_ema(close, 200)
    if ema200_5m is None:
        return None
    BUF = CONFIG.get("TP_5M_BUFFER", 0.1) / 100
    LOOK = CONFIG.get("TP_5M_LOOKBACK", 60)
    MINP = CONFIG.get("TP_5M_MIN_PCT", 0.35) / 100
    window_h = highs[-LOOK-1:-1] if len(highs) > LOOK else highs[:-1]
    window_l = lows[-LOOK-1:-1] if len(lows) > LOOK else lows[:-1]
    if direction == "BUY":
        near_ema = price > ema200_5m   # цена у EMA200 сверху -> в тренде вверх
        if near_ema:
            cands = [v for v in window_h if v > price]
            lvl = min(cands) if cands else None
            if lvl is not None:
                return max(lvl * (1 - BUF), price * (1 + MINP))
        # цена ниже EMA200 ИЛИ нет ближайшего Max -> TP = EMA200(5m), если выше цены
        if ema200_5m > price:
            return max(ema200_5m * (1 - BUF), price * (1 + MINP))
        # иначе (EMA200 ниже цены, но экстремумов нет) -> fallback ближайший Max
        cands = [v for v in window_h if v > price]
        lvl = min(cands) if cands else None
        return max(lvl * (1 - BUF), price * (1 + MINP)) if lvl is not None else price * (1 + MINP)
    else:
        near_ema = price < ema200_5m   # цена у EMA200 снизу -> в тренде вниз
        if near_ema:
            cands = [v for v in window_l if v < price]
            lvl = max(cands) if cands else None
            if lvl is not None:
                return min(lvl * (1 + BUF), price * (1 - MINP))
        if ema200_5m < price:
            return min(ema200_5m * (1 + BUF), price * (1 - MINP))
        cands = [v for v in window_l if v < price]
        lvl = max(cands) if cands else None
        return min(lvl * (1 + BUF), price * (1 - MINP)) if lvl is not None else price * (1 - MINP)


def detect_nison_pattern(opens, highs, lows, closes, direction):
    """Детект РАЗВОРОТНЫХ свечных паттернов С. Нисона на 15m (последние свечи).

    Возвращает имя паттерна (str) если на последних свечах есть паттерн
    нужной стороны (direction), иначе None.
    Разворотные (по Нисону, высокая вероятность):
      BUY:  Молот/Повешенный (пин-бар, длинный нижний хвост), Бычье поглощение,
            Утренняя звезда, Бычья харами.
      SELL: Падающая звезда (пин-бар вверх), Медвежье поглощение, Вечерняя звезда,
            Медвежья харами.
    """
    SH = CONFIG.get("NISON_SHADOW_MULT", 2.0)
    MINB = CONFIG.get("NISON_MIN_BODY_RATIO", 0.1)
    n = len(closes)
    if n < 3:
        return None
    def body(i):
        o = opens[i]; c = closes[i]; h = highs[i]; l = lows[i]
        rng = h - l
        if rng <= 0:
            return 0, 0, 0
        body_sz = abs(c - o)
        upper = h - max(o, c)
        lower = min(o, c) - l
        return body_sz, upper, lower
    # --- МОЛОТ / ПОВЕШЕННЫЙ (BUY) / ПАДАЮЩАЯ ЗВЕЗДА (SELL) ---
    b, up, lo = body(-1)
    rng = highs[-1] - lows[-1]
    if rng > 0:
        body_ratio = b / rng
        if body_ratio >= MINB:
            if direction == "BUY" and lo >= SH * b and up <= b:
                return "Молот"
            if direction == "SELL" and up >= SH * b and lo <= b:
                return "ПадающаяЗвезда"
    # --- ПОГЛОЩЕНИЕ (последние 2 свечи) ---
    o0, c0 = opens[-2], closes[-2]
    o1, c1 = opens[-1], closes[-1]
    if (
        direction == "BUY" and c0 < o0 and c1 > o1
        and o1 <= c0 and c1 >= o0
    ):
        return "БычьеПоглощение"
    if (
        direction == "SELL" and c0 > o0 and c1 < o1
        and o1 >= c0 and c1 <= o0
    ):
        return "МедвежьеПоглощение"
    # --- УТРЕННЯЯ / ВЕЧЕРНЯЯ ЗВЕЗДА (3 свечи) ---
    o0, c0 = opens[-3], closes[-3]
    o1, c1 = opens[-2], closes[-2]
    o2, c2 = opens[-1], closes[-1]
    b0, _, _ = body(-3)
    b1, _, _ = body(-2)
    b2, _, _ = body(-1)
    rng1 = highs[-2] - lows[-2]
    if rng1 > 0 and (b1 / rng1) < MINB * 2:
        if direction == "BUY" and c0 < o0 and c2 > o2 and c2 > (o0 + c0) / 2:
            return "УтренняяЗвезда"
        if direction == "SELL" and c0 > o0 and c2 < o2 and c2 < (o0 + c0) / 2:
            return "ВечерняяЗвезда"
    # Харами: тело последней свечи находится внутри тела предыдущей.
    if (
        direction == "BUY" and c0 < o0 and c2 > o2 and b2 < b0
        and min(o2, c2) >= min(o0, c0) and max(o2, c2) <= max(o0, c0)
    ):
        return "БычьяХарами"
    if (
        direction == "SELL" and c0 > o0 and c2 < o2 and b2 < b0
        and min(o2, c2) >= min(o0, c0) and max(o2, c2) <= max(o0, c0)
    ):
        return "МедвежьяХарами"
    return None


def _find_fvg(highs, lows, window):
    """Ищет FVG (Fair Value Gap) на свечах: 3-свечный гэп.
    Бычий: low более новой свечи выше high старой.
    Медвежий: high более новой свечи ниже low старой.
    Возвращает список (dir, top, bottom)."""
    fvgs = []
    hi = highs[-window-1:-1] if len(highs) > window else highs[:-1]
    lo = lows[-window-1:-1] if len(lows) > window else lows[:-1]
    for i in range(1, len(hi) - 1):
        if lo[i + 1] > hi[i - 1]:
            fvgs.append(("BUY", lo[i + 1], hi[i - 1]))
        elif hi[i + 1] < lo[i - 1]:
            fvgs.append(("SELL", lo[i - 1], hi[i + 1]))
    return fvgs


def _calculate_ote_zone(swing_low, swing_high, direction):
    """Возвращает ценовую OTE-зону 62–79% отката от импульсной ноги."""
    leg = swing_high - swing_low
    if leg <= 0:
        return None, None
    if direction == "BUY":
        return swing_high - leg * 0.79, swing_high - leg * 0.62
    return swing_low + leg * 0.62, swing_low + leg * 0.79


def calc_ict_setup(symbol, price, direction):
    """ICT-модель: Фибо от ноги 15m + OTE(0.62-0.79) ∩ FVG (жёсткий фильтр).

    Контекст (бычий/медвежий) по EMA200 на старших ТФ (1d, 4h).
    Фибо строится на 15m от последней импульсной ноги:
      бычий: Low->High (от ближайшего свинга low к свингу high >= price)
      медвежий: High->Low
    OTE = 0.62..0.79 от ноги. Ищем FVG(15m), пересекающийся с OTE.
    Возвращает (ok, tp, sl) или (False, None, None).
      tp = ближайший ликвидный уровень (хай/лоу ноги) [вариант В]
      sl = за FVG + буфер [защита ликвидности]
    """
    # 1) КОНТЕКСТ по старшему ТФ (только 4h, без требования совпадения 1d+4h — ослаблено для частоты)
    #    Берём направление от EMA200 на 4h. 1d НЕ блокирует вход (было слишком строго -> 1 сделка/день).
    ctx_tf = CONFIG.get("ICT_CONTEXT_TF", 240)
    ctx = None
    if ctx_tf in histories:
        d = analyze_timeframe(symbol, ctx_tf, current_params, use_5m=False)
        if d is not None and d['ema200'] is not None:
            if price > d['ema200']:
                ctx = "BUY"
            elif price < d['ema200']:
                ctx = "SELL"
    if ctx is None:
        return False, None, None, None
    if direction != ctx:
        # сделка против контекста 4h -> не берём (приоритет 4h)
        return False, None, None, None

    # 2) НОГА 15m (импульсная): от свинга low к свингу high (бычий)
    if symbol not in histories.get(15, {}):
        return False, None, None, None
    data15 = histories[15][symbol]
    op15 = list(data15['open'])
    hi15 = list(data15['high'])
    lo15 = list(data15['low'])
    cl15 = list(data15['close'])
    WIN = CONFIG.get("ICT_LEG_WINDOW", 100)
    if len(hi15) < 5:
        return False, None, None, None
    radius = max(1, int(CONFIG.get("STRUCT_PIVOT_RADIUS", 2)))
    start = max(radius, len(hi15) - 1 - WIN)
    stop = len(hi15) - 1 - radius
    pivot_highs = []
    pivot_lows = []
    for i in range(start, stop):
        local_highs = hi15[i - radius:i + radius + 1]
        local_lows = lo15[i - radius:i + radius + 1]
        if hi15[i] == max(local_highs) and any(
            hi15[i] > value for j, value in enumerate(local_highs) if j != radius
        ):
            pivot_highs.append((i, hi15[i]))
        if lo15[i] == min(local_lows) and any(
            lo15[i] < value for j, value in enumerate(local_lows) if j != radius
        ):
            pivot_lows.append((i, lo15[i]))

    if direction == "BUY":
        if not pivot_highs:
            return False, None, None, None
        high_index, swing_high = pivot_highs[-1]
        prior_lows = [point for point in pivot_lows if point[0] < high_index]
        if not prior_lows:
            return False, None, None, None
        _, swing_low = prior_lows[-1]
        tp_level = swing_high
    else:
        if not pivot_lows:
            return False, None, None, None
        low_index, swing_low = pivot_lows[-1]
        prior_highs = [point for point in pivot_highs if point[0] < low_index]
        if not prior_highs:
            return False, None, None, None
        _, swing_high = prior_highs[-1]
        tp_level = swing_low

    leg = swing_high - swing_low
    atr15 = calculate_atr_for_tf(symbol, 14, 15)
    if (
        leg <= 0
        or not (swing_low < price < swing_high)
        or (atr15 is not None and leg < atr15 * CONFIG.get("ICT_MIN_LEG_ATR", 2.0))
    ):
        return False, None, None, None
    ote_lo, ote_hi = _calculate_ote_zone(swing_low, swing_high, direction)

    # 3) FVG(15m), пересекающийся с OTE
    fvgs = _find_fvg(hi15, lo15, CONFIG.get("ICT_FVG_WINDOW", 50))
    hit = None
    price_buffer = price * CONFIG.get("ICT_ENTRY_BUFFER", 0.15) / 100
    for fdir, ftop, fbot in reversed(fvgs):
        if fdir != direction:
            continue
        # пересечение зоны FVG [fbot, ftop] с OTE [ote_lo, ote_hi]
        overlap_bottom = max(fbot, ote_lo)
        overlap_top = min(ftop, ote_hi)
        if (
            overlap_bottom <= overlap_top
            and overlap_bottom - price_buffer <= price <= overlap_top + price_buffer
        ):
            hit = (overlap_top, overlap_bottom)
            break
    if hit is None:
        return False, None, None, None   # жёсткий фильтр: OTE не на FVG -> пропускаем

    # 3.5) СВЕЧНОЙ ФИЛЬТР НИСОНА (разворотный паттерн в зоне OTE∩FVG, 15m)
    if CONFIG.get("USE_NISON_PATTERNS", False):
        pat = detect_nison_pattern(op15, hi15, lo15, cl15, direction)
        if pat is None:
            return False, None, None, None   # жёсткий фильтр: нет разворотного паттерна -> пропуск
        nison_pat = pat
    else:
        nison_pat = "NONE"

    # 4) УРОВНИ
    # TP (вариант В): ближайший ликвидный уровень в сторону сделки, но не ближе MIN_TP
    MINP = CONFIG.get("TP_5M_MIN_PCT", 0.35) / 100
    if direction == "BUY":
        tp = tp_level
        if (tp - price) / price < MINP:
            tp = price * (1 + MINP)
        # SL за FVG (ниже нижнего края) + буфер
        sl = hit[1] * (1 - CONFIG.get("SL_STRUCT_BUFFER", 0.4) / 100)
        if (price - sl) / price < (CONFIG.get("TP_5M_MIN_PCT", 0.35) / 100):
            sl = price * (1 - MINP)
    else:
        tp = tp_level
        if (price - tp) / price < MINP:
            tp = price * (1 - MINP)
        sl = hit[0] * (1 + CONFIG.get("SL_STRUCT_BUFFER", 0.4) / 100)
        if (sl - price) / price < (CONFIG.get("TP_5M_MIN_PCT", 0.35) / 100):
            sl = price * (1 + MINP)
    return True, tp, sl, nison_pat


def generate_signal(symbol, params, trigger_tf=None):
    TF_WEIGHTS = CONFIG["TF_WEIGHTS"]
    TRIGGER_TFS = CONFIG["MACD_CROSS_CASCADE_TFS"]   # [15,30,60,240,1440,10080]
    if trigger_tf is None:
        trigger_tf = CONFIG["BASE_TF"]               # 15 по умолчанию
    SL_BUF = CONFIG["SL_BUFFER_PCT"] / 100
    MIN_RISK_REWARD_RATIO = CONFIG["MIN_RISK_REWARD_RATIO"]

    # 1) Анализ trigger_tf — тут ищем перекрест
    base = analyze_timeframe(symbol, trigger_tf, params, use_5m=False)
    if base is None or base['macd_line'] is None or base['signal_line'] is None:
        return "NONE", None, None, 0.0, 0, None

    price = live_prices.get(symbol) or last_completed_price.get(symbol) or base['close']

    # 2) Перекрест MACD на trigger_tf
    cross = base['cross']
    if cross == "bullish":
        direction = "BUY"
    elif cross == "bearish":
        direction = "SELL"
    else:
        return "NONE", None, None, 0.0, 0, None

    # 2.5) ICT-ФИЛЬТР (приоритет старших ТФ 4h/1d, OTE∩FVG на 15m) — жёсткий
    ict_levels = None
    ict_pat = None
    if CONFIG.get("USE_ICT_MODEL", False):
        ict_ok, ict_tp, ict_sl, ict_pat = calc_ict_setup(symbol, price, direction)
        if not ict_ok:
            logger.debug(f"{symbol} [{trigger_tf}m]: ICT-фильтр НЕ пройден (нет OTE∩FVG/паттерна или против контекста) -> пропуск")
            return "NONE", None, None, 0.0, trigger_tf, None
        ict_levels = (ict_tp, ict_sl)
        logger.info(
            f"{symbol} [{trigger_tf}m]: ICT-сетап OK | {direction} | "
            f"паттерн={ict_pat} | TP={ict_tp:.4f} SL={ict_sl:.4f} "
            f"(OTE∩FVG, контекст старших ТФ)"
        )

    # 3) Каскад подтверждений по ВСЕМ ТФ кроме 5m: старшие ТФ подтверждают направление
    #    (MACD в ту же сторону) и усиливают вход. Вес перекрёста = TF_WEIGHTS[trigger_tf].
    strength = TF_WEIGHTS.get(trigger_tf, 1.0)
    highest_confirm_tf = trigger_tf
    for tf in TRIGGER_TFS:
        if tf == trigger_tf:
            continue
        d = analyze_timeframe(symbol, tf, params, use_5m=False)
        if d is None or d['macd_line'] is None or d['signal_line'] is None:
            continue
        w = TF_WEIGHTS.get(tf, 1.0)
        if direction == "BUY" and d['macd_line'] > d['signal_line']:
            strength += w
            highest_confirm_tf = tf
        elif direction == "SELL" and d['macd_line'] < d['signal_line']:
            strength += w
            highest_confirm_tf = tf
        # если старший ТФ ПРОТИВ — ослабляем сигнал
        elif direction == "BUY" and d['macd_line'] < d['signal_line']:
            strength -= w * 0.5
        elif direction == "SELL" and d['macd_line'] > d['signal_line']:
            strength -= w * 0.5

    # 4) УРОВНИ TP/SL — СТРУКТУРНЫЕ (Max/Min свечей ТФ сигнала, вариант 2 пользователя).
    #    TP = ближайший локальный экстремум ТОГО ЖЕ ТФ в сторону сделки (достижимый уровень).
    #    SL = за ближайшим экстремумом против сделки + ATR-запас.
    #    Fallback на EMA, если экстремумов нет (новый актив / мало истории).
    STRUCT_LOOKBACK = CONFIG["STRUCT_LOOKBACK"]
    MIN_TP_PCT = CONFIG["MIN_TP_PERCENT"] / 100
    MAX_TP_PCT = CONFIG["MAX_TP_PERCENT"] / 100
    if ict_levels is not None:
        tp, sl = ict_levels
    else:
        tp, sl = calc_struct_levels(
            symbol, trigger_tf, price, direction, STRUCT_LOOKBACK, SL_ATR_MULTIPLIER
        )

    # БЫСТРЫЙ TP ПО 5m для импульсных сделок на младших ТФ (15/30m) — логика пользователя:
    # TP у ближайшего экстремума 5m (если цена у EMA200 5m) или у EMA200 5m (если против).
    # SL оставляем структурный (узкий, за ликвидностью) — он работает независимо от ТФ.
    if (
        ict_levels is None
        and CONFIG.get("USE_TP_5M_FOR_FAST_TF", False)
        and trigger_tf <= CONFIG.get("TP_5M_MAX_TF", 30)
    ):
        tp5 = calc_tp_5m(symbol, price, direction)
        if tp5 is not None:
            tp = tp5
            logger.debug(f"{symbol} [{trigger_tf}m]: TP по 5m = {tp:.4f} (цена {price:.4f}, EMA200_5m={calculate_ema(list(histories_5m.get(symbol, {}).get('close', [0])), 200)}), структурный TP был {calc_struct_levels(symbol, trigger_tf, price, direction, STRUCT_LOOKBACK, SL_ATR_MULTIPLIER)[0]}")

    if tp is None or sl is None:
        # Fallback: EMA того же ТФ
        ema20, ema50, ema200 = base['ema20'], base['ema50'], base['ema200']
        emas = [(20, ema20), (50, ema50), (200, ema200)]
        emas = [(s, v) for s, v in emas if v is not None]
        if not emas:
            return "NONE", None, None, strength, trigger_tf, None
        if direction == "BUY":
            below = [(s, v) for s, v in emas if v <= price]
            sl_ema = max(below, key=lambda x: x[1])[1] if below else min(emas, key=lambda x: x[1])[1]
            sl = sl_ema * (1 - SL_BUF)
            above = [(s, v) for s, v in emas if v > price]
            tp = min(above, key=lambda x: x[1])[1] if above else price * (1 + 0.02)
        else:
            above = [(s, v) for s, v in emas if v >= price]
            sl_ema = min(above, key=lambda x: x[1])[1] if above else max(emas, key=lambda x: x[1])[1]
            sl = sl_ema * (1 + SL_BUF)
            below = [(s, v) for s, v in emas if v < price]
            tp = max(below, key=lambda x: x[1])[1] if below else price * (1 - 0.02)

    # Фильтр TP: слишком близко или слишком далеко -> не берём (недостижим / микро-TF)
    if direction == "BUY":
        tp_dist = (tp - price) / price if tp > price else 0
    else:
        tp_dist = (price - tp) / price if tp < price else 0
    if tp_dist < MIN_TP_PCT or tp_dist > MAX_TP_PCT:
        return "NONE", None, None, strength, trigger_tf, None

    # Фильтры оцениваются от той цены, по которой бот действительно входит рынком.
    entry_price = price

    # 6) Фильтр низкой волатильности
    atr_check = calculate_atr_for_tf(symbol, 14, trigger_tf)
    if atr_check is not None and price > 0 and (atr_check / price) < CONFIG["MIN_ATR_PERCENT"]:
        logger.debug(f"Фильтр {direction} {symbol} [{trigger_tf}m]: низкий ATR ({(atr_check/price):.3%})")
        return "NONE", None, None, strength, trigger_tf, None

    # 6.5) Мин. сила каскада (вес перекрёста + подтверждения старших ТФ)
    MIN_STRENGTH = CONFIG.get("MIN_CONFIRM_STRENGTH", 2.0)
    if strength < MIN_STRENGTH:
        logger.debug(f"Фильтр {direction} {symbol} [{trigger_tf}m]: сила {strength:.2f} < {MIN_STRENGTH}")
        return "NONE", None, None, strength, trigger_tf, None

    # 7) Фильтр RR
    if direction == "BUY":
        reward = (tp - entry_price) / entry_price * 100
        risk = (entry_price - sl) / entry_price * 100
    else:
        reward = (entry_price - tp) / entry_price * 100
        risk = (sl - entry_price) / entry_price * 100
    if risk <= 0 or reward < risk * MIN_RISK_REWARD_RATIO:
        logger.debug(f"Фильтр {direction} {symbol} [{trigger_tf}m]: RR {reward:.2f}/{risk:.2f} = {reward/risk:.2f} < {MIN_RISK_REWARD_RATIO}")
        return "NONE", None, None, strength, trigger_tf, None

    # 7.5) TP должен окупать КОМИССИЮ (покупка + продажа)
    MIN_NET_PROFIT_PCT = CONFIG.get("MIN_NET_PROFIT_PCT", 0.30)
    if reward < MIN_NET_PROFIT_PCT:
        logger.debug(f"Фильтр {direction} {symbol} [{trigger_tf}m]: прибыль {reward:.2f}% < {MIN_NET_PROFIT_PCT}% (комиссия)")
        return "NONE", None, None, strength, trigger_tf, None

    # EMA-значения ТФ сигнала (для записи в сделку; определены в fallback выше, но гарантируем наличие)
    ema20, ema50, ema200 = base.get('ema20'), base.get('ema50'), base.get('ema200')
    ema_vals = (ema20, ema50, ema200)
    pot_gain_pct = (tp - entry_price) / entry_price * 100 if direction == "BUY" else (entry_price - tp) / entry_price * 100
    pot_risk_pct = (entry_price - sl) / entry_price * 100 if direction == "BUY" else (sl - entry_price) / entry_price * 100
    signal_context[symbol] = {
        "trigger_tf": trigger_tf,
        "confirmation_tf": highest_confirm_tf,
        "setup": "ICT_OTE_FVG" if ict_levels is not None else "MACD_STRUCTURE",
        "pattern": ict_pat or "",
        "planned_rr": reward / risk,
        "macd_entry": base.get("macd_line"),
        "signal_entry": base.get("signal_line"),
    }
    logger.info(f"СИГНАЛ {direction} {symbol} [MACD-cross {trigger_tf}m]: cross={cross}, "
                f"TP={tp:.2f} (прибыль ~{pot_gain_pct:.2f}%), вход~{entry_price:.2f}, "
                f"SL={sl:.2f} (риск ~{pot_risk_pct:.2f}%), RR={reward/risk:.2f}, сила={strength:.2f}")
    return direction, tp, sl, strength, highest_confirm_tf, ema_vals

# ============================================================
# ТОРГОВЫЕ ФУНКЦИИ
# ============================================================
def get_balance_usdt():
    if DRY_RUN:
        return float(CONFIG.get("DRY_RUN_BALANCE_USDT", 10000.0))
    try:
        resp = session.get_wallet_balance(accountType="UNIFIED", coin="USDT")
        if resp['retCode'] == 0:
            return float(resp['result']['list'][0]['totalEquity'])
        else:
            logger.error(f"Ошибка баланса: {resp['retMsg']}")
            return None
    except Exception as e:
        logger.error(f"Исключение при получении баланса: {e}")
        return None


def get_spread_pct(symbol):
    try:
        resp = session.get_tickers(category=CATEGORY, symbol=symbol)
        rows = resp.get("result", {}).get("list", []) if resp.get("retCode") == 0 else []
        if not rows:
            return None
        bid = float(rows[0].get("bid1Price", 0) or 0)
        ask = float(rows[0].get("ask1Price", 0) or 0)
        midpoint = (bid + ask) / 2
        if bid <= 0 or ask <= 0 or midpoint <= 0 or ask < bid:
            return None
        return (ask - bid) / midpoint * 100
    except Exception as e:
        logger.warning(f"{symbol}: не удалось проверить спред: {e}")
        return None


_instrument_lot_cache = {}

def get_instrument_lot_info(symbol):
    """Актуальные lot/tick параметры с биржи; статический CONFIG — только fallback."""
    cached = _instrument_lot_cache.get(symbol)
    if cached and time.time() - cached["ts"] < 3600:
        return cached["info"]
    static = LOT_INFO.get(symbol, {"min": 0.001, "max": 1000, "step": 0.001})
    fallback = {
        "min": static["min"],
        "max": static["max"],
        "step": static["step"],
        "tick": None,
    }
    try:
        resp = session.get_instruments_info(category=CATEGORY, symbol=symbol)
        rows = resp.get("result", {}).get("list", []) if resp.get("retCode") == 0 else []
        if rows:
            lot = rows[0].get("lotSizeFilter", {})
            price_filter = rows[0].get("priceFilter", {})
            info = {
                "min": float(lot.get("minOrderQty") or fallback["min"]),
                "max": float(lot.get("maxMktOrderQty") or lot.get("maxOrderQty") or fallback["max"]),
                "step": float(lot.get("qtyStep") or fallback["step"]),
                "tick": float(price_filter["tickSize"]) if price_filter.get("tickSize") else None,
            }
            _instrument_lot_cache[symbol] = {"ts": time.time(), "info": info}
            return info
    except Exception as e:
        logger.warning(f"{symbol}: не удалось обновить параметры лота, используется fallback: {e}")
    return fallback

def adjust_qty_to_lot(symbol, qty):
    info = get_instrument_lot_info(symbol)
    min_lot = Decimal(str(info["min"]))
    max_lot = Decimal(str(info["max"]))
    step = Decimal(str(info["step"]))
    requested = min(Decimal(str(max(qty, 0))), max_lot)
    if requested < min_lot or step <= 0:
        return 0.0
    adjusted = (requested / step).to_integral_value(rounding=ROUND_DOWN) * step
    if adjusted < min_lot:
        return 0.0
    return float(adjusted)


def adjust_price_to_tick(symbol, price, rounding=ROUND_DOWN):
    tick_value = get_instrument_lot_info(symbol).get("tick")
    if not tick_value:
        return float(price)
    tick = Decimal(str(tick_value))
    value = Decimal(str(price))
    return float((value / tick).to_integral_value(rounding=rounding) * tick)


def calculate_position_size(symbol, entry_price, stop_loss_price):
    balance = get_balance_usdt()
    if balance is None or balance <= 0:
        logger.error(f"{symbol}: размер позиции не рассчитан — баланс недоступен")
        return 0.0
    risk_amount = balance * (RISK_PER_TRADE / 100)
    risk_per_contract = abs(entry_price - stop_loss_price)
    if risk_per_contract == 0:
        return 0.0
    qty = risk_amount / risk_per_contract
    max_qty_by_usdt = MAX_POSITION_USDT / entry_price
    qty = min(qty, max_qty_by_usdt)
    return adjust_qty_to_lot(symbol, qty)

def _new_order_link_id(prefix, symbol):
    value = f"{prefix}_{symbol[:8]}_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
    return value[:36]

def get_execution_summary(symbol, order_id, fallback_price=None, retries=6):
    """Возвращает фактическую среднюю цену/комиссию исполнения конкретного ордера."""
    if not order_id:
        return {"price": fallback_price, "fee": None, "qty": 0.0, "orderId": ""}
    if DRY_RUN or str(order_id).startswith("dry_"):
        return {"price": fallback_price, "fee": None, "qty": 0.0, "orderId": order_id}
    for _ in range(retries):
        try:
            resp = session.get_executions(
                category=CATEGORY, symbol=symbol, orderId=order_id, limit=100
            )
            rows = resp.get("result", {}).get("list", []) if resp.get("retCode") == 0 else []
            if rows:
                qty_sum = sum(float(r.get("execQty", 0) or 0) for r in rows)
                value_sum = sum(
                    float(r.get("execQty", 0) or 0) * float(r.get("execPrice", 0) or 0)
                    for r in rows
                )
                fee_sum = sum(float(r.get("execFee", 0) or 0) for r in rows)
                return {
                    "price": value_sum / qty_sum if qty_sum > 0 else fallback_price,
                    "fee": fee_sum,
                    "qty": qty_sum,
                    "orderId": order_id,
                }
            history_resp = session.get_order_history(
                category=CATEGORY, symbol=symbol, orderId=order_id, limit=20
            )
            orders = (
                history_resp.get("result", {}).get("list", [])
                if history_resp.get("retCode") == 0
                else []
            )
            if orders:
                order = orders[0]
                executed_qty = float(order.get("cumExecQty", 0) or 0)
                if executed_qty > 0:
                    return {
                        "price": float(order.get("avgPrice", 0) or fallback_price or 0),
                        "fee": (
                            float(order["cumExecFee"])
                            if order.get("cumExecFee") not in (None, "")
                            else None
                        ),
                        "qty": executed_qty,
                        "orderId": order_id,
                    }
        except Exception as e:
            logger.warning(f"{symbol}: исполнение ордера {order_id} ещё не получено: {e}")
        time.sleep(0.5)
    return {"price": fallback_price, "fee": None, "qty": 0.0, "orderId": order_id}


def get_latest_close_execution(symbol, position_side, opened_at):
    """Находит фактическое последнее встречное исполнение после открытия позиции."""
    if DRY_RUN:
        return None
    expected_side = "Sell" if position_side in ("Buy", "BUY") else "Buy"
    try:
        opened_ms = int(
            datetime.strptime(opened_at, '%Y-%m-%d %H:%M:%S').timestamp() * 1000
        ) - 60_000
        resp = session.get_executions(category=CATEGORY, symbol=symbol, limit=100)
        rows = resp.get("result", {}).get("list", []) if resp.get("retCode") == 0 else []
        candidates = [
            row for row in rows
            if str(row.get("side", "")).capitalize() == expected_side
            and int(row.get("execTime", 0) or 0) >= opened_ms
        ]
        if not candidates:
            return None
        latest = max(candidates, key=lambda row: int(row.get("execTime", 0) or 0))
        order_id = latest.get("orderId", "")
        fills = [row for row in candidates if row.get("orderId", "") == order_id]
        qty_sum = sum(float(row.get("execQty", 0) or 0) for row in fills)
        value_sum = sum(
            float(row.get("execQty", 0) or 0) * float(row.get("execPrice", 0) or 0)
            for row in fills
        )
        return {
            "price": value_sum / qty_sum if qty_sum > 0 else None,
            "fee": sum(float(row.get("execFee", 0) or 0) for row in fills),
            "qty": qty_sum,
            "orderId": order_id,
        }
    except Exception as e:
        logger.warning(f"{symbol}: не удалось получить фактическое исполнение закрытия: {e}")
        return None


def place_limit_order(symbol, side, qty, price, timeout=ORDER_TIMEOUT):
    if DRY_RUN:
        logger.info(f"[DRY_RUN] ЛИМИТ {side} {symbol} qty={qty} по {price} — СИМУЛЯЦИЯ (ордер НЕ отправлен)")
        trade_logger.info(f"ОТКРЫТИЕ(сим): {side} {symbol} qty={qty} цена={price} (лимит)")
        return {"result": {"orderId": f"dry_{symbol}_{int(time.time())}"}}
    params = {"category": CATEGORY, "symbol": symbol, "side": side,
              "orderType": "Limit", "qty": str(qty), "price": str(price),
              "timeInForce": "GTC"}
    logger.info(f"Отправка лимитного ордера {side} {symbol} qty={qty} price={price}, timeout={timeout}с")
    try:
        resp = session.place_order(**params)
        if resp['retCode'] != 0:
            logger.error(f"Лимит ошибка: {resp['retMsg']}")
            return None
        order_id = resp['result']['orderId']
        start = time.time()
        while time.time() - start < timeout:
            status = session.get_open_orders(category=CATEGORY, symbol=symbol, orderId=order_id)
            if status['retCode'] == 0:
                orders = status['result']['list']
                if not orders:
                    break
                for ord in orders:
                    if ord['orderId'] == order_id and ord['orderStatus'] == 'Filled':
                        logger.info(f"Лимитный ордер {side} {symbol} исполнен по {price}")
                        trade_logger.info(f"ОТКРЫТИЕ: {side} {symbol} qty={qty} цена={price} (лимит)")
                        return resp['result']
            time.sleep(2)
        session.cancel_order(category=CATEGORY, symbol=symbol, orderId=order_id)
        logger.warning(f"Лимитный ордер {side} {symbol} отменён по таймауту")
        return None
    except Exception as e:
        logger.error(f"Исключение в лимитном ордере: {e}")
        return None

def place_market_order(symbol, side, qty):
    fallback_price = live_prices.get(symbol) or last_completed_price.get(symbol)
    if DRY_RUN:
        logger.info(f"[DRY_RUN] РЫНОК {side} {symbol} qty={qty} — СИМУЛЯЦИЯ (ордер НЕ отправлен)")
        trade_logger.info(f"ОТКРЫТИЕ(сим): {side} {symbol} qty={qty} цена=MARKET")
        order_id = f"dry_{symbol}_{int(time.time() * 1000)}"
        return {"orderId": order_id, "price": fallback_price, "fee": None, "qty": qty}
    order_link_id = _new_order_link_id("open", symbol)
    params = {"category": CATEGORY, "symbol": symbol, "side": side,
              "orderType": "Market", "qty": str(qty), "timeInForce": "IOC",
              "positionIdx": CONFIG.get("POSITION_IDX", 0),
              "orderLinkId": order_link_id}
    try:
        resp = session.place_order(**params)
        if resp['retCode'] == 0:
            order_id = resp['result']['orderId']
            logger.info(f"Рыночный ордер {side} {symbol} qty={qty} размещён")
            trade_logger.info(f"ОТКРЫТИЕ: {side} {symbol} qty={qty} цена=MARKET")
            result = get_execution_summary(symbol, order_id, fallback_price=fallback_price)
            if float(result.get("qty", 0) or 0) > 0:
                return result
            positions = get_open_positions()
            if positions is not None:
                for position in positions:
                    if (
                        position.get("symbol") == symbol
                        and abs(float(position.get("size", 0) or 0)) > 0
                    ):
                        return {
                            "orderId": order_id,
                            "price": float(position.get("avgPrice", 0) or fallback_price or 0),
                            "fee": None,
                            "qty": abs(float(position.get("size", 0) or qty)),
                            "execution_unconfirmed": True,
                        }
                logger.error(f"{symbol}: ордер принят, но исполнение и позиция не подтверждены")
                return None
            logger.critical(
                f"{symbol}: ордер принят, API подтверждения недоступен; "
                f"позиция будет контролироваться по расчётным данным"
            )
            return {
                "orderId": order_id,
                "price": fallback_price,
                "fee": None,
                "qty": qty,
                "execution_unconfirmed": True,
            }
        else:
            logger.error(f"Рыночный ошибка: {resp['retMsg']}")
            return None
    except Exception as e:
        logger.error(f"Исключение в рыночном ордере: {e}")
        return None

def close_position_market(symbol, position_side, qty, fallback_price=None, reason="strategy"):
    """Реально закрывает указанное количество встречным reduce-only ордером."""
    close_side = "Sell" if position_side in ("Buy", "BUY") else "Buy"
    if qty <= 0:
        return None
    fallback_price = fallback_price or live_prices.get(symbol) or last_completed_price.get(symbol)
    if DRY_RUN:
        order_id = f"dry_close_{symbol}_{int(time.time() * 1000)}"
        logger.info(f"[DRY_RUN] ЗАКРЫТИЕ {position_side} {symbol} qty={qty} reason={reason}")
        return {"orderId": order_id, "price": fallback_price, "fee": None, "qty": qty}
    params = {
        "category": CATEGORY,
        "symbol": symbol,
        "side": close_side,
        "orderType": "Market",
        "qty": str(qty),
        "timeInForce": "IOC",
        "reduceOnly": True,
        "positionIdx": CONFIG.get("POSITION_IDX", 0),
        "orderLinkId": _new_order_link_id("close", symbol),
    }
    try:
        resp = session.place_order(**params)
        if resp.get("retCode") != 0:
            logger.error(f"Ошибка закрытия {symbol}: {resp.get('retMsg')}")
            return None
        order_id = resp["result"]["orderId"]
        result = get_execution_summary(symbol, order_id, fallback_price=fallback_price)
        if float(result.get("qty", 0) or 0) <= 0:
            positions = get_open_positions()
            if positions is None:
                logger.error(f"{symbol}: исполнение закрытия не подтверждено")
                return None
            still_open = any(
                position.get("symbol") == symbol
                and abs(float(position.get("size", 0) or 0)) > 0
                for position in positions
            )
            if still_open:
                logger.error(f"{symbol}: после закрывающего ордера позиция ещё открыта")
                return None
            result = {
                "orderId": order_id,
                "price": fallback_price,
                "fee": None,
                "qty": qty,
                "execution_unconfirmed": True,
            }
        logger.info(f"Закрывающий reduce-only ордер {symbol} qty={qty} размещён, reason={reason}")
        return result
    except Exception as e:
        logger.error(f"Не удалось закрыть {symbol}: {e}", exc_info=True)
        return None

def set_stop_loss_take_profit(symbol, position_side, sl_price, tp_price):
    if DRY_RUN:
        logger.info(f"[DRY_RUN] SL/TP (сим): SL={sl_price}, TP={tp_price}")
        trade_logger.info(f"SL/TP(сим): SL={sl_price} TP={tp_price}")
        return True
    rounding = ROUND_DOWN if position_side in ("Buy", "BUY") else ROUND_UP
    sl_price = adjust_price_to_tick(symbol, sl_price, rounding=rounding)
    tp_price = adjust_price_to_tick(symbol, tp_price, rounding=rounding)
    try:
        params = {
            "category": CATEGORY,
            "symbol": symbol,
            "positionIdx": CONFIG.get("POSITION_IDX", 0),
            "tpslMode": "Full",
            "stopLoss": str(sl_price),
            "slTriggerBy": "LastPrice",
            "takeProfit": str(tp_price),
            "tpTriggerBy": "LastPrice",
        }
        resp = session.set_trading_stop(**params)
        if resp['retCode'] == 0:
            logger.info(f"SL/TP установлены: SL={sl_price}, TP={tp_price}")
            trade_logger.info(f"SL/TP: SL={sl_price} TP={tp_price}")
            return True
        else:
            logger.error(f"Ошибка SL/TP: {resp['retMsg']}")
            return False
    except Exception as e:
        logger.error(f"Исключение SL/TP: {e}")
        return False

def get_open_positions():
    if DRY_RUN:
        # В сухом режиме позиции = то, что в памяти open_trades
        out = []
        for sym, t in open_trades.items():
            out.append({
                'symbol': sym,
                'side': t['side'],
                'size': t['qty'],
                'positionValue': t['entry_price'] * t['qty'],
            })
        return out
    try:
        resp = session.get_positions(category=CATEGORY, settleCoin="USDT")
        if resp['retCode'] == 0:
            return resp['result']['list']
        else:
            logger.error(f"Ошибка получения позиций: {resp['retMsg']}")
            return None
    except Exception as e:
        logger.error(f"Исключение получения позиций: {e}")
        return None

def has_open_position(symbol):
    positions = get_open_positions()
    if positions is None:
        return None
    for pos in positions:
        if pos['symbol'] == symbol and abs(float(pos.get('size', 0))) > 0:
            return True
    return False

def get_last_completed_price(symbol, tf=15):
    data = fetch_klines_completed(symbol, tf, 1)
    if data and len(data) > 0:
        return float(data[0][4])
    return None

def add_trade_open(symbol, side, entry_price, qty, score, consensus_tf, ema_values, sl, tp,
                   order_info=None):
    global open_trades
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    context = signal_context.get(symbol, {})
    if side == "Buy":
        expected_gain_pct = (tp - entry_price) / entry_price * 100
        expected_loss_pct = (entry_price - sl) / entry_price * 100
    else:
        expected_gain_pct = (entry_price - tp) / entry_price * 100
        expected_loss_pct = (sl - entry_price) / entry_price * 100
    # КОНТР-ТРЕНД: цена выше/ниже EMA200 на дневном (глобальный тренд против сделки).
    # Для контр-трендовых сделок включаем УСКОРЕННОЕ закрытие (см. блок выхода по импульсу).
    counter_trend = False
    try:
        d = histories.get(1440, {}).get(symbol)
        if d and len(d['close']) >= 200:
            e200 = calculate_ema(list(d['close']), 200)
            counter_trend = (entry_price < e200) if side == "Buy" else (entry_price > e200)
    except Exception:
        counter_trend = False
    open_trades[symbol] = {
        'timestamp_open': timestamp, 'symbol': symbol, 'side': side,
        'entry_price': entry_price, 'qty': qty, 'sl': sl, 'tp': tp,
        'expected_gain_pct': expected_gain_pct, 'expected_loss_pct': expected_loss_pct,
        'score': score, 'consensus_tf': consensus_tf,
        'trigger_tf': context.get('trigger_tf', ''),
        'confirmation_tf': context.get('confirmation_tf', consensus_tf),
        'setup': context.get('setup', 'MACD_STRUCTURE'),
        'pattern': context.get('pattern', ''),
        'planned_rr': context.get('planned_rr', ''),
        'ema20': ema_values[0] if ema_values else None,
        'ema50': ema_values[1] if ema_values else None,
        'ema200': ema_values[2] if ema_values else None,
        'macd_entry': context.get('macd_entry', ''),
        'signal_entry': context.get('signal_entry', ''),
        'counter_trend': counter_trend,
        'prev_macd_sign': 0,
        'entry_order_id': (order_info or {}).get('orderId', ''),
        'entry_execution_confirmed': not bool(
            (order_info or {}).get('execution_unconfirmed', False)
        ),
        'entry_fee': (order_info or {}).get('fee'),
        'original_qty': qty,
        'partial_gross_pnl': 0.0,
        'partial_commission': 0.0,
        'partial_exit_notional': 0.0,
        'last_exit_candle_ts': 0,
    }
    logger.info(f"СДЕЛКА ОТКРЫТА: {side} {symbol} | Вход {entry_price} | SL {sl} | TP {tp} | Прибыль {expected_gain_pct:.2f}% | Риск {expected_loss_pct:.2f}% | контр-тренд={'ДА' if counter_trend else 'нет'}")
    trade_logger.info(f"ОТКРЫТИЕ: {side} {symbol} qty={qty} цена={entry_price} SL={sl} TP={tp} gain={expected_gain_pct:.1f}% loss={expected_loss_pct:.1f}% counter_trend={'1' if counter_trend else '0'}")

def close_trade(
    symbol,
    exit_price=None,
    score=None,
    reason="strategy",
    execute_order=True,
    order_info=None,
):
    """Закрывает биржевую позицию (если требуется), затем фиксирует подтверждённый результат."""
    global open_trades, last_sl_time
    if symbol not in open_trades:
        return False
    trade = open_trades[symbol]
    entry = trade['entry_price']
    side = trade['side']
    qty = trade['qty']
    sl = trade['sl']
    tp = trade['tp']
    expected_gain = trade['expected_gain_pct']
    expected_loss = trade['expected_loss_pct']

    close_info = order_info
    if execute_order:
        close_info = close_position_market(
            symbol, side, qty,
            fallback_price=exit_price or live_prices.get(symbol) or last_completed_price.get(symbol),
            reason=reason,
        )
        if close_info is None:
            logger.error(f"{symbol}: локальная сделка НЕ удалена — биржевое закрытие не подтверждено")
            return False
        exit_price = close_info.get("price") or exit_price
        executed_qty = float(close_info.get("qty", 0) or 0)
        if 0 < executed_qty < qty * 0.999999:
            if exit_price is None or exit_price <= 0:
                logger.error(f"{symbol}: частичное исполнение без цены, сделка сохранена")
                return False
            partial_gross = (
                (exit_price - entry) * executed_qty
                if side == "Buy"
                else (entry - exit_price) * executed_qty
            )
            trade["partial_gross_pnl"] = (
                float(trade.get("partial_gross_pnl", 0.0)) + partial_gross
            )
            trade["partial_exit_notional"] = (
                float(trade.get("partial_exit_notional", 0.0))
                + exit_price * executed_qty
            )
            if close_info.get("fee") is not None:
                trade["partial_commission"] = (
                    float(trade.get("partial_commission", 0.0))
                    + float(close_info["fee"])
                )
            trade["qty"] = qty - executed_qty
            trade["emergency_close_required"] = reason
            logger.critical(
                f"{symbol}: закрыто только {executed_qty} из {qty}; "
                f"остаток {trade['qty']} будет закрываться повторно"
            )
            return False
    if exit_price is None or exit_price <= 0:
        logger.error(f"{symbol}: закрытие не записано — отсутствует цена исполнения")
        return False

    open_time = datetime.strptime(trade['timestamp_open'], '%Y-%m-%d %H:%M:%S')
    close_time = datetime.now()
    duration_minutes = (close_time - open_time).total_seconds() / 60

    if side == "Buy":
        remaining_gross = (exit_price - entry) * qty
    else:
        remaining_gross = (entry - exit_price) * qty
    gross_pnl = remaining_gross + float(trade.get("partial_gross_pnl", 0.0))

    entry_fee = trade.get("entry_fee")
    close_fee = close_info.get("fee") if close_info else None
    if entry_fee is not None and close_fee is not None:
        commission_usdt = (
            float(entry_fee) + float(trade.get("partial_commission", 0.0)) + float(close_fee)
        )
    else:
        original_qty = float(trade.get("original_qty", qty))
        exit_notional = float(trade.get("partial_exit_notional", 0.0)) + exit_price * qty
        commission_usdt = (entry * original_qty + exit_notional) * COMMISSION
    net_pnl = gross_pnl - commission_usdt
    original_notional = entry * float(trade.get("original_qty", qty))
    gross_pnl_pct = (gross_pnl / original_notional) * 100
    net_pnl_pct = (net_pnl / original_notional) * 100
    result = "Win" if net_pnl > 0 else "Loss" if net_pnl < 0 else "Breakeven"
    original_qty = float(trade.get("original_qty", qty))

    with open(STATS_CSV, 'a', newline='', encoding='utf-8') as f:
        writer = csv.writer(f, delimiter=';')
        writer.writerow([
            RUN_ID,
            trade['timestamp_open'], symbol, side, entry, original_qty,
            close_time.strftime('%Y-%m-%d %H:%M:%S'), exit_price,
            round(gross_pnl_pct, 2), result, round(commission_usdt, 4),
            round(net_pnl_pct, 2), round(score, 2) if score is not None else "",
            trade.get("trigger_tf", ""), trade.get("confirmation_tf", ""),
            trade.get("setup", ""), trade.get("pattern", ""),
            round(float(trade["planned_rr"]), 3) if trade.get("planned_rr") != "" else "",
            int(bool(trade.get("counter_trend", False))),
            int(bool(trade.get("scaled", False))),
            trade.get('ema20', ""), trade.get('ema50', ""), trade.get('ema200', ""),
            trade.get("macd_entry", ""), trade.get("signal_entry", ""),
            round(sl, 8), round(tp, 8), round(expected_gain, 2), round(expected_loss, 2),
            round(duration_minutes, 1), round(gross_pnl, 4), round(net_pnl, 4),
            trade.get("entry_order_id", ""),
            (close_info or {}).get("orderId", ""),
            int(bool(trade.get("entry_execution_confirmed", False))),
            int(bool(close_info) and not bool(
                (close_info or {}).get("execution_unconfirmed", False)
            )),
            reason,
        ])
    del open_trades[symbol]
    if result == "Loss":
        last_sl_time[symbol] = close_time
    logger.info(
        f"Сделка закрыта: {side} {symbol} reason={reason} результат {result} "
        f"(валовая {gross_pnl_pct:.2f}%, чистая {net_pnl_pct:.2f}%, "
        f"комиссия {commission_usdt:.2f} USDT, длительность {int(duration_minutes)}м)"
    )
    trade_logger.info(
        f"ЗАКРЫТИЕ: {side} {symbol} qty_open={original_qty} qty_final={qty} "
        f"цена={exit_price} reason={reason} "
        f"net={net_pnl:.4f} USDT orderId={(close_info or {}).get('orderId', '')}"
    )
    update_stats()
    return True

def update_stats():
    if not os.path.exists(STATS_CSV):
        return
    with open(STATS_CSV, 'r', newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f, delimiter=';'))
    if not rows:
        logger.info("Статистика: пока нет завершённых сделок")
        return
    wins = losses = total = 0
    net_total = 0.0
    positive_net = 0.0
    negative_net = 0.0
    for row in rows:
        if row.get("result"):
            total += 1
            if row["result"] == "Win":
                wins += 1
            elif row["result"] == "Loss":
                losses += 1
            try:
                value = float(row.get("net_pnl_usdt") or 0)
                net_total += value
                if value > 0:
                    positive_net += value
                elif value < 0:
                    negative_net += abs(value)
            except ValueError:
                pass
    if total == 0:
        logger.info("Статистика: пока нет завершённых сделок")
        return
    winrate = wins / total * 100
    profit_factor = positive_net / negative_net if negative_net > 0 else float("inf")
    pf_text = f"{profit_factor:.2f}" if math.isfinite(profit_factor) else "∞"
    logger.info(
        f"Статистика сделок: Всего {total}, Win {wins} ({winrate:.1f}%), "
        f"Loss {losses}, PF={pf_text}, net={net_total:.2f} USDT"
    )

# ============================================================
# ТРЕЙЛИНГ (два метода: EMA из v6, ATR из TESTTT)
# ============================================================
def update_trailing_stop(symbol, current_price):
    if symbol not in open_trades:
        return
    trade = open_trades[symbol]
    entry = trade['entry_price']
    side = trade['side']
    current_sl = trade['sl']
    current_tp = trade['tp']

    if side == "Buy":
        profit_pct = (current_price - entry) / entry * 100
    else:
        profit_pct = (entry - current_price) / entry * 100

    if profit_pct < TRAILING_MIN_PROFIT_PCT:
        return

    new_sl = None
    method = CONFIG["TRAILING_METHOD"]
    if method == "ATR":
        atr_5m = calculate_atr_for_tf(symbol, 14, TRAILING_TF, use_5m=True)
        if atr_5m is None:
            return
        mult = CONFIG["TRAILING_ATR_MULTIPLIER"]
        if side == "Buy":
            new_sl = current_price - atr_5m * mult
        else:
            new_sl = current_price + atr_5m * mult
    else:  # EMA
        tf_data = get_5m_data(symbol, current_params)
        if tf_data is None:
            return
        ema_value = tf_data['ema50'] if TRAILING_USE_EMA50 else tf_data['ema20']
        if ema_value is None:
            return
        offset = TRAILING_OFFSET_PCT / 100
        if side == "Buy":
            new_sl = ema_value * (1 - offset)
        else:
            new_sl = ema_value * (1 + offset)

    if new_sl is None:
        return

    moved = False
    if side == "Buy":
        if new_sl > current_sl and new_sl < current_price:
            if (new_sl - current_sl) / entry * 100 >= TRAILING_STEP_PCT:
                moved = True
    else:
        if new_sl < current_sl and new_sl > current_price:
            if (current_sl - new_sl) / entry * 100 >= TRAILING_STEP_PCT:
                moved = True

    if moved:
        if set_stop_loss_take_profit(symbol, side, new_sl, current_tp):
            open_trades[symbol]['sl'] = new_sl
            logger.info(
                f"Стоп-лосс {symbol} передвинут на {new_sl:.4f} "
                f"({method}, прибыль {profit_pct:.1f}%)"
            )

# ============================================================
# WEBSOCKET: обработчики и менеджер (режим testnet=False = рыночные данные)
# ============================================================
def make_ws_candle_handler(tf):
    def handler(message):
        try:
            if "data" not in message or not message["data"]:
                return
            symbol = message["topic"].split(".")[-1]
            for data in message["data"]:
                candle_time = int(data["start"])
                o = float(data["open"])
                hi = float(data["high"])
                lo = float(data["low"])
                cl = float(data["close"])
                vol = float(data["volume"])
                ws_last_message_at["ts"] = time.time()
                live_prices[symbol] = cl
                confirmed = data.get("confirm") is True or str(data.get("confirm")).lower() == "true"
                if not confirmed:
                    continue
                candle = [candle_time, o, hi, lo, cl, vol]
                if tf == 5:
                    ws_last_candle_time_5m[symbol] = candle_time
                    added = upsert_completed_candle(histories_5m[symbol], candle)
                else:
                    ws_last_candle_time[tf][symbol] = candle_time
                    added = upsert_completed_candle(histories[tf][symbol], candle)
                    if added:
                        ws_new_candle[tf][symbol] = True
                    if tf == ENTRY_TF:
                        last_completed_price[symbol] = cl
                last_candle_time.setdefault(tf, {}).setdefault(symbol, None)
                last_candle_time[tf][symbol] = candle_time
        except Exception as e:
            logger.error(f"WS ошибка обработчика {tf}m: {e}", exc_info=True)
    return handler

ws_callbacks = {tf: make_ws_candle_handler(tf) for tf in WS_WATCH_TFS}

class WSManager:
    def __init__(self, symbols, callbacks):
        self.symbols = symbols
        self.callbacks = callbacks
        self.ws = None
        self.running = True
        self.stale_after = 120.0

    def _connect(self):
        self.ws = WebSocket(testnet=False, channel_type="linear")
        for tf, cb in self.callbacks.items():
            for sym in self.symbols:
                interval_str = str(tf) if tf != 5 else "5"
                self.ws.kline_stream(interval=interval_str, symbol=sym, callback=cb)
        # тихо: плановый реконнект не шумит в логе (виден только при реальной ошибке)

    def start(self):
        while self.running:
            try:
                self._connect()
                ws_last_message_at["ts"] = time.time()
                while self.running:
                    time.sleep(1)
                    # Переподключаемся только если поток действительно замолчал.
                    if time.time() - ws_last_message_at["ts"] > self.stale_after:
                        logger.warning("WebSocket не присылал данные 120с, выполняется переподключение")
                        try:
                            self.ws.close()
                        except Exception:
                            pass
                        break
            except Exception as e:
                # реальная ошибка подключения/дисконнект — логируем, чтобы было видно
                logger.error(f"WebSocket ошибка/дисконнект: {e}, переподключение через 5с")
                try:
                    if self.ws:
                        self.ws.close()
                except Exception:
                    pass
                time.sleep(5)
                continue

    def stop(self):
        self.running = False
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass

# ============================================================
# ОТКРЫТИЕ СДЕЛКИ СРАЗУ ПРИ ПЕРЕКРЁСТЕ (без регистрации/ожидания подтверждения)
# ============================================================
def open_trade_now(sym, signal, tp, sl, diff, consensus_tf, ema_vals, has_pos):
    """Открыть сделку сразу при перекрёсте MACD (без стадии pending_signals/отката)."""
    global open_trades, last_sl_time
    # защита от дубля: уже открыта в памяти ИЛИ реально на бирже
    if has_pos is None:
        logger.warning(f"{sym} пропущен: состояние биржевых позиций неизвестно")
        return
    if has_pos or sym in open_trades:
        logger.info(f"{sym} пропущен: позиция уже открыта")
        return
    if len(open_trades) >= MAX_OPEN_TRADES:
        logger.info(f"{sym} пропущен: достигнут лимит одновременных сделок ({MAX_OPEN_TRADES})")
        return
    if sym in last_sl_time:
        if (datetime.now() - last_sl_time[sym]).total_seconds() < RE_ENTRY_AFTER_SL * 15 * 60:
            return
    entry_price = live_prices.get(sym) or last_completed_price.get(sym)
    if entry_price is None:
        entry_price = histories[ENTRY_TF][sym]['close'][-2] if len(histories[ENTRY_TF][sym]['close']) >= 2 else None
    if entry_price is None:
        logger.warning(f"{sym} пропущен: нет цены входа")
        return
    current_price = live_prices.get(sym) or entry_price
    # ИМПУЛЬС: движение цены от цены закрытия свечи креста до текущей
    if signal == "BUY":
        impulse_move = (current_price - entry_price) / entry_price * 100
    else:
        impulse_move = (entry_price - current_price) / entry_price * 100
    is_impulse = IMPULSE_MARKET_ENTRY and impulse_move >= IMPULSE_ENTRY_PCT
    if signal == "BUY":
        expected_pct = (tp - entry_price) / entry_price * 100
    else:
        expected_pct = (entry_price - tp) / entry_price * 100
    min_gross_edge = max(
        COMMISSION * 2 * 100 + 0.10,
        float(CONFIG.get("MIN_NET_PROFIT_PCT", 0.30)),
    )
    if expected_pct < min_gross_edge:
        logger.info(
            f"{sym} пропущен: ожид. прибыль {expected_pct:.2f}% < "
            f"минимального gross edge {min_gross_edge:.2f}%"
        )
        return
    spread_pct = get_spread_pct(sym)
    max_spread_pct = float(CONFIG.get("MAX_SPREAD_PCT", 0.08))
    if spread_pct is None:
        logger.warning(f"{sym} пропущен: спред недоступен")
        return
    if spread_pct > max_spread_pct:
        logger.info(
            f"{sym} пропущен: спред {spread_pct:.3f}% > {max_spread_pct:.3f}%"
        )
        return
    qty = calculate_position_size(sym, entry_price, sl)
    if qty == 0:
        logger.warning(f"{sym} пропущен: qty=0")
        return
    side = "Buy" if signal == "BUY" else "Sell"
    risk_pct = abs(sl - entry_price) / entry_price * 100
    if is_impulse:
        logger.info(f"ИМПУЛЬС {impulse_move:+.2f}% -> рыночный вход | РАСЧЁТ: {side} {sym} | Вход ~{current_price:.4f} | SL {sl:.4f} | TP {tp:.4f} | Прибыль {expected_pct:.2f}% | Риск {risk_pct:.2f}%")
        logger.info(f"Попытка открыть {side} {sym} рыночный (импульс) qty={qty}")
        order_result = place_market_order(sym, side, qty)
    else:
        # Мгновенный вход: лимит НЕ используем (цена уходит от цены креста -> лимит "висит
        # в прошлом" и не исполняется). Входим по рынку у текущей цены.
        logger.info(f"РАСЧЁТ: {side} {sym} | Вход ~{current_price:.4f} | SL {sl} | TP {tp} | Прибыль {expected_pct:.2f}% | Риск {risk_pct:.2f}%")
        logger.info(f"Попытка открыть {side} {sym} рыночный qty={qty}")
        order_result = place_market_order(sym, side, qty)
    if order_result:
        pos_side = "Buy" if signal == "BUY" else "Sell"
        fill_price = float(order_result.get("price") or entry_price)
        filled_qty = float(order_result.get("qty") or qty)

        def keep_tracking_failed_emergency(reason):
            safe_sl = (
                sl
                if (sl < fill_price if pos_side == "Buy" else sl > fill_price)
                else fill_price * (0.99 if pos_side == "Buy" else 1.01)
            )
            safe_tp = (
                tp
                if (tp > fill_price if pos_side == "Buy" else tp < fill_price)
                else fill_price * (1.01 if pos_side == "Buy" else 0.99)
            )
            add_trade_open(
                sym, side, fill_price, filled_qty, diff, consensus_tf, ema_vals,
                safe_sl, safe_tp, order_info=order_result,
            )
            open_trades[sym]["emergency_close_required"] = reason
            logger.critical(
                f"{sym}: аварийное закрытие не подтверждено; позиция сохранена "
                f"в контроле и будет закрываться повторно"
            )

        levels_valid = (
            sl < fill_price < tp if pos_side == "Buy" else tp < fill_price < sl
        )
        if not levels_valid:
            logger.error(
                f"{sym}: fill={fill_price} оказался вне SL/TP ({sl}, {tp}); "
                f"позиция аварийно закрывается"
            )
            emergency_result = close_position_market(
                sym, pos_side, filled_qty, fallback_price=fill_price,
                reason="invalid_levels_after_fill",
            )
            if emergency_result is None:
                keep_tracking_failed_emergency("invalid_levels_after_fill")
            return
        if pos_side == "Buy":
            fill_reward_pct = (tp - fill_price) / fill_price * 100
            fill_risk_pct = (fill_price - sl) / fill_price * 100
        else:
            fill_reward_pct = (fill_price - tp) / fill_price * 100
            fill_risk_pct = (sl - fill_price) / fill_price * 100
        fill_rr = (
            fill_reward_pct / fill_risk_pct
            if fill_risk_pct > 0
            else 0.0
        )
        if (
            fill_reward_pct < min_gross_edge
            or fill_rr < CONFIG["MIN_RISK_REWARD_RATIO"]
        ):
            logger.error(
                f"{sym}: исполнение ухудшило сетап: edge={fill_reward_pct:.2f}%, "
                f"RR={fill_rr:.2f}; позиция аварийно закрывается"
            )
            emergency_result = close_position_market(
                sym, pos_side, filled_qty, fallback_price=fill_price,
                reason="slippage_invalidated_setup",
            )
            if emergency_result is None:
                keep_tracking_failed_emergency("slippage_invalidated_setup")
            return
        if not set_stop_loss_take_profit(sym, pos_side, sl, tp):
            logger.critical(
                f"{sym}: защитные SL/TP не установлены; позиция аварийно закрывается"
            )
            emergency_result = close_position_market(
                sym, pos_side, filled_qty, fallback_price=fill_price,
                reason="protective_orders_failed",
            )
            if emergency_result is None:
                keep_tracking_failed_emergency("protective_orders_failed")
            return
        add_trade_open(
            sym, side, fill_price, filled_qty, diff, consensus_tf, ema_vals, sl, tp,
            order_info=order_result,
        )
        if sym in last_sl_time:
            del last_sl_time[sym]
    else:
        logger.error(f"Не удалось открыть позицию {sym}")


# ============================================================
# ОСНОВНОЙ ЦИКЛ
# ============================================================
def main_loop():
    global open_trades, last_sl_time, last_completed_price
    logger.info(
        f"V7 запущен run_id={RUN_ID} | demo={CONFIG['DEMO_MODE']} "
        f"DRY_RUN={DRY_RUN} | symbols={len(SYMBOLS)} | risk={RISK_PER_TRADE}% "
        f"| max_positions={MAX_OPEN_TRADES} | RR={MIN_RISK_REWARD_RATIO} "
        f"| трейлинг={CONFIG['TRAILING_METHOD']}"
    )

    last_update = {tf: 0 for tf in TIMEFRAMES}
    # младшие ТФ (5/15/30/60m) идут через WebSocket — БЕЗ REST-опроса (нет лимита)
    # REST оставляем только для старших ТФ (4h/D/W) + редкий backfill 15m.
    intervals = {240: 600, 1440: 3600, 10080: 21600}
    last_backfill_15m = 0
    backfill_every = 300  # раз в 5 мин подстраховываем 15m из REST (на случай разрыва WS)
    last_positions_fetch = 0
    cached_positions = []
    positions_state_ok = False
    main_loop._last_seen = {tf: {sym: 0 for sym in SYMBOLS} for tf in CONFIG["MACD_CROSS_CASCADE_TFS"]}  # детект закрытия свечи по времени (по каждому ТФ)

    # === RESYNC открытых позиций при старте ===
    # Если бот перезапущен, а сделки остались открытыми на бирже — подхватываем их в память,
    # чтобы жёсткий трейлинг и выход по импульсу работали (иначе open_trades пуст -> SL не двигается).
    try:
        live = get_open_positions()
        if live is None:
            raise RuntimeError("приватный API позиций недоступен")
        cached_positions = live
        positions_state_ok = True
        for pos in live:
            sym = pos.get('symbol')
            size = float(pos.get('size', 0))
            if not sym or abs(size) < 1e-9:
                continue
            side = str(pos.get("side") or "").capitalize()
            if side not in ("Buy", "Sell"):
                side = "Buy" if size > 0 else "Sell"
            entry = float(pos.get('entryPrice', pos.get('avgPrice', 0)) or 0)
            sl = float(pos.get('stopLoss', 0) or 0)
            tp = float(pos.get('takeProfit', 0) or 0)
            if entry <= 0:
                continue
            # текущая цена из истории (если есть), иначе entry
            cur = live_prices.get(sym) or (
                histories[ENTRY_TF][sym]['close'][-1]
                if sym in histories.get(ENTRY_TF, {}) and histories[ENTRY_TF][sym]['close']
                else entry
            )
            open_trades[sym] = {
                'timestamp_open': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                'symbol': sym, 'side': side, 'entry_price': entry, 'qty': abs(size),
                'sl': sl or entry * (0.99 if side == "Buy" else 1.01),
                'tp': tp or entry * (1.01 if side == "Buy" else 0.99),
                'expected_gain_pct': 0, 'expected_loss_pct': 0, 'score': 0,
                'consensus_tf': 15, 'ema20': None, 'ema50': None, 'ema200': None,
                'counter_trend': False, 'prev_macd_sign': 0,
                'peak': cur, 'trough': cur,
                'entry_order_id': '', 'entry_fee': None, 'original_qty': abs(size),
                'partial_gross_pnl': 0.0, 'partial_commission': 0.0,
                'partial_exit_notional': 0.0, 'last_exit_candle_ts': 0,
            }
            logger.info(f"RESYNC: подхвачена открытая позиция {side} {sym} @ {entry} (SL={sl}, TP={tp})")
    except Exception as e:
        logger.warning(f"RESYNC позиций не удался: {e}")

    last_bootstrap = 0
    bootstrap_every = 60  # раз в 60с пытаемся догрузить историю по REST, пока Bybit доступен

    while True:
        now = time.time()

        # --- Догоняющая загрузка истории по REST (пока <26 свечей на младших ТФ) ---
        if now - last_bootstrap >= bootstrap_every:
            last_bootstrap = now
            need = [
                sym for sym in SYMBOLS
                if len(histories[ENTRY_TF][sym]['close']) < MACD_SLOW + MACD_SIGNAL
            ]
            if need:
                logger.info(
                    f"Догрузка истории по REST для {len(need)} символов "
                    f"(нужно ≥{MACD_SLOW + MACD_SIGNAL} завершённых свечей)..."
                )
                for sym in need:
                    for tf in TIMEFRAMES:
                        try:
                            data = fetch_klines_completed(sym, tf, 250)
                        except Exception:
                            data = []
                        if data:
                            for k in data:
                                upsert_completed_candle(histories[tf][sym], k)
                    try:
                        d5 = fetch_klines_completed(sym, TRAILING_TF, 250)
                    except Exception:
                        d5 = []
                    if d5:
                        for k in d5:
                            upsert_completed_candle(histories_5m[sym], k)
                    if len(histories[ENTRY_TF][sym]['close']) > 0:
                        last_completed_price[sym] = histories[ENTRY_TF][sym]['close'][-1]
                logger.info(f"После догрузки: минимум свечей 15m = {min(len(histories[ENTRY_TF][s]['close']) for s in SYMBOLS)}")

        # --- Старшие ТФ: редкий REST-polling (4h/D/W) ---
        for tf in (240, 1440, 10080):
            if now - last_update[tf] < intervals.get(tf, 600):
                continue
            for sym in SYMBOLS:
                data = fetch_klines_completed(sym, tf, 1)
                if data:
                    k = data[0]
                    candle_time = int(k[0])
                    if upsert_completed_candle(histories[tf][sym], k):
                        last_candle_time[tf][sym] = candle_time
            last_update[tf] = now

        # --- Редкий backfill 15m из REST (защита от разрыва WS) ---
        if now - last_backfill_15m >= backfill_every:
            last_backfill_15m = now
            for sym in SYMBOLS:
                data = fetch_klines_completed(sym, ENTRY_TF, 1)
                if data:
                    k = data[0]
                    candle_time = int(k[0])
                    if upsert_completed_candle(histories[ENTRY_TF][sym], k):
                        last_candle_time[ENTRY_TF][sym] = candle_time
                        last_completed_price[sym] = float(k[4])

        # --- Кэш позиций (ОДИН вызов на цикл, а не по 22 на каждый символ) ---
        if now - last_positions_fetch >= CONFIG.get("POSITION_POLL_INTERVAL", 15):
            snapshot = get_open_positions()
            if snapshot is None:
                positions_state_ok = False
                logger.warning("Снимок позиций недоступен: закрытия/новые входы заблокированы")
            else:
                cached_positions = snapshot
                positions_state_ok = True
            last_positions_fetch = now

        def has_pos_cached(symbol):
            if not positions_state_ok:
                return None
            for pos in cached_positions:
                if pos.get('symbol') == symbol and abs(float(pos.get('size', 0))) > 0:
                    return True
            return False

        # --- По символам ---
        for sym in SYMBOLS:
            has_pos = has_pos_cached(sym)

            # Кэш мог быть получен непосредственно перед новым входом. Даём следующему
            # снимку увидеть позицию, иначе свежая сделка ложно считалась бы закрытой.
            if sym in open_trades and positions_state_ok and not has_pos:
                try:
                    opened_at = datetime.strptime(
                        open_trades[sym]['timestamp_open'], '%Y-%m-%d %H:%M:%S'
                    )
                    age_seconds = (datetime.now() - opened_at).total_seconds()
                except Exception:
                    age_seconds = float("inf")
                snapshot_grace = CONFIG.get("POSITION_POLL_INTERVAL", 15) * 2 + 5
                if age_seconds < snapshot_grace:
                    has_pos = True

            if sym in open_trades and positions_state_ok and not has_pos:
                last_price = live_prices.get(sym) or last_completed_price.get(sym)
                if last_price:
                    trade = open_trades[sym]
                    score = trade.get('score', None)
                    close_info = get_latest_close_execution(
                        sym, trade['side'], trade['timestamp_open']
                    )
                    confirmed_price = (
                        close_info.get("price")
                        if close_info and close_info.get("price")
                        else last_price
                    )
                    close_trade(
                        sym, confirmed_price, score,
                        reason="exchange_position_closed",
                        execute_order=False,
                        order_info=close_info,
                    )
                else:
                    logger.warning(f"Не удалось получить цену для закрытия {sym}")
                continue

            if sym in open_trades and (has_pos or not positions_state_ok):
                trade = open_trades[sym]
                current_price = live_prices.get(sym) or last_completed_price.get(sym)
                if current_price is None:
                    continue

                emergency_reason = trade.get("emergency_close_required")
                if emergency_reason:
                    close_trade(
                        sym,
                        current_price,
                        trade.get('score'),
                        reason=emergency_reason,
                        execute_order=True,
                    )
                    continue

                # В симуляции биржа не закроет позицию за нас, поэтому воспроизводим
                # срабатывание защитных уровней по текущей публичной цене.
                if DRY_RUN:
                    hit_sl = (
                        current_price <= trade['sl']
                        if trade['side'] == "Buy"
                        else current_price >= trade['sl']
                    )
                    hit_tp = (
                        current_price >= trade['tp']
                        if trade['side'] == "Buy"
                        else current_price <= trade['tp']
                    )
                    if hit_sl or hit_tp:
                        close_trade(
                            sym,
                            current_price,
                            trade.get('score'),
                            reason="dry_run_sl" if hit_sl else "dry_run_tp",
                            execute_order=True,
                        )
                        continue

                if TRAILING_STOP_ENABLED:
                    update_trailing_stop(sym, current_price)

                # --- SCALE-OUT (скальп): закрыть часть у первого тейка, остальное тащить трейлингом ---
                if CONFIG.get("SCALP_SCALE_OUT", False) and not trade.get('scaled', False):
                    _first_tp = trade['entry_price'] * (1 + CONFIG.get("SCALP_FIRST_TP_PCT", 0.25) / 100) if trade['side'] == "Buy" \
                                else trade['entry_price'] * (1 - CONFIG.get("SCALP_FIRST_TP_PCT", 0.25) / 100)
                    _reached = (trade['side'] == "Buy" and current_price >= _first_tp) or \
                               (trade['side'] == "Sell" and current_price <= _first_tp)
                    if _reached:
                        _ratio = CONFIG.get("SCALP_SCALE_OUT_RATIO", 0.5)
                        _close_qty = adjust_qty_to_lot(sym, trade['qty'] * _ratio)
                        _partial = close_position_market(
                            sym, trade['side'], _close_qty,
                            fallback_price=current_price, reason="scale_out",
                        )
                        if _partial:
                            _partial_price = float(_partial.get("price") or current_price)
                            _executed_qty = float(_partial.get("qty") or _close_qty)
                            if trade['side'] == "Buy":
                                _partial_gross = (
                                    _partial_price - trade['entry_price']
                                ) * _executed_qty
                            else:
                                _partial_gross = (
                                    trade['entry_price'] - _partial_price
                                ) * _executed_qty
                            trade['partial_gross_pnl'] += _partial_gross
                            trade['partial_exit_notional'] += _partial_price * _executed_qty
                            if _partial.get("fee") is not None:
                                trade['partial_commission'] += float(_partial["fee"])
                            trade['qty'] -= _executed_qty
                            trade['scaled'] = True
                            # Безубыток включает обе комиссии и небольшой запас на проскальзывание.
                            _be_pct = max(0.15, COMMISSION * 2 * 100 + 0.05)
                            _be = trade['entry_price'] * (1 + _be_pct / 100) if trade['side'] == "Buy" \
                                  else trade['entry_price'] * (1 - _be_pct / 100)
                            if set_stop_loss_take_profit(sym, trade['side'], _be, trade['tp']):
                                trade['sl'] = _be
                            else:
                                close_trade(
                                    sym, current_price, trade.get('score'),
                                    reason="scale_out_protection_failed",
                                    execute_order=True,
                                )
                                continue
                            _partial_pct = _partial_gross / (
                                trade['entry_price'] * trade.get('original_qty', trade['qty'])
                            ) * 100
                            logger.info(
                                f"SCALP scale-out {sym} ({trade['side']}): "
                                f"закрыто {_ratio*100:.0f}% @ {_partial_price:.4f} "
                                f"({_partial_pct:+.2f}%), остаток SL->{_be:.4f}"
                            )

                # --- ВЫХОД ПО ОКОНЧАНИЮ ИМПУЛЬСА (вариант 1): 100% закрытие ---

                #   (А) MACD пересёк signal_line обратно  ИЛИ
                #   (Б) MACD пересекла НОЛЬ (сменила знак) — срабатывает РАНЬШЕ (вариант В).
                # ПЛЮС цена отошла от пика/впадины сделки на >= EXIT_IMPULSE_PCT (шум-фильтр).
                # Пик/впадину обновляем по live price, но решение MACD принимаем лишь
                # один раз на новую завершённую свечу EXIT_IMPULSE_TF.
                if trade['side'] == "Buy":
                    trade['peak'] = max(trade.get('peak', current_price), current_price)
                    dd = (trade['peak'] - current_price) / trade['peak'] * 100 if trade['peak'] > 0 else 0
                    pnl = (current_price - trade['entry_price']) / trade['entry_price'] * 100
                else:
                    trade['trough'] = min(trade.get('trough', current_price), current_price)
                    dd = (current_price - trade['trough']) / trade['trough'] * 100 if trade['trough'] > 0 else 0
                    pnl = (trade['entry_price'] - current_price) / trade['entry_price'] * 100

                exit_tf = CONFIG["EXIT_IMPULSE_TF"]
                exit_history = histories.get(exit_tf, {}).get(sym)
                exit_candle_ts = (
                    exit_history['timestamp'][-1]
                    if exit_history and exit_history.get('timestamp') and exit_history['timestamp']
                    else 0
                )
                if (
                    CONFIG.get("IMPULSE_TRAIL_ENABLED", True)
                    and exit_candle_ts > trade.get('last_exit_candle_ts', 0)
                ):
                    trade['last_exit_candle_ts'] = exit_candle_ts
                    _eb = analyze_timeframe(sym, exit_tf, current_params, use_5m=False)
                    if _eb is not None and _eb['macd_line'] is not None and _eb['signal_line'] is not None:
                        m_now = _eb['macd_line']
                        s_now = _eb['signal_line']
                        cross_signal = m_now < s_now if trade['side'] == "Buy" else m_now > s_now
                        prev_sign = trade.get('prev_macd_sign', 0)
                        cur_sign = 1 if m_now > 0 else (-1 if m_now < 0 else 0)
                        zero_cross = False
                        if (
                            CONFIG.get("EXIT_ZERO_CROSS", True)
                            and prev_sign != 0 and cur_sign != 0 and prev_sign != cur_sign
                        ):
                            zero_cross = (
                                prev_sign > 0 and cur_sign < 0
                                if trade['side'] == "Buy"
                                else prev_sign < 0 and cur_sign > 0
                            )
                        trade['prev_macd_sign'] = cur_sign
                        is_ct = trade.get('counter_trend', False)
                        against = cross_signal or zero_cross
                        drawdown_limit = (
                            CONFIG.get("EXIT_IMPULSE_PCT_CT", 0.15)
                            if is_ct else CONFIG.get("EXIT_IMPULSE_PCT", 0.30)
                        )

                        if against and pnl <= -CONFIG["IMPULSE_TRAIL_CLOSE_IF_LOSS"]:
                            logger.info(
                                f"ИМПУЛЬС ПРОТИВ {sym} ({trade['side']}): "
                                f"pnl={pnl:.2f}% -> reduce-only закрытие"
                            )
                            close_trade(
                                sym, current_price, trade.get('score'),
                                reason="impulse_loss", execute_order=True,
                            )
                            continue
                        if (
                            against and is_ct and CONFIG.get("EXIT_ZERO_CROSS_CT", True)
                            and zero_cross
                        ):
                            close_trade(
                                sym, current_price, trade.get('score'),
                                reason="counter_trend_zero_cross", execute_order=True,
                            )
                            continue
                        # Прибыль защищаем только после реального отката от пика, а не
                        # сразу после входа из-за отрицательного значения MACD ниже нуля.
                        if against and dd >= drawdown_limit and pnl > COMMISSION * 2 * 100 + 0.05:
                            fee_buffer = COMMISSION * 2 + 0.0005
                            if trade['side'] == "Buy":
                                breakeven = trade['entry_price'] * (1 + fee_buffer)
                                new_sl = max(
                                    breakeven,
                                    current_price * (1 - CONFIG["IMPULSE_TRAIL_BUFFER"] / 100),
                                )
                                should_move = new_sl > trade['sl'] and new_sl < current_price
                            else:
                                breakeven = trade['entry_price'] * (1 - fee_buffer)
                                new_sl = min(
                                    breakeven,
                                    current_price * (1 + CONFIG["IMPULSE_TRAIL_BUFFER"] / 100),
                                )
                                should_move = new_sl < trade['sl'] and new_sl > current_price
                            if should_move and set_stop_loss_take_profit(
                                sym, trade['side'], new_sl, trade['tp']
                            ):
                                trade['sl'] = new_sl
                                logger.info(
                                    f"Импульс ослаб {sym}: SL->{new_sl:.6f}, "
                                    f"pnl={pnl:.2f}%, drawdown={dd:.2f}%"
                                )

            # --- Нет открытой позиции ---
            # (регистрация сигналов отключена: вход сразу при перекрёсте — см. блок генерации)

            # --- Генерация нового сигнала только по НОВОЙ завершённой свече ---
            for tf in CONFIG["MACD_CROSS_CASCADE_TFS"]:
                tf_history = histories.get(tf, {}).get(sym)
                latest_completed_ts = (
                    tf_history['timestamp'][-1]
                    if tf_history and tf_history.get('timestamp') and tf_history['timestamp']
                    else 0
                )
                last_seen_ts = main_loop._last_seen.setdefault(tf, {}).get(sym, 0)
                if latest_completed_ts and last_seen_ts == 0:
                    # На старте запоминаем последнюю историю, но не переигрываем старый cross.
                    main_loop._last_seen[tf][sym] = latest_completed_ts
                    continue
                if latest_completed_ts > last_seen_ts:
                    main_loop._last_seen[tf][sym] = latest_completed_ts
                    if len(histories[tf][sym]['close']) < MACD_SLOW + MACD_SIGNAL:
                        continue
                    # ЗАПРЕТ ДУБЛЯ: не генерировать новый сигнал, если пара уже открыта
                    if sym in open_trades:
                        continue
                    if sym in last_sl_time:
                        if (datetime.now() - last_sl_time[sym]).total_seconds() < RE_ENTRY_AFTER_SL * 15 * 60:
                            continue
                    signal, tp, sl, diff, consensus_tf, ema_vals = generate_signal(sym, current_params, trigger_tf=tf)
                    if signal == "NONE":
                        continue
                    # ВХОД СРАЗУ ПРИ ПЕРЕКРЁСТЕ (без регистрации/ожидания подтверждения)
                    logger.info(f"СИГНАЛ {signal} {sym} [{tf}m] -> немедленный вход | TP={tp:.4f} SL={sl:.4f}")
                    open_trade_now(sym, signal, tp, sl, diff, consensus_tf, ema_vals, has_pos_cached(sym))

        time.sleep(5)  # REST-polling гейтится интервалами выше; 5с — для быстрой реакции на WS-сигналы/трейлинг

def run_bot():
    if not acquire_instance_lock():
        return
    # --- Запуск WebSocket-потока (реaltime-данные, БЕЗ лимита публичного REST) ---
    ws_manager = WSManager(SYMBOLS, ws_callbacks)
    ws_thread = threading.Thread(target=ws_manager.start, daemon=True)
    ws_thread.start()

    # --- Быстрая загрузка истории ---
    # 1) Пробный пинг Bybit (1 запрос, 4с): если доступен — грузим штатно (Россия и т.п.).
    # 2) Если Bybit недоступен (гео-блок) — сразу OKX-fallback, БЕЗ ожидания таймаутов Bybit.
    logger.info("Попытка загрузки истории (Bybit REST, иначе OKX)...")
    _bybit_ok = False
    try:
        _probe = _fetch_klines_bybit(SYMBOLS[0], 15, 5, retries=1, fast=True)
        _bybit_ok = bool(_probe)
    except Exception:
        _bybit_ok = False
    logger.info(f"Bybit REST доступен: {_bybit_ok} -> {'Bybit' if _bybit_ok else 'OKX fallback'}")

    _boot_start = time.time()
    _boot_limit = 120  # достаточно для OKX по всем символам/ТФ
    for tf in TIMEFRAMES:
        for sym in SYMBOLS:
            if time.time() - _boot_start > _boot_limit:
                break
            try:
                if _bybit_ok:
                    data = _fetch_klines_bybit(sym, tf, 250, retries=2, fast=True)
                else:
                    data = _fetch_klines_okx(sym, tf, 250)
            except Exception as e:
                data = []
                logger.warning(f"  {sym} ({tf}м): ошибка {e}")
            if data:
                for k in data:
                    upsert_completed_candle(histories[tf][sym], k)
                logger.info(f"  {sym} ({tf}м): загружено {len(data)} свечей")
            else:
                logger.debug(f"  {sym} ({tf}м): пропущено")
        if time.time() - _boot_start > _boot_limit:
            break

    for sym in SYMBOLS:
        if time.time() - _boot_start > _boot_limit:
            break
        try:
            if _bybit_ok:
                data = _fetch_klines_bybit(sym, TRAILING_TF, 250, retries=2, fast=True)
            else:
                data = _fetch_klines_okx(sym, TRAILING_TF, 250)
        except Exception as e:
            data = []
            logger.warning(f"  {sym} (5m): ошибка {e}")
        if data:
            for k in data:
                upsert_completed_candle(histories_5m[sym], k)
            logger.info(f"  {sym} (5m): загружено {len(data)} свечей")
        else:
            logger.debug(f"  {sym} (5m): пропущено")

    for sym in SYMBOLS:
        if len(histories[ENTRY_TF][sym]['close']) > 0:
            last_completed_price[sym] = histories[ENTRY_TF][sym]['close'][-1]
    logger.info(f"DEBUG: 15m {SYMBOLS[0]} len={len(histories[ENTRY_TF][SYMBOLS[0]]['close'])} (всего символов={len(SYMBOLS)})")
    _lens = [len(histories[ENTRY_TF][s]['close']) for s in SYMBOLS]
    logger.info(f"DEBUG: все длины 15m = {_lens}")
    _minimum_candles = MACD_SLOW + MACD_SIGNAL
    _ready = sum(
        1 for s in SYMBOLS
        if len(histories[ENTRY_TF][s]['close']) >= _minimum_candles
    )
    logger.info(
        f"Старт завершён. Готово символов (≥{_minimum_candles} свечей 15m): "
        f"{_ready} из {len(SYMBOLS)}"
    )

    try:
        main_loop()
    except KeyboardInterrupt:
        logger.info("Остановка по запросу пользователя.")
        ws_manager.stop()
    except Exception as e:
        logger.error(f"Критическая ошибка: {e}", exc_info=True)
        ws_manager.stop()


if __name__ == "__main__":
    run_bot()
