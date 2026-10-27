/**
 * 表情台账与目录去重的回归测试（2026-10-25）。
 * 跑法：node scripts/test-sticker-usage.mjs
 * 覆盖：同图去重留最新编号、台账读写与计数、刚发过的窗口判定、坏文件不炸。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadUsage, recordUse, sentRecently, uniqueRows } from '../src/sticker-usage.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'su-'));
let fail = 0;
const ok = (c, m) => {
  if (!c) { console.log('FAIL', m); fail++; } else console.log('ok  ', m);
};

// 1. 去重：同一张图出现 3 次，只留最新编号，且保持原顺序
const rows = [{ file: 'a.png' }, { file: 'b.png' }, { file: 'a.png' }, { file: 'c.png' }, { file: 'a.png' }];
const keyOf = (r) => r.file;
const uniq = uniqueRows(rows, keyOf);
ok(uniq.length === 3, `去重后 3 条（实际 ${uniq.length}）`);
ok(uniq.find((r) => r.key === 'a.png').index === 4, 'a.png 保留最新编号 4');
ok(JSON.stringify(uniq.map((r) => r.index)) === '[1,3,4]', `保持顺序并跳过旧编号：${uniq.map((r) => r.index)}`);

// 2. 台账：记了能读回来，窗口外不算刚发过，计数累加
const now = Date.now();
recordUse(dir, 'a.png', now - 60 * 1000);
ok(sentRecently(loadUsage(dir), 'a.png', now, 25 * 60000), '1 分钟前发过 → 算刚发过');
ok(!sentRecently(loadUsage(dir), 'a.png', now, 30 * 1000), '窗口设 30 秒 → 不算刚发过');
recordUse(dir, 'a.png', now);
ok(loadUsage(dir)['a.png'].n === 2, `计数累加（实际 ${loadUsage(dir)['a.png'].n}）`);

// 3. 空键不写；坏文件退回空表不抛
recordUse(dir, '');
ok(Object.keys(loadUsage(dir)).length === 1, '空键不写台账');
fs.writeFileSync(path.join(dir, 'sticker-usage.json'), '{坏 json');
ok(Object.keys(loadUsage(dir)).length === 0, '坏文件退回空表不抛');

// 4. 没有 key 的行不参与去重（不能把不同文件合并掉）
const noKey = uniqueRows([{ file: '' }, { file: '' }], (r) => r.file);
ok(noKey.length === 2, '无 key 的行全部保留');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
