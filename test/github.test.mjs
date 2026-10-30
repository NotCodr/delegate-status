import assert from "node:assert/strict";
import { test } from "node:test";
import { NOOP, collectUpdates, githubEnabled, isTrusted, isTrustedStored, makeGithub } from "../scripts/lib/github.mjs";

const person = (association, login = "someone") => ({ author_association: association, user: { login, type: "User" } });

test("only an owner, member or collaborator who is a person is trusted", () => {
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) assert.equal(isTrusted(person(a)), true, a);
  for (const a of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", undefined]) {
    assert.equal(isTrusted(person(a)), false, String(a));
  }
  assert.equal(isTrusted({ author_association: "OWNER", user: { login: "github-actions[bot]", type: "Bot" } }), false);
  assert.equal(isTrusted({ author_association: "MEMBER", user: { login: "helper[bot]", type: "User" } }), false);
  assert.equal(isTrusted(null), false);
  assert.equal(isTrustedStored({ assoc: "OWNER", bot: false }), true);
  assert.equal(isTrustedStored({ assoc: "NONE", bot: false }), false);
  assert.equal(isTrustedStored({ assoc: "OWNER", bot: true }), false);
});

test("without a token nothing reaches GitHub", async () => {
  assert.equal(githubEnabled({}), false);
  assert.equal(githubEnabled({ GITHUB_TOKEN: "x" }), false);
  assert.equal(githubEnabled({ GITHUB_TOKEN: "x", GITHUB_REPOSITORY: "o/r" }), true);
  assert.strictEqual(makeGithub({}), NOOP);
  assert.equal(await NOOP.openIssue({ title: "t", body: "b" }), null);
  assert.deepEqual(await NOOP.listIncidentIssues("2026-10-01T00:00:00Z"), []);
});

test("a stranger's words never reach the record: their issues and their comments are dropped", async () => {
  const monitorIssue = { number: 3, user: { login: "github-actions[bot]", type: "Bot" }, author_association: "NONE", title: "Delegate app is down", body: "auto", state: "closed", created_at: "2026-10-30T10:00:00Z", closed_at: "2026-10-30T10:12:00Z", comments: 3 };
  const ownerNotice = { ...person("OWNER", "NotCodr"), number: 4, title: "Planned maintenance tonight", body: "We will restart at 11 pm.", state: "open", created_at: "2026-10-30T11:00:00Z", closed_at: null, comments: 0 };
  const strangerIssue = { ...person("NONE", "spammer"), number: 5, title: "Visit my site", body: "spam", state: "open", created_at: "2026-10-30T11:30:00Z", comments: 0 };
  const pull = { ...person("OWNER"), number: 6, pull_request: {}, title: "PR", state: "open", created_at: "2026-10-30T12:00:00Z", comments: 0 };
  const comments = {
    3: [
      { ...person("OWNER", "NotCodr"), created_at: "2026-10-30T10:04:00Z", body: "Looking into it now." },
      { ...person("NONE", "spammer"), created_at: "2026-10-30T10:05:00Z", body: "BUY CHEAP FOLLOWERS" },
      { author_association: "NONE", user: { login: "github-actions[bot]", type: "Bot" }, created_at: "2026-10-30T10:12:00Z", body: "Answering again." },
    ],
  };
  const fake = {
    listIncidentIssues: async () => [monitorIssue, ownerNotice, strangerIssue, pull],
    listComments: async (n) => comments[n] ?? [],
  };
  const out = await collectUpdates(fake, "2026-10-15T00:00:00Z");
  assert.deepEqual(out.map((i) => i.number), [3, 4]);
  const auto = out.find((i) => i.number === 3);
  assert.equal(auto.manual, false);
  assert.equal(auto.title, null, "the monitor's own issue text is not shown, only the owner's comments on it");
  assert.deepEqual(auto.updates, [{ at: "2026-10-30T10:04:00Z", body: "Looking into it now.", assoc: "OWNER", bot: false }]);
  const notice = out.find((i) => i.number === 4);
  assert.deepEqual([notice.manual, notice.assoc, notice.title, notice.state], [true, "OWNER", "Planned maintenance tonight", "open"]);
  assert.ok(!JSON.stringify(out).includes("BUY CHEAP") && !JSON.stringify(out).includes("spam"));
});
