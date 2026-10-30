// Build the site from the record: `_site/` gets the static page, summary.json, the Atom feed and the
// fixed assets in site/. The page is a pure function of data/, so the same record always publishes
// the same page.
//
//   node scripts/render.mjs [--data data] [--out _site] [--config config.json]

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSite } from "./lib/page.mjs";
import { loadChecks, loadDaily, loadIncidents, loadUpdates } from "./lib/store.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(arg("--config", join(root, "config.json")), "utf8"));
const dir = arg("--data", join(root, "data"));
const out = arg("--out", join(root, "_site"));

const runs = [...loadChecks(dir).values()].flat().filter((r) => r && typeof r.t === "string").sort((a, b) => a.t.localeCompare(b.t));
const now = runs.length ? runs.at(-1).t : null;

const files = renderSite({
  config,
  daily: loadDaily(dir),
  runs,
  incidents: loadIncidents(dir),
  updates: loadUpdates(dir),
  now,
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "site"), out, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
console.log(`rendered ${Object.keys(files).join(", ")} into ${out}${now ? `, last check ${now}` : ", no checks yet"}`);
