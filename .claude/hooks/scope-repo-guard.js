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
 * - 承認範囲がない場合は、上記の明示的な別リポジトリ指定のみを拒否する
 */

const { execFileSync } = require('child_process');
const path = require('path');
const S = require('./lib/scope');
const SH = require('./lib/shell');

const HOOK = 'scope-repo-guard';

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
