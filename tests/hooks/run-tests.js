#!/usr/bin/env node
'use strict';
/**
 * .claude/hooks の自動テスト。
 *
 * 方針
 * - 実際の GitHub や本番環境へは一切送信しない。
 *   一時ディレクトリに作ったローカル Git リポジトリと、模擬の Hook 入力のみを使う。
 * - origin URL は実在しないホストを設定する（git remote get-url は通信しない）。
 * - 承認範囲ファイルは一時ディレクトリに置き、環境変数で Hook に渡す。
 *
 * 使い方: node tests/hooks/run-tests.js
 * 終了コード: 0 = 全件 PASS / 1 = 失敗あり
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks');

const BLOCK = 2;
const OK = 0;

let pass = 0;
let fail = 0;
const failures = [];

/* ------------------------------------------------------------------ */
/* テスト用の一時環境                                                  */
/* ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwb-hooks-'));

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** テスト用のローカル Git リポジトリを作る（通信しない） */
function makeRepo(name, originUrl, branch) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'test']);
  sh(dir, ['config', 'user.email', 'test' + '@' + 'example.invalid']);
  sh(dir, ['remote', 'add', 'origin', originUrl]);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'note.md'), 'note\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'init']);
  if (branch && branch !== 'main') sh(dir, ['checkout', '-q', '-b', branch]);
  return dir;
}

const SCOPE = {
  taskId: 'test-task-001',
  repository: 'example-owner/example-repo',
  branch: 'setup/step1-common-rules',
  allowPaths: ['src/**', 'docs/**', '.claude/hooks/**', 'tests/**'],
  denyPaths: ['src/generated/**', '.claude/settings.json'],
  gitOperations: { commit: true, push: true, pullRequest: false },
  forbiddenNames: ['acme-internal'],
};

function writeScope(obj) {
  const p = path.join(TMP, `scope-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}

const scopeOk = writeScope(SCOPE);
const scopeBroken = writeScope('{ this is not json');
const scopeMissingKeys = writeScope({ taskId: 'x', repository: 'a/b' });
const scopeExpired = writeScope(Object.assign({}, SCOPE, { expiresAt: '2000-01-01T00:00:00Z' }));
const scopeNoPush = writeScope(Object.assign({}, SCOPE, {
  gitOperations: { commit: true, push: false, pullRequest: false },
}));
const scopeAbsent = path.join(TMP, 'does-not-exist.json');

const repoOk = makeRepo('ai-workbench', 'https://github.com/example-owner/example-repo.git', 'setup/step1-common-rules');
const repoOther = makeRepo('other-repo', 'https://github.com/example-owner/other-repo.git', 'setup/step1-common-rules');
const repoOnMain = makeRepo('on-main', 'https://github.com/example-owner/example-repo.git', 'main');

/* ------------------------------------------------------------------ */
/* 実行ヘルパ                                                          */
/* ------------------------------------------------------------------ */

function runHook(hook, payload, opts = {}) {
  const env = Object.assign({}, process.env);
  if (opts.scope === null) delete env.AI_WORKBENCH_TASK_SCOPE;
  else env.AI_WORKBENCH_TASK_SCOPE = opts.scope || scopeOk;
  const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
    input: payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  return { code: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

function bashInput(cwd, command) {
  return {
    session_id: 'test', cwd, permission_mode: 'default',
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command, description: 'test' }, tool_use_id: 'toolu_test',
  };
}
function psInput(cwd, command) {
  const o = bashInput(cwd, command);
  o.tool_name = 'PowerShell';
  return o;
}
function editInput(cwd, filePath, tool = 'Edit') {
  return {
    session_id: 'test', cwd, permission_mode: 'default',
    hook_event_name: 'PreToolUse', tool_name: tool,
    tool_input: tool === 'NotebookEdit' ? { notebook_path: filePath } : { file_path: filePath, old_string: 'a', new_string: 'b' },
    tool_use_id: 'toolu_test',
  };
}

function check(desc, got, want) {
  if (got.code === want) {
    pass++;
    console.log(`  PASS  ${desc}`);
  } else {
    fail++;
    failures.push(desc);
    console.log(`  FAIL  ${desc}`);
    console.log(`        期待 exit=${want} / 実際 exit=${got.code}`);
    if (got.stderr) console.log(`        stderr: ${got.stderr.trim().split('\n')[0]}`);
  }
}

function section(t) { console.log(`\n--- ${t} ---`); }

/* ------------------------------------------------------------------ */
/* 1. scope-repo-guard                                                 */
/* ------------------------------------------------------------------ */
section('1. scope-repo-guard');

check('正しいリポジトリでの commit は許可',
  runHook('scope-repo-guard.js', bashInput(repoOk, 'git commit -m x')), OK);

check('異なるリポジトリでの commit は拒否',
  runHook('scope-repo-guard.js', bashInput(repoOther, 'git commit -m x')), BLOCK);

check('異なるリポジトリでの push は拒否',
  runHook('scope-repo-guard.js', bashInput(repoOther, 'git push origin setup/step1-common-rules')), BLOCK);

check('git -C で作業ツリー外を指した書き込みは拒否',
  runHook('scope-repo-guard.js', bashInput(repoOk, `git -C ${repoOther.replace(/\\/g, '/')} commit -m x`)), BLOCK);

check('git -C で作業ツリー内を指した書き込みは許可',
  runHook('scope-repo-guard.js', bashInput(repoOk, 'git -C . commit -m x')), OK);

check('gh --repo が別リポジトリなら拒否',
  runHook('scope-repo-guard.js', bashInput(repoOk, 'gh pr create --repo example-owner/other-repo --fill')), BLOCK);

check('gh --repo が承認リポジトリなら許可',
  runHook('scope-repo-guard.js', bashInput(repoOk, 'gh pr list --repo example-owner/example-repo')), OK);

check('読み取り系 git は別リポジトリでも許可',
  runHook('scope-repo-guard.js', bashInput(repoOther, 'git status')), OK);

check('承認範囲なし + 別リポジトリの commit は判定しない（既存ルールに委ねる）',
  runHook('scope-repo-guard.js', bashInput(repoOther, 'git commit -m x'), { scope: scopeAbsent }), OK);

check('承認範囲が壊れていれば拒否',
  runHook('scope-repo-guard.js', bashInput(repoOk, 'git commit -m x'), { scope: scopeBroken }), BLOCK);

check('承認範囲の必須項目が欠けていれば拒否',
  runHook('scope-repo-guard.js', bashInput(repoOk, 'git commit -m x'), { scope: scopeMissingKeys }), BLOCK);

check('承認の有効期限切れは拒否',
  runHook('scope-repo-guard.js', bashInput(repoOk, 'git commit -m x'), { scope: scopeExpired }), BLOCK);

/* ------------------------------------------------------------------ */
/* 2. scope-branch-guard                                               */
/* ------------------------------------------------------------------ */
section('2. scope-branch-guard');

check('承認ブランチへの push は許可',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin setup/step1-common-rules')), OK);

check('引数なしの push（現在が承認ブランチ）は許可',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push')), OK);

check('main への push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin main')), BLOCK);

check('master への push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin master')), BLOCK);

check('refs/heads/main 形式の push も拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin HEAD:refs/heads/main')), BLOCK);

check('現在が main のとき引数なし push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOnMain, 'git push')), BLOCK);

check('force push（--force）は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push --force origin setup/step1-common-rules')), BLOCK);

check('force push（-f）は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push -f origin setup/step1-common-rules')), BLOCK);

check('force push（--force-with-lease）は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push --force-with-lease origin setup/step1-common-rules')), BLOCK);

check('+refspec 形式の force push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin +setup/step1-common-rules')), BLOCK);

check('--mirror は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push --mirror origin')), BLOCK);

check('ブランチ削除 push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin --delete setup/step1-common-rules')), BLOCK);

check('--all は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push --all origin')), BLOCK);

check('--tags は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push --tags origin')), BLOCK);

check('承認外ブランチへの push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin feat/other')), BLOCK);

check('gitOperations.push=false なら拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin setup/step1-common-rules'), { scope: scopeNoPush }), BLOCK);

check('承認範囲なしでも main への push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push origin main'), { scope: scopeAbsent }), BLOCK);

check('承認範囲なしでも force push は拒否',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git push -f origin feat/x'), { scope: scopeAbsent }), BLOCK);

check('push 以外の git は許可',
  runHook('scope-branch-guard.js', bashInput(repoOk, 'git status')), OK);

check('PowerShell 経由の main への push も拒否',
  runHook('scope-branch-guard.js', psInput(repoOk, 'git push origin main')), BLOCK);

/* ------------------------------------------------------------------ */
/* 3. scope-file-guard                                                 */
/* ------------------------------------------------------------------ */
section('3. scope-file-guard');

check('範囲内ファイルの Edit は許可',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'src/app.ts'))), OK);

check('範囲外ファイルの Edit は拒否',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'README.md'))), BLOCK);

check('denyPaths のファイルは拒否（allowPaths より優先）',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, '.claude/settings.json'))), BLOCK);

check('denyPaths 配下（src/generated）は拒否',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'src/generated/x.ts'))), BLOCK);

check('Write ツールも対象',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'README.md'), 'Write')), BLOCK);

check('NotebookEdit も対象',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'README.md'), 'NotebookEdit')), BLOCK);

check('作業ディレクトリ外の Edit は拒否',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(TMP, 'outside.txt'))), BLOCK);

check('変更先パスが無い Edit は拒否',
  runHook('scope-file-guard.js', {
    session_id: 't', cwd: repoOk, hook_event_name: 'PreToolUse',
    tool_name: 'Edit', tool_input: {}, tool_use_id: 'x',
  }), BLOCK);

check('承認範囲なしなら Edit は判定しない',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'README.md')), { scope: scopeAbsent }), OK);

check('Bash リダイレクトが範囲内なら許可',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo hi > docs/out.md')), OK);

check('Bash リダイレクトが範囲外なら拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo hi > README.md')), BLOCK);

check('Bash 追記リダイレクト（>>）も対象',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo hi >> CLAUDE.md')), BLOCK);

check('tee の宛先も対象',
  runHook('scope-file-guard.js', bashInput(repoOk, 'make | tee README.md')), BLOCK);

check('/dev/null へのリダイレクトは許可',
  runHook('scope-file-guard.js', bashInput(repoOk, 'make > /dev/null')), OK);

check('sed -i の対象が範囲外なら拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'sed -i s/a/b/ README.md')), BLOCK);

check('sed -i の対象が範囲内なら許可',
  runHook('scope-file-guard.js', bashInput(repoOk, 'sed -i s/a/b/ src/app.ts')), OK);

check('一括書き換えでワイルドカードは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'sed -i s/a/b/ src/*.ts')), BLOCK);

check('prettier --write が範囲外なら拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'prettier --write README.md')), BLOCK);

check('bash -c による間接実行は拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, "bash -c 'echo x > README.md'")), BLOCK);

check('sh -c による間接実行は拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, "sh -c 'rm -rf src'")), BLOCK);

check('絶対パス実行は拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, '/usr/bin/tee README.md')), BLOCK);

check('npx による間接実行は拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'npx prettier --write .')), BLOCK);

check('書き込みを伴わないコマンドは許可',
  runHook('scope-file-guard.js', bashInput(repoOk, 'git status')), OK);

check('PowerShell Set-Content が範囲外なら拒否',
  runHook('scope-file-guard.js', psInput(repoOk, 'Set-Content -Path README.md -Value x')), BLOCK);

check('PowerShell Set-Content が範囲内なら許可',
  runHook('scope-file-guard.js', psInput(repoOk, 'Set-Content -Path src/app.ts -Value x')), OK);

check('PowerShell Out-File が範囲外なら拒否',
  runHook('scope-file-guard.js', psInput(repoOk, 'Out-File -FilePath CLAUDE.md -InputObject x')), BLOCK);

check('PowerShell Add-Content（位置パラメータ）も対象',
  runHook('scope-file-guard.js', psInput(repoOk, 'Add-Content README.md "x"')), BLOCK);

/* ------------------------------------------------------------------ */
/* 4. secret-scan-precommit                                            */
/* ------------------------------------------------------------------ */
section('4. secret-scan-precommit');

function stage(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  sh(dir, ['add', '--', rel]);
}
function unstageAll(dir) {
  try { sh(dir, ['reset', '-q']); } catch (e) { /* ignore */ }
}

const secretRepo = makeRepo('secret-test', 'https://github.com/example-owner/example-repo.git', 'setup/step1-common-rules');

check('commit 以外のコマンドは判定しない',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git status')), OK);

unstageAll(secretRepo);
check('差分が空なら判定しない',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), OK);

unstageAll(secretRepo);
stage(secretRepo, 'src/clean.ts', 'export const x = 1;\n');
check('秘密情報を含まない差分は許可',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), OK);

unstageAll(secretRepo);
stage(secretRepo, 'src/leak1.ts', 'const t = "ghp_' + 'A'.repeat(36) + '";\n');
check('GitHub トークンを含む差分は拒否',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), BLOCK);

unstageAll(secretRepo);
stage(secretRepo, 'src/leak2.ts', 'const k = "AKIA' + 'B'.repeat(16) + '";\n');
check('AWS アクセスキーを含む差分は拒否',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), BLOCK);

unstageAll(secretRepo);
stage(secretRepo, 'src/leak3.ts', 'pass' + 'word = "hunter2hunter2"\n');
check('代入形式の秘密情報を含む差分は拒否',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), BLOCK);

unstageAll(secretRepo);
stage(secretRepo, 'src/leak4.ts', 'const u = "post' + 'gres://user:pw' + '@' + 'db.example.com:5432/x";\n');
check('認証情報付き接続文字列を含む差分は拒否',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), BLOCK);

unstageAll(secretRepo);
stage(secretRepo, 'src/leak5.ts', '-----BEGIN RSA ' + 'PRIVATE KEY-----\n');
check('秘密鍵ブロックを含む差分は拒否',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), BLOCK);

unstageAll(secretRepo);
stage(secretRepo, 'src/name.ts', '// ACME-Internal project\n');
check('禁止された固有名（大文字小文字を区別しない）を含む差分は拒否',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x')), BLOCK);

unstageAll(secretRepo);
stage(secretRepo, 'src/ok.ts', 'export const y = 2;\n');
fs.writeFileSync(path.join(secretRepo, 'src', 'app.ts'), 'const t = "ghp_' + 'C'.repeat(36) + '";\n');
check('git commit -a は作業ツリーの変更も検査して拒否',
  runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -a -m x')), BLOCK);
sh(secretRepo, ['checkout', '-q', '--', 'src/app.ts']);
unstageAll(secretRepo);

check('秘密情報の値そのものを stderr に出さない', (() => {
  unstageAll(secretRepo);
  const token = 'ghp_' + 'D'.repeat(36);
  stage(secretRepo, 'src/leak6.ts', `const t = "${token}";\n`);
  const r = runHook('secret-scan-precommit.js', bashInput(secretRepo, 'git commit -m x'));
  const leaked = r.stderr.includes(token);
  if (leaked) {
    console.log('        stderr に値が含まれていた');
    return { code: -1 };
  }
  return { code: r.code };
})(), BLOCK);
unstageAll(secretRepo);

check('git が使えないディレクトリでは拒否', (() => {
  const nonRepo = path.join(TMP, 'not-a-repo');
  fs.mkdirSync(nonRepo, { recursive: true });
  return runHook('secret-scan-precommit.js', bashInput(nonRepo, 'git commit -m x'));
})(), BLOCK);

/* ------------------------------------------------------------------ */
/* 5. 異常系（全 Hook 共通）                                           */
/* ------------------------------------------------------------------ */
section('5. 異常系（不正入力・空入力）');

const ALL = ['scope-repo-guard.js', 'scope-branch-guard.js', 'scope-file-guard.js', 'secret-scan-precommit.js'];

for (const h of ALL) {
  check(`${h}: 空入力は拒否`, runHook(h, ''), BLOCK);
  check(`${h}: 不正な JSON は拒否`, runHook(h, '{not json'), BLOCK);
  check(`${h}: 配列入力は拒否`, runHook(h, '[]'), BLOCK);
  check(`${h}: tool_name 欠落は拒否`, runHook(h, { cwd: repoOk, tool_input: {} }), BLOCK);
  check(`${h}: tool_input 欠落は拒否`, runHook(h, { tool_name: 'Bash', cwd: repoOk }), BLOCK);
  check(`${h}: null 入力は拒否`, runHook(h, 'null'), BLOCK);
}

/* ------------------------------------------------------------------ */
/* 5-b. ベースライン保護（承認範囲が無くても常に適用）                  */
/* ------------------------------------------------------------------ */
section('5-b. ベースライン保護（承認範囲ファイルなし）');

const NO = { scope: scopeAbsent };

check('承認範囲なし: リダイレクトで CLAUDE.md の書き換えは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo x > CLAUDE.md'), NO), BLOCK);

check('承認範囲なし: リダイレクトで settings.json の書き換えは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo x > .claude/settings.json'), NO), BLOCK);

check('承認範囲なし: リダイレクトで hooks の書き換えは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo x > .claude/hooks/lib/scope.js'), NO), BLOCK);

check('承認範囲なし: リダイレクトで rules の書き換えは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo x >> .claude/rules/safety.md'), NO), BLOCK);

check('承認範囲なし: tee で CLAUDE.md への書き込みは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'make | tee CLAUDE.md'), NO), BLOCK);

check('承認範囲なし: リポジトリ外への書き込みは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo x > ../outside.txt'), NO), BLOCK);

check('承認範囲なし: ワイルドカード一括書き換えは拒否',
  runHook('scope-file-guard.js', bashInput(repoOk, 'sed -i s/a/b/ docs/*.md'), NO), BLOCK);

check('承認範囲なし: PowerShell Set-Content で settings.json は拒否',
  runHook('scope-file-guard.js', psInput(repoOk, 'Set-Content -Path .claude/settings.json -Value x'), NO), BLOCK);

check('承認範囲なし: Edit で .git 配下は拒否',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, '.git/config')), NO), BLOCK);

check('承認範囲なし: Edit でリポジトリ外は拒否',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(TMP, 'outside.txt')), NO), BLOCK);

check('承認範囲なし: 通常のファイルへのリダイレクトは許可',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo x > docs/tmp.md'), NO), OK);

check('承認範囲なし: Edit で CLAUDE.md は判定しない（ask に委ねる）',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'CLAUDE.md')), NO), OK);

check('承認範囲なし: Edit で通常ファイルは判定しない',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'src/app.ts')), NO), OK);

check('承認範囲あり: ベースライン保護も併せて効く（リポジトリ外）',
  runHook('scope-file-guard.js', bashInput(repoOk, 'echo x > ../outside.txt')), BLOCK);

section('6. Windows 実行互換性');

check('hook が node で起動できる（exit コードが 0 または 2）', (() => {
  const r = runHook('scope-repo-guard.js', bashInput(repoOk, 'git status'));
  return { code: (r.code === 0 || r.code === 2) ? 0 : r.code };
})(), OK);

check('Windows 形式の絶対パスでも Edit 判定が動く',
  runHook('scope-file-guard.js', editInput(repoOk, path.join(repoOk, 'src', 'app.ts'))), OK);

check('バックスラッシュ区切りのパスも正規化される',
  runHook('scope-file-guard.js', editInput(repoOk, repoOk + '\\src\\app.ts')), OK);

check('exit コードが 1 にならない（1 は非ブロッキング扱いのため）', (() => {
  const bad = runHook('scope-file-guard.js', '');
  return { code: bad.code === 1 ? -1 : 0 };
})(), OK);

/* ------------------------------------------------------------------ */

console.log(`\n================ 結果 ================`);
console.log(`  合計 ${pass + fail} 件 / PASS ${pass} 件 / FAIL ${fail} 件`);
if (fail > 0) {
  console.log('  失敗したテスト:');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`  一時ディレクトリ: ${TMP}`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

process.exit(fail > 0 ? 1 : 0);
