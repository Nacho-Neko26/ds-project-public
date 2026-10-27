// 黄脸收录回归测试：node scripts/test-face-usage.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { loadFaceUsage, recordFaceUse, recordFaces, topFaces } from '../src/face-usage.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-usage-'));
let pass = 0;
const t = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

t('空库返回空对象', () => {
  assert.deepStrictEqual(loadFaceUsage(dir), {});
});

t('从消息段里收 face', () => {
  recordFaces(dir, [
    { type: 'text', data: { text: '哈哈' } },
    { type: 'face', data: { id: '13' } },
    { type: 'face', data: { id: '178' } },
  ], { 13: '呲牙', 178: '斜眼笑' });
  const u = loadFaceUsage(dir);
  assert.strictEqual(u['13'].count, 1);
  assert.strictEqual(u['13'].name, '呲牙');
  assert.strictEqual(u['178'].count, 1);
});

t('同 id 累加', () => {
  recordFaces(dir, [{ type: 'face', data: { id: 13 } }], {});
  recordFaces(dir, [{ type: 'face', data: { id: 13 } }], {});
  assert.strictEqual(loadFaceUsage(dir)['13'].count, 3);
});

t('非数字 id 忽略', () => {
  recordFaces(dir, [{ type: 'face', data: { id: '' } }, { type: 'face', data: { id: 'abc' } }], {});
  const u = loadFaceUsage(dir);
  assert.strictEqual(Object.keys(u).length, 2);
});

t('topFaces 按次数排序', () => {
  const top = topFaces(loadFaceUsage(dir), 10);
  assert.strictEqual(top[0].id, '13');
  assert.strictEqual(top[0].count, 3);
  assert.strictEqual(top.length, 2);
});

t('topFaces 截断', () => {
  assert.strictEqual(topFaces(loadFaceUsage(dir), 1).length, 1);
});

t('recordFaceUse 直接记名字', () => {
  recordFaceUse(dir, 100, '激动');
  assert.strictEqual(loadFaceUsage(dir)['100'].name, '激动');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项，失败 0`);
