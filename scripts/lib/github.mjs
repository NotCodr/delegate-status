// Incidents as GitHub issues: the monitor opens one when a component goes down (which emails the
// repository's owner) and closes it on recovery. The owner's comments on those issues, and issues
// the owner opens with the `incident` label, become updates on the status page. An owner's issue
// that also carries `maintenance` is planned work: shown, but it does not change the banner.
//
// The repository is public, so anyone can comment. Only an OWNER, MEMBER or COLLABORATOR who is a
// person, not a bot, is ever trusted, and that is checked twice: here, before anything is stored,
// and again in the page, before anything is shown.
//
// Without GITHUB_TOKEN (any local run) every call is a no-op, so nothing local can touch GitHub.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const LABEL = "incident";
/** Added beside `incident` on a notice the owner opens, it marks planned work: shown, but it never turns the banner. */
export const MAINTENANCE = "maintenance";
export const TRUSTED = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);
const MONITOR_LOGIN = "github-actions[bot]";

/** Is this issue or comment by a trusted person? */
export function isTrusted(item) {
  return Boolean(item) && TRUSTED.includes(item.author_association) && item.user?.type !== "Bot" && !String(item.user?.login ?? "").endsWith("[bot]");
}

/** The same test for something already stored, which carries its association and whether a bot wrote it. */
export const isTrustedStored = (item) => Boolean(item) && TRUSTED.includes(item.assoc) && item.bot !== true;

export const githubEnabled = (env = process.env) => Boolean(env.GITHUB_TOKEN && env.GITHUB_REPOSITORY);

const clip = (text, max) => {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

export const NOOP = Object.freeze({
  enabled: false,
  ensureLabel: async () => {},
  openIssue: async () => null,
  closeIssue: async () => {},
  listIncidentIssues: async () => [],
  listComments: async () => [],
});

/** The GitHub calls, or the no-op set when there is no token. */
export function makeGithub(env = process.env) {
  if (!githubEnabled(env)) return NOOP;
  const repo = env.GITHUB_REPOSITORY;
  const gh = async (args) => {
    const { stdout } = await run("gh", args, { env: { ...env, GH_TOKEN: env.GITHUB_TOKEN }, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  };
  return {
    enabled: true,
    async ensureLabel() {
      await gh(["label", "create", LABEL, "--repo", repo, "--color", "D33A2C", "--description", "Shown on the status page", "--force"]);
    },
    async openIssue({ title, body }) {
      const out = await gh(["issue", "create", "--repo", repo, "--title", title, "--body", body, "--label", LABEL]);
      const m = /\/issues\/(\d+)/.exec(out);
      return m ? Number(m[1]) : null;
    },
    async closeIssue(number, comment) {
      await gh(["issue", "close", String(number), "--repo", repo, "--comment", comment]);
    },
    async listIncidentIssues(sinceIso) {
      const out = await gh(["api", "--method", "GET", `repos/${repo}/issues`, "-f", `labels=${LABEL}`, "-f", "state=all", "-f", `since=${sinceIso}`, "-f", "per_page=50"]);
      return JSON.parse(out);
    },
    async listComments(number) {
      const out = await gh(["api", "--method", "GET", `repos/${repo}/issues/${number}/comments`, "-f", "per_page=100"]);
      return JSON.parse(out);
    },
  };
}

/**
 * What the owner has said about incidents, ready to store. The monitor's own issues are kept so
 * that the owner's comments on them can be shown; an issue anyone else opened is dropped entirely,
 * and every comment from someone untrusted is dropped before it is written down.
 */
export async function collectUpdates(github, sinceIso) {
  const issues = (await github.listIncidentIssues(sinceIso)).filter((i) => !i.pull_request);
  const out = [];
  for (const issue of issues) {
    const manual = isTrusted(issue);
    const monitor = issue.user?.login === MONITOR_LOGIN;
    if (!manual && !monitor) continue;
    const comments = issue.comments > 0 ? await github.listComments(issue.number) : [];
    const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
    out.push({
      number: issue.number,
      manual,
      maintenance: manual && labels.includes(MAINTENANCE),
      assoc: manual ? issue.author_association : null,
      bot: !manual,
      title: manual ? clip(issue.title, 140) : null,
      body: manual ? clip(issue.body, 2000) : null,
      state: issue.state === "closed" ? "closed" : "open",
      created: issue.created_at,
      closed: issue.closed_at ?? null,
      updates: comments
        .filter(isTrusted)
        .map((c) => ({ at: c.created_at, body: clip(c.body, 2000), assoc: c.author_association, bot: false })),
    });
  }
  return out.sort((a, b) => a.number - b.number);
}
