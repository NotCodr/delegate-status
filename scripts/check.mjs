// One monitoring run: check every component, add the result to the record, open or close incidents,
// and fetch what the owner has written about them. A component being down is data, not a failure of
// this script, so it exits 0 whatever it finds; only a broken record would stop it.
//
//   node scripts/check.mjs [--data data] [--config config.json]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectUpdates, makeGithub } from "./lib/github.mjs";
import { transition } from "./lib/incidents.mjs";
import { runCheck } from "./lib/probe.mjs";
import {
  appendRun,
  loadChecks,
  loadDaily,
  loadIncidents,
  pruneChecks,
  recomputeDaily,
  saveDaily,
  saveIncidents,
  saveUpdates,
} from "./lib/store.mjs";
import { aboutDuration, dayKey, stamp } from "./lib/time.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(arg("--config", join(root, "config.json")), "utf8"));
const dir = arg("--data", join(root, "data"));
const components = config.components;
const github = makeGithub();
const warn = (what, e) => console.warn(`warning: ${what}: ${e?.message ?? e}`);

const t = new Date().toISOString();
const results = await Promise.all(components.map((c) => runCheck({ ...config.defaults, ...c })));
const run = { t, r: Object.fromEntries(components.map((c, i) => [c.id, results[i]])) };
appendRun(dir, run);
for (const c of components) {
  const r = run.r[c.id];
  console.log(`${c.id.padEnd(5)} ${r.s.padEnd(8)} ${r.ms == null ? "    -" : String(r.ms).padStart(5)} ms  ${r.n} attempt${r.n === 1 ? "" : "s"}${r.why ? `  ${r.why}` : ""}`);
}

// Saved before any call to GitHub, so a run that dies half way cannot open the same issue twice.
const { incidents, resolved } = transition(loadIncidents(dir), run, components);
saveIncidents(dir, incidents);

if (github.enabled) {
  const site = config.site;
  const nameOf = (id) => components.find((c) => c.id === id)?.name ?? id;
  const urlOf = (id) => components.find((c) => c.id === id)?.url ?? "";
  try {
    await github.ensureLabel();
  } catch (e) {
    warn("could not create the incident label", e);
  }
  // Every open incident without an issue gets one: the new ones, and any a failed run left behind.
  for (const inc of incidents.filter((i) => !i.end && i.issue == null)) {
    try {
      inc.issue = await github.openIssue({
        title: `${nameOf(inc.component)} is down`,
        body: [
          `**${nameOf(inc.component)}** stopped answering at ${stamp(inc.start)}.`,
          "",
          `- Check: GET ${urlOf(inc.component)}`,
          `- What happened: ${inc.why ?? "no answer"}`,
          `- Status page: ${site}`,
          "",
          "The monitor closes this issue itself when the check passes again. A comment you add here is shown on the status page as an update.",
        ].join("\n"),
      });
    } catch (e) {
      warn(`could not open an issue for ${inc.id}`, e);
    }
  }
  for (const inc of resolved) {
    if (!inc.issue) continue;
    try {
      await github.closeIssue(inc.issue, `Answering again at ${stamp(inc.end)}. Down for ${aboutDuration(Date.parse(inc.end) - Date.parse(inc.start))}.`);
    } catch (e) {
      warn(`could not close issue #${inc.issue}`, e);
    }
  }
  saveIncidents(dir, incidents);
  try {
    const since = new Date(Date.parse(t) - 15 * 864e5).toISOString();
    saveUpdates(dir, { fetched: t, issues: await collectUpdates(github, since) });
  } catch (e) {
    warn("could not read incident updates", e);
  }
}

const daily = recomputeDaily(loadDaily(dir), loadChecks(dir), incidents, components, Date.parse(t));
saveDaily(dir, daily);
pruneChecks(dir, dayKey(t), config.retainDays ?? 8);
