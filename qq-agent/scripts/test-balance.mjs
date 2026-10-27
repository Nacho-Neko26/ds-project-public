/**
 * 余额与消耗记账单测。
 *   node scripts/test-balance.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordBalancePoint, computeSpend, balanceLineFor } from '../src/balance.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bal-'));

console.log('消耗记账');
t('只算下降，充值不算消耗', () => {
  recordBalancePoint(tmp, 100);
  recordBalancePoint(tmp, 90);   // -10 消耗
  recordBalancePoint(tmp, 200);  // 充值，不算
  recordBalancePoint(tmp, 195);  // -5 消耗
  const s = computeSpend(tmp);
  ok(Math.abs(s.total - 15) < 0.01, `累计应 15，实际 ${s.total}`);
});

t('余额没变不重复记点', () => {
  const before = computeSpend(tmp).total;
  recordBalancePoint(tmp, 195);
  recordBalancePoint(tmp, 195);
  ok(Math.abs(computeSpend(tmp).total - before) < 0.01, '重复点不该改变累计');
});

console.log('回答分档');
t('主人：如实报数 + 消耗', () => {
  const line = balanceLineFor({ cny: 42.5, spend: { today: 3.2, total: 18.8 }, isOwner: true, favor: 100 });
  ok(line.includes('42.50'), '应含余额');
  ok(line.includes('3.20'), '应含今日消耗');
  ok(line.includes('18.80'), '应含累计消耗');
});

t('好感≥80 且余额>30：只说还很饱', () => {
  const line = balanceLineFor({ cny: 42.5, isOwner: false, favor: 85 });
  ok(line.includes('还很饱'), '应说还很饱');
  ok(!line.includes('42.5'), '不该报数字');
});

t('好感≥80 且余额<10：只说有点饿了', () => {
  const line = balanceLineFor({ cny: 6.2, isOwner: false, favor: 90 });
  ok(line.includes('有点饿了'), '应说有点饿了');
  ok(!line.includes('6.2'), '不该报数字');
});

t('好感≥80 但 10~30：没有特别效果', () => {
  const line = balanceLineFor({ cny: 20, isOwner: false, favor: 85 });
  ok(line === '', '应为空');
});

t('普通群友：不给任何余额信息', () => {
  const line = balanceLineFor({ cny: 42.5, isOwner: false, favor: 60 });
  ok(line === '', '应为空');
});

t('主人即便余额充裕也报数', () => {
  const line = balanceLineFor({ cny: 99.9, isOwner: true, favor: 100 });
  ok(line.includes('99.90'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
