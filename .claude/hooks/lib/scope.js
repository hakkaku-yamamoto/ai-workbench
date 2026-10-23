'use strict';
/**
 * 承認範囲（タスクスコープ）の読み込みと共通ユーティリティ。
 *
 * 設計方針
 * - 承認範囲ファイルは **リポジトリ外** に置く。リポジトリ内に置くと
 *   エージェント自身が書き換えて保護を解除できてしまう。
 * - 承認範囲が「宣言されていない」場合、Hook は判定を行わない（exit 0・無出力）。
 *   既存の deny / ask にそのまま委ねる。保護は弱まらない。
 * - 承認範囲が「宣言されているが壊れている」場合は **拒否**（fail closed）。
 * - 絶対禁止（main への push、force push 等）は承認範囲の有無に関わらず拒否する。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Hook の終了コード */
const EXIT_OK = 0;    // 続行（通常の permission フローに委ねる）
const EXIT_BLOCK = 2; // 遮断（stderr が理由として Claude に渡る）

/**
 * 承認範囲ファイルの探索順。
 * 1. 環境変数 AI_WORKBENCH_TASK_SCOPE（明示指定）
 * 2. ~/.claude/ai-workbench/task-scope.json（既定。リポジトリ外）
 */
function scopeFilePath() {
  if (process.env.AI_WORKBENCH_TASK_SCOPE) {
    return process.env.AI_WORKBENCH_TASK_SCOPE;
  }
  return path.join(os.homedir(), '.claude', 'ai-workbench', 'task-scope.json');
}

/** 承認範囲の読み込み結果 */
const SCOPE_ABSENT = 'absent';   // 宣言なし → Hook は判定しない
const SCOPE_INVALID = 'invalid'; // 壊れている → 拒否
const SCOPE_OK = 'ok';

const REQUIRED_KEYS = [
  'taskId', 'repository', 'branch', 'allowPaths', 'denyPaths', 'gitOperations',
];

function loadScope() {
  const file = scopeFilePath();
  if (!fs.existsSync(file)) {
    return { state: SCOPE_ABSENT, file };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { state: SCOPE_INVALID, file, reason: `読み取れない: ${e.code || e.message}` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { state: SCOPE_INVALID, file, reason: 'JSON として解析できない' };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { state: SCOPE_INVALID, file, reason: 'オブジェクトではない' };
  }
  const missing = REQUIRED_KEYS.filter((k) => !(k in obj));
  if (missing.length) {
    return { state: SCOPE_INVALID, file, reason: `必須項目が欠けている: ${missing.join(', ')}` };
  }
  if (typeof obj.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(obj.repository)) {
    return { state: SCOPE_INVALID, file, reason: 'repository が owner/repo 形式でない' };
  }
  if (typeof obj.branch !== 'string' || obj.branch.length === 0) {
    return { state: SCOPE_INVALID, file, reason: 'branch が空' };
  }
  for (const k of ['allowPaths', 'denyPaths']) {
    if (!Array.isArray(obj[k]) || obj[k].some((p) => typeof p !== 'string')) {
      return { state: SCOPE_INVALID, file, reason: `${k} が文字列の配列でない` };
    }
  }
  const g = obj.gitOperations;
  if (g === null || typeof g !== 'object' || Array.isArray(g)) {
    return { state: SCOPE_INVALID, file, reason: 'gitOperations がオブジェクトでない' };
  }
  for (const k of ['commit', 'push', 'pullRequest']) {
    if (typeof g[k] !== 'boolean') {
      return { state: SCOPE_INVALID, file, reason: `gitOperations.${k} が真偽値でない` };
    }
  }
  if (obj.expiresAt !== undefined) {
    const t = Date.parse(obj.expiresAt);
    if (Number.isNaN(t)) {
      return { state: SCOPE_INVALID, file, reason: 'expiresAt が日時として解析できない' };
    }
    if (Date.now() > t) {
      return { state: SCOPE_INVALID, file, reason: '承認の有効期限が切れている' };
    }
  }
  return { state: SCOPE_OK, file, scope: obj };
}

/**
 * 承認範囲が宣言されていなくても常に保護するパス（ベースライン保護）。
 *
 * 目的
 * - Claude Code の `Edit` の `ask` ルールは、Bash のリダイレクトや `tee` の
 *   宛先には適用されない（公式仕様）。この穴を Hook 側で塞ぐ。
 * - 保護の仕組みそのもの（Hook・設定・ルール）を、シェル経由で黙って
 *   書き換えられないようにする。
 *
 * 注意
 * - `Edit` / `Write` ツール経由の編集は、既存の `ask` / `deny` ルールで
 *   人間が判断できる。ここで一律に拒否すると人間が修正できなくなるため、
 *   ベースラインは **シェル経由の書き込み**と**リポジトリ外**に限定する。
 */
const BASELINE_SHELL_PROTECTED = [
  '.claude/hooks/**',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/rules/**',
  'CLAUDE.md',
  '.git/**',
  '.gitattributes',
  '.gitignore',
];

/** すべての経路で常に保護するパス（ツール経由も含む） */
const BASELINE_ALWAYS_PROTECTED = [
  '.git/**',
];

/** stdin から Hook 入力 JSON を読む。壊れていれば null を返す。 */
function readInput() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (e) {
    return null;
  }
  if (!raw || !raw.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.tool_name !== 'string' || obj.tool_name.length === 0) return null;
  if (obj.tool_input === null || typeof obj.tool_input !== 'object') return null;
  return obj;
}

/** 遮断して終了する。stderr が Claude に渡る理由になる。 */
function block(hookName, reason) {
  process.stderr.write(`[${hookName}] 遮断: ${reason}\n`);
  process.exit(EXIT_BLOCK);
}

/** 続行（判定しない）。「無出力の exit 0」は承認ではなく、通常の permission フローに委ねる。 */
function pass() {
  process.exit(EXIT_OK);
}

/**
 * Hook 本体を安全に実行する。
 * 例外が出た場合も **遮断側**に倒す（fail closed）。
 * exit 1 等は Claude Code では非ブロッキング扱いになるため使わない。
 */
function run(hookName, fn) {
  try {
    fn();
  } catch (e) {
    block(hookName, `Hook の内部エラーのため安全側で拒否します: ${e && e.message ? e.message : String(e)}`);
  }
  // fn が exit しなかった場合も続行扱いにはしない。明示的に pass() を呼ぶ設計。
  block(hookName, 'Hook が判定を返さなかったため安全側で拒否します');
}

/** パスを POSIX 形式の相対パスに正規化する（Windows の \ を / に）。 */
function normalizeRel(cwd, target) {
  if (!target) return null;
  let abs;
  try {
    abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd || process.cwd(), target);
  } catch (e) {
    return null;
  }
  const rel = path.relative(cwd || process.cwd(), abs);
  return rel.split(path.sep).join('/');
}

/** glob パターン（* と ** のみ対応）を正規表現に変換する。 */
function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** は / を含めて任意
        i++;
        if (pattern[i + 1] === '/') i++;
        out += '(?:.*)';
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

function matchesAny(relPath, patterns) {
  return patterns.some((p) => globToRegExp(p).test(relPath));
}

/** 作業ディレクトリ外を指しているか。 */
function isOutsideCwd(rel) {
  return rel === null || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel);
}

module.exports = {
  EXIT_OK, EXIT_BLOCK,
  SCOPE_ABSENT, SCOPE_INVALID, SCOPE_OK,
  BASELINE_SHELL_PROTECTED, BASELINE_ALWAYS_PROTECTED,
  scopeFilePath, loadScope, readInput, block, pass, run,
  normalizeRel, globToRegExp, matchesAny, isOutsideCwd,
};
