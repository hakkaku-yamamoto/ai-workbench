#!/usr/bin/env node
'use strict';
/**
 * scope-branch-guard
 *
 * 既定ブランチへの直接 push と force push を遮断し、
 * 承認された開発ブランチ以外への push を防ぐ。
 *
 * 判定（承認範囲の有無に関わらず適用するもの）
 * - force push（--force / -f / --force-with-lease / +refspec / --mirror）→ 拒否
 * - 既定ブランチ（既定で main / master）への push → 拒否
 * - push 先ブランチを特定できない → 拒否
 *
 * 判定（承認範囲がある場合）
 * - push 先が承認ブランチと異なる → 拒否
 * - gitOperations.push が false → 拒否
 */

const { execFileSync } = require('child_process');
const S = require('./lib/scope');
const SH = require('./lib/shell');

const HOOK = 'scope-branch-guard';

/** 既定で保護するブランチ名 */
const PROTECTED_DEFAULT = ['main', 'master'];

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    }).trim();
  } catch (e) {
    return null;
  }
}

function currentBranch(cwd) {
  const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!b || b === 'HEAD') return null;
  return b;
}

function defaultBranches(cwd, scope) {
  const set = new Set(PROTECTED_DEFAULT);
  if (scope && Array.isArray(scope.protectedBranches)) {
    for (const b of scope.protectedBranches) if (typeof b === 'string') set.add(b);
  }
  const head = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) set.add(head.replace(/^origin\//, ''));
  return set;
}

/** push 先ブランチ名を refspec から取り出す。 */
function destFromRefspec(refspec) {
  let r = refspec;
  if (r.startsWith('+')) r = r.slice(1);
  const parts = r.split(':');
  const dst = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  if (!dst) return null;
  return dst.replace(/^refs\/heads\//, '');
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
    const g = SH.gitSubcommand(sub);
    if (!g || g.name !== 'push') continue;

    const args = g.args;
    const flags = args.filter((a) => a.startsWith('-'));
    const positional = args.filter((a) => !a.startsWith('-'));

    // --- force push の遮断（無条件） ---
    const forceFlags = ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror'];
    const hasForce = flags.some((f) => forceFlags.includes(f) || f.startsWith('--force-with-lease=') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f));
    const plusRefspec = positional.some((p) => p.startsWith('+'));
    if (hasForce || plusRefspec) {
      S.block(HOOK, 'force push は禁止されています（--force / -f / --force-with-lease / +refspec / --mirror）');
    }

    // --- 削除 push の遮断（無条件） ---
    if (flags.includes('--delete') || flags.includes('-d') || positional.some((p) => /^:/.test(p))) {
      S.block(HOOK, 'リモートブランチの削除 push は禁止されています');
    }

    if (scope && scope.gitOperations && scope.gitOperations.push === false) {
      S.block(HOOK, '承認範囲に push が含まれていません（gitOperations.push が false）');
    }

    // --- push 先ブランチの特定 ---
    const protectedSet = defaultBranches(cwd, scope);
    let dests = [];
    if (flags.includes('--all')) {
      S.block(HOOK, 'git push --all は push 先を限定できないため許可されません');
    }
    if (flags.includes('--tags') || flags.includes('--follow-tags')) {
      S.block(HOOK, 'タグの push は禁止されています（--tags / --follow-tags）');
    }
    if (positional.length >= 2) {
      dests = positional.slice(1).map(destFromRefspec).filter(Boolean);
    } else {
      // remote のみ、または引数なし → 現在のブランチ
      const cur = currentBranch(cwd);
      if (!cur) {
        S.block(HOOK, 'push 先ブランチを特定できないため拒否します（HEAD が分離している可能性があります）');
      }
      dests = [cur];
    }
    if (dests.length === 0) {
      S.block(HOOK, 'push 先ブランチを特定できないため拒否します');
    }

    for (const d of dests) {
      if (protectedSet.has(d)) {
        S.block(HOOK,
          `保護ブランチ ${d} への直接 push は禁止されています。作業ブランチへ push し、PR 経由で反映してください`);
      }
      if (scope && d !== scope.branch) {
        S.block(HOOK,
          `承認された作業ブランチは ${scope.branch} ですが、push 先は ${d} です`);
      }
    }
  }

  S.pass();
});
