import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bumpVersion,
  checkReleaseVersion,
  prepareVersionFiles,
  readReleaseFiles,
} from "./release-version.mjs";

const fixture = () => ({
  "package.json": { name: "workspace", version: "0.3.0" },
  "packages/cli/package.json": { name: "cli", version: "0.3.0", bin: "dist/main.js" },
  "packages/worker/package.json": { name: "worker", version: "0.3.0", private: true },
  "manifest.json": { version: "0.3.0", minAppVersion: "1.13.0" },
  "versions.json": { "0.1.0": "1.11.4", "0.3.0": "1.13.0" },
});

for (const [kind, expected] of [
  ["patch", "0.3.1"],
  ["minor", "0.4.0"],
  ["major", "1.0.0"],
]) {
  test(`${kind} bumps all versions atomically and preserves historical compatibility`, () => {
    const source = fixture();
    const before = structuredClone(source);
    const result = prepareVersionFiles(source, kind);
    assert.equal(result.version, expected);
    assert.equal(checkReleaseVersion(result.files, `release/prepare-v${expected}`), expected);
    assert.equal(result.files["versions.json"]["0.1.0"], "1.11.4");
    assert.equal(result.files["packages/cli/package.json"].bin, "dist/main.js");
    assert.deepEqual(source, before);
  });
}

for (const version of [
  "v1.2.3",
  "1.2",
  "01.2.3",
  "1.2.3-beta.1",
  "1.2.3+build",
  "1.2.3\n",
  123,
  "9007199254740992.0.0",
]) {
  test(`rejects invalid version ${JSON.stringify(version)}`, () =>
    assert.throws(() => bumpVersion(version, "patch")));
}
test("rejects unsafe increment and unknown bump type", () => {
  assert.throws(() => bumpVersion("1.2.9007199254740991", "patch"), /out of range/);
  assert.throws(() => bumpVersion("0.3.0", "beta"), /Unknown release type/);
});
test("rejects package/manifest mismatch before mutating source", () => {
  const source = fixture();
  source["packages/worker/package.json"].version = "0.2.0";
  assert.throws(() => prepareVersionFiles(source, "patch"), /Version mismatch/);
  assert.equal(source["package.json"].version, "0.3.0");
});
test("rejects incompatible version map, malformed app version, and incorrect release branch", () => {
  const source = fixture();
  source["versions.json"]["0.3.0"] = "1.11.4";
  assert.throws(() => checkReleaseVersion(source), /versions.json/);
  source["manifest.json"].minAppVersion = "latest";
  assert.throws(() => checkReleaseVersion(source), /Version must be/);
  assert.throws(() => checkReleaseVersion(fixture(), "release/prepare-v9.9.9"), /branch/);
});
test("the actual repository has aligned root, five workspace packages and manifest", () => {
  const files = readReleaseFiles();
  assert.equal(Object.keys(files).length, 8);
  assert.equal(checkReleaseVersion(files), files["package.json"].version);
});

export { fixture };
