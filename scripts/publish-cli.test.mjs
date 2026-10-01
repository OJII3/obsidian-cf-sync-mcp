import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publishCli } from "./publish-cli.mjs";

function setup(t, registry, latest = "0.3.0") {
  const root = mkdtempSync(join(tmpdir(), "cf-sync-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "packages/cli");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "obsidian-cf-sync", version: "0.3.1" }),
  );
  const calls = [];
  const run = (command, args) => {
    assert.equal(command, "npm");
    calls.push(args);
    if (args[0] === "pack")
      return JSON.stringify([
        {
          name: "obsidian-cf-sync",
          version: "0.3.1",
          integrity: "sha512-same",
          filename: "obsidian-cf-sync-0.3.1.tgz",
        },
      ]);
    if (args[0] === "view" && args[2] === "dist-tags.latest") return JSON.stringify(latest);
    if (args[0] === "view") {
      if (registry instanceof Error) throw registry;
      return JSON.stringify(registry);
    }
    assert.equal(args[0], "publish");
    return "";
  };
  return { calls, execute: () => publishCli({ cwd, run }) };
}
test("publishes only when registry returns E404, with provenance", (t) => {
  const error = Object.assign(new Error("not found"), {
    stdout: JSON.stringify({ error: { code: "E404" } }),
  });
  const { calls, execute } = setup(t, error);
  assert.equal(execute(), "published");
  assert.ok(calls.at(-1).includes("--provenance"));
});
test("skips an already published identical tarball on retry", (t) => {
  const { calls, execute } = setup(t, "sha512-same");
  assert.equal(execute(), "already-published");
  assert.ok(!calls.some((args) => args[0] === "publish"));
});
test("refuses to accept a different package with the same version", (t) => {
  const { execute } = setup(t, "sha512-different");
  assert.throws(execute, /different contents/);
});
test("fails closed on registry, authentication and malformed response errors", (t) => {
  for (const error of [
    new Error("network timeout"),
    Object.assign(new Error("unauthorized"), {
      stdout: JSON.stringify({ error: { code: "E401" } }),
    }),
    Object.assign(new Error("invalid json"), { stdout: "not json" }),
  ]) {
    const { calls, execute } = setup(t, error);
    assert.throws(execute);
    assert.ok(!calls.some((args) => args[0] === "publish"));
  }
});

test("does not move npm latest backwards when retrying an old release", (t) => {
  const { calls, execute } = setup(t, "sha512-same", "0.4.0");
  assert.throws(execute, /newer CLI version/);
  assert.ok(!calls.some((args) => args[0] === "publish"));
});
