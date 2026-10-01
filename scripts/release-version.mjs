import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const preparationBranch = /^release\/prepare-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Version must be X.Y.Z: ${version}`);
  }
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Version is out of range: ${version}`);
  return parts;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

export function bumpVersion(version, releaseType) {
  const parts = parseVersion(version);
  const index = ["major", "minor", "patch"].indexOf(releaseType);
  if (index === -1) throw new Error(`Unknown release type: ${releaseType}`);
  parts[index] += 1;
  parts.fill(0, index + 1);
  const next = parts.join(".");
  parseVersion(next);
  return next;
}

export function readReleaseFiles(root = ".") {
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`)
    .sort();
  const paths = ["package.json", ...packages, "manifest.json", "versions.json"];
  return Object.fromEntries(
    paths.map((path) => [path, JSON.parse(readFileSync(join(root, path), "utf8"))]),
  );
}

export function checkReleaseVersion(files, branch) {
  const version = files["package.json"].version;
  parseVersion(version);
  for (const [path, json] of Object.entries(files)) {
    if (path !== "versions.json" && json.version !== version) {
      throw new Error(`Version mismatch in ${path}: expected ${version}, found ${json.version}`);
    }
  }
  parseVersion(files["manifest.json"].minAppVersion);
  if (files["versions.json"][version] !== files["manifest.json"].minAppVersion) {
    throw new Error(`versions.json must map ${version} to manifest.minAppVersion`);
  }
  if (branch !== undefined && branch !== `release/prepare-v${version}`) {
    throw new Error(`Release branch and package version differ: ${branch}, ${version}`);
  }
  return version;
}

export function prepareVersionFiles(files, releaseType) {
  const current = checkReleaseVersion(files);
  const version = bumpVersion(current, releaseType);
  const updated = structuredClone(files);
  for (const [path, json] of Object.entries(updated)) {
    if (path !== "versions.json") json.version = version;
  }
  updated["versions.json"][version] = updated["manifest.json"].minAppVersion;
  return { version, files: updated };
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (import.meta.main) {
  console.log(checkReleaseVersion(readReleaseFiles(), process.env.RELEASE_BRANCH));
}
