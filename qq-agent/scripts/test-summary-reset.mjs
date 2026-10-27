// 回归测试：换天清空 history 后，摘要要能重新触发（2026-10-25 修的 covered 卡死 bug）。
// 跑法：cd /root/qq-agent && node tools/test-summary-reset.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maybeSummarize } from '../src/summary.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumtest-'));
const histFile = path.join(tmp, 'history.jsonl');
const rows = [];
for (let i = 0; i < 100; i++) {
  rows.push(JSON.stringify({ t: Date.now() + i, role: i % 2 ? 'bot' : 'user', name: '顾鹤', text: `第${i}条消息` }));
}
fs.writeFileSync(histFile, rows.join('\n') + '\n', 'utf8');

const sumDir = path.join(tmp, 'summary');
fs.mkdirSync(sumDir, { recursive: true });
const stateFile = path.join(sumDir, 'group_1.json');
fs.writeFileSync(stateFile, JSON.stringify({ covered: 1020 }), 'utf8');

const cfg = { agentCwd: tmp, raw: { summary: { enabled: true, everyMessages: 80, takeMessages: 60, maxBlocks: 4, maxChars: 700 } } };
const history = { file: () => histFile };
let calls = 0;
const runner = { run: async () => { calls++; return { ok: true, text: '这段在聊测试摘要重置。' }; } };

const out = await maybeSummarize({ cfg, runner, history, chatKey: 'group:1', note: () => {} });
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

if (!out) {
  console.error('FAIL: 摘要没有触发（covered 卡死没被重置）');
  process.exit(1);
}
if (calls !== 1) {
  console.error('FAIL: 模型调用次数应为 1，实际', calls);
  process.exit(1);
}
if (st.covered !== 60) {
  console.error('FAIL: covered 应为 60，实际', st.covered);
  process.exit(1);
}
const md = fs.readFileSync(path.join(sumDir, 'group_1.md'), 'utf8');
if (!md.includes('测试摘要重置')) {
  console.error('FAIL: 摘要文件没写进去');
  process.exit(1);
}
console.log('PASS: 清空后摘要重新触发，covered 1020 → 60，写入一段摘要');
