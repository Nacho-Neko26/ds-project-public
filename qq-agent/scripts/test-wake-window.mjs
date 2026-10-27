// 「被 @ 之后 N 分钟窗口 + 桥侧掷骰」的单测：node scripts/test-wake-window.mjs
// 覆盖 pickGroupMessage()：被叫／窗口内／掷骰／mention 模式／窗口边界／关掉窗口
import { pickGroupMessage } from '../src/agent.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
};
const eq = (a, b, msg = '') => {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const MIN = 60_000;
const cfg = (min, chance = { default: [0.2, 0.4] }) => ({ raw: { reply: { wakeWindowMinutes: min, groupChance: chance } } });
const always = () => 0;   // 掷骰必中（rnd=0 < p）
const never = () => 0.999; // 掷骰必不中

console.log('被叫后 N 分钟窗口');

t('被叫 → 进，reason=called，并刷新 wakeUntil', () => {
  const now = 1_000_000;
  const r = pickGroupMessage({ cfg: cfg(5), chatKey: 'group:1', calledNow: true, now });
  eq(r.accept, true, 'accept');
  eq(r.reason, 'called', 'reason');
  eq(r.wakeUntil, now + 5 * MIN, 'wakeUntil');
});

t('默认 5 分钟（配置里没写这一项也一样）', () => {
  const now = 1_000_000;
  const r = pickGroupMessage({ cfg: { raw: {} }, chatKey: 'group:1', calledNow: true, now });
  eq(r.wakeUntil, now + 5 * MIN, 'wakeUntil');
});

t('窗口内（剩 4 分钟）没被叫 → 进，reason=wake', () => {
  const now = 1_000_000;
  const r = pickGroupMessage({
    cfg: cfg(5), chatKey: 'group:1', calledNow: false, wakeUntil: now + 4 * MIN, now, rnd: never,
  });
  eq(r.accept, true, 'accept');
  eq(r.reason, 'wake', 'reason');
});

t('窗口刚过 1 秒 → 不再白喂，改走掷骰', () => {
  const now = 1_000_000;
  const r = pickGroupMessage({
    cfg: cfg(5), chatKey: 'group:1', calledNow: false, wakeUntil: now - 1000, now, rnd: never,
  });
  eq(r.accept, false, 'accept');
  eq(r.reason, '', 'reason');
});

t('窗口边界：正好到点就算过期', () => {
  const now = 1_000_000;
  const r = pickGroupMessage({
    cfg: cfg(5), chatKey: 'group:1', calledNow: false, wakeUntil: now, now, rnd: never,
  });
  eq(r.accept, false, 'accept');
});

t('窗口内再说一句被叫的话 → 窗口从这一刻重新算', () => {
  const now = 1_000_000;
  const r = pickGroupMessage({
    cfg: cfg(5), chatKey: 'group:1', calledNow: true, wakeUntil: now + 60_000, now,
  });
  eq(r.wakeUntil, now + 5 * MIN, 'wakeUntil 应刷新');
});

t('wakeWindowMinutes=0 → 关窗口，被叫之后也不白喂', () => {
  const now = 1_000_000;
  const called = pickGroupMessage({ cfg: cfg(0), chatKey: 'group:1', calledNow: true, now });
  eq(called.reason, 'called', 'reason');
  eq(called.wakeUntil, 0, 'wakeUntil 应为 0');
  const after = pickGroupMessage({
    cfg: cfg(0), chatKey: 'group:1', calledNow: false, wakeUntil: 0, now, rnd: never,
  });
  eq(after.accept, false, 'accept');
});

t('mention 模式：窗口内也不进（那类群只认被叫）', () => {
  const now = 1_000_000;
  const r = pickGroupMessage({
    cfg: cfg(5), chatKey: 'group:1', mode: 'mention', calledNow: false, wakeUntil: now + 4 * MIN, now, rnd: always,
  });
  eq(r.accept, false, 'accept');
});

t('mention 模式被叫 → 照进', () => {
  const r = pickGroupMessage({ cfg: cfg(5), chatKey: 'group:1', mode: 'mention', calledNow: true });
  eq(r.accept, true, 'accept');
  eq(r.reason, 'called', 'reason');
});

t('没被叫没窗口：掷骰中 → reason=roll 且带出概率', () => {
  const r = pickGroupMessage({
    cfg: cfg(5, { default: [0.6, 0.8] }), chatKey: 'group:1', calledNow: false, wakeUntil: 0, rnd: always,
  });
  eq(r.accept, true, 'accept');
  eq(r.reason, 'roll', 'reason');
  eq(r.pct >= 60 && r.pct <= 80, true, 'pct 应落在 60~80，实际 ' + r.pct);
});

t('没被叫没窗口：掷骰没中 → 不进', () => {
  const r = pickGroupMessage({
    cfg: cfg(5), chatKey: 'group:1', calledNow: false, wakeUntil: 0, rnd: never,
  });
  eq(r.accept, false, 'accept');
  eq(r.reason, '', 'reason');
});

t('概率真的生效：同一个群里 2000 次大约四成命中', () => {
  const cf = cfg(5, { default: [0.4, 0.4] });
  let hit = 0;
  for (let i = 0; i < 2000; i++) {
    if (pickGroupMessage({ cfg: cf, chatKey: 'group:1', calledNow: false }).accept) hit++;
  }
  const rate = hit / 2000;
  eq(rate > 0.34 && rate < 0.46, true, `命中率应在 34%~46%，实际 ${(rate * 100).toFixed(1)}%`);
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
