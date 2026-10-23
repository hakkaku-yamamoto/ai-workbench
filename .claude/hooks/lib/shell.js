'use strict';
/**
 * シェルコマンドの解析。
 *
 * 前提と限界
 * - 完全なシェル構文解析は行わない。**解析しきれないものは呼び出し側で
 *   安全側（拒否）に倒す**ことを前提にした設計である。
 * - Claude Code の permission ルールと同様、複合コマンドは区切り文字で分割し、
 *   各サブコマンドを個別に評価する。
 */

/** コマンドの区切り文字（Claude Code が認識するものに合わせる） */
const SEPARATORS = /\s*(?:&&|\|\||;|\|&|\||&)\s*/;

/** Claude Code が除去するラッパー */
const WRAPPERS = new Set([
  'timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob',
]);

/** 内部で任意のコマンドを実行するラッパー（解析不能として扱う対象） */
const INDIRECTION = [
  /^(?:\/[\w./-]*)?\bbash\s+-[a-z]*c\b/,
  /^(?:\/[\w./-]*)?\bsh\s+-[a-z]*c\b/,
  /^(?:\/[\w./-]*)?\bzsh\s+-[a-z]*c\b/,
  /^cmd(?:\.exe)?\s+\/[cC]\b/,
  /^powershell(?:\.exe)?\s+.*-(?:Command|c)\b/i,
  /^pwsh(?:\.exe)?\s+.*-(?:Command|c)\b/i,
  /^\beval\b/,
  /^\bxargs\b/,
  /^\benv\b\s+\S+=/,
  /^\bnpx\b/,
  /^\bpnpm\s+dlx\b/,
  /^\bbunx\b/,
  /^\bdocker\s+exec\b/,
  /^\bdevbox\s+run\b/,
  /^\bmise\s+exec\b/,
];

/** 文字列を区切り文字でサブコマンドに分割する。 */
function splitSubcommands(command) {
  if (typeof command !== 'string') return [];
  return command
    .split(SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 先頭のラッパーと環境変数代入を除去する。 */
function stripWrappers(sub) {
  let s = sub.trim();
  // 先頭の環境変数代入（VAR=value ...）を除去
  for (;;) {
    const m = s.match(/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/);
    if (!m) break;
    s = s.slice(m[0].length).trim();
  }
  for (;;) {
    const parts = s.split(/\s+/);
    if (parts.length < 2) break;
    const head = parts[0].replace(/^.*[\\/]/, '');
    if (!WRAPPERS.has(head)) break;
    s = parts.slice(1).join(' ');
  }
  return s;
}

/** コマンドが「内部で任意のコマンドを実行する」形か。 */
function isIndirection(sub) {
  const s = stripWrappers(sub);
  return INDIRECTION.some((re) => re.test(s));
}

/** 絶対パスでの実行か（permission ルールの前方一致を回避する経路）。 */
function isAbsolutePathInvocation(sub) {
  const s = stripWrappers(sub);
  return /^(?:\/[\w.+-]+)+\s|^(?:\/[\w.+-]+)+$|^[A-Za-z]:[\\/]/.test(s);
}

/**
 * リダイレクト（> file / >> file / 2> file）と tee の宛先を抽出する。
 * Claude Code の permission ルールは `ask` ではこの経路を検査しないため、
 * Hook 側で検査する必要がある。
 */
function redirectTargets(command) {
  const targets = [];
  if (typeof command !== 'string') return targets;
  // > file, >> file, 1> file, 2> file, &> file
  const reRedirect = /(?:^|\s)(?:\d*|&)>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&)]+)/g;
  let m;
  while ((m = reRedirect.exec(command)) !== null) {
    targets.push(unquote(m[1]));
  }
  // tee [-a] file...
  const reTee = /(?:^|[\s;|&])tee\b([^;|&]*)/g;
  while ((m = reTee.exec(command)) !== null) {
    const args = m[1].trim().split(/\s+/).filter(Boolean);
    for (const a of args) {
      if (a.startsWith('-')) continue;
      targets.push(unquote(a));
    }
  }
  return targets.filter((t) => t && t !== '/dev/null' && t.toLowerCase() !== 'nul');
}

function unquote(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** ファイルを一括で書き換えうるコマンドか（Edit ツールを通らない書き込み経路）。 */
const BULK_WRITERS = [
  /^\bsed\b[^|]*\s-i\b/,            // sed -i
  /^\bperl\b[^|]*\s-i\b/,           // perl -i
  /^\bruff\s+format\b/,
  /^\bblack\b/,
  /^\bprettier\b[^|]*--write\b/,
  /^\beslint\b[^|]*--fix\b/,
  /^\bgofmt\s+-w\b/,
  /^\bcargo\s+fmt\b/,
  /^\bdos2unix\b/, /^\bunix2dos\b/,
  /^\btruncate\b/,
  /^\bshred\b/,
];

function isBulkWriter(sub) {
  const s = stripWrappers(sub);
  return BULK_WRITERS.some((re) => re.test(s));
}

/** PowerShell のファイル書き込み系コマンドレット（エイリアス含む）の宛先を抽出する。 */
function powershellWriteTargets(command) {
  const targets = [];
  if (typeof command !== 'string') return targets;
  const re = /\b(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Set-ItemProperty|sc|ac|clc)\b([^;|]*)/gi;
  let m;
  while ((m = re.exec(command)) !== null) {
    const rest = m[1];
    const pathMatch = rest.match(/-(?:Path|LiteralPath|FilePath)\s+("[^"]+"|'[^']+'|[^\s;|]+)/i);
    if (pathMatch) {
      targets.push(unquote(pathMatch[1]));
      continue;
    }
    // 位置パラメータ（最初の非フラグ引数）
    const args = rest.trim().split(/\s+/).filter(Boolean);
    for (const a of args) {
      if (a.startsWith('-')) continue;
      targets.push(unquote(a));
      break;
    }
  }
  return targets.filter(Boolean);
}

/** git サブコマンドを取り出す（git 以外なら null）。 */
function gitSubcommand(sub) {
  const s = stripWrappers(sub);
  const m = s.match(/^(?:[\w.:\\/-]*[\\/])?git(?:\.exe)?\s+(.*)$/);
  if (!m) return null;
  const argv = tokenize(m[1]);
  // グローバルオプションを飛ばす
  let i = 0;
  const globals = [];
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      globals.push({ flag: a, value: argv[i + 1] });
      i += 2;
      continue;
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      globals.push({ flag: a.split('=')[0], value: a.split('=').slice(1).join('=') });
      i += 1;
      continue;
    }
    if (a.startsWith('-')) { i += 1; continue; }
    break;
  }
  return { name: argv[i] || '', args: argv.slice(i + 1), globals, raw: s };
}

/** gh サブコマンドを取り出す（gh 以外なら null）。 */
function ghSubcommand(sub) {
  const s = stripWrappers(sub);
  const m = s.match(/^(?:[\w.:\\/-]*[\\/])?gh(?:\.exe)?\s+(.*)$/);
  if (!m) return null;
  const argv = tokenize(m[1]);
  return { argv, raw: s };
}

/** 簡易トークナイザ（クォートを考慮）。 */
function tokenize(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; } else { cur += c; }
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = {
  SEPARATORS, WRAPPERS,
  splitSubcommands, stripWrappers, isIndirection, isAbsolutePathInvocation,
  redirectTargets, isBulkWriter, powershellWriteTargets,
  gitSubcommand, ghSubcommand, tokenize, unquote,
};
