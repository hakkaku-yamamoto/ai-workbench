#!/usr/bin/env node
'use strict';
/**
 * scope-repo-guard
 *
 * 承認された対象リポジトリ以外への書き込みを防ぐ。
 *
 * 判定
 * - git の -C / --git-dir / --work-tree で作業ツリーを移したうえでの
 *   書き込み操作 → 承認範囲の有無に関わらず拒否
 * - gh の --repo が承認リポジトリと異なる → 拒否
 * - 承認範囲がある場合、書き込み操作の origin が承認リポジトリと一致しなければ拒否
 * - **承認範囲がない場合、承認を要する Git 操作（commit / push / merge /
 *   タグ作成 / gh の書き込み）は拒否する（fail closed）。**
 *   これは `ask` を将来外しても「承認範囲が未設定なら無条件に通る」状態を
 *   作らないための設計である。`ask` に依存しない。
 *
 * 運用上の帰結（重要）
 *   エージェントが commit・push・PR 作成を行うには、人間が発行した
 *   タスクスコープ承認ファイルが必要になる。
 *   承認ファイルが無い場合は、人間自身が操作する。
 *   Hook 側に環境変数等の迂回口は設けない（設けると穴になる）。
 */

const { execFileSync } = require('child_process');
const path = require('path');
const S = require('./lib/scope');
const SH = require('./lib/shell');

const HOOK = 'scope-repo-guard';

/**
 * 承認がなければ実行させない git サブコマンド。
 *
 * GIT_WRITE より狭い。`add` / `fetch` / `stash` のような、
 * 承認範囲が無くても作業の継続に必要なものは含めない
 * （それらは permission の `ask` 側で扱う）。
 */
const GIT_NEEDS_APPROVAL = new Set([
  'push', 'commit', 'merge', 'rebase', 'cherry-pick', 'revert',
  'tag', 'am', 'update-ref', 'filter-branch', 'replace',
]);

/**
 * ラッパー経由（`bash -c` / `npx` / `xargs` 等）に、承認を要する操作の
 * 記述が含まれているか。
 *
 * これらのラッパーの中身は解析できない（`stripWrappers` は意図的に
 * 展開しない）。そのため「解析できない経路に承認必須操作の記述がある」
 * 場合は、確認できない以上 **拒否する**（fail closed）。
 *
 * 誤検出の向き：遮断側に倒れる。ラッパーを使わない通常のコマンドは
 * この判定の対象にならないため、文書内の文字列検索などは影響を受けない。
 * 取りこぼしは残る（ラッパーの中で変数展開や base64 を使えば検出できない）。
 */
const APPROVAL_OP_TEXT = [
  /\bgit\b[\s\S]{0,40}?\b(?:push|commit|merge|rebase|cherry-pick|revert|tag|am|update-ref|filter-branch|replace)\b/,
  /\bgh\b[\s\S]{0,40}?\b(?:pr|release|repo|api|secret|variable|ruleset)\b/,
];
function wrappedApprovalOp(command) {
  const subs = SH.splitSubcommands(command);
  if (!subs.some((s) => SH.isIndirection(s))) return false;
  return APPROVAL_OP_TEXT.some((re) => re.test(command));
}

/** 書き込みを伴う git サブコマンド */
const GIT_WRITE = new Set([
  'push', 'commit', 'merge', 'rebase', 'reset', 'clean', 'checkout', 'switch',
  'restore', 'apply', 'am', 'cherry-pick', 'revert', 'tag', 'branch', 'remote',
  'stash', 'rm', 'mv', 'add', 'gc', 'prune', 'update-ref', 'filter-branch',
  'fetch', 'pull', 'submodule', 'worktree', 'notes', 'replace',
]);

/** 書き込みを伴う gh サブコマンド（第1〜2語） */
const GH_WRITE = [
  ['pr', 'create'], ['pr', 'merge'], ['pr', 'close'], ['pr', 'edit'], ['pr', 'review'],
  ['pr', 'comment'], ['pr', 'reopen'], ['pr', 'ready'],
  ['issue', 'create'], ['issue', 'close'], ['issue', 'edit'], ['issue', 'comment'],
  ['repo', 'create'], ['repo', 'delete'], ['repo', 'edit'], ['repo', 'rename'],
  ['repo', 'archive'], ['repo', 'sync'], ['repo', 'fork'],
  ['release', 'create'], ['release', 'delete'], ['release', 'edit'], ['release', 'upload'],
  ['secret', 'set'], ['secret', 'delete'], ['variable', 'set'], ['variable', 'delete'],
  ['workflow', 'run'], ['workflow', 'enable'], ['workflow', 'disable'],
  ['ruleset', 'create'], ['label', 'create'], ['label', 'delete'], ['label', 'edit'],
];

function normalizeRepo(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/\.git$/, '');
  // すでに owner/repo 形式（スキーム・ホスト・@ を含まず、スラッシュが1つ）
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return u;
  let m = u.match(/^(?:https?:\/\/|git:\/\/)(?:[^@]*@)?[^/]+\/(.+)$/);
  if (m) return m[1].replace(/^\/+/, '');
  m = u.match(/^(?:ssh:\/\/)?(?:[^@]*@)?[^:/]+[:/](.+)$/);
  if (m) return m[1].replace(/^\/+/, '');
  return null;
}

function originRepo(cwd) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    });
    return normalizeRepo(out);
  } catch (e) {
    return null;
  }
}

function isInsideCwd(cwd, target) {
  const rel = S.normalizeRel(cwd, target);
  if (rel === null) return false;
  return rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
}

S.run(HOOK, () => {
  const input = S.readInput();
  if (input === null) {
    S.block(HOOK, 'Hook の入力が不正または空のため安全側で拒否します');
  }
  const tool = input.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') S.pass();

  const command = input.tool_input.command;
  if (typeof command !== 'string' || command.length === 0) S.pass();

  const cwd = input.cwd || process.cwd();
  const loaded = S.loadScope();
  if (loaded.state === S.SCOPE_INVALID) {
    S.block(HOOK, `承認範囲ファイル（${loaded.file}）が不正です: ${loaded.reason}`);
  }
  const scope = loaded.state === S.SCOPE_OK ? loaded.scope : null;

  // 解析できない経路（bash -c / npx / xargs 等）に承認必須操作の記述がある場合は、
  // 承認範囲の有無に関わらず拒否する。中身を確認できないため。
  if (wrappedApprovalOp(command)) {
    S.block(HOOK,
      'ラッパー経由（`bash -c` / `npx` / `xargs` 等）で承認が必要な Git / gh 操作が ' +
      '指定されています。この経路は中身を解析できないため拒否します。' +
      'コマンドを直接記述してください。');
  }

  for (const sub of SH.splitSubcommands(command)) {
    const git = SH.gitSubcommand(sub);
    if (git) {
      const isWrite = GIT_WRITE.has(git.name);
      // 作業ツリーを別の場所へ移す指定
      const moved = git.globals.filter((g) => ['-C', '--git-dir', '--work-tree'].includes(g.flag));
      if (moved.length && isWrite) {
        const outside = moved.some((g) => !g.value || !isInsideCwd(cwd, g.value));
        if (outside) {
          S.block(HOOK,
            `git の ${moved.map((g) => g.flag).join(' / ')} で作業ツリー外を指定した書き込み操作（git ${git.name}）は許可されません。` +
            '対象リポジトリの作業ディレクトリ内で実行してください。');
        }
      }
      // 承認範囲が無い状態での承認必須操作は拒否する（fail closed）
      if (!scope && GIT_NEEDS_APPROVAL.has(git.name)) {
        S.block(HOOK,
          `git ${git.name} は承認が必要な操作ですが、タスクスコープ承認が宣言されていません。` +
          '人間が発行した承認範囲ファイルが無い状態では実行できません。' +
          '承認範囲の 7 項目（対象リポジトリ・目的・変更を許可する範囲・変更禁止の対象・' +
          '作業ブランチ・許可する Git 操作・完了条件）を人間に確認してください。');
      }
      if (isWrite && scope) {
        const origin = originRepo(cwd);
        if (origin === null) {
          S.block(HOOK, `origin の URL を取得できないため、対象リポジトリを確認できません（git ${git.name}）`);
        }
        if (origin.toLowerCase() !== scope.repository.toLowerCase()) {
          S.block(HOOK,
            `承認された対象リポジトリは ${scope.repository} ですが、現在の origin は ${origin} です（git ${git.name}）`);
        }
      }
    }

    const gh = SH.ghSubcommand(sub);
    if (gh) {
      const argv = gh.argv;
      // --repo / -R の値
      let repoFlag = null;
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--repo' || argv[i] === '-R') { repoFlag = argv[i + 1]; break; }
        if (argv[i].startsWith('--repo=')) { repoFlag = argv[i].slice('--repo='.length); break; }
      }
      const positional = argv.filter((a) => !a.startsWith('-'));
      const isWrite = GH_WRITE.some(([a, b]) => positional[0] === a && positional[1] === b);
      const expected = scope ? scope.repository : originRepo(cwd);
      // --repo の照合は書き込み操作のみに適用する（読み取りは他リポジトリでも害がない）
      if (repoFlag && isWrite) {
        const norm = normalizeRepo(repoFlag) || repoFlag;
        if (!expected) {
          S.block(HOOK, 'gh の --repo が指定されていますが、許可対象リポジトリを特定できないため拒否します');
        }
        if (norm.toLowerCase() !== expected.toLowerCase()) {
          S.block(HOOK,
            `gh の --repo が ${norm} を指しています。許可されている対象は ${expected} です`);
        }
      }
      // 承認範囲が無い状態での gh 書き込みは拒否する（fail closed）
      if (isWrite && !scope) {
        S.block(HOOK,
          `gh ${positional.slice(0, 2).join(' ')} は承認が必要な操作ですが、` +
          'タスクスコープ承認が宣言されていません。' +
          '人間が発行した承認範囲ファイルが無い状態では実行できません。');
      }
      if (isWrite && scope) {
        const origin = originRepo(cwd);
        if (!repoFlag && origin === null) {
          S.block(HOOK, `origin の URL を取得できないため、対象リポジトリを確認できません（gh ${positional.slice(0, 2).join(' ')}）`);
        }
        if (!repoFlag && origin.toLowerCase() !== scope.repository.toLowerCase()) {
          S.block(HOOK,
            `承認された対象リポジトリは ${scope.repository} ですが、現在の origin は ${origin} です（gh ${positional.slice(0, 2).join(' ')}）`);
        }
      }
    }
  }

  S.pass();
});
