import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compareVersions } from "./release-version.mjs";

export function publishCli({ cwd = "packages/cli", run = execFileSync } = {}) {
  const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
  // Keep the tarball outside the package's "dist" files list to avoid packing an earlier tarball on retry.
  const packDirectory = resolve(cwd, "../../dist/npm");
  mkdirSync(packDirectory, { recursive: true });
  const [packed] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", packDirectory], { cwd, encoding: "utf8" }),
  );
  if (
    packed?.name !== pkg.name ||
    packed?.version !== pkg.version ||
    !packed?.integrity ||
    !packed?.filename
  ) {
    throw new Error("npm pack returned invalid package metadata");
  }
  let latest;
  try {
    latest = JSON.parse(
      run(
        "npm",
        ["view", pkg.name, "dist-tags.latest", "--json", "--registry=https://registry.npmjs.org"],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    let response;
    try {
      response = JSON.parse(error.stdout);
    } catch {
      /* Preserve the original error below. */
    }
    if (response?.error?.code !== "E404") throw error;
  }
  if (latest && compareVersions(latest, pkg.version) > 0) {
    throw new Error(`A newer CLI version is already published: ${latest}`);
  }
  let integrity;
  try {
    integrity = JSON.parse(
      run(
        "npm",
        [
          "view",
          `${pkg.name}@${pkg.version}`,
          "dist.integrity",
          "--json",
          "--registry=https://registry.npmjs.org",
        ],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    let response;
    try {
      response = JSON.parse(error.stdout);
    } catch {
      /* Preserve the original error below. */
    }
    if (response?.error?.code !== "E404") throw error;
    run(
      "npm",
      [
        "publish",
        resolve(packDirectory, packed.filename),
        "--access",
        "public",
        "--provenance",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd, stdio: "inherit" },
    );
    return "published";
  }
  if (integrity !== packed.integrity)
    throw new Error(`npm already has different contents for ${pkg.name}@${pkg.version}`);
  console.log(`${pkg.name}@${pkg.version} is already published with the same integrity`);
  return "already-published";
}

if (import.meta.main) publishCli();
