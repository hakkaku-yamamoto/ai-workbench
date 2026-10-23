# 技術的ガードの限界

`.claude/settings.json` の permission ルールと Hooks は防御の一層だが、
**単独で安全性を保証しない。** ここに既知の限界をまとめる。

常時読み込みルール（[../.claude/rules/safety.md](../.claude/rules/safety.md) 第 6 節）
には要点のみを置き、根拠と詳細はこの文書に置いている。

permission ルールは防御の一層だが、**単独で安全性を保証しない。**
以下の限界は設計上の前提である。

## 6-1. コマンド文字列の照合だけで本番環境は識別できない

**これは最も重要な限界である。**

`vercel --prod` のような明示的なフラグは照合できるが、以下は照合できない。

- 環境名がプロファイル・環境変数・設定ファイル側にある場合
  （`AWS_PROFILE=prod aws s3 rm ...`、`kubectl --context=prod ...` の別表記、`.env` 経由の切替）
- 接続文字列・ホスト名から本番かどうかを判定する必要がある場合（DB クライアント全般）
- 同じコマンドが環境によって異なる対象を指す場合（`terraform apply` の workspace 依存）
- 組織独自の命名（`prod` でなく `live` / `main` / 顧客名 など）

したがって、**「本番は deny で止まる」と考えてはならない。**
本番環境の操作を防ぐのは、1-a の行動規範と、人間が本番の認証情報を
エージェントの実行環境に置かないことである。
`deny` パターンは「明らかな本番操作に一段の壁を置く」ための補助に過ぎない。

## 6-2. Bash の deny ルールは表記の変更で回避されうる

Claude Code の Bash ルールはコマンド文字列のパターン照合である。公式ドキュメントが挙げる例：

- `Bash(curl *)` は `curl https://example.com` に一致するが、`/usr/bin/curl https://example.com` や `sh -c 'curl https://example.com'` には**一致しない。**
- `Bash(rm *)` は `rm -rf build/` に一致するが、`/bin/rm -rf build/` や `bash -c 'rm -rf build/'` には**一致しない。**
- `Bash(git push *)` は `git push origin main` に一致するが、`git -C . push origin main` や `git -c push.default=current push` には**一致しない。**

緩和策として `Bash(/bin/*)` / `Bash(/usr/bin/*)` / `Bash(bash -c *)` / `Bash(sh -c *)` /
`Bash(git -C *)` / `Bash(git -c *)` を `ask` に置き、これらの経路に確認を入れている。
ただし網羅ではない。別のパスやラッパーを使う回避は依然として成立する。

## 6-3. 引数を制限するパターンは脆い

`Bash(curl http://example.com/ *)` のように引数で対象を絞る書き方は、URL の表記揺れで容易に外れる。
公式ドキュメントも「fragile」と明記している。

クラウド CLI の変更系 deny（`Bash(aws * delete*)` 等）は、この脆いパターンを
あえて使っている。目的は網羅的な遮断ではなく、**明らかな破壊操作に一段の壁を置くこと**である。
サブコマンドの別表記・引数順の違い・新しいサブコマンドでは外れる。

## 6-4. Read / Edit ルールの適用範囲は限定的

`Read` / `Edit` の deny ルールは、Claude Code の組み込みファイルツールと、
Claude Code が認識する一部の Bash コマンド（`cat`、`head`、`tail`、`sed`、`tee`、リダイレクト先）に適用される。
**ファイル名を引数に取らない読み取り**（カレントディレクトリでの `grep -r pattern .` など）や、
**自分でファイルを開くスクリプト**（Python / Node のコード）には適用されない。
OS レベルで全プロセスを遮断するには sandbox が必要である。

また、`Read` の deny は同じパスへの `Edit` / `Write` も遮断する。
このため `.env` 系の deny は `.env.*` の一括指定ではなく、
`.env.local` / `.env.production` 等を列挙する形にしている。
一括指定にすると `.env.example` の作成・編集まで不可能になるためである。
**列挙は網羅ではない。** 列挙にない名前（`.env.<独自名>`）は deny されない。
`.gitignore` 側は `.env.*` を一括除外しているため、コミットは防がれる。

## 6-5. 環境別ツールは別ルール

`Bash(...)` と `PowerShell(...)` は別のツールであり、ルールも別に書く必要がある。
Windows 11 で運用する場合、PowerShell 側のルールが欠けていると Bash 側の deny は意味を持たない。
本リポジトリの `settings.json` は両方を記述している。

PowerShell ルールはエイリアスが正規化されるため、`PowerShell(Remove-Item *)` は
`rm` / `del` / `rd` / `erase` / `ri` / `rmdir` も対象になる。
この性質により、`Remove-Item` を一括 deny にすると PowerShell からのファイル削除が
一切できなくなるため、本リポジトリでは再帰削除のみを deny とし、
単一ファイル削除は `ask` としている。
ただし PowerShell は引数の位置が自由なため、`-Recurse` の位置を
パターンで捉えきれない組み合わせが残る。

## 6-6. 環境ランナーは素通しになる

`npx`、`docker exec`、`devbox run`、`mise exec` などは引数をコマンドとして実行するが、
Claude Code の組み込みラッパー除去対象ではない。
`npx` / `pnpm dlx` / `bunx` / `docker` は `ask` に置いたが、内側のコマンドは
個別ルールがないと制御されない。

## 6-7. permission ルールは「指示」ではなく「設定」である

ルール文書（CLAUDE.md / `.claude/rules/`）はコンテキストとして渡される指示であり、
遵守は保証されない。公式ドキュメントも
「Claude treats them as context, not enforced configuration」と明記している。
決定論的に遮断するには Hooks（`PreToolUse` で exit code 2）が必要である。

## 6-8. したがって多層防御を前提とする

| 層 | 役割 | 本工程での状態 |
| :- | :- | :- |
| GitHub Ruleset（`protect-main`） | サーバ側強制。`main` の PR 必須・削除禁止・force push 禁止 | **設定済・Active** |
| 最小権限の認証 | トークンのスコープを必要最小限に絞る。本番の認証情報をエージェントの実行環境に置かない | 未整備（次工程） |
| permission ルール（`settings.json`） | セッション内の事故防止。善意の誤操作を止める | **設定済**（限界は 6-1〜6-7） |
| Hooks（`PreToolUse` 等） | ツール呼び出しの決定論的な遮断。exit code 2 で停止 | **実装済・登録済。実機での発火も確認済**（4 本のうち 2 本。[ARCHITECTURE.md](ARCHITECTURE.md) 11-5-c）。**ただしプロジェクトルート起点で開始したセッションに限る。起点が違えば一切効かない** |
| ルール文書（`.claude/rules/`） | エージェントの判断基準 | **設定済** |
| 人間の承認 | 最終的な責任の所在 | 常時 |

`permissions.allow` ルールと `additionalDirectories` は**ワークスペースの信頼（trust）を承認するまで適用されない**が、
`deny` と `ask` は即時適用される。
本リポジトリの `settings.json` は、保護を `deny` と `ask` だけで成立させている。
`allow` には開発ループの定型操作のみを置いており、trust 承認が得られない環境でも
保護は変わらない（確認プロンプトが増えるだけである）。

`bypassPermissions` モードは permission ルールを飛ばすため、`permissions.disableBypassPermissionsMode` を `"disable"` に設定して無効化している。
