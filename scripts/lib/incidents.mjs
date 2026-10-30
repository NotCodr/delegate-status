// Incidents are not declared, they are detected: the first run in which a component is down opens
// one, and the first run in which it answers again closes it. Slowness alone opens nothing; it shows
// on the day's bar instead. Pure functions, so the rules can be tested without a network.

/** A stable id from the component and the minute the outage was first seen: "app-202610302015". */
export const incidentId = (component, t) => `${component}-${String(t).slice(0, 16).replace(/[-:T]/g, "")}`;

/**
 * Apply one run to the incident list. Returns the new list (the input is not changed) plus the
 * incidents this run opened and the ones it resolved, which are objects inside the new list.
 */
export function transition(incidents, run, components) {
  const next = incidents.map((i) => ({ ...i }));
  const opened = [];
  const resolved = [];
  for (const c of components) {
    const r = run.r?.[c.id];
    if (!r) continue;
    const open = next.find((i) => i.component === c.id && !i.end);
    if (r.s === "down") {
      if (open) {
        open.last = run.t;
        open.checks = (open.checks ?? 1) + 1;
        if (r.why) open.why = r.why;
      } else {
        const created = { id: incidentId(c.id, run.t), component: c.id, start: run.t, end: null, last: run.t, checks: 1, why: r.why ?? null, issue: null };
        next.push(created);
        opened.push(created);
      }
    } else if (open) {
      open.end = run.t;
      resolved.push(open);
    }
  }
  return { incidents: next, opened, resolved };
}
