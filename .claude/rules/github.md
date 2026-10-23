# GitHub 運用ルール（github）

対象：このリポジトリおよび本基盤を再利用するリポジトリ。
位置づけ：[../../CLAUDE.md](../../CLAUDE.md) の最上位原則 2 の詳細。

---

## 1. 前提：サーバ側の保護

このリポジトリには `protect-main` Ruleset が **Active** で設定されている。

| ルール | 内容 |
| :- | :- |
| `pull_request` | `main` への変更は PR 経由のみ |
| `deletion` | `main` の削除を禁止 |
| `non_fast_forward` | `main` への force push を禁止 |

対象は `~DEFAULT_BRANCH`（= `main`）。bypass actor は設定されていない。

**このローカルルールは Ruleset の代替ではなく、二層目である。**
Ruleset が未設定・無効・確認不能なリポジトリでは、作業を開始せず STOP する。

Ruleset の確認は `gh ruleset list` / `gh ruleset view` または `gh api repos/<owner>/<repo>/rulesets`
で行う。いずれも `settings.json` の `ask` に置いてあり、人間の承認を得て実行できる。
確認には最低限、次の 4 点を見る。

1. `enforcement` が `active` であること
2. `conditions.ref_name.include` に既定ブランチが含まれること
3. `rules` に `pull_request` / `deletion` / `non_fast_forward` が揃っていること
4. `bypass_actors` が空、または迂回可能なアクターが意図通りであること

Ruleset の**変更**は [safety.md](safety.md) 1-a によりエージェントが実行しない。
`gh api` の書き込みメソッド（POST / PUT / PATCH / DELETE）は `deny` としている。

## 2. ブランチ運用

- `main` で直接作業しない。作業は必ず専用ブランチで行う。
- ブランチは `main` の最新状態から作成する。
- 命名は `<種別>/<内容>` 形式（例：`setup/step1-common-rules`、`feat/report-agent`、`fix/login-redirect`）。
- タスクスコープ承認を受けている場合、作業ブランチは承認の第 5 項で
  指定されたものを使う。自分で別のブランチを作らない。
- 1 ブランチ = 1 目的。無関係な変更を混ぜない。
- **同名のブランチが既に存在する場合は、上書き・切り替え・強制作成をせず STOP して報告する。**

## 3. commit

- 人間の承認なしに commit しない。
  承認は**都度承認**でも、**タスクスコープ承認**（[approval.md](approval.md) 第 7 節）
  の第 6 項に commit が明示されている場合でもよい。
  タスクスコープ承認に書かれていなければ、commit しない。
- commit 前に `git status` と `git diff` で変更範囲を確認し、**許可された対象のみが含まれていること**を確認する。
- 意図しないファイルが含まれていたら commit せず STOP する。
- 1 commit = 1 論理変更。
- メッセージは「何を」「なぜ」を日本語または英語で簡潔に書く。差分の逐語訳は書かない。
- `--no-verify` による hook のスキップは禁止。hook が失敗したら原因を調べる。
- 署名のバイパス（`--no-gpg-sign` 等）は禁止。
- `git commit --amend` より新規 commit を優先する。push 済みの commit は amend しない。

## 4. push

- 人間の承認なしに push しない。
  承認は**都度承認**でも、**タスクスコープ承認**の第 6 項に push が
  明示されている場合でもよい。書かれていなければ push しない。
- push 先は、タスクスコープ承認の第 5 項で指定された作業ブランチに限る。
  承認されていないブランチへは push しない。
- `main` への push は禁止。
- `--force` / `--force-with-lease` による force push は禁止。
- push 先のブランチ名を承認時に明示する。

## 5. Pull Request

- 人間の承認なしに PR を作成しない。
  承認は**都度承認**でも、**タスクスコープ承認**の第 6 項に PR 作成が
  明示されている場合でもよい。書かれていなければ作成しない。
- base は承認で指定されたブランチに限る。指定がなければ確認する。
- PR 本文には以下を含める。
  - 目的
  - 変更内容の一覧
  - 検証したこと / **していないこと**
  - レビューしてほしい観点
  - 未解決事項
- **PR の merge は常に人間が行う。** エージェントは merge しない。
- **auto-merge の有効化は禁止。**
- merge 方式（merge / squash / rebase）の選択は人間の判断事項。

## 6. タグとリリース

- **一覧・内容の確認は許可する。** `git tag -l`、`git for-each-ref refs/tags`、
  `git show-ref --tags`、`gh release list`、`gh release view` を使う。
- **作成・変更は人間の個別承認を得てから行う。** 対象のタグ名・リリース名を明示して承認を求める。
- **削除は行わない。** タグの削除（`git tag -d`、`git push --delete`）と
  リリースの削除は `deny` としている。
- タグの push（`git push --tags` / `--follow-tags`）は行わない。
  タグを共有する必要がある場合は、対象タグ名を明示して人間に push を依頼する。

技術的な補足：`git tag -l`（一覧）と `git tag <name>`（作成）は
コマンドのパターン照合で区別できない。このため `settings.json` は
`Bash(git tag *)` を一括で `ask` にしている。
一覧確認で確認プロンプトを避けたい場合は `git for-each-ref refs/tags` を使う
（こちらは `ask` の対象外）。

## 7. 禁止操作

- 他リポジトリの変更（明示的に対象として指定された場合を除く）
- Ruleset / ブランチ保護設定の変更
- リポジトリの可視性変更（Public ↔ Private）
- Collaborator / Team / 権限の変更
- Webhook、GitHub App、Deploy key、Actions secrets、Actions variables の追加・変更・削除
- SSH 鍵・GPG 鍵の登録・削除
- Issue / PR の close、削除、ロック（指示された場合を除く）
- `git filter-branch` / `git filter-repo` 等による履歴改変

## 8. 認証とトークン

- トークンのスコープは必要最小限にする。
- トークン値をログ・報告・コミット内容に出力しない。
- 認証情報の作成・更新・ローテーションは人間が行う。
  `gh auth login` / `logout` / `refresh` / `token` / `setup-git` は `deny` としている。
  `gh auth status`（状態確認）は `ask` で実行できる。
- 対話的なエディタを開く操作（`git rebase -i`、`git add -i`、`git commit` の
  エディタ起動など）は、エージェントは実行しない。必要な場合は人間に依頼する。
