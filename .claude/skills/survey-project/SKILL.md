---
name: survey-project
description: 対象プロジェクトの構成・技術スタック・テスト手段・保護設定を調べて整理する。新しいリポジトリで作業を始めるとき、または既存コードの全体像を把握したいときに使う。
allowed-tools: Read, Grep, Glob, Bash
---

対象プロジェクトを調査し、**確認できた事実と未確認を区別して**報告します。
推測で埋めないこと。

## 1. リポジトリの基本情報

```
git rev-parse --show-toplevel
git remote get-url origin
git rev-parse --abbrev-ref HEAD
git status --porcelain
git log --oneline -10
```

- 可視性（Public / Private）。Public なら秘密情報の扱いが厳しくなる
- 既定ブランチ
- 未コミット変更の有無（依頼と無関係なものを壊さないため記録する）

## 2. 保護設定

```
gh ruleset list
gh api repos/<owner>/<repo>/rulesets
```

確認する 4 点：

1. `enforcement` が `active` か
2. 対象に既定ブランチが含まれるか
3. `rules` に `pull_request` / `deletion` / `non_fast_forward` が揃っているか
4. `bypass_actors` が空か

**保護が未設定・無効・確認不能なら、作業を始めずに報告する。**

## 3. 構成とスタック

- ディレクトリ構成（深さ 2〜3 まで）
- 言語とバージョン（`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` 等）
- フレームワーク、主要な依存
- ビルド・起動の手段

## 4. テスト・Lint・型チェックの手段

**実行はせず、何が使えるかを特定する。**

- 定義されているスクリプト（`package.json` の `scripts`、Makefile、タスクランナー）
- テストフレームワーク、テストの置き場所
- Lint / フォーマッタ / 型チェッカの設定ファイル
- CI の定義（`.github/workflows/` 等）

**スクリプトの中身を読む。** `build` や `test` という名前で本番に影響する
処理が走る可能性があるため、名前だけで安全と判断しない。

## 5. 既存の規約

- `CLAUDE.md` / `.claude/rules/` / `.claude/settings.json` の有無と内容
- コーディング規約、命名規則、コメントの密度
- 既存の抽象化とデザインパターン

## 6. 秘密情報の扱い

- `.gitignore` が `.env` 系・鍵・認証情報を除外しているか
- リポジトリ内に秘密情報が入っていないか（大文字小文字を区別せず検査）
- 環境変数・秘密情報管理の方式

## 報告の形

- 確認できた事実（コマンド出力やファイルの内容を根拠に）
- 未確認の項目とその理由
- 作業を始める前に人間に確認すべき点
- 保護設定が不十分な場合はその旨
