#!/usr/bin/env node
/**
 * 群图策略单测（2026-10-28）。不连桥、不碰网络，Windows/服务器都能跑：
 *   node scripts/test-image-policy.mjs
 *
 * 验的是「群里到底看不看图」这件事的判断，以及被 @ 时那三张怎么捞。
 */
import {
  DEFAULT_POLICY, resolvePolicy, shouldReadImages, createRecentImageRing,
  buildRecentImagesHint, blindPlaceholder,
} from '../src/image-policy.mjs';

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(a, b, label) {
  ok(a === b, `${label}（得到 ${JSON.stringify(a)}，应为 ${JSON.stringify(b)}）`);
}

/* ---------- 1. 政策合并 ---------- */
{
  const p = resolvePolicy();
  eq(p.groupOnlyWhenAt, true, '默认：群里没被 @ 不看图');
  eq(p.recentPerCaller, 3, '默认：被 @ 补看最近 3 张');
  eq(p.recentWindowMs, 10 * 60_000, '默认：补看窗口 10 分钟');

  eq(resolvePolicy({ groupOnlyWhenAt: false }).groupOnlyWhenAt, false, 'config 能关掉群图策略');
  eq(resolvePolicy({ recentPerCaller: 5 }).recentPerCaller, 5, 'config 能改补看张数');
  eq(resolvePolicy({ recentPerCaller: 0 }).recentPerCaller, 0, '补看张数能设为 0（等于不补看）');
  eq(resolvePolicy({ recentPerCaller: 'x' }).recentPerCaller, 3, '张数写错回落默认，不炸');
  eq(resolvePolicy(null).recentPerCaller, 3, 'config 为空也不炸');
}

/* ---------- 2. 看不看：四种组合 ---------- */
{
  const p = DEFAULT_POLICY;
  eq(shouldReadImages(p, { isGroup: false, atMe: false }), true, '私聊：照常看');
  eq(shouldReadImages(p, { isGroup: false, atMe: true }), true, '私聊 ads：照常看');
  eq(shouldReadImages(p, { isGroup: true, atMe: false }), false, '群聊没被 @：不看');
  eq(shouldReadImages(p, { isGroup: true, atMe: true }), true, '群聊被 @：看');
  eq(shouldReadImages(p, {}), true, '缺字段当私聊，看');
  eq(shouldReadImages(null, { isGroup: true, atMe: false }), false, 'policy 为空也用默认');

  const off = { ...p, groupOnlyWhenAt: false };
  eq(shouldReadImages(off, { isGroup: true, atMe: false }), true, '关掉策略后群里也看');
}

/* ---------- 3. 最近发过哪几张：环形记录 ---------- */
{
  const ring = createRecentImageRing(4);
  const t0 = 1_000_000;
  ring.remember('group:1', { uid: 7, name: '祈羽', file: '/a.jpg', at: t0 });
  ring.remember('group:1', { uid: 8, name: '别人', file: '/b.jpg', at: t0 + 10 });
  ring.remember('group:1', { uid: 7, name: '祈羽', file: '/c.jpg', at: t0 + 20 });
  ring.remember('group:1', { uid: 7, name: '祈羽', file: '/d.jpg', at: t0 + 30 });

  eq(ring.from('group:1', 7, 3, 0).map((e) => e.file).join(','), '/a.jpg,/c.jpg,/d.jpg',
    '只捞这个人的，按时间正序，取最近 3 张');
  eq(ring.from('group:1', 7, 10, 0).length, 3, '要得多也只给这个人的全部');
  eq(ring.from('group:1', 8, 3, 0).map((e) => e.file).join(','), '/b.jpg', '别人发的不会串到这个人头上');
  eq(ring.from('group:1', 7, 3, t0 + 15).map((e) => e.file).join(','), '/c.jpg,/d.jpg', '时间窗外的不要');
  eq(ring.from('group:9', 7, 3, 0).length, 0, '别的聊天窗口的记录不会串过来');

  // 超出容量要挤掉最老的
  ring.remember('group:1', { uid: 7, name: '祈羽', file: '/e.jpg', at: t0 + 40 });
  ring.remember('group:1', { uid: 7, name: '祈羽', file: '/f.jpg', at: t0 + 50 });
  eq(ring.size('group:1'), 4, '容量封顶');
  eq(ring.from('group:1', 7, 9, 0).map((e) => e.file).join(','), '/c.jpg,/d.jpg,/e.jpg,/f.jpg',
    '最老的两条被挤掉了（a 是第 1 条、b 是第 2 条）');

  // 空值不许进
  ring.remember('group:1', null);
  ring.remember('group:1', { uid: 7, file: '' });
  ring.remember('', { uid: 7, file: '/z.jpg' });
  eq(ring.size('group:1'), 4, '没有文件路径/没有窗口的条目不记');
}

/* ---------- 4. 文案 ---------- */
{
  const hint = buildRecentImagesHint('祈羽', ['一只橘猫', '一张截图']);
  ok(hint.includes('祈羽'), '被 @ 提示里带上是谁');
  ok(hint.includes('2 张图'), '被 @ 提示里报张数');
  ok(hint.includes('（1）一只橘猫') && hint.includes('（2）一张截图'), '逐张编号');
  ok(hint.includes('别复述这段话'), '提示里带了「别复述」的护栏');
  eq(buildRecentImagesHint('祈羽', []), '', '没有图就不产生提示');
  eq(buildRecentImagesHint('祈羽', [null, '']), '', '空描述不算数');

  eq(blindPlaceholder('祈羽', false), '[祈羽发了一张图，群里刷的，没细看]', '群图不看时的占位符');
  eq(blindPlaceholder('祈羽', true), '[祈羽发了个表情包，群里刷的，没细看]', '表情包占位符');
  eq(blindPlaceholder('', false), '[对方发了一张图，群里刷的，没细看]', '没名字时说「对方」');
  ok(!blindPlaceholder('祈羽', false).includes('看不到'), '占位符里不许出现「看不到」（那会让她打哈哈）');
}

if (fails.length) {
  console.error(`✗ ${fails.length} 条没过（共 ${pass + fails.length}）：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 群图策略 ${pass} 条断言全过`);
