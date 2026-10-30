import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutDuration, addDays, clock, dayEnd, dayKey, dayStart, lastDays, stamp, zoneName } from "../scripts/lib/time.mjs";

const HOUR = 3600e3;

test("a day turns over at Australian Eastern midnight, in summer and in winter", () => {
  // Summer, AEDT is UTC+11.
  assert.equal(dayKey("2026-10-30T12:59:59Z"), "2026-10-30");
  assert.equal(dayKey("2026-10-30T13:00:00Z"), "2026-10-31");
  // Winter, AEST is UTC+10.
  assert.equal(dayKey("2026-07-01T13:59:59Z"), "2026-07-01");
  assert.equal(dayKey("2026-07-01T14:00:00Z"), "2026-07-02");
});

test("the day daylight saving starts is 23 hours long and still one day", () => {
  // Clocks go from 2:00 AEST to 3:00 AEDT on Sunday 4 October 2026 (16:00 UTC on the 3rd).
  assert.equal(dayKey("2026-10-03T15:59:59Z"), "2026-10-04");
  assert.equal(dayKey("2026-10-03T16:00:00Z"), "2026-10-04");
  assert.equal(dayStart("2026-10-04"), Date.parse("2026-10-03T14:00:00Z"));
  assert.equal(dayStart("2026-10-05"), Date.parse("2026-10-04T13:00:00Z"));
  assert.equal(dayEnd("2026-10-04") - dayStart("2026-10-04"), 23 * HOUR);
});

test("the day daylight saving ends is 25 hours long", () => {
  // Clocks go from 3:00 AEDT back to 2:00 AEST on Sunday 5 April 2026.
  assert.equal(dayStart("2026-04-05"), Date.parse("2026-04-04T13:00:00Z"));
  assert.equal(dayStart("2026-04-06"), Date.parse("2026-04-05T14:00:00Z"));
  assert.equal(dayEnd("2026-04-05") - dayStart("2026-04-05"), 25 * HOUR);
});

test("days are stepped by the calendar, so 90 days across a DST change are 90 different days", () => {
  const days = lastDays("2026-10-30", 90);
  assert.equal(days.length, 90);
  assert.equal(new Set(days).size, 90);
  assert.equal(days.at(-1), "2026-10-30");
  assert.equal(days[0], "2026-08-02"); // 30 days of August, all of September, 30 of October
  assert.equal(lastDays("2026-10-30", 1)[0], "2026-10-30");
  for (let i = 1; i < days.length; i++) assert.equal(addDays(days[i - 1], 1), days[i]);
  assert.ok(days.includes("2026-10-04"));
});

test("times are written the Australian way, with the zone in force at the time", () => {
  assert.equal(zoneName("2026-10-30T10:15:00Z"), "AEDT");
  assert.equal(zoneName("2026-07-01T00:00:00Z"), "AEST");
  assert.equal(clock("2026-10-30T10:15:00Z"), "9:15 pm");
  assert.equal(stamp("2026-10-30T10:15:00Z"), "9:15 pm AEDT, 30 October 2026");
});

test("durations are approximate and never zero", () => {
  assert.equal(aboutDuration(0), "about 1 minute");
  assert.equal(aboutDuration(12 * 60e3), "about 12 minutes");
  assert.equal(aboutDuration(65 * 60e3), "about 1 hour 5 minutes");
  assert.equal(aboutDuration(120 * 60e3), "about 2 hours");
});
