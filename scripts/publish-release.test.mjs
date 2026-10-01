import assert from "node:assert/strict";
import { test } from "node:test";

import { publishRelease } from "./publish-release.mjs";

function setup({ latest = "0.3.0", draft = true, assets = ["main.js", "manifest.json"] } = {}) {
  const calls = [];
  return {
    calls,
    execute: () =>
      publishRelease({
        repository: "owner/repo",
        tag: "0.3.1",
        api: (_method, path) => {
          if (path.endsWith("/latest")) return { tag_name: latest };
          return { draft, assets: assets.map((name) => ({ name, size: 100, state: "uploaded" })) };
        },
        run: (command, args) => calls.push({ command, args }),
      }),
  };
}
test("publishes a complete draft only after all assets are present", () => {
  const { calls, execute } = setup();
  assert.equal(execute(), "published");
  assert.ok(calls[0].args.includes("--draft=false"));
});
test("failed-jobs-only reruns cannot move GitHub latest backwards", () => {
  const { calls, execute } = setup({ latest: "0.4.0" });
  assert.throws(execute, /newer release/);
  assert.equal(calls.length, 0);
});
test("rerun after successful publication does not promote an old version again", () => {
  const { calls, execute } = setup({ latest: "0.4.0", draft: false });
  assert.equal(execute(), "already-published");
  assert.equal(calls.length, 0);
});
test("refuses publication with missing plugin assets", () => {
  const { calls, execute } = setup({ assets: ["main.js"] });
  assert.throws(execute, /manifest.json/);
  assert.equal(calls.length, 0);
});
