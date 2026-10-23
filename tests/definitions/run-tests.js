#!/usr/bin/env node
'use strict';
/**
 * 定義ファイルと設定の検証テスト。
 *
 * 対象
 * - .claude/agents/*.md        エージェント定義（frontmatter・役割制限）
 * - .claude/skills/<name>/SKILL.md スキル定義（frontmatter・サイズ）
 * - .claude/settings.json      permission と hooks の登録
 * - CLAUDE.md / .claude/rules/ 重要ルールの存在と常時読み込み容量
 * - 公開可能な情報だけが含まれること
 *
 * 禁止固有名のリストは **リポジトリ外** から読む。
 * リポジトリ内に実在の社内名を書かないため。
 *   1. 環境変数 AI_WORKBENCH_FORBIDDEN_NAMES（JSON 配列のファイル）
 *   2. ~/.claude/ai-workbench/forbidden-names.json
 * 無ければ組み込みの汎用パターンのみで検査し、その旨を表示する。
 *
 * 使い方: node tests/definitions/run-tests.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];

function check(desc, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${desc}`); }
  else {
    fail++; failures.push(desc);
    console.log(`  FAIL  ${desc}`);
    if (detail) console.log(`        ${detail}`);
  }
}
function section(t) { console.log(`\n--- ${t} ---`); }

/** 簡易 YAML frontmatter パーサ（key: value と単純なリストのみ） */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { ok: false, reason: '先頭が --- で始まらない' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { ok: false, reason: 'frontmatter が閉じていない' };
  const raw = text.slice(3, end).replace(/^\r?\n/, '');
  const obj = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    obj[m[1]] = m[2].trim();
  }
  return { ok: true, data: obj, body: text.slice(end + 4) };
}

/* ------------------------------------------------------------------ */
section('1. エージェント定義');

const AGENT_DIR = path.join(ROOT, '.claude', 'agents');
const agentFiles = fs.existsSync(AGENT_DIR)
  ? fs.readdirSync(AGENT_DIR).filter((f) => f.endsWith('.md')) : [];

const EXPECTED_AGENTS = ['orchestrator', 'architect', 'developer', 'reviewer', 'tester',
  'security', 'uiux-designer', 'documenter'];
check(`エージェントが ${EXPECTED_AGENTS.length} 件ある`, agentFiles.length === EXPECTED_AGENTS.length,
  `実際 ${agentFiles.length} 件: ${agentFiles.join(', ')}`);

const agentNames = new Set();
for (const f of agentFiles) {
  const p = path.join(AGENT_DIR, f);
  const text = fs.readFileSync(p, 'utf8');
  const fm = parseFrontmatter(text);
  check(`${f}: frontmatter が解析できる`, fm.ok, fm.reason);
  if (!fm.ok) continue;
  const d = fm.data;
  check(`${f}: name がある`, typeof d.name === 'string' && d.name.length > 0);
  check(`${f}: description がある`, typeof d.description === 'string' && d.description.length > 10);
  check(`${f}: name がファイル名と一致`, d.name === path.basename(f, '.md'), `name=${d.name}`);
  check(`${f}: name が重複していない`, !agentNames.has(d.name));
  agentNames.add(d.name);
  check(`${f}: name に禁止文字（< > :）がない`, !/[<>:]/.test(d.name || ''));
  check(`${f}: 本文がある`, (fm.body || '').trim().length > 200);
}

for (const n of EXPECTED_AGENTS) {
  check(`エージェント ${n} が存在する`, agentNames.has(n));
}

section('2. エージェントの役割制限（tools）');

/** 編集ツールを持ってはいけない役割 */
const NO_EDIT = ['orchestrator', 'architect', 'reviewer', 'tester', 'security', 'uiux-designer'];
/** 編集ツールを持つべき役割（成果物がファイルそのものである役割だけ） */
const NEEDS_EDIT = ['developer', 'documenter'];

for (const n of NO_EDIT) {
  const p = path.join(AGENT_DIR, `${n}.md`);
  if (!fs.existsSync(p)) { check(`${n}: tools を確認できる`, false, 'ファイルがない'); continue; }
  const fm = parseFrontmatter(fs.readFileSync(p, 'utf8'));
  const tools = (fm.data && fm.data.tools) || '';
  const list = tools.split(',').map((s) => s.trim());
  check(`${n}: Edit を持たない`, !list.includes('Edit'), `tools=${tools}`);
  check(`${n}: Write を持たない`, !list.includes('Write'), `tools=${tools}`);
  check(`${n}: NotebookEdit を持たない`, !list.includes('NotebookEdit'), `tools=${tools}`);
}
for (const n of NEEDS_EDIT) {
  const fm = parseFrontmatter(fs.readFileSync(path.join(AGENT_DIR, `${n}.md`), 'utf8'));
  const list = ((fm.data && fm.data.tools) || '').split(',').map((s) => s.trim());
  check(`${n}: Edit を持つ`, list.includes('Edit'));
  check(`${n}: Write を持つ`, list.includes('Write'));
}

check('orchestrator: Agent ツールを持つ（委譲のため）', (() => {
  const fm = parseFrontmatter(fs.readFileSync(path.join(AGENT_DIR, 'orchestrator.md'), 'utf8'));
  return ((fm.data && fm.data.tools) || '').split(',').map((s) => s.trim()).includes('Agent');
})());

check(`編集ツールを持つのは ${NEEDS_EDIT.join(' / ')} だけ`, (() => {
  const owners = [];
  for (const f of agentFiles) {
    const fm = parseFrontmatter(fs.readFileSync(path.join(AGENT_DIR, f), 'utf8'));
    const list = ((fm.data && fm.data.tools) || '').split(',').map((s) => s.trim());
    if (list.includes('Edit') || list.includes('Write')) owners.push(path.basename(f, '.md'));
  }
  return owners.length === NEEDS_EDIT.length && NEEDS_EDIT.every((n) => owners.includes(n));
})());

section('3. エージェント本文の必須記述（範囲の自己拡大の禁止）');

for (const f of agentFiles) {
  const text = fs.readFileSync(path.join(AGENT_DIR, f), 'utf8');
  const n = path.basename(f, '.md');
  if (n === 'orchestrator') {
    check(`${n}: 承認範囲の確認が書かれている`, text.includes('承認範囲の確認') || text.includes('7 項目'));
    check(`${n}: 最小権限の引き継ぎが書かれている`, text.includes('最小権限') || text.includes('担当分のみ') || text.includes('そのまま渡さない'));
    check(`${n}: 報告を検証せず信じない旨`, text.includes('検証せずに事実として扱わない') || text.includes('検証せずに完了とする'));
  } else {
    check(`${n}: 承認範囲を広げない旨が書かれている`,
      text.includes('承認範囲を超える') || text.includes('承認範囲を広げる') || text.includes('範囲外として扱い') || text.includes('承認範囲外'));
  }
}

check('tester: テストの書き換え禁止が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'tester.md'), 'utf8');
  return t.includes('書き換え');
})());
check('tester: 未実施を PASS と報告しない旨が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'tester.md'), 'utf8');
  return t.includes('PASS と報告しない');
})());
check('security: 値そのものを出力しない旨が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'security.md'), 'utf8');
  return t.includes('値そのもの');
})());
check('uiux-designer: 原則3案が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'uiux-designer.md'), 'utf8');
  return t.includes('3 案');
})());
check('uiux-designer: 根拠のないブランド要素を作らない旨が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'uiux-designer.md'), 'utf8');
  return t.includes('根拠なく');
})());
check('documenter: 推測で書かない旨が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'documenter.md'), 'utf8');
  return t.includes('推測で書かない') && t.includes('未確定');
})());
check('documenter: 宣伝表記を自動追加しない旨が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'documenter.md'), 'utf8');
  return t.includes('宣伝表記') && t.includes('Co-Authored-By');
})());
check('documenter: 実装コードを変更しない旨が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'documenter.md'), 'utf8');
  return t.includes('実装コードやテストを変更する');
})());
check('documenter: PR 作成そのものは行わない旨が明記', (() => {
  const t = fs.readFileSync(path.join(AGENT_DIR, 'documenter.md'), 'utf8');
  return t.includes('PR の作成そのものは行わない');
})());

section('3b. Orchestrator のタスク振分け');

const orch = fs.readFileSync(path.join(AGENT_DIR, 'orchestrator.md'), 'utf8');

// 割当表から役割名を取り出す（| `name` | ... | の行）
const routed = [];
for (const line of orch.split('\n')) {
  const m = line.match(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/);
  if (m) routed.push(m[1]);
}
check(`割当表に役割が並んでいる（${routed.length} 件）`, routed.length >= 6, `取得=${routed.join(',')}`);
for (const r of routed) {
  check(`割当表の ${r} に対応するエージェント定義がある`, agentNames.has(r));
}
// 到達不能なエージェントがないこと（orchestrator 自身を除く）
for (const n of EXPECTED_AGENTS) {
  if (n === 'orchestrator') continue;
  check(`${n} が割当表から到達できる`, routed.includes(n), `割当表=${routed.join(',')}`);
}
check('割当表に重複がない', new Set(routed).size === routed.length);

// 事前手順の順序：依頼分析 → 対象確認 → 承認範囲確認 → 分解
const ORDER = ['依頼内容の分析', '対象プロジェクトの確認', '承認範囲の確認', '開発タスクへの分解'];
const pos = ORDER.map((t) => orch.indexOf(t));
check('事前手順が 4 つすべて記載されている', pos.every((x) => x >= 0));
check('事前手順の順序が正しい', pos.every((x, k) => k === 0 || x > pos[k - 1]), `位置=${pos.join(',')}`);
check('順番を変えないと明記されている', orch.includes('順番を変えない'));

// 承認・STOP の参照
check('承認 7 項目の参照がある', orch.includes('approval.md') && orch.includes('7 項目'));
check('第 6 項にない Git 操作は実行できないと明記', orch.includes('第 6 項に書かれていない Git 操作'));
check('STOP 条件の引き継ぎが明記', orch.includes('STOP 条件'));
check('既定ブランチでの作業を確認する手順がある', orch.includes('既定ブランチ'));
check('失敗時の修正と再テストを人間確認なしで回す旨', orch.includes('逐一人間に確認せず繰り返してよい'));
check('完了報告が reporting.md 第 4 節に従う', orch.includes('reporting.md') && orch.includes('第 4 節'));
check('Edit / Write を持っていないことが本文にも書かれている', orch.includes('`Edit` / `Write` は持っていない'));

/* ------------------------------------------------------------------ */
section('4. スキル定義');

const SKILL_DIR = path.join(ROOT, '.claude', 'skills');
const skillDirs = fs.existsSync(SKILL_DIR)
  ? fs.readdirSync(SKILL_DIR).filter((d) => fs.statSync(path.join(SKILL_DIR, d)).isDirectory()) : [];

const EXPECTED_SKILLS = ['survey-project', 'plan-implementation', 'review-code',
  'fix-with-tests', 'check-security', 'check-uiux', 'write-completion-report'];

check(`スキルが ${EXPECTED_SKILLS.length} 件ある`, skillDirs.length === EXPECTED_SKILLS.length,
  `実際 ${skillDirs.length} 件: ${skillDirs.join(', ')}`);

const skillNames = new Set();
for (const d of skillDirs) {
  const p = path.join(SKILL_DIR, d, 'SKILL.md');
  check(`${d}: SKILL.md がある`, fs.existsSync(p));
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  const fm = parseFrontmatter(text);
  check(`${d}: frontmatter が解析できる`, fm.ok, fm.reason);
  if (!fm.ok) continue;
  check(`${d}: description がある`, typeof fm.data.description === 'string' && fm.data.description.length > 20);
  check(`${d}: name がディレクトリ名と一致`, fm.data.name === d, `name=${fm.data.name}`);
  check(`${d}: name が重複していない`, !skillNames.has(fm.data.name));
  skillNames.add(fm.data.name);
  const lines = text.split('\n').length;
  check(`${d}: 500 行未満（${lines} 行）`, lines < 500);
  check(`${d}: 予約名でない`, !['synced', 'anthropic-skills'].includes(d) && !d.startsWith('anthropic-skills:'));
  check(`${d}: name に禁止文字がない`, !/[<>:]/.test(fm.data.name || ''));
}
for (const n of EXPECTED_SKILLS) check(`スキル ${n} が存在する`, skillNames.has(n));

check('スキル名が組み込みの code-review と衝突しない', !skillNames.has('code-review'));

/* ------------------------------------------------------------------ */
section('5. settings.json（permission と hooks）');

const SETTINGS = path.join(ROOT, '.claude', 'settings.json');
let S = null;
try { S = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); check('settings.json が有効な JSON', true); }
catch (e) { check('settings.json が有効な JSON', false, e.message); }

if (S) {
  const P = S.permissions || {};
  check('allow が空（共通配布では無条件許可しない）', Array.isArray(P.allow) && P.allow.length === 0,
    `allow=${JSON.stringify(P.allow)}`);
  check('deny が 200 件以上ある', Array.isArray(P.deny) && P.deny.length >= 200, `deny=${(P.deny || []).length}`);
  check('ask が 100 件以上ある', Array.isArray(P.ask) && P.ask.length >= 100, `ask=${(P.ask || []).length}`);
  check('bypassPermissions を使っていない', P.defaultMode !== 'bypassPermissions');
  check('disableBypassPermissionsMode が disable', P.disableBypassPermissionsMode === 'disable');

  const MUST_DENY = ['Bash(git push origin main*)', 'Bash(git push --force *)', 'Bash(gh pr merge *)',
    'Bash(rm -rf *)', 'Bash(sudo *)', 'Bash(terraform apply *)', 'Edit(.git/**)', 'Read(.env)',
    'Edit(.claude/hooks/**)', 'Bash(git checkout -- *)', 'Bash(git reset --hard *)',
    'PowerShell(git push origin main*)'];
  for (const r of MUST_DENY) check(`deny に ${r} がある`, (P.deny || []).includes(r));

  const MUST_ASK = ['Bash(git commit *)', 'Bash(git push *)', 'Bash(gh pr create *)',
    'Edit(.claude/**)', 'Edit(CLAUDE.md)', 'Bash(bash -c *)', 'Bash(npx *)'];
  for (const r of MUST_ASK) check(`ask に ${r} がある`, (P.ask || []).includes(r));

  check('allow に Git 書き込みが入っていない', !(P.allow || []).some((a) =>
    /git push|git commit|gh pr create|gh pr merge|git merge|git rebase/.test(a)));

  // ルール形式
  const all = [].concat(P.allow || [], P.ask || [], P.deny || []);
  check('ルール形式がすべて Tool または Tool(specifier)',
    all.every((r) => /^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$/.test(r)));
  check('ルールに重複がない', new Set(all).size === all.length);
  check('参照されないツールへのパスルールがない',
    !all.some((r) => /^(Write|NotebookEdit|Glob|MultiEdit)\(/.test(r)));

  // hooks
  const H = (S.hooks || {}).PreToolUse;
  check('hooks.PreToolUse が配列', Array.isArray(H));
  if (Array.isArray(H)) {
    const handlers = H.flatMap((g) => g.hooks || []);
    check('ハンドラが 4 件ある', handlers.length === 4, `実際 ${handlers.length} 件`);
    check('全ハンドラが node + args 形式', handlers.every((h) => h.command === 'node' && Array.isArray(h.args) && h.args.length === 1));
    check('全ハンドラに onFailure=block がある', handlers.every((h) => h.onFailure === 'block'));
    check('全ハンドラに timeout がある', handlers.every((h) => typeof h.timeout === 'number' && h.timeout > 0));
    check('全ハンドラの type が command', handlers.every((h) => h.type === 'command'));
    const scripts = handlers.map((h) => h.args[0]);
    for (const s of scripts) {
      check(`Hook スクリプトが存在する: ${path.basename(s)}`,
        fs.existsSync(path.join(ROOT, s.replace('${CLAUDE_PROJECT_DIR}/', ''))));
      check(`Hook パスが \${CLAUDE_PROJECT_DIR} を使う: ${path.basename(s)}`, s.startsWith('${CLAUDE_PROJECT_DIR}/'));
    }
    for (const n of ['scope-repo-guard', 'scope-branch-guard', 'scope-file-guard', 'secret-scan-precommit']) {
      check(`Hook ${n} が登録されている`, scripts.some((s) => s.includes(n)));
    }
    const matchers = H.map((g) => g.matcher);
    check('Bash|PowerShell の matcher がある', matchers.includes('Bash|PowerShell'));
    check('編集ツールを含む matcher がある', matchers.some((m) => m && m.includes('Edit') && m.includes('Write')));
  }
}

/* ------------------------------------------------------------------ */
section('6. 重要ルールが常時読み込みに残っていること');

const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const claudeMd = R('CLAUDE.md');
const safety = R('.claude/rules/safety.md');
const approval = R('.claude/rules/approval.md');
const github = R('.claude/rules/github.md');
const conduct = R('.claude/rules/agent-conduct.md');
const quality = R('.claude/rules/quality.md');
const reporting = R('.claude/rules/reporting.md');

check('本番・重要権限操作の制限（safety 1-a）', safety.includes('### 1-a. エージェントは実行しない') && safety.includes('本番環境へのデプロイ'));
check('main への直接 push 禁止', safety.includes('### 1-b') && /main` への直接 push/.test(safety));
check('force push 禁止（safety と github）', safety.includes('force push') && github.includes('force push'));
check('PR merge は人間が実行', github.includes('PR の merge は常に人間が行う'));
check('auto-merge の有効化は禁止', github.includes('auto-merge の有効化は禁止'));
check('タスクスコープ承認（approval 第7節）', approval.includes('## 7. タスクスコープ承認'));
check('タスクスコープ承認が CLAUDE.md にある', claudeMd.includes('タスクスコープ承認'));
check('承認の 7 項目が定義されている', approval.includes('承認時に宣言する 7 項目'));
check('範囲外操作で STOP（approval 7-5）', approval.includes('### 7-5') && approval.includes('変更が許可範囲を超える'));
check('STOP 条件を自己解除しない（3 ファイル）',
  [claudeMd, approval, conduct].every((t) => t.includes('自分で解除できない')));
check('許可範囲内では不要な確認を繰り返さない（approval 7-4）',
  approval.includes('### 7-4') && approval.includes('逐一確認せずに進める'));
check('未実施のテストを PASS と報告しない（quality）', quality.includes('PASS と報告することを禁止'));
check('UI/UX の要点が quality に残っている', quality.includes('## 9. UI/UX 設計原則') && quality.includes('原則 3 案'));
check('技術的ガードの限界の要点が safety に残っている',
  safety.includes('## 6. 技術的ガードの限界') && safety.includes('本番環境は識別できない'));
check('成果物の表記ルール（quality 第8節）', quality.includes('## 8. 成果物の表記'));
check('判定基準が reporting にある', reporting.includes('PASS_WITH_WARNINGS'));

section('6b. 文書が実態と一致していること');

// 件数の記載が古くなる不具合が実際に 2 回発生した。機械的に照合する。
const arch = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');

check(`CLAUDE.md のエージェント件数が実態（${agentFiles.length} 件）と一致`,
  claudeMd.includes(`${agentFiles.length} 件`) && /agents\/`、\s*\d+ 件/.test(claudeMd),
  claudeMd.match(/agents\/`、\s*\d+ 件/) ? claudeMd.match(/agents\/`、\s*\d+ 件/)[0] : '記載なし');
check(`CLAUDE.md のスキル件数が実態（${skillDirs.length} 件）と一致`,
  /skills\/`、\s*(\d+) 件/.test(claudeMd)
  && Number(claudeMd.match(/skills\/`、\s*(\d+) 件/)[1]) === skillDirs.length,
  claudeMd.match(/skills\/`、\s*\d+ 件/) ? claudeMd.match(/skills\/`、\s*\d+ 件/)[0] : '記載なし');
check(`ARCHITECTURE.md のエージェント件数が実態（${agentFiles.length} 件）と一致`,
  /エージェント定義（(\d+) 件/.test(arch)
  && Number(arch.match(/エージェント定義（(\d+) 件/)[1]) === agentFiles.length);
check(`ARCHITECTURE.md のスキル件数が実態（${skillDirs.length} 件）と一致`,
  /スキル定義（(\d+) 件/.test(arch)
  && Number(arch.match(/スキル定義（(\d+) 件/)[1]) === skillDirs.length);

// ディレクトリ構成図に載っている定義ファイルが実在すること
for (const f of agentFiles) {
  check(`構成図に ${f} が載っている`, arch.includes(f));
}
for (const d of skillDirs) {
  check(`構成図に skills/${d}/ が載っている`, arch.includes(`${d}/`));
}

// 役割の名簿が 3 か所で一致していること
/** 定義ファイル名 → 文書での表記 */
const DISPLAY = {
  orchestrator: 'Orchestrator', architect: 'Architect', 'uiux-designer': 'UI/UX Designer',
  developer: 'Developer', security: 'Security', tester: 'Tester',
  reviewer: 'Reviewer', documenter: 'Documenter',
};
// 名簿の文（「対象：… の各エージェント」）だけを取り出す。
// 行で切ると後続の参照リンクまで拾ってしまう。
const roster = (conduct.match(/対象：[\s\S]*?の各エージェント/) || [''])[0];

check('DISPLAY 表がすべてのエージェントを網羅している（表の保守漏れの検出）',
  EXPECTED_AGENTS.every((n) => DISPLAY[n]) && Object.keys(DISPLAY).length === EXPECTED_AGENTS.length);
for (const n of EXPECTED_AGENTS) {
  check(`agent-conduct.md の名簿に ${DISPLAY[n]} が載っている`, roster.includes(DISPLAY[n]));
}
// 名簿に挙がっている表記のうち、定義ファイルが無いものがないこと
check('agent-conduct.md の名簿に実体のない役割が載っていない', (() => {
  // 「UI/UX Designer」を割らないよう、区切りは空白を伴う ' / ' だけに限る
  const listed = roster.replace(/^対象：/, '').replace(/の各エージェント$/, '')
    .split(/\s+\/\s+|および/)
    .map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => /^[A-Z]/.test(s));
  const valid = new Set(Object.values(DISPLAY));
  const phantom = listed.filter((s) => !valid.has(s));
  return listed.length > 0 && phantom.length === 0;
})(), '名簿に無効な役割名がある');

check('Hooks が未実装と書かれていない（実装済のため）', !/Hooks[^\n|]*\|[^\n|]*\*\*未実装\*\*/.test(arch));
check('agents / skills が未作成と書かれていない', !arch.includes('（未作成）エージェント定義')
  && !arch.includes('（未作成）スキル定義'));
check('実機での発火が未確認であることが明記されている（過大報告の防止）',
  arch.includes('実機') && arch.includes('未確認') && claudeMd.includes('未確認'));

section('7. 常時読み込み容量');

const ALWAYS = ['CLAUDE.md'].concat(
  fs.readdirSync(path.join(ROOT, '.claude', 'rules')).filter((f) => f.endsWith('.md')).map((f) => `.claude/rules/${f}`));
let bytes = 0;
for (const f of ALWAYS) bytes += fs.statSync(path.join(ROOT, f)).size;
console.log(`  常時読み込み: ${bytes} bytes（概算 ${Math.round(bytes / 4)} トークン）`);
for (const f of ALWAYS) console.log(`    ${f.padEnd(34)} ${fs.statSync(path.join(ROOT, f)).size}`);
check('常時読み込みが 75,000 bytes 未満', bytes < 75000, `実際 ${bytes}`);
check('rules 配下に frontmatter がない（常時読み込みのため）',
  ALWAYS.slice(1).every((f) => !fs.readFileSync(path.join(ROOT, f), 'utf8').startsWith('---')));

/* ------------------------------------------------------------------ */
section('8. 公開可能な情報だけが含まれること');

function loadForbiddenNames() {
  const p = process.env.AI_WORKBENCH_FORBIDDEN_NAMES
    || path.join(os.homedir(), '.claude', 'ai-workbench', 'forbidden-names.json');
  if (!fs.existsSync(p)) return { names: [], source: null };
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(v)) return { names: v.filter((x) => typeof x === 'string' && x.length >= 3), source: p };
  } catch (e) { /* ignore */ }
  return { names: [], source: p, broken: true };
}
const fb = loadForbiddenNames();
const BS2 = String.fromCharCode(92) + String.fromCharCode(92); // 正規表現ソース上の \\
const LOCAL_USER = ((os.userInfo && os.userInfo().username) || '').trim();
if (fb.source && !fb.broken) console.log(`  禁止固有名リスト: ${fb.names.length} 件（${fb.source}）`);
else console.log('  禁止固有名リスト: 未提供（組み込みの汎用パターンのみで検査）');

const TARGET_FILES = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules') continue;
    const full = path.join(dir, e);
    const r = rel ? `${rel}/${e}` : e;
    if (fs.statSync(full).isDirectory()) walk(full, r);
    else if (/\.(md|json|js)$/.test(e)) TARGET_FILES.push(r);
  }
})(ROOT, '');

const PATTERNS = [
  { n: '認証情報', re: /gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { n: '代入形式の秘密情報', re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{8,}/i },
  { n: '認証情報付き接続文字列', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:]+:[^\s@]+@/i },
  { n: 'メールアドレス', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { n: 'IPv4 リテラル', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  // 実行中のユーザー名はこのファイルに書かない（書けば検査対象そのものになる）。
  // 実行時に取得し、ホームディレクトリ由来のパスが混入していないかを見る。
  { n: '個人のファイルパス', re: new RegExp([
      LOCAL_USER.length >= 4 ? LOCAL_USER.replace(/[^A-Za-z0-9_-]/g, '') : null,
      'AppDa' + 'ta',
      // 円記号を含むパターンは、転送時のエスケープ崩れを避けるため文字コードから組む
      'C:' + BS2 + 'Users' + BS2 + '(?!x[' + BS2 + '/]|user|USERNAME|example|your)[A-Za-z0-9._-]{3,}',
      '/c/Users/(?!x[/$]|user|USERNAME|example|your)[A-Za-z0-9._-]{3,}',
    ].filter(Boolean).join('|'), 'i') },
].concat(fb.names.map((n) => ({ n: '禁止固有名', re: new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })));

const hits = [];
for (const rel of TARGET_FILES) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) hits.push({ rel, line: i + 1, pattern: p.n });
    }
  });
}
check(`追跡対象ファイル（${TARGET_FILES.length} 件）に秘密情報・個人情報・禁止固有名がない`,
  hits.length === 0,
  hits.slice(0, 10).map((h) => `${h.pattern}: ${h.rel}:${h.line}`).join(' / '));

section('8b. 検査パターン自体の自己テスト（空振りしていないことの確認）');

// 試料はすべて文字列連結で組む。リテラルとして書くと検査対象に引っかかるため。
const BS1 = String.fromCharCode(92);
const SAMPLES = [
  { n: '認証情報', bad: 'gh' + 'p' + '_' + 'A'.repeat(36) },
  { n: '代入形式の秘密情報', bad: 'pass' + 'word' + '=' + 'correcthorse' },
  { n: '認証情報付き接続文字列', bad: 'post' + 'gres' + '://usr:pw@host/db' },
  { n: 'メールアドレス', bad: 'someone' + '@' + 'host.example' },
  { n: 'IPv4 リテラル', bad: '203.0.' + '113.9' },
  { n: '個人のファイルパス', bad: 'C:' + BS1 + 'Users' + BS1 + 'alice' + BS1 + 'dev' },
];
function matchNames(line) {
  return PATTERNS.filter((p) => p.re.test(line)).map((p) => p.n);
}
for (const s0 of SAMPLES) {
  check(`パターン「${s0.n}」が該当文字列を検出する`, matchNames(s0.bad).includes(s0.n));
}

const CLEAN = [
  'C:' + BS1 + 'Users' + BS1 + 'x',            // 文書中のプレースホルダ
  'C:' + BS1 + 'AI-DEV' + BS1 + 'example-app', // 架空の記入例
  'example-owner/example-app',
  'Claude Code 2.1.295 以降',
  '`.env.example` のプレースホルダ',
  'git push origin setup/step1-common-rules',
];
for (const line of CLEAN) {
  const m = matchNames(line);
  check(`正常な記述を誤検出しない: ${line.slice(0, 32)}`, m.length === 0, `検出=${m.join(',')}`);
}

check('LOCAL_USER を実行時に取得できている（個人パス検査が有効）', LOCAL_USER.length > 0);
check('このテストファイル自身に個人パスのリテラルがない', (() => {
  const self = fs.readFileSync(__filename, 'utf8');
  const bad = LOCAL_USER.length >= 4 ? new RegExp(LOCAL_USER.replace(/[^A-Za-z0-9_-]/g, ''), 'i') : null;
  return !bad || !bad.test(self);
})());

if (!fb.source || fb.broken) {
  console.log('  注意: 禁止固有名リストが未提供のため、社内固有名の検査は不完全である');
}

/* ------------------------------------------------------------------ */
section('9. Windows 互換性');

check('改行コードの設定がある（.gitattributes）', fs.existsSync(path.join(ROOT, '.gitattributes')));
check('定義ファイルに BOM がない', [].concat(
  agentFiles.map((f) => `.claude/agents/${f}`),
  skillDirs.map((d) => `.claude/skills/${d}/SKILL.md`),
  ['CLAUDE.md', '.claude/settings.json']
).every((f) => !fs.readFileSync(path.join(ROOT, f), 'utf8').startsWith('﻿')));
check('定義ファイルが UTF-8 として読める', (() => {
  try {
    for (const f of agentFiles) fs.readFileSync(path.join(AGENT_DIR, f), 'utf8');
    for (const d of skillDirs) fs.readFileSync(path.join(SKILL_DIR, d, 'SKILL.md'), 'utf8');
    return true;
  } catch (e) { return false; }
})());
check('Windows で使えないファイル名がない', TARGET_FILES.every((f) => !/[<>:"|?*]/.test(path.basename(f))));

/* ------------------------------------------------------------------ */
section('10. Markdown の相対リンク');

let linkTotal = 0, linkBad = 0;
const MD = TARGET_FILES.filter((f) => f.endsWith('.md'));
for (const rel of MD) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[2];
    if (/^(https?:|#)/.test(t)) continue;
    linkTotal++;
    const target = path.resolve(path.dirname(path.join(ROOT, rel)), t.split('#')[0]);
    if (!fs.existsSync(target)) { linkBad++; console.log(`        BROKEN ${rel} -> ${t}`); }
  }
}
check(`相対リンク ${linkTotal} 件すべて解決する`, linkBad === 0, `破損 ${linkBad} 件`);

/* ------------------------------------------------------------------ */
console.log('\n================ 定義テスト結果 ================');
console.log(`  合計 ${pass + fail} 件 / PASS ${pass} 件 / FAIL ${fail} 件`);
if (fail) { console.log('  失敗:'); for (const f of failures) console.log(`    - ${f}`); }
process.exit(fail > 0 ? 1 : 0);
