import assert from "node:assert/strict";
import { test } from "node:test";
import { incidentId, transition } from "../scripts/lib/incidents.mjs";

const COMPONENTS = [{ id: "app" }, { id: "site" }];
const run = (t, app, site = "up") => ({ t, r: { app: { s: app, why: app === "down" ? "Could not connect" : undefined }, site: { s: site } } });

test("the first down run opens an incident, later ones extend it, the first answer resolves it", () => {
  let state = transition([], run("2026-10-30T10:00:00Z", "down"), COMPONENTS);
  assert.equal(state.opened.length, 1);
  assert.deepEqual(state.incidents[0], {
    id: "app-202610301000",
    component: "app",
    start: "2026-10-30T10:00:00Z",
    end: null,
    last: "2026-10-30T10:00:00Z",
    checks: 1,
    why: "Could not connect",
    issue: null,
  });

  state = transition(state.incidents, run("2026-10-30T10:05:00Z", "down"), COMPONENTS);
  assert.equal(state.opened.length, 0);
  assert.equal(state.incidents.length, 1);
  assert.equal(state.incidents[0].checks, 2);

  state = transition(state.incidents, run("2026-10-30T10:10:00Z", "up"), COMPONENTS);
  assert.equal(state.resolved.length, 1);
  assert.equal(state.incidents[0].end, "2026-10-30T10:10:00Z");
  assert.strictEqual(state.resolved[0], state.incidents[0], "resolved incidents are the ones in the new list");

  // Down again later is a new incident, not a reopened one.
  state = transition(state.incidents, run("2026-10-30T11:00:00Z", "down"), COMPONENTS);
  assert.equal(state.incidents.length, 2);
  assert.equal(state.opened[0].id, incidentId("app", "2026-10-30T11:00:00Z"));
});

test("slowness opens nothing, and a slow answer still ends an outage", () => {
  let state = transition([], run("2026-10-30T10:00:00Z", "degraded"), COMPONENTS);
  assert.equal(state.incidents.length, 0);
  state = transition([], run("2026-10-30T10:00:00Z", "down"), COMPONENTS);
  state = transition(state.incidents, run("2026-10-30T10:05:00Z", "degraded"), COMPONENTS);
  assert.equal(state.resolved.length, 1);
});

test("components are tracked separately, and the input list is never changed", () => {
  const before = [];
  const state = transition(before, run("2026-10-30T10:00:00Z", "down", "down"), COMPONENTS);
  assert.deepEqual(state.incidents.map((i) => i.component).sort(), ["app", "site"]);
  assert.deepEqual(before, []);
  const frozen = Object.freeze([Object.freeze({ ...state.incidents[0] })]);
  assert.doesNotThrow(() => transition(frozen, run("2026-10-30T10:05:00Z", "up"), COMPONENTS));
});
