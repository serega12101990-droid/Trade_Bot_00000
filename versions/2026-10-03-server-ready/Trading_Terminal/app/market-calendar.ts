import type { Market, Timeframe } from "./terminal-types";

const NEW_YORK_TIMEZONE = "America/New_York";
const MOSCOW_TIMEZONE = "Europe/Moscow";

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

type CalendarDate = { year: number; month: number; day: number };
type NewYorkDateTime = CalendarDate & { hour: number; minute: number; second: number };

export type MarketSessionState = {
  isOpen: boolean;
  reason: "OPEN" | "WEEKEND" | "HOLIDAY" | "OUTSIDE_HOURS" | "ALWAYS_OPEN";
  nextOpen: number | null;
  sessionClose: number | null;
};

const nyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: NEW_YORK_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const moscowFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MOSCOW_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function newYorkParts(timestamp: number): NewYorkDateTime {
  const parts = Object.fromEntries(
    nyFormatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function moscowParts(timestamp: number): NewYorkDateTime {
  const parts = Object.fromEntries(
    moscowFormatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function newYorkLocalToTimestamp(date: CalendarDate, hour: number, minute: number) {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  let guess = wanted;
  for (let pass = 0; pass < 3; pass += 1) {
    const actual = newYorkParts(guess);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += wanted - actualAsUtc;
  }
  return guess;
}

function moscowLocalToTimestamp(date: CalendarDate, hour: number, minute: number) {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  let guess = wanted;
  for (let pass = 0; pass < 3; pass += 1) {
    const actual = moscowParts(guess);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += wanted - actualAsUtc;
  }
  return guess;
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function weekday(date: CalendarDate) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function dateKey(date: CalendarDate) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function nthWeekday(year: number, month: number, dayOfWeek: number, occurrence: number) {
  const first = { year, month, day: 1 };
  const day = 1 + ((7 + dayOfWeek - weekday(first)) % 7) + (occurrence - 1) * 7;
  return { year, month, day };
}

function lastWeekday(year: number, month: number, dayOfWeek: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = { year, month, day: lastDay };
  return { year, month, day: lastDay - ((7 + weekday(last) - dayOfWeek) % 7) };
}

function observedFixedHoliday(year: number, month: number, day: number, saturdayObserved = true) {
  const date = { year, month, day };
  const dayOfWeek = weekday(date);
  if (dayOfWeek === 6 && saturdayObserved) return addDays(date, -1);
  if (dayOfWeek === 0) return addDays(date, 1);
  return date;
}

// Meeus/Jones/Butcher Gregorian Easter algorithm. Good Friday is two days earlier.
function easterSunday(year: number): CalendarDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function holidayKeys(year: number) {
  const dates = [
    observedFixedHoliday(year, 1, 1, false),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    addDays(easterSunday(year), -2),
    lastWeekday(year, 5, 1),
    ...(year >= 2022 ? [observedFixedHoliday(year, 6, 19)] : []),
    observedFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixedHoliday(year, 12, 25),
  ];
  return new Set(dates.map(dateKey));
}

const holidayCache = new Map<number, Set<string>>();

function isHoliday(date: CalendarDate) {
  let holidays = holidayCache.get(date.year);
  if (!holidays) {
    holidays = holidayKeys(date.year);
    holidayCache.set(date.year, holidays);
  }
  return holidays.has(dateKey(date));
}

export function isUsTradingDay(date: CalendarDate) {
  const day = weekday(date);
  return day !== 0 && day !== 6 && !isHoliday(date);
}

// Official MOEX equity-market schedule for 2026. Weekend sessions are part of
// the next settlement day and run on a shorter schedule.
const MOEX_2026_CLOSED_DATES = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-07", "2026-01-10", "2026-01-11",
  "2026-02-14", "2026-02-15",
  "2026-03-07", "2026-03-08", "2026-03-21", "2026-03-22",
  "2026-05-09", "2026-05-10",
  "2026-06-20", "2026-06-21",
  "2026-08-01", "2026-08-02", "2026-08-15", "2026-08-16",
  "2026-09-12", "2026-09-13",
  "2026-10-24", "2026-10-25",
  "2026-12-05", "2026-12-06", "2026-12-31",
]);

const MOEX_2026_HOLIDAY_SESSIONS = new Set([
  "2026-02-23", "2026-05-01", "2026-06-12", "2026-11-04",
]);

function isMoexWeekendSession(date: CalendarDate) {
  if (MOEX_2026_HOLIDAY_SESSIONS.has(dateKey(date))) return true;
  const day = weekday(date);
  return date.year === 2026 && (day === 0 || day === 6) && !MOEX_2026_CLOSED_DATES.has(dateKey(date));
}

export function isMoexTradingDay(date: CalendarDate) {
  if (MOEX_2026_CLOSED_DATES.has(dateKey(date))) return false;
  if (isMoexWeekendSession(date)) return true;
  const day = weekday(date);
  return day !== 0 && day !== 6;
}

function moexSessionBounds(date: CalendarDate) {
  const weekendHours = isMoexWeekendSession(date);
  return {
    open: moscowLocalToTimestamp(date, weekendHours ? 9 : 6, 50),
    close: moscowLocalToTimestamp(date, weekendHours ? 19 : 23, weekendHours ? 0 : 50),
  };
}

function nextMoexTradingDate(date: CalendarDate, includeCurrent: boolean) {
  let candidate = includeCurrent ? date : addDays(date, 1);
  for (let day = 0; day < 14; day += 1) {
    if (isMoexTradingDay(candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error("Не удалось определить следующую сессию MOEX");
}

function nextMoexOpenAfter(timestamp: number) {
  const parts = moscowParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  if (isMoexTradingDay(date)) {
    const bounds = moexSessionBounds(date);
    if (timestamp < bounds.open) return bounds.open;
  }
  return moexSessionBounds(nextMoexTradingDate(date, false)).open;
}

// Official NYSE early closes published for the calendar range used by this project.
const EARLY_CLOSES = new Set([
  "2025-07-03", "2025-11-28", "2025-12-24",
  "2026-11-27", "2026-12-24",
  "2027-11-26",
  "2028-07-03", "2028-11-24",
]);

function sessionBounds(date: CalendarDate) {
  const earlyClose = EARLY_CLOSES.has(dateKey(date));
  return {
    open: newYorkLocalToTimestamp(date, 9, 30),
    close: newYorkLocalToTimestamp(date, earlyClose ? 13 : 16, 0),
    earlyClose,
  };
}

function nextTradingDate(date: CalendarDate, includeCurrent: boolean) {
  let candidate = includeCurrent ? date : addDays(date, 1);
  for (let day = 0; day < 370; day += 1) {
    if (isUsTradingDay(candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error("Не удалось определить следующую сессию рынка США");
}

function nextSessionOpenAfter(timestamp: number) {
  const parts = newYorkParts(timestamp);
  const currentDate = { year: parts.year, month: parts.month, day: parts.day };
  if (isUsTradingDay(currentDate)) {
    const bounds = sessionBounds(currentDate);
    if (timestamp < bounds.open) return bounds.open;
  }
  return sessionBounds(nextTradingDate(currentDate, false)).open;
}

function continuousOpeningHour(market: "forex" | "commodities") {
  return market === "forex" ? 17 : 18;
}

function continuousSessionIsOpen(market: "forex" | "commodities", timestamp: number) {
  const parts = newYorkParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  const day = weekday(date);
  const minutes = parts.hour * 60 + parts.minute;
  if (day === 6) return false;
  if (day === 0) return minutes >= continuousOpeningHour(market) * 60;
  if (day === 5) return minutes < 17 * 60;
  if (market === "commodities" && minutes >= 17 * 60 && minutes < 18 * 60) return false;
  return true;
}

function nextContinuousOpenAfter(market: "forex" | "commodities", timestamp: number) {
  const parts = newYorkParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  const candidates: number[] = [];
  for (let offset = 0; offset < 9; offset += 1) {
    const candidateDate = addDays(date, offset);
    const day = weekday(candidateDate);
    if (day === 0) candidates.push(newYorkLocalToTimestamp(candidateDate, continuousOpeningHour(market), 0));
    if (market === "commodities" && day >= 1 && day <= 4) candidates.push(newYorkLocalToTimestamp(candidateDate, 18, 0));
  }
  return candidates.filter((candidate) => candidate > timestamp).sort((left, right) => left - right)[0] ?? null;
}

function continuousSessionClose(market: "forex" | "commodities", timestamp: number) {
  const parts = newYorkParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateDate = addDays(date, offset);
    const day = weekday(candidateDate);
    if (market === "forex" && day !== 5) continue;
    if (market === "commodities" && (day < 1 || day > 5)) continue;
    const close = newYorkLocalToTimestamp(candidateDate, 17, 0);
    if (close > timestamp) return close;
  }
  return null;
}

function continuousSessionState(market: "forex" | "commodities", timestamp: number): MarketSessionState {
  if (continuousSessionIsOpen(market, timestamp)) {
    return { isOpen: true, reason: "OPEN", nextOpen: null, sessionClose: continuousSessionClose(market, timestamp) };
  }
  const parts = newYorkParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  const day = weekday(date);
  const minutes = parts.hour * 60 + parts.minute;
  const weekend = day === 6 || day === 0 || day === 5 && minutes >= 17 * 60;
  return {
    isOpen: false,
    reason: weekend ? "WEEKEND" : "OUTSIDE_HOURS",
    nextOpen: nextContinuousOpenAfter(market, timestamp),
    sessionClose: null,
  };
}

export function getMarketSessionState(market: Market, timestamp = Date.now()): MarketSessionState {
  if (market === "crypto") {
    return { isOpen: true, reason: "ALWAYS_OPEN", nextOpen: null, sessionClose: null };
  }

  if (market === "forex" || market === "commodities") {
    return continuousSessionState(market, timestamp);
  }

  if (market === "moex") {
    const parts = moscowParts(timestamp);
    const date = { year: parts.year, month: parts.month, day: parts.day };
    if (!isMoexTradingDay(date)) {
      const reason = weekday(date) === 0 || weekday(date) === 6 ? "WEEKEND" : "HOLIDAY";
      return { isOpen: false, reason, nextOpen: nextMoexOpenAfter(timestamp), sessionClose: null };
    }
    const bounds = moexSessionBounds(date);
    if (timestamp >= bounds.open && timestamp < bounds.close) {
      return { isOpen: true, reason: "OPEN", nextOpen: null, sessionClose: bounds.close };
    }
    return { isOpen: false, reason: "OUTSIDE_HOURS", nextOpen: nextMoexOpenAfter(timestamp), sessionClose: bounds.close };
  }

  const parts = newYorkParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  const day = weekday(date);
  if (day === 0 || day === 6) {
    return { isOpen: false, reason: "WEEKEND", nextOpen: nextSessionOpenAfter(timestamp), sessionClose: null };
  }
  if (isHoliday(date)) {
    return { isOpen: false, reason: "HOLIDAY", nextOpen: nextSessionOpenAfter(timestamp), sessionClose: null };
  }
  const bounds = sessionBounds(date);
  if (timestamp >= bounds.open && timestamp < bounds.close) {
    return { isOpen: true, reason: "OPEN", nextOpen: null, sessionClose: bounds.close };
  }
  return { isOpen: false, reason: "OUTSIDE_HOURS", nextOpen: nextSessionOpenAfter(timestamp), sessionClose: bounds.close };
}

function nextWeeklyTradingOpen(timestamp: number) {
  const parts = newYorkParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  const monday = addDays(date, -((weekday(date) + 6) % 7));
  let candidate = addDays(monday, 7);
  for (let day = 0; day < 7; day += 1) {
    if (isUsTradingDay(candidate)) return sessionBounds(candidate).open;
    candidate = addDays(candidate, 1);
  }
  return sessionBounds(nextTradingDate(candidate, true)).open;
}

export function marketCandleCloseTime(timestamp: number, timeframe: Timeframe, market: Market) {
  const nominalClose = timestamp + TIMEFRAME_MS[timeframe];
  // A weekly candle spans several sessions; the first day's close is not its close.
  if (timeframe === "1w" || market === "crypto") return nominalClose;
  let session = getMarketSessionState(market, timestamp);
  // Some daily feeds label a trading day at midnight rather than its session open.
  if (timeframe === "1d" && (session.sessionClose == null || session.sessionClose <= timestamp)
    && session.nextOpen != null && session.nextOpen < nominalClose) {
    session = getMarketSessionState(market, session.nextOpen);
  }
  return session.sessionClose != null && session.sessionClose > timestamp
    ? Math.min(nominalClose, session.sessionClose)
    : nominalClose;
}

export function nextMarketBarTime(timestamp: number, timeframe: Timeframe, market: Market) {
  if (market === "crypto") return timestamp + TIMEFRAME_MS[timeframe];
  if (market === "forex" || market === "commodities") {
    const candidate = timestamp + TIMEFRAME_MS[timeframe];
    const state = continuousSessionState(market, candidate);
    return state.isOpen ? candidate : state.nextOpen ?? candidate;
  }
  if (market === "moex") {
    const parts = moscowParts(timestamp);
    const date = { year: parts.year, month: parts.month, day: parts.day };
    if (timeframe === "1w") {
      let candidate = nextMoexTradingDate(date, false);
      while (weekday(candidate) !== 1) candidate = nextMoexTradingDate(candidate, false);
      return moexSessionBounds(candidate).open;
    }
    if (timeframe === "1d") return moexSessionBounds(nextMoexTradingDate(date, false)).open;
    const candidate = timestamp + TIMEFRAME_MS[timeframe];
    const candidateParts = moscowParts(candidate);
    const candidateDate = { year: candidateParts.year, month: candidateParts.month, day: candidateParts.day };
    if (isMoexTradingDay(candidateDate)) {
      const bounds = moexSessionBounds(candidateDate);
      if (candidate >= bounds.open && candidate < bounds.close) return candidate;
    }
    return nextMoexOpenAfter(timestamp);
  }
  if (timeframe === "1w") return nextWeeklyTradingOpen(timestamp);

  const parts = newYorkParts(timestamp);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  if (timeframe === "1d") {
    return sessionBounds(nextTradingDate(date, false)).open;
  }

  const candidate = timestamp + TIMEFRAME_MS[timeframe];
  const candidateParts = newYorkParts(candidate);
  const candidateDate = { year: candidateParts.year, month: candidateParts.month, day: candidateParts.day };
  if (isUsTradingDay(candidateDate)) {
    const bounds = sessionBounds(candidateDate);
    if (candidate >= bounds.open && candidate < bounds.close) return candidate;
  }
  return nextSessionOpenAfter(timestamp);
}

export function projectMarketTimes(asofTime: number, horizonBars: number, timeframe: Timeframe, market: Market) {
  const times = [asofTime];
  for (let index = 0; index < horizonBars; index += 1) {
    times.push(nextMarketBarTime(times.at(-1) ?? asofTime, timeframe, market));
  }
  return times;
}
