/**
 * 好感度系统单测。不连网。
 *   node scripts/test-favor.mjs
 */
import { FAVOR, ensureFavor, rollDay, applyFavor, applyPersuade, settleDailyChat, settleHourlyChat, tierOf, beijingNow } from '../src/favor.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); };
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const D = '2026-10-23';

console.log('基础');
t('新人是 50', () => { const p = {}; eq(ensureFavor(p), 50); });

t('老档案 intimacy 迁移（保守映射）', () => {
  eq(ensureFavor({ intimacy: 3 }), 62, 'intimacy3→62');
  eq(ensureFavor({ intimacy: 5 }), 80, 'intimacy5→80，不直接满分');
  eq(ensureFavor({ intimacy: 0 }), 30);
});

t('夸 +1 / 惹 -1', () => {
  const p = { favor: 50 };
  eq(applyFavor(p, 1, { dayKey: D }).after, 51);
  eq(applyFavor(p, -1, { dayKey: D }).after, 50);
});

console.log('单日上限');
t('单日最多 +20', () => {
  const p = { favor: 50 };
  applyFavor(p, 19, { dayKey: D });
  const r = applyFavor(p, 5, { dayKey: D });
  eq(p.favor, 70, '只到 +20');
  ok(r.capped, '应标记封顶');
});

t('单日最多 -10', () => {
  const p = { favor: 80 };
  applyFavor(p, -8, { dayKey: D });
  applyFavor(p, -5, { dayKey: D });
  eq(p.favor, 70, '只掉 10');
});

t('跨天额度重置', () => {
  const p = { favor: 50 };
  applyFavor(p, 20, { dayKey: D });
  eq(p.favor, 70);
  applyFavor(p, 20, { dayKey: '2026-10-24' });
  eq(p.favor, 90, '第二天重新 +20');
});

console.log('每日 +5');
t('聊了且没惹她 → 第二天日结 +5', () => {
  const p = { favor: 50, dayKey: D, dayMark: '+', dayChatted: true };
  const r = settleDailyChat(p, '2026-10-26');
  eq(r.gained, 5);
  eq(p.favor, 55);
});

t('惹了她 → 不加', () => {
  const p = { favor: 50 };
  rollDay(p, D); p.dayChatted = true; p.dayAngered = true;
  const r = settleDailyChat(p, D);
  eq(r.gained, 0);
  eq(p.favor, 50);
});

t('没聊天 → 不加', () => {
  const p = { favor: 50 };
  rollDay(p, D);
  eq(settleDailyChat(p, D).gained, 0);
});

console.log('每小时 +1');
const NOW = 1_800_000_000_000;
t('同一小时只加一次', () => {
  const p = { favor: 60, dayMark: '+', lastChatAt: NOW };
  rollDay(p, D); p.dayMark = '+'; p.lastChatAt = NOW;
  const a = settleHourlyChat(p, D, `${D}T10`, NOW);
  eq(a.gained, 1); eq(p.favor, 61);
  const b = settleHourlyChat(p, D, `${D}T10`, NOW);
  eq(b.gained, 0); eq(p.favor, 61);
});

t('换一个钟头再加 1', () => {
  const p = { favor: 60 };
  rollDay(p, D); p.dayMark = '+'; p.lastChatAt = NOW;
  settleHourlyChat(p, D, `${D}T10`, NOW);
  const r = settleHourlyChat(p, D, `${D}T11`, NOW);
  eq(r.gained, 1); eq(p.favor, 62);
});

t('过去一小时没互动 → 不加', () => {
  const p = { favor: 60 };
  rollDay(p, D); p.dayMark = '+'; p.lastChatAt = NOW - 3700_000;
  eq(settleHourlyChat(p, D, `${D}T10`, NOW).gained, 0);
  eq(p.favor, 60);
});

t('没聊过天 → 不加', () => {
  const p = { favor: 60 };
  rollDay(p, D);
  eq(settleHourlyChat(p, D, `${D}T10`, NOW).gained, 0);
  eq(p.favor, 60);
});

t('当天标记是「-」→ 不加', () => {
  const p = { favor: 60 };
  rollDay(p, D); p.dayMark = '-'; p.lastChatAt = NOW;
  eq(settleHourlyChat(p, D, `${D}T10`, NOW).gained, 0);
  eq(p.favor, 60);
});

t('当天已按小时发过，第二天 04:00 日结照给 +5', () => {
  const p = { favor: 60, dayKey: D, dayMark: '+', lastChatAt: NOW };
  settleHourlyChat(p, D, `${D}T10`, NOW);
  eq(p.favor, 61);
  eq(settleDailyChat(p, '2026-10-26').gained, 5);
  eq(p.favor, 66);
});

t('每小时 +1 每天最多 5 分，加满就不再给', () => {
  const p = { favor: 60 };
  rollDay(p, D); p.dayMark = '+'; p.lastChatAt = NOW;
  for (let h = 10; h <= 19; h += 1) settleHourlyChat(p, D, `${D}T${h}`, NOW);
  eq(p.hourlyGainToday, 5);
  eq(p.favor, 65);
});

t('每小时加满后，第二天 04:00 日结照给 +5', () => {
  const p = { favor: 60, dayKey: D, dayMark: '+', lastChatAt: NOW };
  for (let h = 10; h <= 19; h += 1) settleHourlyChat(p, D, `${D}T${h}`, NOW);
  eq(p.favor, 65);
  eq(settleDailyChat(p, '2026-10-26').gained, 5);
  eq(p.favor, 70);
});

t('同一天所有加分方式加起来封顶 20', () => {
  const p = { favor: 60 };
  rollDay(p, D); p.dayMark = '+'; p.lastChatAt = NOW;
  for (let h = 10; h <= 19; h += 1) settleHourlyChat(p, D, `${D}T${h}`, NOW); // +5
  eq(p.dayGain, 5);
  eq(applyFavor(p, 20, { dayKey: D }).applied, 15, '只剩 15 的额度');
  eq(p.dayGain, 20);
  eq(p.favor, 80);
  eq(applyFavor(p, 5, { dayKey: D }).applied, 0, '加满后再加是 0');
});

t('补偿 +10 不占每日 20 额度', () => {
  const p = { favor: 60 };
  rollDay(p, D); p.dayMark = '+'; p.lastChatAt = NOW;
  for (let h = 10; h <= 19; h += 1) settleHourlyChat(p, D, `${D}T${h}`, NOW);
  applyFavor(p, 20, { dayKey: D });
  eq(p.dayGain, 20); eq(p.favor, 80);
  eq(applyFavor(p, 10, { ignoreCap: true }).applied, 10);
  eq(p.favor, 90);
  eq(p.dayGain, 20, '补偿不动日额度');
});

t('昨天标记「+」→ 04:00 日结 +5', () => {
  const p = { favor: 60, dayKey: D, dayMark: '+', dayChatted: true };
  const E = '2026-10-24';
  rollDay(p, E);
  eq(p.prevDayMark, '+');
  eq(settleDailyChat(p, E).gained, 5);
  eq(p.favor, 65);
});

t('昨天标记「-」→ 日结不加', () => {
  const p = { favor: 60, dayKey: D, dayMark: '-', dayChatted: true, dayAngered: true };
  rollDay(p, '2026-10-24');
  eq(p.prevDayMark, '-');
  eq(settleDailyChat(p, '2026-10-24').gained, 0);
  eq(p.favor, 60);
});

console.log('劝说');
t('帮手每天只能 +5 一次（好感50以上全额）', () => {
  const p = { favor: 60 };
  const a = applyPersuade(p, 111, D);
  ok(a.ok, '第一次应成功');
  eq(p.favor, 65);
  const b = applyPersuade(p, 111, D);
  ok(!b.ok, '同一天第二次应失败');
});

t('不同帮手可以各 +5', () => {
  const p = { favor: 60 };
  applyPersuade(p, 111, D);
  applyPersuade(p, 222, D);
  eq(p.favor, 70);
});

t('单人靠劝说最多 +20', () => {
  const p = { favor: 60 };
  for (let i = 0; i < 6; i++) applyPersuade(p, 1000 + i, D);
  eq(p.favor, 80, '6 个帮手各 +5，正好 +20');
  eq(p.persuadeGainToday, 20);
  const more = applyPersuade(p, 9999, D);
  ok(!more.ok, '第 7 个应被 +20 上限挡住');
});

t('低好感(<50)劝说也是半速', () => {
  const p = { favor: 30 };
  applyPersuade(p, 111, D);
  ok(p.favor < 35, `半速应小于 +5，实际到了 ${p.favor}`);
});

console.log('半速成长');
t('好感<50 时涨幅减半，但日上限也是 20', () => {
  const p = { favor: 30 };
  applyFavor(p, 20, { dayKey: D });
  eq(p.dayGain, 10, '半速一次只落 10');
  eq(p.favor, 40, '一次只涨 10');
  applyFavor(p, 20, { dayKey: D });
  eq(p.dayGain, 20, '同一天还能继续加到 20');
  eq(p.favor, 50, '当天总共 20');
});

t('好感>=50 全额、日上限 20', () => {
  const p = { favor: 55 };
  applyFavor(p, 20, { dayKey: D });
  eq(p.favor, 75);
});

t('掉到 20 以下会留疤 everBelow20', () => {
  const p = { favor: 25 };
  applyFavor(p, -10, { dayKey: D });
  ok(p.everBelow20, '应标记 everBelow20');
});

console.log('档位');
t('档位边界', () => {
  eq(tierOf(19), 'hated');
  eq(tierOf(20), 'normal');
  eq(tierOf(69), 'normal');
  eq(tierOf(70), 'friend');
  eq(tierOf(79), 'friend');
  eq(tierOf(80), 'obey');
  eq(tierOf(89), 'obey');
  eq(tierOf(90), 'sing');
});

console.log('北京时间');
t('北京时间键与小时', () => {
  const b = beijingNow(new Date('2026-10-23T20:05:00Z')); // UTC 20:05 → 北京 04:05 次日
  eq(b.key, '2026-10-24');
  eq(b.hour, 4);
  eq(b.minute, 5);
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
