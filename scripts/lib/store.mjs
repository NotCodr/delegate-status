// The record, as files in this repository. Every file is written one entry to a line, so a check
// shows up in the history as one added line and the record reads as a plain log.
//
//   data/daily.json        one line per Australian Eastern day: per component, how many checks,
//                          how many were up, degraded or down, the median response, minutes down.
//                          Kept for good: it is the uptime history.
//   data/checks/<day>.json every check run of that day. Kept for `retainDays`: enough for the
//                          24-hour response line and to rebuild recent days exactly.
//   data/incidents.json    every outage, from the first failed check to the first good one.
//   data/updates.json      what the owner wrote about incidents, already filtered to trusted people.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, dayEnd, dayKey, dayStart } from "./time.mjs";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write through a temp file and a rename, so a killed run leaves the previous file, never half of one. */
function writeAtomic(file, text) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** An array as one JSON value per line. */
export const linesJson = (items) => (items.length ? `[\n${items.map((x) => JSON.stringify(x)).join(",\n")}\n]\n` : "[]\n");

export function loadDaily(dir) {
  const d = readJson(join(dir, "daily.json"), null);
  return { since: typeof d?.since === "string" ? d.since : null, days: d?.days && typeof d.days === "object" ? d.days : {} };
}

export function serializeDaily(daily) {
  const keys = Object.keys(daily.days).sort();
  const rows = keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(daily.days[k])}`).join(",\n");
  return `{\n  "since": ${JSON.stringify(daily.since)},\n  "days": {${keys.length ? `\n${rows}\n  ` : ""}}\n}\n`;
}

export const saveDaily = (dir, daily) => writeAtomic(join(dir, "daily.json"), serializeDaily(daily));

export function loadIncidents(dir) {
  const d = readJson(join(dir, "incidents.json"), []);
  return Array.isArray(d) ? d : [];
}

export const saveIncidents = (dir, incidents) => writeAtomic(join(dir, "incidents.json"), linesJson(incidents));

export function loadUpdates(dir) {
  const d = readJson(join(dir, "updates.json"), null);
  return { fetched: typeof d?.fetched === "string" ? d.fetched : null, issues: Array.isArray(d?.issues) ? d.issues : [] };
}

export function saveUpdates(dir, updates) {
  writeAtomic(join(dir, "updates.json"), `{\n  "fetched": ${JSON.stringify(updates.fetched)},\n  "issues": ${linesJson(updates.issues).trimEnd().replace(/\n/g, "\n  ")}\n}\n`);
}

/** Every retained day of raw checks, keyed by day, oldest first. */
export function loadChecks(dir) {
  const map = new Map();
  const folder = join(dir, "checks");
  if (!existsSync(folder)) return map;
  for (const name of readdirSync(folder).sort()) {
    const m = DAY_FILE.exec(name);
    if (!m) continue;
    const runs = readJson(join(folder, name), []);
    if (Array.isArray(runs)) map.set(m[1], runs);
  }
  return map;
}

/** Add one run to its day's file. Returns the day. */
export function appendRun(dir, run) {
  const key = dayKey(run.t);
  const file = join(dir, "checks", `${key}.json`);
  const runs = readJson(file, []);
  runs.push(run);
  writeAtomic(file, linesJson(runs));
  return key;
}

/** Drop raw days older than the retention. Their aggregates in daily.json are the permanent record. */
export function pruneChecks(dir, today, keepDays) {
  const folder = join(dir, "checks");
  if (!existsSync(folder)) return [];
  const oldest = addDays(today, -(Math.max(1, keepDays) - 1));
  const dropped = [];
  for (const name of readdirSync(folder)) {
    const m = DAY_FILE.exec(name);
    if (m && m[1] < oldest) {
      unlinkSync(join(folder, name));
      dropped.push(m[1]);
    }
  }
  return dropped;
}

// ── Arithmetic ──────────────────────────────────────────────────────────────────────────────────

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** One component's day: how many checks, and how they went. Degraded still counts as answering. */
export function aggregateDay(runs, id) {
  let checks = 0;
  let up = 0;
  let degraded = 0;
  let down = 0;
  const times = [];
  for (const run of runs) {
    const r = run?.r?.[id];
    if (!r) continue;
    checks++;
    if (r.s === "down") {
      down++;
      continue;
    }
    if (r.s === "degraded") degraded++;
    else up++;
    if (Number.isFinite(r.ms)) times.push(r.ms);
  }
  return { checks, up, degraded, down, median: median(times) };
}

/** Share of checks that answered, up or degraded. Null when nothing was checked. */
export const uptimeOf = (agg) => (agg && agg.checks ? (agg.checks - agg.down) / agg.checks : null);

/**
 * Minutes one component spent in outages during one Australian Eastern day: each incident runs from
 * its first failed check to its first good one, and only the part inside the day counts. An incident
 * still open runs to `nowMs`.
 */
export function downMinutes(incidents, id, key, nowMs) {
  const from = dayStart(key);
  const to = dayEnd(key);
  let ms = 0;
  for (const i of incidents) {
    if (i.component !== id) continue;
    const start = Date.parse(i.start);
    const end = i.end ? Date.parse(i.end) : nowMs;
    const lo = Math.max(from, start);
    const hi = Math.min(to, end);
    if (hi > lo) ms += hi - lo;
  }
  return Math.round(ms / 60000);
}

/**
 * Rebuild the aggregate of every day whose raw checks are still held. Recomputing from the raw
 * file, rather than adding one run at a time, means a rerun can never count a check twice. Days
 * whose raw file has been pruned keep the aggregate they already have.
 */
export function recomputeDaily(daily, checksByDay, incidents, components, nowMs) {
  const days = { ...daily.days };
  for (const [key, runs] of checksByDay) {
    const day = {};
    for (const c of components) {
      const agg = aggregateDay(runs, c.id);
      if (!agg.checks) continue;
      day[c.id] = { ...agg, downMin: downMinutes(incidents, c.id, key, nowMs) };
    }
    if (Object.keys(day).length) days[key] = day;
  }
  const since = daily.since ?? ([...checksByDay.keys()].filter((k) => checksByDay.get(k).length).sort()[0] ?? null);
  return { since, days };
}
