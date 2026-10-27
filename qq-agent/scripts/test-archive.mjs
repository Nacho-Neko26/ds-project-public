import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../src/context.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
const h = new HistoryStore(tmp, { maxMessages: 100 });
h.append('group:1', { t: Date.now(), role: 'user', name: 'a', text: 'hello' });
h.append('group:1', { t: Date.now(), role: 'bot', name: '我', text: 'hi' });
h.append('private:2', { t: Date.now(), role: 'user', name: 'b', text: 'yo' });
console.log('清理前 history 文件:', fs.readdirSync(path.join(tmp, 'history')).join(', '));

const n = h.archiveAndClear();
console.log('归档条数:', n);
const after = fs.readdirSync(path.join(tmp, 'history')).filter((f) => f.endsWith('.jsonl'));
console.log('清理后剩下的 jsonl:', after.length ? after.join(', ') : '（空）');
const arch = fs.readdirSync(path.join(tmp, 'history', 'archive'));
console.log('归档目录:', arch.join(', '));
console.log('清空后 transcript:', JSON.stringify(h.transcript('group:1')));
console.log(n === 3 && after.length === 0 && arch.length === 2 ? '\n通过' : '\n失败');
fs.rmSync(tmp, { recursive: true, force: true });
