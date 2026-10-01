import { execFileSync } from "node:child_process";

import { githubApi } from "./prepare-release.mjs";
import { compareVersions, parseVersion } from "./release-version.mjs";

export function publishRelease({ repository, tag, api = githubApi, run = execFileSync }) {
  parseVersion(tag);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GH_REPO");
  const prefix = `repos/${repository}`;
  const release = api("GET", `${prefix}/releases/tags/${tag}`);
  if (!release || typeof release.draft !== "boolean")
    throw new Error("Release is missing or invalid");
  if (!release.draft) return "already-published";
  const latest = api("GET", `${prefix}/releases/latest`);
  if (latest && compareVersions(latest.tag_name, tag) > 0) {
    throw new Error(`A newer release is already published: ${latest.tag_name}`);
  }
  for (const name of ["main.js", "manifest.json"]) {
    if (
      !release.assets?.some(
        (asset) => asset.name === name && asset.state === "uploaded" && asset.size > 0,
      )
    ) {
      throw new Error(`Release asset is missing or incomplete: ${name}`);
    }
  }
  run("gh", ["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"], {
    stdio: "inherit",
  });
  return "published";
}

if (import.meta.main) {
  publishRelease({ repository: process.env.GH_REPO, tag: process.env.RELEASE_TAG });
}
