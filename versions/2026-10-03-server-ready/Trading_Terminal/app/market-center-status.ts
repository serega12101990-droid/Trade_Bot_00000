import { getMarketSessionState, isUsTradingDay } from "./market-calendar";

export type MarketCenterId = "Europe/Moscow" | "Europe/London" | "America/New_York" | "Asia/Hong_Kong";
export type MarketCenterTone = "open" | "extended" | "break" | "closed" | "auction";

export type MarketCenterStatus = {
  label: string;
  tone: MarketCenterTone;
  detail: string;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(timestamp: number, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function closed(detail = "Основные торги не проводятся") : MarketCenterStatus {
  return { label: "Закрыто", tone: "closed", detail };
}

function weekdayOpen(parts: LocalParts) {
  return parts.weekday >= 1 && parts.weekday <= 5;
}

function moscowStatus(timestamp: number): MarketCenterStatus {
  const parts = localParts(timestamp, "Europe/Moscow");
  if (!weekdayOpen(parts)) return closed("Выходной; отдельные специальные сессии зависят от календаря MOEX");
  if (parts.minutes >= 410 && parts.minutes < 420) return { label: "Аукцион", tone: "auction", detail: "Аукцион открытия 06:50–07:00" };
  if (parts.minutes >= 420 && parts.minutes < 590) return { label: "Утренняя", tone: "extended", detail: "Дополнительная утренняя сессия; доступна не для всех бумаг" };
  if (parts.minutes >= 590 && parts.minutes < 1140) return { label: "Открыто", tone: "open", detail: "Основная сессия рынка акций 09:50–19:00" };
  if (parts.minutes >= 1140 && parts.minutes < 1430) return { label: "Вечерняя", tone: "extended", detail: "Дополнительная вечерняя сессия 19:00–23:50" };
  return closed("Следующая стандартная сессия начинается в 06:50 по Москве");
}

function londonStatus(timestamp: number): MarketCenterStatus {
  const parts = localParts(timestamp, "Europe/London");
  if (!weekdayOpen(parts)) return closed("Выходной день Лондонской фондовой биржи");
  if (parts.minutes >= 470 && parts.minutes < 480) return { label: "Аукцион", tone: "auction", detail: "Аукцион открытия 07:50–08:00" };
  if (parts.minutes >= 480 && parts.minutes < 990) return { label: "Открыто", tone: "open", detail: "Регулярные торги LSE 08:00–16:30" };
  return closed("Регулярные торги LSE проходят 08:00–16:30");
}

function newYorkStatus(timestamp: number): MarketCenterStatus {
  const parts = localParts(timestamp, "America/New_York");
  const tradingDay = isUsTradingDay({ year: parts.year, month: parts.month, day: parts.day });
  if (!tradingDay) return closed("Выходной или праздник рынка США");

  const regular = getMarketSessionState("stocks", timestamp);
  if (regular.isOpen) return { label: "Открыто", tone: "open", detail: "Регулярная сессия рынка США" };
  if (parts.minutes >= 240 && parts.minutes < 570) {
    return { label: "Премаркет", tone: "extended", detail: "Расширенная сессия Nasdaq 04:00–09:30 ET; ликвидность ниже основной" };
  }
  const closeParts = regular.sessionClose == null ? null : localParts(regular.sessionClose, "America/New_York");
  const regularClose = closeParts?.minutes ?? 960;
  if (parts.minutes >= regularClose && parts.minutes < 1200) {
    return { label: "Постмаркет", tone: "extended", detail: "Расширенная сессия Nasdaq до 20:00 ET; ликвидность ниже основной" };
  }
  return closed("Стандартные расширенные торги Nasdaq начинаются в 04:00 ET");
}

function hongKongStatus(timestamp: number): MarketCenterStatus {
  const parts = localParts(timestamp, "Asia/Hong_Kong");
  if (!weekdayOpen(parts)) return closed("Выходной день Гонконгской фондовой биржи");
  if (parts.minutes >= 540 && parts.minutes < 570) return { label: "Предторги", tone: "auction", detail: "Предторговая сессия HKEX 09:00–09:30" };
  if ((parts.minutes >= 570 && parts.minutes < 720) || (parts.minutes >= 780 && parts.minutes < 960)) {
    return { label: "Открыто", tone: "open", detail: "Непрерывные торги HKEX 09:30–12:00 и 13:00–16:00" };
  }
  if (parts.minutes >= 720 && parts.minutes < 780) {
    return { label: "Перерыв", tone: "break", detail: "Перерыв обычных акций 12:00–13:00; отдельные бумаги могут торговаться" };
  }
  if (parts.minutes >= 960 && parts.minutes < 970) return { label: "Аукцион", tone: "auction", detail: "Аукцион закрытия HKEX примерно до 16:10" };
  return closed("Основные торги HKEX проходят 09:30–12:00 и 13:00–16:00");
}

export function getMarketCenterStatus(center: MarketCenterId, timestamp = Date.now()): MarketCenterStatus {
  if (center === "Europe/Moscow") return moscowStatus(timestamp);
  if (center === "Europe/London") return londonStatus(timestamp);
  if (center === "America/New_York") return newYorkStatus(timestamp);
  return hongKongStatus(timestamp);
}

