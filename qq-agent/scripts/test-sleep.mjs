/**
 * 睡觉时间解析 + 晚安/午安判定。
 *   node scripts/test-sleep.mjs
 */
import { parseSleepMention, parseClock } from '../src/favor.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

console.log('解析时钟');
t('十一点', () => eq(parseClock('十一点'), { hour: 11, minute: 0 }));
t('十一点半', () => eq(parseClock('十一点半'), { hour: 11, minute: 30 }));
t('11:30', () => eq(parseClock('11:30'), { hour: 11, minute: 30 }));
t('两点', () => eq(parseClock('两点'), { hour: 2, minute: 0 }));

console.log('睡觉说法');
t('我十一点睡 → 23:00', () => eq(parseSleepMention('我十一点睡'), { hour: 23, minute: 0, nap: false }));
t('我一点睡 → 01:00（凌晨）', () => eq(parseSleepMention('我一点睡'), { hour: 1, minute: 0, nap: false }));
t('凌晨两点睡 → 02:00', () => eq(parseSleepMention('我凌晨两点睡'), { hour: 2, minute: 0, nap: false }));
t('晚上十点睡 → 22:00', () => eq(parseSleepMention('我晚上十点睡'), { hour: 22, minute: 0, nap: false }));
t('下午两点前睡 → 14:00 午睡', () => eq(parseSleepMention('我下午两点前睡'), { hour: 14, minute: 0, nap: true }));
t('下午一点午睡 → 13:00 午睡', () => eq(parseSleepMention('我下午一点午睡'), { hour: 13, minute: 0, nap: true }));

console.log('不该误判');
t('三点开会 → null', () => eq(parseSleepMention('三点开会'), null));
t('我吃饱了 → null', () => eq(parseSleepMention('我吃饱了'), null));
t('六点下班 → null', () => eq(parseSleepMention('六点下班'), null));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
