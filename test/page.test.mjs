import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DAYS_SHOWN, buildModel, formatPct, overallState, renderSite } from "../scripts/lib/page.mjs";

const CONFIG = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const NOW = "2026-10-30T10:15:00Z"; // 9:15 pm AEDT, Friday 30 October 2026

const day = (checks, down = 0, degraded = 0, downMin = 0) => ({ checks, up: checks - down - degraded, degraded, down, median: 640, downMin });

/** Three days of record, a resolved outage with the owner's update, and words that must never be shown. */
function fixture({ appNow = "up", siteNow = "up", noticeOpen = true } = {}) {
  const daily = {
    since: "2026-10-28",
    days: {
      "2026-10-28": { app: day(100), api: day(100), site: day(100) },
      "2026-10-29": { app: day(288, 3, 0, 12), api: day(288), site: day(288, 0, 4) },
      "2026-10-30": { app: day(120), api: day(120), site: day(120) },
    },
  };
  const runs = [];
  for (let i = 12; i >= 0; i--) {
    const t = new Date(Date.parse(NOW) - i * 5 * 60e3).toISOString();
    const last = i === 0;
    runs.push({
      t,
      r: {
        app: last && appNow !== "up" ? { s: appNow, ms: appNow === "down" ? null : 5100, code: appNow === "down" ? 0 : 200, n: 3 } : { s: "up", ms: 600 + i * 7, code: 200, n: 1 },
        api: { s: "up", ms: 800 + i * 3, code: 200, n: 1 },
        site: last && siteNow !== "up" ? { s: siteNow, ms: null, code: 503, n: 3 } : { s: "up", ms: 420, code: 200, n: 1 },
      },
    });
  }
  const incidents = [{ id: "app-202610290915", component: "app", start: "2026-10-29T09:15:00Z", end: "2026-10-29T09:27:00Z", last: "2026-10-29T09:25:00Z", checks: 3, why: "No answer within 15 seconds", issue: 3 }];
  if (appNow === "down") incidents.push({ id: "app-202610301015", component: "app", start: NOW, end: null, last: NOW, checks: 1, why: "Could not connect", issue: null });
  const updates = {
    fetched: NOW,
    issues: [
      {
        number: 3,
        manual: false,
        assoc: null,
        bot: true,
        title: null,
        body: null,
        state: "closed",
        created: "2026-10-29T09:15:00Z",
        closed: "2026-10-29T09:27:00Z",
        updates: [
          { at: "2026-10-29T09:20:00Z", body: "Restarting the service now. <script>alert(1)</script>", assoc: "OWNER", bot: false },
          { at: "2026-10-29T09:21:00Z", body: "BUY CHEAP FOLLOWERS", assoc: "NONE", bot: false },
          { at: "2026-10-29T09:22:00Z", body: "automated noise", assoc: "OWNER", bot: true },
        ],
      },
      { number: 4, manual: true, maintenance: false, assoc: "OWNER", bot: false, title: "Email delivery is slow", body: "Invitations are taking up to an hour.\n\nWe are on it.", state: noticeOpen ? "open" : "closed", created: "2026-10-30T08:00:00Z", closed: noticeOpen ? null : "2026-10-30T09:00:00Z", updates: [] },
      { number: 5, manual: true, assoc: "NONE", bot: false, title: "Visit my site", body: "spam", state: "open", created: "2026-10-30T09:00:00Z", closed: null, updates: [] },
    ],
  };
  return { config: CONFIG, daily, runs, incidents, updates, now: NOW };
}

/** What a reader with scripts off gets: the text, with scripts and styles gone. */
const textOf = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

test("the page is a pure function of the record", () => {
  const a = renderSite(fixture());
  const b = renderSite(fixture());
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ["feed.xml", "index.html", "summary.json"]);
});

test("everything reads with scripts off", () => {
  const text = textOf(renderSite(fixture({ noticeOpen: false }))["index.html"]);
  for (const words of [
    "All systems operational",
    "Last checked 9:15 pm AEDT, 30 October 2026",
    "Delegate app",
    "API and database",
    "Website",
    "Operational",
    "uptime since 28 Oct 2026",
    "Past incidents",
    "Delegate app unavailable",
    "Resolved. Down for about 12 minutes.",
    "Restarting the service now.",
    "No incidents reported.",
    "Monitoring began on 28 October 2026.",
    "Checked about every five minutes by a monitor outside our hosting, in the United States.",
    "Monitoring since 28 October 2026.",
  ]) {
    assert.ok(text.includes(words), `missing: ${words}`);
  }
  // A day's detail is in the page itself, not only in the script's readout.
  assert.ok(text.includes("29 Oct 2026: 98.95% of checks answered, about 12 minutes down"));
  assert.match(text, / 2 Aug 2026: no data, monitoring had not started/);
  assert.ok(!text.includes(" 1 Aug 2026:"), "exactly 90 days are shown, ending today");
});

test("an untrusted or automated word never reaches the page, and the owner's words are escaped", () => {
  const files = renderSite(fixture());
  for (const name of ["index.html", "feed.xml", "summary.json"]) {
    assert.ok(!files[name].includes("BUY CHEAP"), name);
    assert.ok(!files[name].includes("Visit my site"), name);
    assert.ok(!files[name].includes("automated noise"), name);
    assert.ok(!files[name].includes("<script>alert"), name);
  }
  assert.ok(files["index.html"].includes("Restarting the service now. &lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("days before monitoring began are shown as no data, never as up", () => {
  const model = buildModel(fixture());
  for (const c of model.components) {
    assert.equal(c.days.length, DAYS_SHOWN);
    const before = c.days.filter((d) => d.key < "2026-10-28");
    assert.ok(before.length > 80);
    assert.ok(before.every((d) => d.state === "nodata" && d.label.endsWith("monitoring had not started")));
  }
  const app = model.components.find((c) => c.id === "app");
  assert.equal(app.days.find((d) => d.key === "2026-10-29").state, "down");
  assert.equal(model.components.find((c) => c.id === "site").days.find((d) => d.key === "2026-10-29").state, "degraded");
  assert.equal(app.uptime, (508 - 3) / 508);
});

test("the banner says what is wrong, worst first", () => {
  assert.equal(buildModel(fixture({ noticeOpen: false })).overall, "operational");
  assert.equal(buildModel(fixture()).overall, "degraded", "an open notice from the owner is not 'all operational'");
  assert.equal(buildModel(fixture({ siteNow: "down", noticeOpen: false })).overall, "partial");
  assert.equal(buildModel(fixture({ appNow: "down" })).overall, "major");
  assert.equal(buildModel(fixture({ appNow: "degraded", noticeOpen: false })).overall, "degraded");
  assert.equal(overallState([{ state: "nodata" }], 0), "starting");
  const maintenance = fixture();
  maintenance.updates.issues[1].maintenance = true;
  assert.equal(buildModel(maintenance).overall, "operational", "planned work does not turn the banner");
});

test("an outage happening now is shown first, with how long it has lasted, and only once in full", () => {
  const html = renderSite(fixture({ appNow: "down", noticeOpen: false }))["index.html"];
  const text = textOf(html);
  assert.ok(text.includes("Major outage"));
  assert.ok(text.includes("Happening now"));
  assert.ok(text.includes("Ongoing. Down since 9:15 pm AEDT."));
  assert.ok(text.indexOf("Happening now") < text.indexOf("Systems"));
  // The history points up to it rather than repeating it, so no id appears twice.
  assert.ok(text.includes("Still ongoing. The details are at the top of this page."));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
});

test("the uptime figure covers the days watched, then the full 90", () => {
  const young = buildModel(fixture());
  assert.equal(young.components[0].uptimeLabel, "since 28 Oct 2026");
  const old = fixture();
  old.daily.since = "2026-06-01";
  assert.equal(buildModel(old).components[0].uptimeLabel, "over 90 days");
  assert.equal(buildModel(old).historyNote, null);
  assert.equal(buildModel(old).history.length, 14);
  assert.equal(buildModel(fixture()).history.length, 3, "only the watched days are listed");
});

test("the page keeps the public copy rules", () => {
  const files = renderSite(fixture({ appNow: "down" }));
  for (const [name, body] of Object.entries(files)) {
    assert.ok(!body.includes("—"), `${name} has an em dash`);
    assert.ok(!/fly\.io|\bFly\b|Anthropic|Claude|GitHub/i.test(body), `${name} names a vendor`);
  }
});

test("an empty record says monitoring is starting rather than showing anything as up", () => {
  const html = renderSite({ config: CONFIG, daily: { since: null, days: {} }, runs: [], incidents: [], updates: { fetched: null, issues: [] }, now: null })["index.html"];
  const text = textOf(html);
  assert.ok(text.includes("Monitoring is starting"));
  assert.ok(text.includes("The first check has not run yet."));
  assert.ok(text.includes("Monitoring starts with the first check."));
  assert.ok(!text.includes("Operational"));
});

test("percentages are floored, so one failed check never reads as perfect", () => {
  assert.equal(formatPct(1), "100%");
  assert.equal(formatPct(0.99999), "99.99%");
  assert.equal(formatPct(287 / 288), "99.65%");
  assert.equal(formatPct(null), null);
});

test("the feed and the summary describe the same record", () => {
  const files = renderSite(fixture({ appNow: "down" }));
  const summary = JSON.parse(files["summary.json"]);
  assert.equal(summary.status, "major");
  assert.equal(summary.components.find((c) => c.id === "app").status, "down");
  assert.equal(summary.openIncidents.length, 2);
  assert.match(files["feed.xml"], /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.equal((files["feed.xml"].match(/<entry>/g) ?? []).length, 3);
  assert.ok(files["feed.xml"].includes("<title>Delegate app unavailable</title>"));
});
