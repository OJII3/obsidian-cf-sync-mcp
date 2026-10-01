import assert from "node:assert/strict";
import { test } from "node:test";

import { githubApi, prepareRelease } from "./prepare-release.mjs";

const sha = "a".repeat(40);
const repository = "owner/cf-sync";
const branch = "release/prepare-v0.3.1";
function setup(overrides = {}) {
  const calls = [];
  const responses = {
    "GET /git/ref/heads/main": { object: { sha } },
    "GET /git/ref/tags/0.3.1": undefined,
    "GET /pulls?base=main&state=open&per_page=100&page=1": [],
    [`GET /git/commits/${sha}`]: { tree: { sha: "base-tree" } },
    "POST /git/trees": { sha: "new-tree" },
    [`GET /git/ref/heads/${branch}`]: undefined,
    "POST /git/commits": { sha: "new-commit" },
    "POST /git/refs": {},
    "POST /pulls": { html_url: "https://github.com/owner/cf-sync/pull/1" },
    ...overrides,
  };
  const api = (method, path, body) => {
    const key = `${method} ${path.slice(`repos/${repository}`.length)}`;
    calls.push({ key, body });
    assert.ok(Object.hasOwn(responses, key), `Unexpected API request: ${key}`);
    if (responses[key] instanceof Error) throw responses[key];
    return responses[key];
  };
  const files = {
    "package.json": { version: "0.3.0" },
    "packages/cli/package.json": { version: "0.3.0" },
    "manifest.json": { version: "0.3.0", minAppVersion: "1.13.0" },
    "versions.json": { "0.3.0": "1.13.0" },
  };
  return {
    calls,
    execute: () => prepareRelease({ repository, baseSha: sha, releaseType: "patch", files, api }),
  };
}

test("creates one atomic version commit and a reviewable release PR", () => {
  const { calls, execute } = setup();
  assert.equal(execute(), "https://github.com/owner/cf-sync/pull/1");
  const tree = calls.find((call) => call.key === "POST /git/trees").body;
  assert.equal(tree.base_tree, "base-tree");
  assert.equal(tree.tree.length, 4);
  assert.equal(JSON.parse(tree.tree[0].content).version, "0.3.1");
  assert.deepEqual(calls.find((call) => call.key === "POST /git/commits").body.parents, [sha]);
  assert.equal(calls.at(-1).body.head, branch);
  assert.match(calls.at(-1).body.body, /Approve workflows to run/);
});
test("rejects stale main and an existing tag before writing", () => {
  for (const overrides of [
    { "GET /git/ref/heads/main": { object: { sha: "different" } } },
    { "GET /git/ref/tags/0.3.1": { object: { sha } } },
  ]) {
    const { calls, execute } = setup(overrides);
    assert.throws(execute);
    assert.ok(calls.every((call) => call.key.startsWith("GET ")));
  }
});
test("never closes another release PR or deletes a branch", () => {
  const { calls, execute } = setup({
    "GET /pulls?base=main&state=open&per_page=100&page=1": [
      { head: { repo: { full_name: repository }, ref: "release/prepare-v0.4.0" } },
    ],
  });
  assert.throws(execute, /Another release preparation PR/);
  assert.ok(calls.every((call) => call.key.startsWith("GET ")));
});
test("ignores release-like branches from forks and unrelated PRs", () => {
  const { execute } = setup({
    "GET /pulls?base=main&state=open&per_page=100&page=1": [
      { head: { repo: { full_name: "other/fork" }, ref: "release/prepare-v0.4.0" } },
      { head: { repo: { full_name: repository }, ref: "feature/example" } },
    ],
  });
  assert.match(execute(), /pull\/1$/);
});
test("reuses an identical branch and PR after a partial failure", () => {
  const { calls, execute } = setup({
    "GET /pulls?base=main&state=open&per_page=100&page=1": [
      { head: { repo: { full_name: repository }, ref: branch }, html_url: "existing-pr" },
    ],
    [`GET /git/ref/heads/${branch}`]: { object: { sha: "existing" } },
    "GET /git/commits/existing": { tree: { sha: "new-tree" }, parents: [{ sha }] },
  });
  assert.equal(execute(), "existing-pr");
  assert.ok(
    !calls.some((call) =>
      ["POST /git/commits", "POST /git/refs", "POST /pulls"].includes(call.key),
    ),
  );
  assert.equal(calls.at(-1).key, "GET /git/commits/existing");
});
test("refuses to overwrite an edited or stale preparation branch", () => {
  const { calls, execute } = setup({
    [`GET /git/ref/heads/${branch}`]: { object: { sha: "existing" } },
    "GET /git/commits/existing": { tree: { sha: "user-edits" }, parents: [{ sha }] },
  });
  assert.throws(execute, /refusing to overwrite/);
  assert.ok(!calls.some((call) => call.key === "POST /git/refs"));
});
test("API failures propagate instead of continuing with publication", () => {
  const { calls, execute } = setup({ "POST /git/trees": new Error("rate limited") });
  assert.throws(execute, /rate limited/);
  assert.equal(calls.at(-1).key, "POST /git/trees");
});
test("failed PR creation can resume from the existing matching commit", () => {
  const { execute } = setup({
    [`GET /git/ref/heads/${branch}`]: { object: { sha: "existing" } },
    "GET /git/commits/existing": { tree: { sha: "new-tree" }, parents: [{ sha }] },
  });
  assert.match(execute(), /pull\/1$/);
});

test("GitHub adapter only treats read 404s as missing, not auth/network/write failures", () => {
  const request = (status) => () => {
    throw Object.assign(new Error(`HTTP ${status}`), { stdout: JSON.stringify({ status }) });
  };
  assert.equal(githubApi("GET", "missing", undefined, request("404")), undefined);
  assert.equal(githubApi("GET", "missing", undefined, request(404)), undefined);
  assert.throws(() => githubApi("POST", "missing", {}, request("404")), /HTTP 404/);
  assert.throws(() => githubApi("GET", "private", undefined, request("403")), /HTTP 403/);
  assert.throws(
    () =>
      githubApi("GET", "timeout", undefined, () => {
        throw new Error("timeout");
      }),
    /timeout/,
  );
});
test("GitHub adapter sends structured JSON without shell interpolation", () => {
  const body = { title: 'quotes " and $shell characters' };
  const result = githubApi("POST", "repos/owner/repo/pulls", body, (command, args, options) => {
    assert.equal(command, "gh");
    assert.deepEqual(args, ["api", "--method", "POST", "repos/owner/repo/pulls", "--input", "-"]);
    assert.deepEqual(JSON.parse(options.input), body);
    return '{"html_url":"test"}';
  });
  assert.deepEqual(result, { html_url: "test" });
});
