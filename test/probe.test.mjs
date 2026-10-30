import assert from "node:assert/strict";
import { test } from "node:test";
import { attempt, expectation, runCheck } from "../scripts/lib/probe.mjs";

const API = {
  url: "https://example.test/api/health",
  expect: { status: 200, json: { db: "ok" }, softJson: { db: ["opening"] }, softReason: "still starting", failReason: "not ready" },
};

test("an answer must be the right status, the right page and the right data", () => {
  assert.equal(expectation({ status: 200 }, 200, "").ok, true);
  assert.match(expectation({ status: 200 }, 503, "").reason, /server error, HTTP 503/);
  assert.match(expectation({ status: 200 }, 404, "").reason, /HTTP 404/);
  assert.equal(expectation({ contains: '<div id="root"' }, 200, "<html><div id=\"root\"></div>").ok, true);
  assert.equal(expectation({ contains: '<div id="root"' }, 200, "<html>maintenance</html>").ok, false);
  assert.equal(expectation(API.expect, 200, '{"ok":true,"db":"ok"}').ok, true);
  assert.deepEqual(expectation(API.expect, 200, '{"ok":true,"db":"opening"}'), { ok: false, soft: true, reason: "still starting" });
  assert.deepEqual(expectation(API.expect, 200, '{"ok":false,"db":"down"}'), { ok: false, reason: "not ready" });
  assert.equal(expectation(API.expect, 200, "<html>").ok, false);
});

/** A scripted sequence of attempt results, and a record of every backoff the check waited. */
function scripted(results) {
  const sleeps = [];
  let i = 0;
  return {
    sleeps,
    deps: {
      attemptFn: async () => results[Math.min(i++, results.length - 1)],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
}
const OK = (ms = 300) => ({ ok: true, ms, code: 200 });
const FAIL = { ok: false, reason: "Could not connect", ms: 20, code: 0 };
const SOFT = { ok: false, soft: true, reason: "still starting", ms: 200, code: 200 };

test("up on the first good answer, with no waiting", async () => {
  const s = scripted([OK(412)]);
  assert.deepEqual(await runCheck(API, s.deps), { s: "up", ms: 412, code: 200, n: 1 });
  assert.deepEqual(s.sleeps, []);
});

test("a failure is retried after 5 seconds, then 10, before anything is called down", async () => {
  const s = scripted([FAIL, OK()]);
  const r = await runCheck(API, s.deps);
  assert.equal(r.s, "up");
  assert.equal(r.n, 2);
  assert.deepEqual(s.sleeps, [5000]);

  const all = scripted([FAIL, FAIL, FAIL]);
  const down = await runCheck(API, all.deps);
  assert.deepEqual(down, { s: "down", ms: null, code: 0, n: 3, why: "Could not connect" });
  assert.deepEqual(all.sleeps, [5000, 10000]);
});

test("a slow answer is degraded, not down", async () => {
  const s = scripted([OK(5200)]);
  const r = await runCheck({ ...API, slowMs: 4000 }, s.deps);
  assert.equal(r.s, "degraded");
  assert.equal(r.n, 1);
  assert.match(r.why, /5\.2 seconds/);
});

test("a database still starting is degraded if that is the last word, down if the last word is a failure", async () => {
  assert.equal((await runCheck(API, scripted([FAIL, FAIL, SOFT]).deps)).s, "degraded");
  assert.equal((await runCheck(API, scripted([SOFT, SOFT, FAIL]).deps)).s, "down");
  assert.equal((await runCheck(API, scripted([SOFT, OK()]).deps)).s, "up");
});

test("an attempt that never answers is cut off at the timeout and says so", async () => {
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const r = await attempt({ url: "https://example.test/", timeoutMs: 40 }, { fetchImpl: hang });
  assert.equal(r.ok, false);
  assert.equal(r.code, 0);
  assert.match(r.reason, /^No answer within/);
});

test("a refused connection is a failed attempt, not a crash", async () => {
  const refuse = async () => {
    throw new TypeError("fetch failed");
  };
  const r = await attempt({ url: "https://example.test/" }, { fetchImpl: refuse });
  assert.deepEqual([r.ok, r.code, r.reason], [false, 0, "Could not connect"]);
});

test("an attempt reads the body and times it", async () => {
  let t = 1000;
  const fake = async () => ({ status: 200, text: async () => '{"db":"ok"}' });
  const r = await attempt(API, { fetchImpl: fake, now: () => (t += 250) });
  assert.deepEqual(r, { ok: true, ms: 250, code: 200 });
});
