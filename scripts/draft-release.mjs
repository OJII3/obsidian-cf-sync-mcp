import { execFileSync } from "node:child_process";

import { githubApi } from "./prepare-release.mjs";
import { compareVersions, parseVersion } from "./release-version.mjs";

export function draftRelease({ repository, tag, mergeSha, api = githubApi, run = execFileSync }) {
  parseVersion(tag);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(mergeSha)) {
    throw new Error("Invalid GH_REPO or MERGE_SHA");
  }
  const prefix = `repos/${repository}`;
  const head = run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== mergeSha) throw new Error("Checkout does not match merged commit");
  const latest = api("GET", `${prefix}/releases/latest`);
  if (latest && compareVersions(latest.tag_name, tag) > 0) {
    throw new Error(`A newer release is already published: ${latest.tag_name}`);
  }
  const ref = api("GET", `${prefix}/git/ref/tags/${tag}`);
  if (ref) {
    // rev-list dereferences annotated as well as lightweight tags.
    const target = run("git", ["rev-list", "-n", "1", `refs/tags/${tag}`], {
      encoding: "utf8",
    }).trim();
    if (target !== mergeSha) throw new Error(`Release tag points to another commit: ${tag}`);
  } else {
    api("POST", `${prefix}/git/refs`, { ref: `refs/tags/${tag}`, sha: mergeSha });
  }
  const release = api("GET", `${prefix}/releases/tags/${tag}`);
  if (release) {
    if (!release.draft) throw new Error(`Release is already published: ${tag}`);
  } else {
    run(
      "gh",
      [
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--draft",
        "--generate-notes",
        "--verify-tag",
      ],
      { stdio: "inherit" },
    );
  }
}

if (import.meta.main) {
  draftRelease({
    repository: process.env.GH_REPO,
    tag: process.env.RELEASE_TAG,
    mergeSha: process.env.MERGE_SHA,
  });
}
