// One check of one component: a GET, the answer tested against what that component must say, and
// up to three attempts before anything is called down. A single dropped packet on the monitor's own
// side is not an outage, and recording it as one would make the history a record of our network
// luck rather than of the service.

export const USER_AGENT = "DelegateStatusMonitor/1.0 (+https://status.delegateau.com/)";

export const DEFAULTS = Object.freeze({ timeoutMs: 15000, attempts: 3, backoffMs: [5000, 10000], slowMs: 4000 });

/**
 * Does an answer meet the component's expectation? A "soft" failure is an answer that is nearly
 * right, such as the database still starting just after a deploy: retried like any failure, and if it
 * is still the last word, recorded as degraded rather than down.
 */
export function expectation(spec = {}, status, body) {
  const want = spec.status ?? 200;
  if (status !== want) {
    return {
      ok: false,
      reason: status >= 500 ? `Answered with a server error, HTTP ${status}` : `Answered HTTP ${status} instead of ${want}`,
    };
  }
  if (spec.contains && !String(body).includes(spec.contains)) {
    return { ok: false, reason: "Answered, but not with the expected page" };
  }
  if (spec.json) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return { ok: false, reason: "Answered, but not with the expected data" };
    }
    for (const [key, value] of Object.entries(spec.json)) {
      if (data?.[key] === value) continue;
      const soft = spec.softJson?.[key];
      if (Array.isArray(soft) && soft.includes(data?.[key])) {
        return { ok: false, soft: true, reason: spec.softReason ?? "Answered, but not fully ready" };
      }
      return { ok: false, reason: spec.failReason ?? "Answered, but reported a fault" };
    }
  }
  return { ok: true };
}

/** One attempt. Never throws: every way it can go wrong is an answer about the component. */
export async function attempt(component, { fetchImpl = globalThis.fetch, now = () => performance.now() } = {}) {
  const timeoutMs = component.timeoutMs ?? DEFAULTS.timeoutMs;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = now();
  try {
    const res = await fetchImpl(component.url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT, accept: component.accept ?? "*/*", "cache-control": "no-cache" },
    });
    const body = await res.text();
    const ms = Math.round(now() - started);
    return { ...expectation(component.expect, res.status, body), ms, code: res.status };
  } catch {
    const ms = Math.round(now() - started);
    return {
      ok: false,
      reason: ctl.signal.aborted ? `No answer within ${Math.round(timeoutMs / 1000)} seconds` : "Could not connect",
      ms,
      code: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The verdict for one component this run: "up", "degraded" (answered, but slowly or not fully
 * ready) or "down" (every attempt failed). `n` is how many attempts it took, `why` says what went
 * wrong in words a person can act on.
 */
export async function runCheck(component, { attemptFn = attempt, sleep = wait, ...deps } = {}) {
  const attempts = Math.max(1, component.attempts ?? DEFAULTS.attempts);
  const backoff = component.backoffMs ?? DEFAULTS.backoffMs;
  const slowMs = component.slowMs ?? DEFAULTS.slowMs;
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(backoff[Math.min(i - 1, backoff.length - 1)] ?? 0);
    last = await attemptFn(component, deps);
    if (last.ok) {
      const slow = last.ms > slowMs;
      return {
        s: slow ? "degraded" : "up",
        ms: last.ms,
        code: last.code,
        n: i + 1,
        ...(slow ? { why: `Answered slowly, in ${(last.ms / 1000).toFixed(1)} seconds` } : {}),
      };
    }
  }
  if (last.soft) return { s: "degraded", ms: last.ms, code: last.code, n: attempts, why: last.reason };
  return { s: "down", ms: null, code: last.code, n: attempts, why: last.reason };
}
