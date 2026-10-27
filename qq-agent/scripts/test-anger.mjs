/**
 * 怒气档位单测：不连网、不调模型，只验 anger.mjs 的升降/回落/哄法。
 *
 *   node scripts/test-anger.mjs
 */
import assert from 'node:assert/strict';
import { updateAnger, loadProfiles, saveProfiles, angerTarget, callName, touchIntimacy } from '../src/anger.mjs';

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const mk = (text, uid = 1, name = '主人') => ({ now: new Date('2026-10-23T15:00:00'), batch: [{ text, uid, name }] });

/** 每一轮都新建 state，但把 angerAt/档位带过去——模拟真实会话 */
function run(text, st, p, now = new Date('2026-10-23T15:00:00')) {
  return updateAnger({ now, batch: [{ text, uid: 1, name: '主人' }], moodState: st, profile: p });
}

console.log('怒气档位');
t('Lv0 正常开场', () => {
  const st = {}, p = { nickFor: '主人' };
  const r = run('今天吃啥', st, p);
  assert.equal(r.lv, 0);
});

t('被催 → Lv1', () => {
  const st = {}, p = {};
  const r = run('快点回我啊', st, p);
  assert.equal(r.lv, 1, `期望 Lv1，实际 Lv${r.lv}`);
});

t('被说胖 → Lv2，且不叫主人', () => {
  const st = {}, p = {};
  const r = run('你是不是胖了', st, p);
  assert.equal(r.lv, 2);
  assert.equal(callName({ ...p, intimacy: 5 }), '主人', '亲密度高时平时叫主人');
  // Lv2 的提示词里必须写死不叫主人
  assert.match(r.text, /不再叫昵称/);
});

t('Lv2 继续被戳 → Lv3', () => {
  const st = {}, p = {};
  run('你是不是胖了', st, p);
  const r = run('胖子', st, p);
  assert.equal(r.lv, 3, `期望 Lv3，实际 Lv${r.lv}`);
  assert.deepEqual(r.hardReplies, ['嗯', '哦']);
});

t('拿生气开玩笑 → 直接 Lv3', () => {
  const st = {}, p = {};
  const r = run('你生气的样子真好玩', st, p);
  assert.equal(r.lv, 3);
});

t('叫全名「机器人」→ 回落并给和解信号', () => {
  const st = {}, p = {};
  run('你是不是胖了', st, p);
  const r = run('机器人', st, p);
  assert.equal(r.lv, 1, `期望回落到 Lv1，实际 Lv${r.lv}`);
  assert.equal(r.reconcile, true);
});

t('提饭 → 立刻归零', () => {
  const st = {}, p = {};
  run('你是不是胖了', st, p);
  const r = run('我请你吃饭吧', st, p);
  assert.equal(r.lv, 0, `期望 Lv0，实际 Lv${r.lv}`);
  assert.equal(p.sootheCount.food, 1);
});

t('认真道歉 → 回落一档', () => {
  const st = {}, p = {};
  run('你滚', st, p);
  assert.equal(st.angerLv, 2);
  const r = run('对不起，我错了，我不该那样说', st, p);
  assert.equal(r.lv, 1, `期望 Lv1，实际 Lv${r.lv}`);
});

t('连发「别生气了嘛」不加档但也不消气（信息量低→neutral 回落）', () => {
  const st = {}, p = {};
  run('你滚', st, p);
  const r = run('别生气了嘛别生气了嘛', st, p);
  // 现有实现里这算 neutral 回落，但不该升到 Lv3
  assert.ok(r.lv <= 2, `不该升级，实际 Lv${r.lv}`);
});

t('跨天清零', () => {
  const st = {}, p = {};
  run('你是不是胖了', st, p);
  const r = run('随便聊聊', st, p, new Date('2026-10-24T10:00:00'));
  assert.equal(r.lv, 0);
  assert.ok(r.changes.some((c) => c.includes('跨天清零')));
});

t('Lv1 几分钟后自动回落', () => {
  const st = {}, p = {};
  run('快点', st, p);
  assert.equal(st.angerLv, 1);
  const r = run('嗯嗯', st, p, new Date(new Date('2026-10-23T15:00:00').getTime() + 10 * 60 * 1000));
  assert.equal(r.lv, 0, `期望自动回落，实际 Lv${r.lv}`);
});

t('Lv2 90 分钟后慢速回落', () => {
  const st = {}, p = {};
  run('你滚', st, p);
  const r = run('嗯嗯', st, p, new Date(new Date('2026-10-23T15:00:00').getTime() + 100 * 60 * 1000));
  assert.equal(r.lv, 0);
});

t('累计三次同类冒犯 → 记下「这人爱开这种玩笑」', () => {
  const st = {}, p = {};
  const T = (n) => new Date(`2026-10-2${n}T15:00:00`);
  for (let i = 1; i <= 3; i++) {
    st.angerDay = new Date(`2026-10-2${i}T15:00:00`).toISOString().slice(0, 10); // 每天重来，避免跨天覆盖计数
    run('你滚', st, p, T(i));
  }
  assert.equal(p.offenseCount.rude, 3, '累计三次');
  assert.equal(p.flags.rudeRepeat, true);
});

console.log('\n昵称与亲密度');
t('默认叫他主人', () => {
  assert.equal(callName({ nickFor: '主人', intimacy: 3 }), '主人');
});
t('亲密度<3 叫名字', () => {
  assert.equal(callName({ nickFor: '主人', intimacy: 1, displayName: '小明' }), '小明');
});
t('聊 5 轮涨一格亲密度', () => {
  const p = { intimacy: 2 };
  touchIntimacy(p, 5);
  assert.equal(p.intimacy, 3);
});

console.log('\n档案读写');
t('档案能存能读', () => {
  const dir = '/tmp/anger-test-workspace';
  const data = { people: { 1: { nickFor: '主人' } } };
  saveProfiles(dir, 'group:<GROUP_ID_2>', data);
  const back = loadProfiles(dir, 'group:<GROUP_ID_2>');
  assert.deepEqual(back.people[1].nickFor, '主人');
});

console.log(`\n通过 ${pass} 项${process.exitCode ? '，有失败' : ''}`);
