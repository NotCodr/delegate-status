// Australian Eastern time is the only clock this page reads in. Day boundaries follow it, so "today"
// on the bars is the day an Australian reader is having, across daylight-saving changes too. Days
// are stepped by the CALENDAR, never by subtracting 24 hours: a day is 23 or 25 hours long twice a
// year, and 24-hour steps would skip or repeat a day there.

export const ZONE = "Australia/Sydney";

const pad = (n) => String(n).padStart(2, "0");

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The wall clock in Australian Eastern time at an instant. */
export function zoneParts(t) {
  const out = {};
  for (const p of PARTS.formatToParts(new Date(t))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** How far Australian Eastern time runs ahead of UTC at an instant, in milliseconds. */
export function offsetMs(t) {
  const ms = +new Date(t);
  const p = zoneParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The Australian Eastern calendar day an instant falls on, as "2026-10-30". */
export function dayKey(t) {
  const p = zoneParts(t);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** A calendar day moved by whole days. */
export function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const u = new Date(Date.UTC(y, m - 1, d + n));
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}

/** The instant a day begins in Australian Eastern time. The second pass settles a DST change. */
export function dayStart(key) {
  const [y, m, d] = key.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetMs(wall);
  return wall - offsetMs(first);
}

export const dayEnd = (key) => dayStart(addDays(key, 1));

/** The last n days up to and including `today`, oldest first. */
export function lastDays(today, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

// ── Words for people ────────────────────────────────────────────────────────────────────────────

const noon = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
};
const LONG_DAY = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const SHORT_DAY = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const DAY_MONTH = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short" });
const CLOCK = new Intl.DateTimeFormat("en-AU", { timeZone: ZONE, hour: "numeric", minute: "2-digit", hour12: true });
const ZONE_NAME = new Intl.DateTimeFormat("en-AU", { timeZone: ZONE, timeZoneName: "short" });

/** "30 October 2026" */
export const longDay = (key) => LONG_DAY.format(noon(key));
/** "30 Oct 2026" */
export const shortDay = (key) => SHORT_DAY.format(noon(key));
/** "30 Oct" */
export const dayMonth = (key) => DAY_MONTH.format(noon(key));
/** "9:15 pm" in Australian Eastern time. ICU puts a narrow space before "pm"; it reads as one. */
export const clock = (t) => CLOCK.format(new Date(t)).replace(/\s/g, " ");
/** "AEDT" or "AEST", whichever was in force at that instant. */
export const zoneName = (t) =>
  ZONE_NAME.formatToParts(new Date(t)).find((p) => p.type === "timeZoneName")?.value ?? "AET";
/** "9:15 pm AEDT" */
export const clockZone = (t) => `${clock(t)} ${zoneName(t)}`;
/** "9:15 pm AEDT, 30 October 2026" */
export const stamp = (t) => `${clockZone(t)}, ${longDay(dayKey(t))}`;

/** "about 12 minutes", "about 1 hour 5 minutes". Never "0 minutes": a detected outage lasted at least one. */
export function aboutDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return `about ${unit(minutes, "minute")}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `about ${unit(h, "hour")} ${unit(m, "minute")}` : `about ${unit(h, "hour")}`;
}
