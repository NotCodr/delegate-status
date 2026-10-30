import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aggregateDay,
  appendRun,
  downMinutes,
  loadChecks,
  loadDaily,
  median,
  pruneChecks,
  recomputeDaily,
  saveDaily,
  serializeDaily,
  uptimeOf,
} from "../scripts/lib/store.mjs";

const COMPONENTS = [{ id: "app" }, { id: "api" }];
const run = (t, app, api = app) => ({ t, r: { app: { s: app, ms: app === "down" ? null : 300 }, api: { s: api, ms: api === "down" ? null : 500 } } });

test("a day's aggregate counts degraded as answering and keeps the median of the answers", () => {
  const runs = [run("2026-10-30T01:00:00Z", "up"), run("2026-10-30T01:05:00Z", "degraded"), run("2026-10-30T01:10:00Z", "down")];
  runs[1].r.app.ms = 4100;
  const agg = aggregateDay(runs, "app");
  assert.deepEqual(agg, { checks: 3, up: 1, degraded: 1, down: 1, median: 2200 });
  assert.equal(uptimeOf(agg), 2 / 3);
  assert.equal(uptimeOf({ checks: 0, down: 0 }), null);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
});

test("minutes down are split at Australian Eastern midnight", () => {
  // 11:50 pm to 12:20 am AEDT, across the night of 30 to 31 October.
  const incidents = [{ component: "app", start: "2026-10-30T12:50:00Z", end: "2026-10-30T13:20:00Z" }];
  assert.equal(downMinutes(incidents, "app", "2026-10-30", 0), 10);
  assert.equal(downMinutes(incidents, "app", "2026-10-31", 0), 20);
  assert.equal(downMinutes(incidents, "api", "2026-10-30", 0), 0);
  // An incident still open runs to the latest check.
  const open = [{ component: "app", start: "2026-10-30T10:00:00Z", end: null }];
  assert.equal(downMinutes(open, "app", "2026-10-30", Date.parse("2026-10-30T10:45:00Z")), 45);
});

test("the daily record is rebuilt from the raw checks, so a rerun never counts twice", () => {
  const checks = new Map([
    ["2026-10-30", [run("2026-10-30T09:00:00Z", "up"), run("2026-10-30T09:05:00Z", "down", "up")]],
    ["2026-10-31", [run("2026-10-30T13:30:00Z", "up")]],
  ]);
  const incidents = [{ component: "app", start: "2026-10-30T09:05:00Z", end: "2026-10-30T09:10:00Z" }];
  const kept = { since: "2026-10-29", days: { "2026-10-29": { app: { checks: 9, up: 9, degraded: 0, down: 0, median: 280, downMin: 0 } } } };
  const once = recomputeDaily(kept, checks, incidents, COMPONENTS, Date.parse("2026-10-30T13:30:00Z"));
  const twice = recomputeDaily(once, checks, incidents, COMPONENTS, Date.parse("2026-10-30T13:30:00Z"));
  assert.deepEqual(once, twice);
  assert.equal(once.since, "2026-10-29");
  assert.deepEqual(once.days["2026-10-29"], kept.days["2026-10-29"], "a day without raw checks keeps its aggregate");
  assert.deepEqual(once.days["2026-10-30"].app, { checks: 2, up: 1, degraded: 0, down: 1, median: 300, downMin: 5 });
  assert.deepEqual(once.days["2026-10-30"].api, { checks: 2, up: 2, degraded: 0, down: 0, median: 500, downMin: 0 });
  assert.equal(recomputeDaily({ since: null, days: {} }, checks, [], COMPONENTS, 0).since, "2026-10-30");
});

test("the record is written one day to a line and reads back the same", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  const daily = { since: "2026-10-30", days: { "2026-10-31": { app: { checks: 1 } }, "2026-10-30": { app: { checks: 2 } } } };
  saveDaily(dir, daily);
  const text = readFileSync(join(dir, "daily.json"), "utf8");
  assert.equal(text, serializeDaily(daily));
  assert.match(text, /\n {4}"2026-10-30": \{"app":\{"checks":2\}\},\n {4}"2026-10-31"/);
  assert.deepEqual(loadDaily(dir), daily);
  assert.deepEqual(loadDaily(join(dir, "missing")), { since: null, days: {} });
});

test("runs are filed under their Australian Eastern day, and old raw days are pruned", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  assert.equal(appendRun(dir, run("2026-10-30T12:59:00Z", "up")), "2026-10-30");
  assert.equal(appendRun(dir, run("2026-10-30T13:01:00Z", "up")), "2026-10-31");
  appendRun(dir, run("2026-10-20T01:00:00Z", "up"));
  appendRun(dir, run("2026-10-30T13:06:00Z", "down"));
  const byDay = loadChecks(dir);
  assert.deepEqual([...byDay.keys()], ["2026-10-20", "2026-10-30", "2026-10-31"]);
  assert.equal(byDay.get("2026-10-31").length, 2);
  // One run per line, so the history of the file is a plain log.
  assert.equal(readFileSync(join(dir, "checks", "2026-10-31.json"), "utf8").split("\n").length, 5);
  assert.deepEqual(pruneChecks(dir, "2026-10-31", 8), ["2026-10-20"]);
  assert.deepEqual(readdirSync(join(dir, "checks")).sort(), ["2026-10-30.json", "2026-10-31.json"]);
});
