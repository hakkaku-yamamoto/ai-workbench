# 安全確認 Hooks

タスクスコープ承認（[../rules/approval.md](../rules/approval.md) 第 7 節）を
機械的に強制するための `PreToolUse` Hook 群。

**これは補助的な安全装置である。** OS の権限や GitHub Ruleset の代替ではない。
限界は [../rules/safety.md](../rules/safety.md) 第 6 節と
[../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 第 9 節・第 11 節に記載する。

## 構成

| ファイル | 役割 |
| :- | :- |
| `scope-repo-guard.js` | 承認された対象リポジトリ以外への書き込みを遮断 |
| `scope-branch-guard.js` | 既定ブランチへの直接 push と force push を遮断。承認ブランチ以外への push を遮断 |
| `scope-file-guard.js` | 承認範囲外のファイル変更を遮断（Edit / Write / NotebookEdit / シェル経由） |
| `secret-scan-precommit.js` | commit 対象の差分に秘密情報がないか検査 |
| `lib/scope.js` | 承認範囲の読み込み、終了コード、パス正規化 |
| `lib/shell.js` | シェルコマンドの解析（サブコマンド分割、リダイレクト抽出等） |

テストは [../../tests/hooks/run-tests.js](../../tests/hooks/run-tests.js)。
`node tests/hooks/run-tests.js` で実行する。

## 承認範囲ファイル

Hook は承認範囲（タスクスコープ）を**リポジトリ外**のファイルから読む。
リポジトリ内に置くと、エージェント自身が書き換えて保護を解除できてしまう。

探索順：

1. 環境変数 `AI_WORKBENCH_TASK_SCOPE` が指すパス
2. `~/.claude/ai-workbench/task-scope.json`（既定）

形式（すべて必須。`expiresAt` / `protectedBranches` / `forbiddenNames` は任意）：

| キー | 型 | 内容 |
| :- | :- | :- |
| `taskId` | string | 承認の識別子 |
| `repository` | string | `owner/repo` 形式。1 タスク 1 リポジトリ |
| `branch` | string | 承認された作業ブランチ |
| `allowPaths` | string[] | 変更を許可するパスの glob（`*` と `**` に対応） |
| `denyPaths` | string[] | 変更禁止のパスの glob。`allowPaths` より優先 |
| `gitOperations` | object | `commit` / `push` / `pullRequest` の真偽値 |
| `expiresAt` | string | ISO 8601。過去なら承認切れとして拒否 |
| `protectedBranches` | string[] | 追加で保護するブランチ名 |
| `forbiddenNames` | string[] | 差分に含めてはならない固有名（大文字小文字を区別しない） |

パスは作業ディレクトリからの相対パスとして照合する。

## 動作の原則

- **承認範囲が宣言されていない**（ファイルが無い）
  → Hook は判定しない（exit 0・無出力）。既存の `deny` / `ask` にそのまま委ねる。
    保護は弱まらない。
- **承認範囲が壊れている・期限切れ** → 拒否（fail closed）
- **解析できない書き込み経路** → 拒否（`bash -c`、絶対パス実行、`npx` 等）
- **絶対禁止は承認範囲の有無に関わらず適用**
  既定ブランチへの push、force push、削除 push、`--all` / `--tags`
- **秘密情報の検査は常に動く**。検査できなければ commit を許可しない

## 終了コードの扱い

Claude Code の仕様に合わせている。

| 終了コード | 意味 |
| :- | :- |
| `0` | 続行。通常の permission フローに委ねる（**承認ではない**） |
| `2` | 遮断。stderr が Claude に渡る理由になる |
| その他（`1` を含む） | **非ブロッキング扱いになり、ツール呼び出しは通る** |

そのため **拒否には必ず `exit 2` を使う。** `exit 1` は使わない。
内部例外も `exit 2` に変換している（`lib/scope.js` の `run()`）。
加えて `settings.json` の登録で `"onFailure": "block"` を指定しており、
Hook が落ちた・タイムアウトした場合もツール呼び出しを遮断する。

## 秘密情報の扱い

`secret-scan-precommit.js` は**検出した値そのものを出力しない。**
パターン名・ファイル名・行番号のみを出す。

## 登録

`.claude/settings.json` の `hooks.PreToolUse` に登録している。
Windows では exec 形式に実体のある実行ファイルが必要なため、
`command: "node"` ＋ `args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>.js"]`
の形にしている（`.cmd` / `.bat` シムを避ける）。

## 保護

Hook 自身と承認範囲をエージェントが書き換えて保護を解除できないよう、
`.claude/hooks/**` は `Edit` の `deny` に入れている。
承認範囲ファイルはリポジトリ外にある。

ただし完全ではない。`--settings` による設定差し替え、`CLAUDE_CONFIG_DIR` の変更、
Hook を無効化するフラグなどの経路が残る。
**最終的な強制力は GitHub Ruleset（サーバ側）にある。**
