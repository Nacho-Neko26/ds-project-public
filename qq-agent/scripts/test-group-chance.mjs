// 群聊接话概率文案的单测：node scripts/test-group-chance.mjs
import { groupChanceLabel } from '../src/agent.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
};
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

console.log('群聊接话概率');

t('没配 groupChance → 默认 20%~40%', () => {
  eq(groupChanceLabel({ raw: {} }, 'group:1'), '20%~40%');
});

t('配了 default → 用 default', () => {
  const cfg = { raw: { reply: { groupChance: { default: [0.3, 0.5] } } } };
  eq(groupChanceLabel(cfg, 'group:1'), '30%~50%');
});

t('某个群单独配 → 用该群的', () => {
  const cfg = { raw: { reply: { groupChance: { default: [0.2, 0.4], '999': [0.6, 0.8] } } } };
  eq(groupChanceLabel(cfg, 'group:999'), '60%~80%');
  eq(groupChanceLabel(cfg, 'group:111'), '20%~40%');
});

t('没带 group: 前缀也认', () => {
  const cfg = { raw: { reply: { groupChance: { '999': [0.1, 0.2] } } } };
  eq(groupChanceLabel(cfg, '999'), '10%~20%');
});

t('配坏了（不是数组/不是数字）→ 回落 default', () => {
  const cfg = { raw: { reply: { groupChance: { default: [0.2, 0.4], '999': ['x', 2] } } } };
  eq(groupChanceLabel(cfg, 'group:999'), '20%~40%');
});

t('default 也坏了 → 硬兜底 20%~40%', () => {
  const cfg = { raw: { reply: { groupChance: { default: 'oops' } } } };
  eq(groupChanceLabel(cfg, 'group:999'), '20%~40%');
});

t('私聊 key（private:）→ 用 default', () => {
  const cfg = { raw: { reply: { groupChance: { default: [0.2, 0.4] } } } };
  eq(groupChanceLabel(cfg, 'private:<OWNER_QQ>'), '20%~40%');
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
