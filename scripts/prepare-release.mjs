import { execFileSync } from "node:child_process";

import {
  preparationBranch,
  prepareVersionFiles,
  readReleaseFiles,
  serializeJson,
} from "./release-version.mjs";

export function githubApi(method, path, body, run = execFileSync) {
  const args = ["api", "--method", method, path];
  if (body !== undefined) args.push("--input", "-");
  try {
    const output = run("gh", args, {
      encoding: "utf8",
      input: body === undefined ? undefined : JSON.stringify(body),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim() ? JSON.parse(output) : undefined;
  } catch (error) {
    // Only a genuine GitHub 404 means a resource does not exist. Never swallow auth/network failures.
    let response;
    try {
      response = JSON.parse(error.stdout);
    } catch {
      /* gh may not receive a JSON response. */
    }
    if (method === "GET" && String(response?.status) === "404") return undefined;
    throw error;
  }
}

export function prepareRelease({ repository, baseSha, releaseType, files, api = githubApi }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error("Invalid GITHUB_REPOSITORY or GITHUB_SHA");
  }
  const { version, files: updated } = prepareVersionFiles(files, releaseType);
  const prefix = `repos/${repository}`;
  const branch = `release/prepare-v${version}`;
  const main = api("GET", `${prefix}/git/ref/heads/main`);
  if (main?.object?.sha !== baseSha)
    throw new Error("main changed; start a new preparation run from main");
  if (api("GET", `${prefix}/git/ref/tags/${version}`))
    throw new Error(`Release tag already exists: ${version}`);

  const open = [];
  for (let page = 1; ; page += 1) {
    const pulls = api("GET", `${prefix}/pulls?base=main&state=open&per_page=100&page=${page}`);
    if (!Array.isArray(pulls)) throw new Error("Invalid pull request response from GitHub");
    open.push(
      ...pulls.filter(
        (pr) => pr.head?.repo?.full_name === repository && preparationBranch.test(pr.head.ref),
      ),
    );
    if (pulls.length < 100) break;
  }
  if (open.some((pr) => pr.head.ref !== branch)) {
    throw new Error(
      "Another release preparation PR is open; merge or close it before choosing a different version",
    );
  }

  const base = api("GET", `${prefix}/git/commits/${baseSha}`);
  if (!base?.tree?.sha) throw new Error("Invalid base commit response from GitHub");
  const tree = api("POST", `${prefix}/git/trees`, {
    base_tree: base.tree.sha,
    tree: Object.entries(updated).map(([path, json]) => ({
      path,
      mode: "100644",
      type: "blob",
      content: serializeJson(json),
    })),
  });
  if (!tree?.sha) throw new Error("Invalid tree response from GitHub");

  const ref = api("GET", `${prefix}/git/ref/heads/${branch}`);
  if (ref) {
    const existing = api("GET", `${prefix}/git/commits/${ref.object.sha}`);
    if (
      existing?.tree?.sha !== tree.sha ||
      existing?.parents?.length !== 1 ||
      existing.parents[0].sha !== baseSha
    ) {
      throw new Error(`Existing branch has different changes; refusing to overwrite ${branch}`);
    }
  } else {
    const commit = api("POST", `${prefix}/git/commits`, {
      message: `chore: バージョンを ${version} に更新\n\nリリース準備のためワークスペース、manifest.json、versions.jsonをまとめて更新する。`,
      tree: tree.sha,
      parents: [baseSha],
    });
    if (!commit?.sha) throw new Error("Invalid commit response from GitHub");
    api("POST", `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  const pull =
    open[0] ??
    api("POST", `${prefix}/pulls`, {
      base: "main",
      head: branch,
      title: `chore: ${version} のリリースを準備`,
      body: `プラグイン、CLI、Workerと内部パッケージを ${version} に揃え、Obsidianの互換性情報を更新します。\n\nPR上の **Approve workflows to run** でCI実行を承認し、成功を確認してmainにマージすると、タグ作成、プラグインアセットの添付、CLIのnpm公開、GitHub Releaseの公開が順に実行されます。Workerのデプロイは別途行います。`,
    });
  if (!pull?.html_url) throw new Error("Invalid pull request response from GitHub");
  return pull.html_url;
}

if (import.meta.main) {
  const { GITHUB_TOKEN, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF } = process.env;
  if (!(GITHUB_TOKEN || GH_TOKEN) || !GITHUB_REPOSITORY || !GITHUB_SHA) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA are required");
  }
  if (GITHUB_REF !== "refs/heads/main") throw new Error("Release preparation must run from main");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== GITHUB_SHA) throw new Error("Checkout does not match GITHUB_SHA");
  console.log(
    prepareRelease({
      repository: GITHUB_REPOSITORY,
      baseSha: GITHUB_SHA,
      releaseType: process.argv[2],
      files: readReleaseFiles(),
    }),
  );
}
