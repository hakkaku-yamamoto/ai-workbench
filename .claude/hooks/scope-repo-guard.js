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
 * `git tag` は一覧表示と作成を同じサブコマンド名で行う。
 * [github.md](../rules/github.md) 第 6 節は**一覧・内容の確認を許可**している
 * ため、読み取り形を承認必須として遮断してはならない。
 *
 * 書き込みと判定する条件
 * - 作成・削除・署名・強制上書きのフラグがある
 * - または、一覧フラグが無いのに位置引数（タグ名）がある
 *
 * 読み取りと判定する例
 * - `git tag`（引数なし。一覧）
 * - `git tag -l` / `--list` / `-l "v1*"`（パターンは一覧の引数）
 * - `git tag -n` / `--contains` / `--points-at` / `--merged` / `--sort` / `--format`
 */
const TAG_WRITE_FLAGS = [
  '-d', '--delete', '-a', '--annotate', '-s', '--sign', '-m', '--message',
  '-f', '--force', '-F', '--file', '-u', '--local-user', '--edit', '--create-reflog',
];
const TAG_LIST_FLAGS = [
  '-l', '--list', '-n', '--contains', '--no-contains', '--points-at',
  '--merged', '--no-merged', '--sort', '--format', '-i', '--ignore-case', '--column',
];
function isTagWrite(args) {
  const flags = args.filter((a) => a.startsWith('-'));
  // 明示的な書き込みフラグ
  if (flags.some((f) => TAG_WRITE_FLAGS.includes(f))) return true;
  // 短縮フラグの連結（`-am` 等）に書き込みを示す文字が含まれる場合
  if (flags.some((f) => /^-[a-zA-Z]+$/.test(f) && /[dasmfFu]/.test(f.slice(1)))) return true;
  // 一覧フラグがあれば、位置引数はパターン指定なので読み取り
  if (flags.some((f) => TAG_LIST_FLAGS.includes(f)
    || TAG_LIST_FLAGS.some((l) => f.startsWith(l + '=')))) return false;
  // 一覧フラグが無いのにタグ名がある → 作成
  return args.some((a) => !a.startsWith('-'));
}

/**
 * 承認範囲の `gitOperations` と git サブコマンドの対応。
 *
 * [approval.md](../rules/approval.md) 7-1 の第 6 項が列挙するのは
 * **commit / push / PR 作成の 3 つだけ**であり、7-2 は
 * 「書かれていないものは許可されない」と定めている。
 * したがって、この 3 つに対応しない操作は、承認範囲があっても通さない。
 *
 * 不具合の経緯：以前は `gitOperations` を参照しているのが
 * `scope-branch-guard` の push 判定だけで、`commit` と `pullRequest` が
 * **false でも通っていた。** 承認範囲に書いた可否が無視されていた。
 */
const GIT_OP_FLAG = { commit: 'commit', push: 'push' };

function judgeGitOperation(name, scope) {
  const g = (scope && scope.gitOperations) || {};
  const flag = GIT_OP_FLAG[name];
  if (flag) {
    if (g[flag] === true) return { ok: true };
    return {
      ok: false,
      reason: `承認範囲で git ${name} が許可されていません（gitOperations.${flag} が ${JSON.stringify(g[flag])}）。`
        + '許可されていない Git 操作は実行できません。人間に承認範囲の第 6 項を確認してください。',
    };
  }
  // commit / push / PR 作成のいずれにも当たらない承認必須操作
  return {
    ok: false,
    reason: `git ${name} は承認範囲の gitOperations（commit / push / pullRequest）の`
      + 'いずれにも対応しないため許可されません。'
      + '承認範囲で許可できるのは commit・push・PR 作成の 3 つだけです（approval.md 7-2）。'
      + 'この操作が必要な場合は、人間に個別の承認を求めてください。',
  };
}

/**
 * gh のサブコマンドを承認範囲に対して判定する。
 *
 * - `pr merge` は **`pullRequest: true` でも常に禁止**
 *   （[safety.md](../rules/safety.md) 1-b。merge は常に人間が行う）
 * - `pr create` は `pullRequest: true` のときだけ許可
 * - それ以外の PR 書き込み（edit / close / review / comment / reopen / ready）は
 *   承認範囲の第 6 項の「PR 作成」に含まれないため許可しない
 * - PR 以外の gh 書き込み（issue / repo / release / secret / variable /
 *   workflow / ruleset / label）も同様に許可しない
 */
function judgeGhOperation(positional, scope) {
  const [a, b] = positional;
  const op = `${a || ''} ${b || ''}`.trim();
  const g = (scope && scope.gitOperations) || {};

  if (a === 'pr' && b === 'merge') {
    return {
      ok: false,
      reason: 'PR の merge は承認範囲に関わらず禁止です（gitOperations.pullRequest が true でも許可されません）。'
        + 'merge は常に人間が行います。',
    };
  }
  if (a === 'pr' && b === 'create') {
    if (g.pullRequest === true) return { ok: true };
    return {
      ok: false,
      reason: `承認範囲で PR 作成が許可されていません（gitOperations.pullRequest が ${JSON.stringify(g.pullRequest)}）。`,
    };
  }
  return {
    ok: false,
    reason: `gh ${op} は承認範囲で許可できる操作（commit / push / PR 作成）に含まれないため許可されません。`
      + 'PR 作成の承認は、PR の編集・クローズ・レビュー・コメントの承認ではありません（approval.md 第 1 節）。'
      + 'この操作が必要な場合は、人間に個別の承認を求めてください。',
  };
}

/** 承認必須か（サブコマンド名だけでは決められないものを個別に判定する） */
function needsApproval(git) {
  if (!GIT_NEEDS_APPROVAL.has(git.name)) return false;
  if (git.name === 'tag') return isTagWrite(git.args);
  return true;
}

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
      if (!scope && needsApproval(git)) {
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
      // 承認範囲がある場合、gitOperations で許可された操作だけを通す
      if (scope && needsApproval(git)) {
        const v = judgeGitOperation(git.name, scope);
        if (!v.ok) S.block(HOOK, v.reason);
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
      // 承認範囲がある場合、gitOperations で許可された gh 操作だけを通す。
      // `pr merge` は pullRequest: true でも禁止。
      if (isWrite && scope) {
        const v = judgeGhOperation(positional, scope);
        if (!v.ok) S.block(HOOK, v.reason);
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
