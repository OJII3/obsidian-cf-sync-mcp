import assert from "node:assert/strict";
import { test } from "node:test";

import { draftRelease } from "./draft-release.mjs";

function setup({ tagExists = false, release, target, checkout, latest } = {}) {
  const sha = "a".repeat(40);
  const calls = [];
  return {
    calls,
    execute: () =>
      draftRelease({
        repository: "owner/repo",
        tag: "0.3.1",
        mergeSha: sha,
        api: (method, path, body) => {
          calls.push({ method, path, body });
          if (path.endsWith("releases/latest")) return latest;
          if (path.endsWith("git/ref/tags/0.3.1"))
            return tagExists ? { object: { sha } } : undefined;
          if (path.endsWith("releases/tags/0.3.1")) return release;
          assert.equal(path, "repos/owner/repo/git/refs");
          return {};
        },
        run: (command, args) => {
          calls.push({ command, args });
          if (args[0] === "rev-parse") return checkout ?? sha;
          if (args[0] === "rev-list") return target ?? sha;
          return "";
        },
      }),
  };
}
test("creates an unprefixed tag on the exact merge and a draft with generated notes", () => {
  const { calls, execute } = setup();
  execute();
  assert.deepEqual(calls.find((call) => call.method === "POST").body, {
    ref: "refs/tags/0.3.1",
    sha: "a".repeat(40),
  });
  assert.ok(calls.at(-1).args.includes("--draft"));
  assert.ok(calls.at(-1).args.includes("--generate-notes"));
});
test("reuses a draft and matching tag when retried", () => {
  const { calls, execute } = setup({ tagExists: true, release: { draft: true } });
  execute();
  assert.ok(calls.every((call) => call.method !== "POST" && call.command !== "gh"));
});
test("rejects tags pointing at other commits, already published releases, and wrong checkouts", () => {
  assert.throws(setup({ tagExists: true, target: "different" }).execute, /another commit/);
  assert.throws(setup({ tagExists: true, release: { draft: false } }).execute, /already published/);
  assert.throws(setup({ checkout: "different" }).execute, /Checkout/);
});

test("does not resume an older draft over a newer published release", () => {
  const { calls, execute } = setup({ latest: { tag_name: "0.4.0" } });
  assert.throws(execute, /newer release/);
  assert.ok(calls.every((call) => call.method !== "POST" && call.command !== "gh"));
});
