# Delegate status

The public status page for Delegate, published at https://status.delegateau.com/.

Every five minutes a workflow in this repository checks the Delegate app, its API and database, and
the website from outside Delegate's hosting. It adds the result to the record in `data/` and
publishes the page. Nothing here runs on Delegate's own servers, so the page stays up when they do
not.

## What is recorded

- `data/checks/<day>.json`: every check of the last eight days, one run per line.
- `data/daily.json`: one line per Australian Eastern day: how many checks answered, how many were
  slow or failed, the median response and the minutes down. This is the uptime history, and it is
  never trimmed.
- `data/incidents.json`: every outage, from the first failed check to the first good one.
- `data/updates.json`: what the owner has written about incidents.

A component is down only when three attempts in a row fail, five and ten seconds apart. An answer
slower than four seconds, or a database that is still starting, counts as degraded. Days before
monitoring began are shown as having no data, never as up.

## Incidents

When a component goes down, the monitor opens an issue labelled `incident`, and it closes the
issue when the component answers again. GitHub emails the repository's owner when the issue opens.

- To post an update, comment on the issue. The comment appears on the page at the next run.
- To announce something the monitor cannot see, open an issue yourself and label it `incident`.
- For planned work, add the `maintenance` label as well. It is shown without changing the banner.

Only issues and comments from the owner, members and collaborators are shown. Anyone else's are
ignored, both when the record is written and when the page is built.

## Running it locally

```sh
node scripts/check.mjs --data .scratch/data
node scripts/render.mjs --data .scratch/data --out .scratch/site
npm test
```

Use a `--data` folder other than `data/` when trying it out, so local checks never enter the
record. Without `GITHUB_TOKEN`, nothing local touches GitHub. Node 22 or newer; no dependencies.

The page uses Geist and Geist Mono, under the SIL Open Font License (`site/fonts/OFL.txt`).
