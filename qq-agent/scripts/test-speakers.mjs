/**
 * 单元测试：说话人标注，确认「我」的归属清楚。
 *   node scripts/test-speakers.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../src/context.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-'));
const h = new HistoryStore(tmp, { maxMessages: 50, maxAgeMinutes: 0 });
h.append('group:1', { t: Date.now(), role: 'user', name: '主人', text: '我累死了' });
h.append('group:1', { t: Date.now(), role: 'bot', name: '我', text: '谁不累啊' });
h.append('group:1', { t: Date.now(), role: 'user', name: '小阮', text: '我请你吃饭' });

const { transcript } = h.transcript('group:1');
console.log('--- transcript ---');
console.log(transcript);

const checks = [
  ['对方的话带【主人】', transcript.includes('【主人】我累死了')],
  ['她的话带【我】', transcript.includes('【我】谁不累啊')],
  ['没有「名字: 内容」旧格式', !/[^\]]: 我/.test(transcript)],
];
let fail = 0;
for (const [name, ok] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exitCode = fail ? 1 : 0;
