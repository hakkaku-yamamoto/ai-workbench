#!/usr/bin/env node
'use strict';
/**
 * 全テストの実行。
 *   node tests/run-all.js
 *
 * 内訳
 *   tests/hooks/run-tests.js        Hooks の単体・異常系（使い捨てのローカル git リポジトリと模擬 stdin）
 *   tests/definitions/run-tests.js  エージェント・スキル・設定・ルール・公開可否・Windows 互換
 *
 * 外部へ送信する操作、実際の main / 本番環境 / 共有環境への操作は一切行わない。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  { name: 'hooks', script: path.join(__dirname, 'hooks', 'run-tests.js') },
  { name: 'definitions', script: path.join(__dirname, 'definitions', 'run-tests.js') },
];

const results = [];
for (const s of SUITES) {
  console.log(`\n########## ${s.name} ##########`);
  const r = spawnSync(process.execPath, [s.script], { stdio: 'inherit' });
  results.push({ name: s.name, code: r.status });
}

console.log('\n================ 全体 ================');
let bad = 0;
for (const r of results) {
  console.log(`  ${r.name.padEnd(12)} ${r.code === 0 ? 'PASS' : `FAIL (exit ${r.code})`}`);
  if (r.code !== 0) bad++;
}
console.log(bad === 0 ? '  すべてのスイートが通過した' : `  ${bad} スイートが失敗した`);
process.exit(bad === 0 ? 0 : 1);
