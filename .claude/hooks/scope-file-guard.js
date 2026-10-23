#!/usr/bin/env node
'use strict';
/**
 * scope-file-guard
 *
 * 承認範囲外のファイル変更を遮断する。
 *
 * 対象経路
 * - Edit / Write / NotebookEdit ツール（file_path / notebook_path / edits）
 * - Bash / PowerShell のリダイレクト（> file / >> file）と tee の宛先
 * - sed -i / prettier --write 等の一括書き換えコマンド
 * - PowerShell の Set-Content / Add-Content / Out-File 等
 *
 * 方針
 * - 承認範囲が宣言されていなければ判定しない（既存の deny / ask に委ねる）。
 * - 承認範囲がある場合、**解析できない書き込み経路は拒否する**（fail closed）。
 * - denyPaths は allowPaths より優先する。
 */

const S = require('./lib/scope');
const SH = require('./lib/shell');

const HOOK = 'scope-file-guard';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function collectEditTargets(tool, ti) {
  const out = [];
  if (typeof ti.file_path === 'string') out.push(ti.file_path);
  if (typeof ti.notebook_path === 'string') out.push(ti.notebook_path);
  if (typeof ti.path === 'string') out.push(ti.path);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.file_path === 'string') out.push(e.file_path);
    }
  }
  return out;
}

function judgePath(rel, scope) {
  if (rel === null) return { ok: false, reason: 'パスを解決できない' };
  if (rel.startsWith('../') || rel === '..') {
    return { ok: false, reason: '作業ディレクトリ外を指している' };
  }
  if (SH && scope.denyPaths.length && S.matchesAny(rel, scope.denyPaths)) {
    return { ok: false, reason: '変更禁止パターンに一致する' };
  }
  if (!S.matchesAny(rel, scope.allowPaths)) {
    return { ok: false, reason: '承認された変更範囲に含まれていない' };
  }
  return { ok: true };
}

S.run(HOOK, () => {
  const input = S.readInput();
  if (input === null) {
    S.block(HOOK, 'Hook の入力が不正または空のため安全側で拒否します');
  }
  const tool = input.tool_name;
  const ti = input.tool_input;
  const cwd = input.cwd || process.cwd();

  const loaded = S.loadScope();
  if (loaded.state === S.SCOPE_INVALID) {
    S.block(HOOK, `承認範囲ファイル（${loaded.file}）が不正です: ${loaded.reason}`);
  }
  const scope = loaded.state === S.SCOPE_OK ? loaded.scope : null;

  // ------------------------------------------------------------------
  // ベースライン保護（承認範囲が宣言されていなくても常に適用）
  // 「承認範囲が無いこと」を理由に危険な書き込みを無条件に通さない。
  // ------------------------------------------------------------------
  if (EDIT_TOOLS.has(tool)) {
    for (const t of collectEditTargets(tool, ti)) {
      const rel = S.normalizeRel(cwd, t);
      if (S.isOutsideCwd(rel)) {
        S.block(HOOK, `${tool} の対象 ${rel === null ? t : rel} は作業ディレクトリ外のため拒否します`);
      }
      if (S.matchesAny(rel, S.BASELINE_ALWAYS_PROTECTED)) {
        S.block(HOOK, `${tool} の対象 ${rel} は常時保護対象のため拒否します`);
      }
    }
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = ti.command;
    if (typeof cmd === 'string' && cmd.length > 0) {
      const base = new Set(SH.redirectTargets(cmd));
      if (tool === 'PowerShell') for (const t of SH.powershellWriteTargets(cmd)) base.add(t);
      for (const t of base) {
        const rel = S.normalizeRel(cwd, t);
        if (S.isOutsideCwd(rel)) {
          S.block(HOOK, `書き込み先 ${rel === null ? t : rel} は作業ディレクトリ外のため拒否します`);
        }
        if (S.matchesAny(rel, S.BASELINE_SHELL_PROTECTED)) {
          S.block(HOOK,
            `シェル経由での ${rel} への書き込みは拒否します。` +
            'このパスは保護の仕組み（Hook・設定・ルール）に属し、リダイレクト経路は ' +
            '`Edit` の `ask` では止まらないため、Hook 側で遮断しています。' +
            '変更が必要な場合は Edit ツールを使って確認を受けてください');
        }
      }
      // 対象を列挙できない一括書き換えは、承認範囲の有無に関わらず拒否
      for (const sub of SH.splitSubcommands(cmd)) {
        if (!SH.isBulkWriter(sub)) continue;
        const toks = SH.tokenize(SH.stripWrappers(sub));
        const nonFlag = toks.slice(1).filter((a) => !a.startsWith('-'));
        if (nonFlag.some((a) => /[*?\[]/.test(a))) {
          S.block(HOOK, `一括書き換えコマンドでワイルドカードが使われているため拒否します: ${SH.stripWrappers(sub).slice(0, 80)}`);
        }
      }
    }
  }

  if (scope === null) {
    // 承認範囲が宣言されていない → ベースライン以外は判定しない
    // （既存の deny / ask に委ねる）
    S.pass();
  }

  // --- 編集ツール ---
  if (EDIT_TOOLS.has(tool)) {
    const targets = collectEditTargets(tool, ti);
    if (targets.length === 0) {
      S.block(HOOK, `${tool} の変更先パスを特定できないため拒否します`);
    }
    for (const t of targets) {
      const rel = S.normalizeRel(cwd, t);
      const v = judgePath(rel, scope);
      if (!v.ok) {
        S.block(HOOK, `${tool} の対象 ${rel === null ? t : rel} は許可されていません（${v.reason}）`);
      }
    }
    S.pass();
  }

  // --- シェル経由の書き込み ---
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = ti.command;
    if (typeof command !== 'string' || command.length === 0) S.pass();

    const subs = SH.splitSubcommands(command);

    // リダイレクトと tee の宛先
    const targets = new Set(SH.redirectTargets(command));
    if (tool === 'PowerShell') {
      for (const t of SH.powershellWriteTargets(command)) targets.add(t);
    }
    for (const t of targets) {
      const rel = S.normalizeRel(cwd, t);
      const v = judgePath(rel, scope);
      if (!v.ok) {
        S.block(HOOK, `書き込み先 ${rel === null ? t : rel} は許可されていません（${v.reason}）`);
      }
    }

    // 一括書き換えコマンド：対象を特定できなければ拒否
    for (const sub of subs) {
      if (!SH.isBulkWriter(sub)) continue;
      const tokens = SH.tokenize(SH.stripWrappers(sub));
      const prog = (tokens[0] || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
      let argv = tokens.slice(1).filter((a) => !a.startsWith('-'));
      // sed / perl は -e / -f が無い場合、最初の非フラグ引数がスクリプト本体であり対象ファイルではない
      if ((prog === 'sed' || prog === 'perl') &&
          !tokens.some((t) => /^-(?:e|f)$/.test(t) || t === '--expression' || t === '--file')) {
        argv = argv.slice(1);
      }
      if (argv.length === 0) {
        S.block(HOOK, `一括書き換えコマンドの対象を特定できないため拒否します: ${SH.stripWrappers(sub).slice(0, 80)}`);
      }
      for (const a of argv) {
        if (/[*?\[]/.test(a)) {
          S.block(HOOK, `一括書き換えコマンドでワイルドカード（${a}）が使われているため拒否します`);
        }
        const rel = S.normalizeRel(cwd, a);
        const v = judgePath(rel, scope);
        if (!v.ok) {
          S.block(HOOK, `一括書き換えの対象 ${rel === null ? a : rel} は許可されていません（${v.reason}）`);
        }
      }
    }

    // 解析できない間接実行：承認範囲が有効な間は拒否
    for (const sub of subs) {
      if (SH.isIndirection(sub)) {
        S.block(HOOK,
          `内部で任意のコマンドを実行する形式（${SH.stripWrappers(sub).slice(0, 60)}）は、` +
          '書き込み先を解析できないため承認範囲の適用中は拒否します');
      }
      if (SH.isAbsolutePathInvocation(sub)) {
        S.block(HOOK,
          `絶対パスでの実行（${SH.stripWrappers(sub).slice(0, 60)}）は、` +
          'permission ルールの照合を回避しうるため承認範囲の適用中は拒否します');
      }
    }

    S.pass();
  }

  S.pass();
});
