// The page, as a pure function of the record. Same record in, byte-identical page out: no clock is
// read here ("now" is the time of the latest check), nothing is random, nothing is fetched. All of it
// reads with scripts off; the one small script only adds "N minutes ago", a warning if the monitor
// itself has gone quiet, and a readout as you move along the bars.

import { TRUSTED } from "./github.mjs";
import { median, uptimeOf } from "./store.mjs";
import { aboutDuration, addDays, clockZone, dayKey, dayMonth, lastDays, longDay, shortDay, stamp } from "./time.mjs";

export const DAYS_SHOWN = 90;
export const HISTORY_DAYS = 14;

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** "100%", "99.65%". Floored, so a day with one failed check never rounds up to a perfect score. */
export function formatPct(share) {
  if (share == null) return null;
  if (share >= 1) return "100%";
  return `${(Math.floor(share * 10000) / 100).toFixed(2)}%`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const trustedStored = (u) => Boolean(u) && TRUSTED.includes(u.assoc) && u.bot !== true;

// ── The model: what the page says, before it is set as HTML ─────────────────────────────────────

function dayModel(key, agg, since, today) {
  const when = `${shortDay(key)}${key === today ? ", today so far" : ""}`;
  if (!agg || !agg.checks) {
    const before = !since || key < since;
    return { key, state: "nodata", label: `${when}: no data, ${before ? "monitoring had not started" : "no checks were recorded"}` };
  }
  const state = agg.down > 0 ? "down" : agg.degraded >= 3 ? "degraded" : "up";
  const parts = [`${formatPct(uptimeOf(agg))} of checks answered`];
  if (agg.downMin > 0) parts.push(`about ${plural(agg.downMin, "minute")} down`);
  else if (agg.down > 0) parts.push("down briefly");
  else parts.push("no downtime");
  if (agg.degraded > 0) parts.push(plural(agg.degraded, "slow check"));
  return { key, state, label: `${when}: ${parts.join(", ")}` };
}

function incidentModels(incidents, updates, components) {
  const names = new Map(components.map((c) => [c.id, c.name]));
  const byIssue = new Map(updates.issues.map((i) => [i.number, i]));
  const trustedUpdates = (list) =>
    (Array.isArray(list) ? list : []).filter(trustedStored).map((u) => ({ at: u.at, body: String(u.body ?? "") })).filter((u) => u.body);
  const auto = incidents
    .filter((i) => names.has(i.component))
    .map((i) => ({
      id: i.id,
      kind: "auto",
      component: i.component,
      title: `${names.get(i.component)} unavailable`,
      start: i.start,
      end: i.end ?? null,
      why: i.why ?? null,
      body: null,
      updates: trustedUpdates(byIssue.get(i.issue)?.updates),
    }));
  const manual = updates.issues
    .filter((i) => i.manual === true && trustedStored(i) && i.title)
    .map((i) => ({
      id: `notice-${i.number}`,
      kind: "manual",
      maintenance: i.maintenance === true,
      component: null,
      title: String(i.title),
      start: i.created,
      end: i.state === "closed" ? i.closed ?? i.created : null,
      why: null,
      body: String(i.body ?? ""),
      updates: trustedUpdates(i.updates),
    }));
  return [...auto, ...manual].sort((a, b) => b.start.localeCompare(a.start));
}

export function overallState(components, openNotices) {
  const known = components.filter((c) => c.state !== "nodata");
  if (!known.length) return "starting";
  if (known.some((c) => c.state === "down" && c.critical)) return "major";
  if (known.some((c) => c.state === "down")) return "partial";
  if (known.some((c) => c.state === "degraded") || openNotices > 0) return "degraded";
  return "operational";
}

export function buildModel({ config, daily, runs, incidents, updates, now }) {
  const nowMs = now ? Date.parse(now) : null;
  const today = now ? dayKey(now) : null;
  const since = daily.since ?? null;
  const windowStart = today ? addDays(today, -(DAYS_SHOWN - 1)) : null;
  // The uptime figure covers the days actually watched: "since 30 Oct 2026" until there are 90 of them.
  const uptimeFrom = since && windowStart && since > windowStart ? since : windowStart;
  const components = config.components.map((c) => {
    const mine = runs.filter((r) => r?.r?.[c.id]);
    const last = mine.at(-1);
    const days = today ? lastDays(today, DAYS_SHOWN).map((key) => dayModel(key, daily.days[key]?.[c.id], since, today)) : [];
    let checks = 0;
    let down = 0;
    if (today) {
      for (const key of lastDays(today, DAYS_SHOWN)) {
        const agg = daily.days[key]?.[c.id];
        if (agg?.checks) {
          checks += agg.checks;
          down += agg.down;
        }
      }
    }
    const spark = nowMs
      ? mine.filter((r) => Date.parse(r.t) > nowMs - 864e5).map((r) => ({ t: Date.parse(r.t), ms: r.r[c.id].ms, s: r.r[c.id].s }))
      : [];
    const answered = spark.filter((p) => p.s !== "down" && Number.isFinite(p.ms)).map((p) => p.ms);
    return {
      id: c.id,
      name: c.name,
      description: c.description ?? "",
      critical: c.critical !== false,
      state: last ? last.r[c.id].s : "nodata",
      latest: last ? { ...last.r[c.id], t: last.t } : null,
      days,
      uptime: checks ? (checks - down) / checks : null,
      uptimeLabel: uptimeFrom === windowStart ? `over ${DAYS_SHOWN} days` : `since ${shortDay(uptimeFrom)}`,
      spark,
      median24: median(answered),
    };
  });
  const all = incidentModels(incidents, updates, config.components);
  const open = all.filter((i) => !i.end);
  // Only days that were watched. A run of "monitoring had not started" days would be filler.
  const history =
    today && since
      ? lastDays(today, HISTORY_DAYS)
          .reverse()
          .filter((key) => key >= since)
          .map((key) => ({ key, items: all.filter((i) => dayKey(i.start) === key) }))
      : [];
  const historyNote = since && today && since > addDays(today, -(HISTORY_DAYS - 1)) ? `Monitoring began on ${longDay(since)}.` : null;
  return {
    site: config.site,
    now,
    nowMs,
    today,
    since,
    historyNote,
    components,
    overall: overallState(components, open.filter((i) => i.kind === "manual" && !i.maintenance).length),
    open,
    history,
    incidents: all,
  };
}

// ── HTML ────────────────────────────────────────────────────────────────────────────────────────

const STATE_WORD = { up: "Operational", degraded: "Degraded", down: "Down", nodata: "No data yet" };
const BANNER = {
  operational: "All systems operational",
  degraded: "Some systems degraded",
  partial: "Partial outage",
  major: "Major outage",
  starting: "Monitoring is starting",
};

const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="#FF4D00" d="M3 3 H17 V7.2 H7.2 V11 H3 Z"/><path fill="currentColor" d="M29 3 V17 H24.8 V7.2 H21 V3 Z"/><path fill="currentColor" d="M29 29 H15 V24.8 H24.8 V21 H29 Z"/><path fill="currentColor" d="M3 29 V15 H7.2 V24.8 H11 V29 Z"/></svg>`;

const chip = (cls, word) => `<span class="chip ${cls}"><i aria-hidden="true"></i>${esc(word)}</span>`;

/** Owner-written text: escaped, paragraphs on blank lines, line breaks kept. Never parsed as markup. */
function paras(text) {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const fullStop = (s) => (s ? (/[.!?…]$/.test(s) ? s : `${s}.`) : "");

function sparkline(points, nowMs) {
  const W = 240;
  const H = 28;
  const answered = points.filter((p) => p.s !== "down" && Number.isFinite(p.ms));
  // Under an hour of answers draws as a stub at the right edge, which reads as a glitch: wait for more.
  if (answered.length < 2 || !nowMs || answered.at(-1).t - answered[0].t < 3600e3) return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line class="spark-none" x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}"/></svg>`;
  const t0 = nowMs - 864e5;
  const top = Math.max(...answered.map((p) => p.ms)) * 1.15;
  const x = (t) => (((t - t0) / 864e5) * W).toFixed(1);
  const y = (ms) => (H - 2 - (ms / top) * (H - 4)).toFixed(1);
  const runs = [];
  let current = [];
  for (const p of points) {
    if (p.s === "down" || !Number.isFinite(p.ms)) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    current.push(`${x(p.t)},${y(p.ms)}`);
  }
  if (current.length) runs.push(current);
  const lines = runs.map((r) => (r.length > 1 ? `<polyline class="spark-line" points="${r.join(" ")}"/>` : "")).join("");
  const downs = points
    .filter((p) => p.s === "down")
    .map((p) => `<line class="spark-down" x1="${x(p.t)}" y1="${H}" x2="${x(p.t)}" y2="${H - 9}"/>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${lines}${downs}</svg>`;
}

function componentHtml(c, nowMs) {
  const pct = formatPct(c.uptime);
  const rest = pct ? `${pct} uptime ${c.uptimeLabel}` : "No data yet";
  const bars = c.days
    .map((d) => `<li class="${d.state}" title="${esc(d.label)}"><span class="sr">${esc(d.label)}</span></li>`)
    .join("");
  const resp =
    c.median24 != null
      ? `<span class="med">${c.median24.toLocaleString("en-AU")} ms median</span>`
      : `<span class="med">No answers yet</span>`;
  return `<article class="comp" id="c-${esc(c.id)}">
<div class="comp-head"><h3>${esc(c.name)}</h3>${chip(c.state, STATE_WORD[c.state] ?? STATE_WORD.nodata)}</div>
<p class="desc">${esc(c.description)}</p>
${c.days.length ? `<ol class="bars" tabindex="0" aria-label="${esc(`${c.name}, daily uptime for the last ${DAYS_SHOWN} days. Use the arrow keys to read each day.`)}">${bars}</ol>
<div class="bars-foot"><span><span class="s90">90 days ago</span><span class="s60">60 days ago</span><span class="s30">30 days ago</span></span><span class="readout" data-readout aria-live="polite">${esc(rest)}</span><span>Today</span></div>` : `<p class="quiet">The first check has not run yet.</p>`}
<div class="resp"><span>Response, last 24 hours</span>${sparkline(c.spark, nowMs)}${resp}</div>
</article>`;
}

function timelineEntries(inc) {
  const entries = [];
  if (inc.end) {
    entries.push({
      at: inc.end,
      head: "Resolved",
      text: inc.kind === "auto" ? `Answering normally again. Down for ${aboutDuration(Date.parse(inc.end) - Date.parse(inc.start))}.` : "",
    });
  }
  for (const u of inc.updates) entries.push({ at: u.at, head: "Update", text: u.body });
  entries.push({
    at: inc.start,
    head: inc.kind === "auto" ? "Detected" : inc.maintenance ? "Posted" : "Reported",
    text: inc.kind === "auto" ? fullStop(inc.why ?? "Stopped answering") : inc.body,
  });
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function incidentState(inc, today) {
  if (inc.maintenance) return inc.end ? "Completed." : "Planned work. Details below.";
  if (inc.end) {
    return inc.kind === "auto"
      ? `Resolved. Down for ${aboutDuration(Date.parse(inc.end) - Date.parse(inc.start))}.`
      : "Resolved.";
  }
  if (inc.kind === "manual") return "Ongoing. We will post updates here.";
  const day = dayKey(inc.start);
  return `Ongoing. Down since ${clockZone(inc.start)}${day === today ? "" : `, ${dayMonth(day)}`}.`;
}

function incidentHtml(inc, today, level) {
  const day = dayKey(inc.start);
  const items = timelineEntries(inc)
    .map((e) => {
      const d = dayKey(e.at);
      const when = d === day ? clockZone(e.at) : `${dayMonth(d)}, ${clockZone(e.at)}`;
      return `<li><time class="when" datetime="${esc(e.at)}">${esc(when)}</time><div class="what"><b>${esc(e.head)}.</b> ${e.text ? paras(e.text) : ""}</div></li>`;
    })
    .join("");
  const status = inc.maintenance
    ? chip("maint", inc.end ? "Completed" : "Maintenance")
    : inc.end
      ? chip("resolved", "Resolved")
      : chip(inc.kind === "auto" ? "down" : "degraded", "Ongoing");
  const h = `h${level}`;
  return `<article class="inc" id="incident-${esc(inc.id)}">
<div class="inc-head"><${h}>${esc(inc.title)}</${h}>${status}</div>
<p class="inc-state">${esc(incidentState(inc, today))}</p>
<ol class="timeline">${items}</ol>
</article>`;
}

/** An open incident in the history: the full account is already under "Happening now". */
function briefHtml(inc) {
  const status = inc.maintenance ? chip("maint", "Maintenance") : chip(inc.kind === "auto" ? "down" : "degraded", "Ongoing");
  return `<article class="inc">
<div class="inc-head"><h4><a href="#incident-${esc(inc.id)}">${esc(inc.title)}</a></h4>${status}</div>
<p class="inc-state">Still ongoing. The details are at the top of this page.</p>
</article>`;
}

const CSS = `@font-face{font-family:"Geist";src:url(fonts/Geist-Variable.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(fonts/GeistMono-latin.woff2) format("woff2");font-weight:300 700;font-style:normal;font-display:swap}
:root{--paper:#F6F5F2;--card:#FFFFFF;--ink:#0E0F11;--muted:#5C5C60;--dim:#66666A;--line:#E4E2DD;--line-2:#D2CFC9;--ok:#1E8A4C;--ok-wash:#E6F3EB;--ok-ink:#11613A;--warn:#E9A41C;--warn-wash:#FCF2D8;--warn-ink:#1C1C1F;--bad:#D33A2C;--bad-wash:#FBE8E5;--bad-ink:#A3241B;--none:#DFDCD5;--none-wash:#EFEDE8;--sans:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--shadow:0 0 0 1px rgb(14 15 17 / .06),1px 2px 2px rgb(22 28 40 / .025),4px 8px 8px rgb(22 28 40 / .03),16px 32px 32px rgb(22 28 40 / .03);color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:400 15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--line-2);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:2px}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.wrap{max-width:880px;margin:0 auto;padding:0 24px}
.top{display:flex;align-items:center;gap:14px;padding:28px 0 22px}
.lockup{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink)}
.lockup svg{width:22px;height:22px;flex:none}
.word{font:500 13px/1 var(--mono);letter-spacing:.18em}
.sep{width:1px;height:16px;background:var(--line-2)}
.crumb{font-size:14px;color:var(--muted)}
.signin{margin-left:auto;font-size:14px}
main{display:flex;flex-direction:column;gap:18px}
.card{background:var(--card);border-radius:6px;box-shadow:var(--shadow)}
.banner{padding:26px 28px}
.banner h1{margin:0;display:flex;align-items:center;gap:12px;font-size:26px;line-height:1.2;font-weight:560;letter-spacing:-.02em}
.sq{width:12px;height:12px;border-radius:2px;flex:none;background:var(--none)}
.operational .sq{background:var(--ok)}.degraded .sq{background:var(--warn)}.partial .sq,.major .sq{background:var(--bad)}
.checked{margin:10px 0 0;font:400 13px/1.5 var(--mono);color:var(--muted)}
.stale{margin:14px 0 0;padding:10px 12px;border-radius:4px;background:var(--warn-wash);color:var(--warn-ink);font-size:14px}
.label{margin:0;font:500 12px/1.4 var(--mono);color:var(--muted)}
.block{padding:22px 28px}
.block>.label{margin-bottom:4px}
.comp{padding:20px 0;border-top:1px solid var(--line)}
.label+.comp{border-top:0}
.comp-head,.inc-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.comp h3,.inc h3,.inc h4{margin:0;font-size:16px;line-height:1.3;font-weight:560;letter-spacing:-.01em}
.desc{margin:3px 0 0;color:var(--muted);font-size:14px}
.chip{display:inline-flex;align-items:center;gap:8px;flex:none;width:118px;height:26px;padding:0 10px;border-radius:2px;font:500 12.5px/1 var(--sans);background:var(--none-wash);color:var(--muted)}
.chip i{width:8px;height:8px;border-radius:1px;flex:none;background:var(--none)}
.chip.up{background:var(--ok-wash);color:var(--ok-ink)}.chip.up i{background:var(--ok)}
.chip.degraded{background:var(--warn-wash);color:var(--warn-ink)}.chip.degraded i{background:var(--warn)}
.chip.down{background:var(--bad-wash);color:var(--bad-ink)}.chip.down i{background:var(--bad)}
.chip.resolved i{background:var(--ok)}
.chip.maint{color:var(--ink)}.chip.maint i{background:var(--muted)}
.bars{list-style:none;display:flex;gap:2px;height:34px;margin:16px 0 0;padding:0}
.bars li{flex:1 1 0;min-width:0;border-radius:2px;background:var(--none)}
.bars li.up{background:var(--ok)}.bars li.degraded{background:var(--warn)}.bars li.down{background:var(--bad)}
.bars li.cur{outline:2px solid var(--ink);outline-offset:1px}
.bars-foot{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:8px;font:400 12px/1.4 var(--mono);color:var(--dim)}
.readout{flex:1;text-align:center;color:var(--ink)}
.s60,.s30{display:none}
.resp{display:flex;align-items:center;gap:14px;margin-top:14px;font:400 12px/1.4 var(--mono);color:var(--dim)}
.resp svg{flex:1;min-width:40px;height:28px;overflow:visible}
.med{color:var(--ink);white-space:nowrap}
.spark-line{fill:none;stroke:#7D7D82;stroke-width:1.25;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.spark-down{stroke:var(--bad);stroke-width:2;vector-effect:non-scaling-stroke}
.spark-none{stroke:var(--line-2);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.quiet{margin:0;color:var(--muted);font-size:14px}
.alert{padding:22px 28px}
.inc{padding:4px 0}
.inc+.inc{margin-top:18px}
.inc-state{margin:4px 0 0;color:var(--muted);font-size:14px}
.timeline{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:12px}
.timeline li{display:grid;grid-template-columns:178px minmax(0,1fr);gap:14px}
.when{font:400 12.5px/1.65 var(--mono);color:var(--dim)}
.what{font-size:14.5px;overflow-wrap:anywhere}
.what b{font-weight:560}
.what p{margin:0 0 6px}
.what b+p{display:inline}
.day{padding:18px 0;border-top:1px solid var(--line)}
.label+.day{border-top:0}
.day>h3{margin:0 0 8px;font-size:14px;font-weight:560;letter-spacing:0}
.day.is-quiet{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;column-gap:16px;padding:12px 0}
.day.is-quiet>h3{margin:0}
.inc h4 a{text-decoration-color:var(--line-2)}
.note{padding:14px 0 2px;border-top:1px solid var(--line)}
footer{padding:30px 0 52px;color:var(--muted);font-size:13.5px}
footer p{margin:0 0 6px}
@media (max-width:719px){.bars li:nth-child(-n+30){display:none}.s90{display:none}.s60{display:inline}}
@media (max-width:479px){.bars li:nth-child(-n+60){display:none}.s60{display:none}.s30{display:inline}.bars-foot{flex-wrap:wrap;row-gap:4px}.readout{order:3;flex-basis:100%;text-align:left}}
@media (max-width:640px){.wrap{padding:0 16px}.banner,.block,.alert{padding-left:18px;padding-right:18px}.banner h1{font-size:22px}.top{padding:20px 0 16px}.timeline li{grid-template-columns:minmax(0,1fr);gap:2px}.resp{flex-wrap:wrap;row-gap:6px}.resp>span:first-child{flex-basis:100%}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}}`;

// The only script: relative time, a warning when the monitor itself has gone quiet, and the bar readout.
const JS = `(()=>{const ago=m=>m<1?"just now":m<60?m+(m===1?" minute ago":" minutes ago"):(h=>h+(h===1?" hour ago":" hours ago"))(Math.floor(m/60));
const t=document.querySelector("[data-checked]"),a=document.querySelector("[data-ago]"),s=document.querySelector("[data-stale]");
function tick(){if(!t)return;const m=Math.max(0,Math.floor((Date.now()-Date.parse(t.getAttribute("datetime")))/60000));if(a)a.textContent=", "+ago(m);if(s){s.hidden=m<20;if(m>=20)s.textContent="The monitor last reported "+ago(m)+". What you see here may be out of date."}}
tick();setInterval(tick,30000);
for(const ol of document.querySelectorAll(".bars")){const out=ol.closest(".comp").querySelector("[data-readout]");if(!out)continue;const rest=out.textContent;const items=[...ol.children];for(const li of items)li.removeAttribute("title");let cur=-1;
const vis=()=>items.filter(li=>li.offsetParent!==null);
const show=li=>{for(const x of items)x.classList.remove("cur");if(!li){out.textContent=rest;return}li.classList.add("cur");out.textContent=li.textContent};
ol.addEventListener("pointerover",e=>{const li=e.target.closest("li");if(li)show(li)});
ol.addEventListener("pointerleave",()=>{if(document.activeElement!==ol)show(null)});
ol.addEventListener("focus",()=>{const v=vis();cur=v.length-1;show(v[cur])});
ol.addEventListener("blur",()=>show(null));
ol.addEventListener("keydown",e=>{const v=vis();if(!v.length)return;if(e.key==="ArrowLeft")cur=Math.max(0,cur-1);else if(e.key==="ArrowRight")cur=Math.min(v.length-1,cur+1);else if(e.key==="Home")cur=0;else if(e.key==="End")cur=v.length-1;else if(e.key==="Escape"){ol.blur();return}else return;e.preventDefault();show(v[cur])})}})();`;

export function renderPage(model) {
  const { components, overall, open, history, historyNote, now, today, since } = model;
  const checked = now
    ? `<p class="checked">Last checked <time data-checked datetime="${esc(now)}">${esc(stamp(now))}</time><span data-ago></span></p><p class="stale" data-stale hidden></p>`
    : `<p class="checked">The first check has not run yet.</p>`;
  const alerts = open.length
    ? `<section class="card alert" aria-labelledby="open-h"><h2 class="label" id="open-h">Happening now</h2>${open.map((i) => incidentHtml(i, today, 3)).join("")}</section>`
    : "";
  const days = history.length
    ? history
        .map((d) =>
          d.items.length
            ? `<section class="day"><h3>${esc(longDay(d.key))}</h3>${d.items.map((i) => (i.end ? incidentHtml(i, today, 4) : briefHtml(i))).join("")}</section>`
            : `<section class="day is-quiet"><h3>${esc(longDay(d.key))}</h3><p class="quiet">No incidents reported.</p></section>`,
        )
        .join("") + (historyNote ? `<p class="quiet note">${esc(historyNote)}</p>` : "")
    : `<p class="quiet">The record starts with the first check.</p>`;
  const sinceLine = since ? `Monitoring since ${longDay(since)}.` : "Monitoring starts with the first check.";
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delegate status</title>
<meta name="description" content="Whether Delegate is up right now, and how it has run over the last 90 days.">
<meta name="theme-color" content="#F6F5F2">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="alternate" type="application/atom+xml" title="Delegate status updates" href="feed.xml">
<link rel="preload" href="fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<meta property="og:title" content="Delegate status">
<meta property="og:description" content="Whether Delegate is up right now, and how it has run over the last 90 days.">
<meta property="og:url" content="${esc(model.site)}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a class="lockup" href="https://www.delegateau.com/" aria-label="Delegate home">${MARK}<span class="word" aria-hidden="true">DELEGATE</span></a><span class="sep" aria-hidden="true"></span><span class="crumb">Status</span><a class="signin" href="https://app.delegateau.com/login">Sign in</a></header>
<main>
<section class="card banner ${overall}" aria-labelledby="overall-h"><h1 id="overall-h"><span class="sq" aria-hidden="true"></span>${esc(BANNER[overall])}</h1>${checked}</section>
${alerts}
<section class="card block" aria-labelledby="systems-h"><h2 class="label" id="systems-h">Systems</h2>
${components.map((c) => componentHtml(c, model.nowMs)).join("\n")}
</section>
<section class="card block" aria-labelledby="history-h"><h2 class="label" id="history-h">Past incidents</h2>${days}</section>
</main>
<footer>
<p>Checked about every five minutes by a monitor outside our hosting, in the United States. Times are Australian Eastern time. ${esc(sinceLine)}</p>
<p><a href="https://www.delegateau.com/">delegateau.com</a> · <a href="https://app.delegateau.com/login">Sign in</a> · <a href="feed.xml">Subscribe to updates</a> · Problems? <a href="mailto:sri@delegateau.com">sri@delegateau.com</a></p>
</footer>
</div>
<script>${JS}</script>
</body>
</html>
`;
}

// ── For machines and feed readers ───────────────────────────────────────────────────────────────

const STATUS_WORD = { up: "operational", degraded: "degraded", down: "down", nodata: "no data" };

export function renderSummary(model) {
  const incident = (i) => ({ id: i.id, title: i.title, component: i.component, start: i.start, end: i.end });
  return `${JSON.stringify(
    {
      page: model.site,
      status: model.overall,
      checkedAt: model.now,
      since: model.since,
      components: model.components.map((c) => ({
        id: c.id,
        name: c.name,
        status: STATUS_WORD[c.state] ?? "no data",
        uptime90: c.uptime == null ? null : Math.floor(c.uptime * 1e6) / 1e6,
        medianMs24h: c.median24,
      })),
      openIncidents: model.open.map(incident),
      recentIncidents: model.incidents.slice(0, 30).map(incident),
    },
    null,
    2,
  )}\n`;
}

const xml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

export function renderFeed(model) {
  const base = model.site;
  const entries = model.incidents.slice(0, 30).map((inc) => {
    const latest = [inc.end, ...inc.updates.map((u) => u.at), inc.start].filter(Boolean).sort().at(-1);
    const lines = timelineEntries(inc).map((e) => `${e.head}, ${stamp(e.at)}. ${e.text}`.trim());
    return `  <entry>
    <title>${xml(inc.title)}</title>
    <link href="${xml(`${base}#incident-${inc.id}`)}"/>
    <id>${xml(`${base}#incident-${inc.id}`)}</id>
    <published>${xml(inc.start)}</published>
    <updated>${xml(latest)}</updated>
    <content type="text">${xml(`${incidentState(inc, model.today)}\n\n${lines.join("\n")}`)}</content>
  </entry>`;
  });
  const updated =
    model.incidents
      .flatMap((i) => [i.start, i.end, ...i.updates.map((u) => u.at)])
      .filter(Boolean)
      .sort()
      .at(-1) ??
    model.now ??
    "2026-10-30T00:00:00Z";
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Delegate status</title>
  <subtitle>Outages and notices for Delegate, as they happen.</subtitle>
  <link href="${xml(base)}" rel="alternate"/>
  <link href="${xml(`${base}feed.xml`)}" rel="self"/>
  <id>${xml(base)}</id>
  <updated>${xml(updated)}</updated>
  <author><name>Delegate</name></author>
${entries.join("\n")}
</feed>
`;
}

/** Every generated file of the site, from the record alone. */
export function renderSite(input) {
  const model = buildModel(input);
  return {
    "index.html": renderPage(model),
    "summary.json": renderSummary(model),
    "feed.xml": renderFeed(model),
  };
}
