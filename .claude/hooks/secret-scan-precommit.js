#!/usr/bin/env node
'use strict';
/**
 * secret-scan-precommit
 *
 * commit 対象の差分に秘密情報が含まれていないか検査する。
 *
 * 方針
 * - **検出した値そのものはログに出さない。** パターン名・ファイル・行番号のみを出す。
 * - 検査が失敗した場合（git が実行できない等）は commit を許可しない（fail closed）。
 * - 承認範囲の有無に関わらず動作する（絶対的な安全検査）。
 * - 検査は追加行（差分の + 行）のみを対象にする。
 */

const { execFileSync } = require('child_process');
const S = require('./lib/scope');
const SH = require('./lib/shell');

const HOOK = 'secret-scan-precommit';

/** 秘密情報のパターン。値は出力しない。 */
const PATTERNS = [
  { name: 'GitHub トークン', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'OpenAI 形式の API キー', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS アクセスキー ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API キー', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'Slack トークン', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: '秘密鍵ブロック', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '代入形式の秘密情報', re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{8,}/i },
  { name: '認証情報付き接続文字列', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:]+:[^\s@]+@/i },
  { name: 'PEM 系ファイルの追加', re: /^\+\+\+ b\/.*\.(?:pem|key|p12|pfx|jks|keystore)$/ },
];

/** 追加で禁止する固有名（承認範囲ファイルの forbiddenNames で指定。大文字小文字を区別しない） */
function forbiddenNamePatterns(scope) {
  if (!scope || !Array.isArray(scope.forbiddenNames)) return [];
  return scope.forbiddenNames
    .filter((n) => typeof n === 'string' && n.length >= 3)
    .map((n) => ({
      name: '禁止された固有名',
      re: new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }));
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
}

/** commit コマンドか判定し、-a / --all の有無を返す。 */
function commitInfo(command) {
  for (const sub of SH.splitSubcommands(command)) {
    const g = SH.gitSubcommand(sub);
    if (!g || g.name !== 'commit') continue;
    const flags = g.args.filter((a) => a.startsWith('-'));
    const all = flags.some((f) => f === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(f));
    return { found: true, all };
  }
  return { found: false };
}

/** 差分の追加行を走査する。戻り値は検出件数の一覧（値は含めない）。 */
function scanDiff(diff, patterns) {
  const findings = [];
  let file = '(不明)';
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      lineNo = 0;
      for (const p of patterns) {
        if (p.re.source.startsWith('^\\+\\+\\+') && p.re.test(raw)) {
          findings.push({ pattern: p.name, file, line: 0 });
        }
      }
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      lineNo = m ? parseInt(m[1], 10) - 1 : 0;
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lineNo += 1;
      const content = raw.slice(1);
      for (const p of patterns) {
        if (p.re.source.startsWith('^\\+\\+\\+')) continue;
        if (p.re.test(content)) {
          findings.push({ pattern: p.name, file, line: lineNo });
        }
      }
      continue;
    }
    if (!raw.startsWith('-')) lineNo += 1;
  }
  return findings;
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

  const info = commitInfo(command);
  if (!info.found) S.pass();

  const cwd = input.cwd || process.cwd();
  const loaded = S.loadScope();
  if (loaded.state === S.SCOPE_INVALID) {
    S.block(HOOK, `承認範囲ファイル（${loaded.file}）が不正です: ${loaded.reason}`);
  }
  const scope = loaded.state === S.SCOPE_OK ? loaded.scope : null;
  const patterns = PATTERNS.concat(forbiddenNamePatterns(scope));

  let diff = '';
  try {
    diff = git(cwd, ['diff', '--cached', '--no-color', '--unified=0']);
    if (info.all) {
      // -a は追跡済みファイルの変更も commit 時にステージするため、作業ツリー差分も検査する
      diff += '\n' + git(cwd, ['diff', '--no-color', '--unified=0']);
    }
  } catch (e) {
    S.block(HOOK,
      'commit 対象の差分を取得できなかったため、秘密情報の検査を完了できません。' +
      'commit を許可しません（git の実行に失敗しました）');
  }

  if (!diff.trim()) {
    // 差分が空：検査対象なし。commit 自体の可否は既存の permission ルールに委ねる。
    S.pass();
  }

  const findings = scanDiff(diff, patterns);
  if (findings.length > 0) {
    const uniq = [];
    const seen = new Set();
    for (const f of findings) {
      const k = `${f.pattern}|${f.file}|${f.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(f);
    }
    const lines = uniq.slice(0, 20)
      .map((f) => `  - ${f.pattern}: ${f.file}${f.line ? ':' + f.line : ''}`)
      .join('\n');
    S.block(HOOK,
      `commit 対象の差分に秘密情報の可能性がある内容を検出しました（${uniq.length} 件）。commit を許可しません。\n` +
      `${lines}\n` +
      (uniq.length > 20 ? `  （他 ${uniq.length - 20} 件）\n` : '') +
      '検出した値そのものは出力していません。該当箇所を確認し、値を取り除いてから再実行してください。' +
      '誤検出の場合は人間に報告して判断を仰いでください。');
  }

  S.pass();
});
