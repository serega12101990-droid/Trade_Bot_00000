import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

async function withCalendar(run) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    await run(await server.ssrLoadModule("/app/market-calendar.ts"));
  } finally {
    await server.close();
  }
}

test("US stocks wait for Monday when the market is closed on a weekend", async () => {
  await withCalendar(({ getMarketSessionState, projectMarketTimes }) => {
    const sunday = Date.parse("2026-08-09T12:00:00.000Z");
    const state = getMarketSessionState("stocks", sunday);
    assert.equal(state.isOpen, false);
    assert.equal(state.reason, "WEEKEND");
    assert.equal(new Date(state.nextOpen).toISOString(), "2026-08-10T13:30:00.000Z");

    const fridayClose = Date.parse("2026-08-07T20:00:00.000Z");
    const projected = projectMarketTimes(fridayClose, 3, "4h", "stocks");
    assert.equal(new Date(projected[1]).toISOString(), "2026-08-10T13:30:00.000Z");
    assert.equal(new Date(projected[2]).toISOString(), "2026-08-10T17:30:00.000Z");
    assert.equal(new Date(projected[3]).toISOString(), "2026-08-11T13:30:00.000Z");
  });
});

test("NYSE holidays and early closes are excluded from the projection", async () => {
  await withCalendar(({ getMarketSessionState, nextMarketBarTime }) => {
    const thanksgiving = Date.parse("2026-11-26T16:00:00.000Z");
    const holiday = getMarketSessionState("stocks", thanksgiving);
    assert.equal(holiday.reason, "HOLIDAY");
    assert.equal(new Date(holiday.nextOpen).toISOString(), "2026-11-27T14:30:00.000Z");

    const earlyCloseLastBar = Date.parse("2026-11-27T17:30:00.000Z");
    assert.equal(
      new Date(nextMarketBarTime(earlyCloseLastBar, "30m", "stocks")).toISOString(),
      "2026-11-30T14:30:00.000Z",
    );
  });
});

test("crypto projections remain continuous through weekends", async () => {
  await withCalendar(({ projectMarketTimes }) => {
    const start = Date.parse("2026-08-07T20:00:00.000Z");
    const projected = projectMarketTimes(start, 2, "4h", "crypto");
    assert.deepEqual(projected, [start, start + 4 * 60 * 60_000, start + 8 * 60 * 60_000]);
  });
});

test("forex is 24/5 and reopens on Sunday evening in New York", async () => {
  await withCalendar(({ getMarketSessionState, nextMarketBarTime }) => {
    const fridayAfterClose = Date.parse("2026-08-14T22:00:00.000Z");
    const closed = getMarketSessionState("forex", fridayAfterClose);
    assert.equal(closed.isOpen, false);
    assert.equal(closed.reason, "WEEKEND");
    assert.equal(new Date(closed.nextOpen).toISOString(), "2026-08-16T21:00:00.000Z");
    assert.equal(new Date(nextMarketBarTime(fridayAfterClose, "1h", "forex")).toISOString(), "2026-08-16T21:00:00.000Z");
  });
});

test("commodity futures skip the daily New York maintenance break", async () => {
  await withCalendar(({ getMarketSessionState, nextMarketBarTime }) => {
    const breakTime = Date.parse("2026-08-12T21:30:00.000Z");
    const closed = getMarketSessionState("commodities", breakTime);
    assert.equal(closed.isOpen, false);
    assert.equal(closed.reason, "OUTSIDE_HOURS");
    assert.equal(new Date(closed.nextOpen).toISOString(), "2026-08-12T22:00:00.000Z");
    const lastBar = Date.parse("2026-08-12T20:30:00.000Z");
    assert.equal(new Date(nextMarketBarTime(lastBar, "1h", "commodities")).toISOString(), "2026-08-12T22:00:00.000Z");
  });
});

test("MOEX uses Moscow sessions and the official 2026 weekend calendar", async () => {
  await withCalendar(({ getMarketSessionState, projectMarketTimes }) => {
    const mondayMorning = Date.parse("2026-08-10T04:10:00.000Z");
    const open = getMarketSessionState("moex", mondayMorning);
    assert.equal(open.isOpen, true);
    assert.equal(new Date(open.sessionClose).toISOString(), "2026-08-10T20:50:00.000Z");

    const tradingSunday = Date.parse("2026-08-09T12:00:00.000Z");
    const weekendSession = getMarketSessionState("moex", tradingSunday);
    assert.equal(weekendSession.isOpen, true);
    assert.equal(new Date(weekendSession.sessionClose).toISOString(), "2026-08-09T16:00:00.000Z");

    const closedSaturday = Date.parse("2026-08-15T12:00:00.000Z");
    const closed = getMarketSessionState("moex", closedSaturday);
    assert.equal(closed.isOpen, false);
    assert.equal(closed.reason, "WEEKEND");
    assert.equal(new Date(closed.nextOpen).toISOString(), "2026-08-17T03:50:00.000Z");

    const fridayLastBar = Date.parse("2026-08-07T20:20:00.000Z");
    const projected = projectMarketTimes(fridayLastBar, 2, "30m", "moex");
    assert.equal(new Date(projected[1]).toISOString(), "2026-08-08T06:50:00.000Z");
    assert.equal(new Date(projected[2]).toISOString(), "2026-08-08T07:20:00.000Z");
  });
});
