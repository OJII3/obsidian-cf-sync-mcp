# リリース手順

[luna-chat](https://github.com/shun-shobon/luna-chat)と同じく、GitHub Actionsから準備PRを作成し、mainへのマージを公開の起点にする。プラグイン、CLI、Worker、内部パッケージは同じバージョンを使う。

## リリースを開始する

1. GitHub Actionsの **Prepare release** を開き、mainブランチを選ぶ。
2. `release_type` に `patch`、`minor`、`major` を指定して実行する。
3. 作成された `release/prepare-vX.Y.Z` ブランチのPRで、**Approve workflows to run** をクリックしてCIを実行する。全package.json、manifest.json、versions.jsonの差分とCIの **Status check** を確認する。
4. PRをmainにマージする。**Release** がマージコミットに対してCIを再実行し、成功後にタグと下書きリリースを作成する。
5. プラグインの `main.js` / `manifest.json` をビルド・検証証明付きで下書きへ添付し、CLIをnpmに公開する。全て成功してからGitHub Releaseを公開する。

リリースノートはGitHubの自動生成を使用する。CHANGELOGの手動更新やタグの手動pushは不要。通常のPRのマージ、準備PRの未マージでのclose、タグpushだけでは公開しない。

Obsidianではタグがmanifest.jsonのversionと一致する必要があるため、タグは従来どおり `X.Y.Z` とする（luna-chatの `vX.Y.Z` とは異なる）。準備ブランチ名にはluna-chatと同じ `release/prepare-v` を使う。

WorkerはCIでdry-runビルドするが、このフローではCloudflareにデプロイしない。必要に応じて公開したタグをcheckoutし、自分のCloudflare環境へ `pnpm deploy` でデプロイする。

## 初回に確認する設定

- リポジトリのActions設定で、GitHub ActionsによるPull Requestの作成を許可する。準備ワークフローは `contents: write`、`pull-requests: write` を使用する。
- npmの `obsidian-cf-sync` に、GitHubリポジトリ `shun-shobon/obsidian-cf-sync`、ワークフローファイル名 `release.yml` のTrusted Publisherが設定されていることを確認する。既存のファイル名を維持しており、新しいnpmトークンは不要。
- 準備PRはGITHUB_TOKENで作成するため、PR上の **Approve workflows to run** でCIを承認する。書き込み権限を持つユーザーの操作が必要。workflow_dispatchで別途起動したCIではPRの必須チェックを満たせないため、PRイベントのCIを使う。
- リリース準備PRのマージは通常のユーザー操作で行う。GITHUB_TOKENを使った別ワークフローからの自動マージは `pull_request: closed` の公開ワークフローを起動しない。

これらの設定はコードの変更だけでは反映されない。アカウント設定の変更や最初の実公開は、管理者が確認した上で行う。

## 失敗・再実行

- 同じmainコミット・同じバージョンの準備を再実行した場合、同一内容の既存ブランチ/PRを再利用する。PR作成だけが失敗した場合にも再開できる。
- 別バージョンの準備PRが開いている場合は停止する。先に既存PRをマージまたはcloseする。既存の準備ブランチに手動編集がある場合や古いmainから作られている場合も上書きせず停止する。不要な準備PR/ブランチを確認してから片付け、mainから再実行する。
- 途中でmainが更新された準備ワークフローは停止するため、mainを選んで新しく実行する。
- 公開処理で失敗した場合は、まず原因を直し、GitHub Actionsの **Re-run failed jobs** を使う。公開前のGitHub Releaseは下書きのまま残る。
- 全ジョブを再実行しても、同じコミットのタグと既存下書きを再利用できる。別コミットを指すタグや公開済みリリースは変更せず停止する。
- 公開フローは直列実行し、待機中のリリースを通常PRのcloseで取り消さない。古い失敗ジョブを再実行しても、より新しいGitHub/npmバージョンが公開済みなら停止し、latestを巻き戻さない。
- npm公開に成功してGitHub Release公開だけが失敗した場合、npm上のtarballのintegrityが今回のビルドと一致するときだけ再公開をスキップする。同一バージョンで内容が違う場合、認証エラー、通信エラーは成功扱いにしない。
- npmへの公開とGitHub Releaseの公開は別サービスのため、完全な原子的公開ではない。最後のGitHub公開に失敗した場合、CLIだけが先にnpmで利用可能になることがある。

## ローカル検証

```sh
pnpm release:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test:release` はバージョン更新、準備PR作成、タグ/下書き作成、npm公開の失敗・再実行を外部書き込みなしで検証する。`pnpm release:prepare` はGitHub Actions用であり、実行するとGitHubのブランチとPRを作成する。

## 参考

- [luna-chatの準備フロー](https://github.com/shun-shobon/luna-chat/blob/83567b1/.github/workflows/prepare-release.yml)
- [luna-chatの公開フロー](https://github.com/shun-shobon/luna-chat/blob/83567b1/.github/workflows/publish.yml)
- [Obsidianのリリース要件](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [GitHub Actionsの並列実行と待機キュー](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GITHUB_TOKENから起動するワークフロー](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [PRの必須チェックに使えるイベント](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
