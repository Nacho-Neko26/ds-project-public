/**
 * §16 表情中枢单测（doc 测试 43–52 + 冷却门）。不连网、不碰真库。
 *   node scripts/test-memehub.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ingestImage, tagEmoji, takeTagJobs, planMemeAction, renderMemeHint, scoreEmojiV2, scoreEmojis,
  parseDescPayload, normalizeTagList, digestOfFile, EMOJI_V2_WEIGHTS, EMOJI_TAGS, MEMEHUB_DEFAULTS, pickEmoji,
  loadExpression, saveExpression, expressionDebugLogs,
} from '../src/expression.mjs';
import { resolveStickerPath } from '../src/stickerfile.mjs';

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); };
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

function mkCfg(patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memehub-'));
  const agentCwd = path.join(root, 'workspace');
  fs.mkdirSync(agentCwd, { recursive: true });
  return {
    root,
    agentCwd,
    raw: { expression: { expressionFile: 'expr.json', memeHub: { enabled: true, ...patch } } },
  };
}

let seq = 0;
function mkImg(cfg, bytes = null) {
  seq += 1;
  const dir = path.join(cfg.root, 'incoming');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `img${seq}.jpg`);
  fs.writeFileSync(file, bytes ?? Buffer.from(`pixel-${seq}-${Math.random()}`));
  return file;
}

const G = 'group:200000001';
const mkMeta = (uid, extra = {}) => ({ chatKey: G, uid, name: `u${uid}`, isGroup: true, ...extra });

console.log('43 digest 去重');
t('同内容不同文件名只入库一次', () => {
  const cfg = mkCfg();
  const bytes = Buffer.from('same-bytes');
  const a = mkImg(cfg, bytes);
  const b = mkImg(cfg, bytes);
  const r1 = ingestImage({ cfg, file: a, meta: mkMeta(1) });
  const r2 = ingestImage({ cfg, file: b, meta: mkMeta(1) });
  eq(r1.reason, 'new');
  eq(r2.reason, 'seen');
  eq(r2.digest, digestOfFile(a));
  const st = loadExpression(cfg);
  eq(st.emojiCollection.length, 1, '只应有一条');
  eq(st.emojiCollection[0].frequency, 2, 'frequency 累加');
});

t('关闸时什么都不做', () => {
  const cfg = mkCfg({ enabled: false });
  const r = ingestImage({ cfg, file: mkImg(cfg), meta: mkMeta(1) });
  eq(r.reason, 'disabled');
  eq(loadExpression(cfg).emojiCollection.length, 0);
  eq(takeTagJobs(cfg, 1).length, 0);
});

console.log('44 多标签解析');
t('一行 JSON 解析出 summary/tags/moodHints', () => {
  const r = parseDescPayload('好的：{"summary":"猫在狂笑","tags":["搞笑","可爱"],"moodHints":["happy"]}');
  eq(r.text, '猫在狂笑');
  eq(r.tags.join(','), '搞笑,可爱');
  eq(r.moodHints.join(','), 'happy');
});
t('纯文本也能退回去，不抛', () => {
  const r = parseDescPayload('一只柴犬歪头看着镜头');
  eq(r.text, '一只柴犬歪头看着镜头');
  eq(r.tags.length, 0);
});
t('词表外的标签被丢掉', () => {
  eq(normalizeTagList(['搞笑', '外星词', '可爱', '搞笑']).join(','), '搞笑,可爱');
  eq(normalizeTagList(EMOJI_TAGS).length, MEMEHUB_DEFAULTS.tagMax);
});

console.log('45 六项权重');
t('权重和是 1.00', () => {
  const sum = Object.values(EMOJI_V2_WEIGHTS).reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 1) < 1e-9, `权重和=${sum}`);
  eq(Object.keys(EMOJI_V2_WEIGHTS).length, 6);
});
t('冷却门把所有分数归零', () => {
  const r = scoreEmojiV2([{ digest: 'a', state: 'active', tags: ['搞笑'], associatedMood: ['happy'] }],
    { emotionName: 'happy', now: 1000, emojiCooldownUntil: 5000 });
  eq(r.scores[0].score, 0);
});
t('B 方案：scoreEmojis 已是薄壳，与 scoreEmojiV2 同分', () => {
  const item = { digest: 'x', state: 'active', tags: ['搞笑'], associatedMood: ['happy'], selfUsedCount: 0, source: { uid: 1 } };
  const opts = { emotionName: 'happy', now: 1000, favorOf: () => 80, tagOverlapTags: ['搞笑'] };
  const a = scoreEmojis([item], opts).scores[0].score;
  const b = scoreEmojiV2([item], opts).scores[0].score;
  ok(Math.abs(a - b) < 1e-9, `venv ${a} vs ${b}`);
});
t('没标签时 tagOverlap 权重摊给其余五因子', () => {
  const bare = scoreEmojiV2([{ associatedMood: ['happy'], selfUsedCount: 0, source: { uid: 1 } }],
    { emotionName: 'happy', now: 1000, favorOf: () => 80 }).scores[0];
  eq(bare.parts.tagOverlap, null);
  ok(Math.abs(bare.score - 0.594 / 0.78) < 1e-9, `score=${bare.score}`);
  const tagged = scoreEmojiV2([{ associatedMood: ['happy'], tags: ['搞笑'], selfUsedCount: 0, source: { uid: 1 } }],
    { emotionName: 'happy', now: 1000, favorOf: () => 80, tagOverlapTags: ['搞笑'] }).scores[0];
  ok(tagged.score > bare.score, '命中标签的应更高');
});
t('还没打标到 active 时 pickEmoji 仍能选（includeInactive 兜底）', () => {
  const list = [{ digest: 'p1', state: 'pending', verified: true, associatedMood: ['happy'], selfUsedCount: 0, source: { uid: 1 } }];
  const r = pickEmoji(list, { emotionName: 'happy', now: 1000, favorOf: () => 80 });
  ok(r.emoji && r.emoji.digest === 'p1', '应选中 pending 那张');
});

console.log('46 队形');
t('三个人刷同一张图 → 队形成立', () => {
  const cfg = mkCfg({ joinFormation: true });
  const bytes = Buffer.from('formation-bytes');
  for (const uid of [11, 12, 13]) ingestImage({ cfg, file: mkImg(cfg, bytes), meta: mkMeta(uid) });
  const plan = planMemeAction({ cfg, chatKey: G, now: Date.now(), rand: () => 0 });
  ok(plan.formation, 'formation 应为真');
  eq(plan.formation.count, 3);
  ok(renderMemeHint(plan).includes('队形'), '提示里要有队形字样');
});
t('两个人不够，且私聊不出斗图', () => {
  const cfg = mkCfg({ joinFormation: true });
  const bytes = Buffer.from('two-only');
  for (const uid of [21, 22]) ingestImage({ cfg, file: mkImg(cfg, bytes), meta: mkMeta(uid) });
  eq(planMemeAction({ cfg, chatKey: G, now: Date.now(), rand: () => 0 }).formation, null);
  eq(planMemeAction({ cfg, chatKey: 'private:100000001', now: Date.now(), rand: () => 0 }).lines.length, 0);
});

console.log('47 连发');
t('能量够 + 掷中 → 建议连发 1~2 张', () => {
  const cfg = mkCfg({ multiSend: true, multiSendChance: 1 });
  const plan = planMemeAction({ cfg, chatKey: G, now: Date.now(), energy: 0.9, rand: () => 0 });
  ok(plan.multiSend >= 1, `multiSend=${plan.multiSend}`);
  ok(plan.multiSend <= MEMEHUB_DEFAULTS.multiSendMax, 'multiSend 超过上限');
});
t('能量不足不建议连发', () => {
  const cfg = mkCfg({ multiSend: true, multiSendChance: 1 });
  eq(planMemeAction({ cfg, chatKey: G, now: Date.now(), energy: 0.2, rand: () => 0 }).multiSend, 0);
});

console.log('48 团战');
t('一轮里三张不同的图 → 团战成立', () => {
  const cfg = mkCfg({ memeWar: true, warChance: 1 });
  for (const uid of [31, 32, 33]) ingestImage({ cfg, file: mkImg(cfg), meta: mkMeta(uid) });
  const plan = planMemeAction({ cfg, chatKey: G, now: Date.now(), rand: () => 0 });
  eq(plan.memeWar, true);
});

console.log('49 图库物化（P0）');
t('file 相对 stashDir 能取到', () => {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-'));
  fs.mkdirSync(path.join(stash, 'files'), { recursive: true });
  fs.writeFileSync(path.join(stash, 'files', 'a.jpg'), 'x');
  const p = resolveStickerPath({ file: 'files/a.jpg' }, stash);
  eq(p, path.join(stash, 'files', 'a.jpg'));
});
t('只有 Windows 绝对路径（Linux 上不存在）→ null', () => {
  eq(resolveStickerPath({ local: 'C:/Users/x/stickers/a.jpg' }, '/tmp/whatever'), null);
});
t('local 相对路径也能兜住', () => {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), 'stash2-'));
  fs.mkdirSync(path.join(stash, 'rel'), { recursive: true });
  fs.writeFileSync(path.join(stash, 'rel', 'b.jpg'), 'x');
  eq(resolveStickerPath({ local: 'rel/b.jpg' }, stash), path.join(stash, 'rel', 'b.jpg'));
});

console.log('50 涩涩硬闸');
t('命中涩涩关键词 → discarded 且文件删掉', () => {
  const cfg = mkCfg();
  const r = ingestImage({ cfg, file: mkImg(cfg), meta: mkMeta(41, { trusted: true }) });
  const abs = path.join(cfg.agentCwd, 'stickers', 'collected');
  const before = fs.readdirSync(abs).length;
  eq(before, 1);
  const out = tagEmoji({ cfg, digest: r.digest, summary: '露骨的图', tags: ['涩涩', '搞笑'] });
  eq(out.state, 'discarded');
  const item = loadExpression(cfg).emojiCollection[0];
  eq(item.file, '');
  eq(fs.readdirSync(abs).length, 0, '图片应被删除');
  ok(!item.tags.includes('涩涩'));
});

console.log('51 审核池');
t('非可信来源首次只登记；第二次才进打标队列', () => {
  const cfg = mkCfg();
  const bytes = Buffer.from('review-pool');
  const r1 = ingestImage({ cfg, file: mkImg(cfg, bytes), meta: mkMeta(51) });
  eq(loadExpression(cfg).memeHub.pendingTag.length, 0, '首次不该进队列');
  eq(takeTagJobs(cfg, 1).length, 0);
  void r1;
  ingestImage({ cfg, file: mkImg(cfg, bytes), meta: mkMeta(52) });
  eq(loadExpression(cfg).memeHub.pendingTag.length, 1, '第二次该进队列');
  const jobs = takeTagJobs(cfg, 1);
  eq(jobs.length, 1);
  eq(jobs[0].kind, 'new');
});
t('可信来源（号主/trusted）首次就打标', () => {
  const cfg = mkCfg();
  ingestImage({ cfg, file: mkImg(cfg), meta: mkMeta(61, { trusted: true }) });
  eq(takeTagJobs(cfg, 1).length, 1);
});

console.log('52 legacy 补打');
t('老条目没 taggedAt → 作为 legacy 任务补打', () => {
  const cfg = mkCfg();
  const r = ingestImage({ cfg, file: mkImg(cfg), meta: mkMeta(71, { trusted: true }) });
  tagEmoji({ cfg, digest: r.digest, summary: '老描述', tags: ['日常'] });
  const st = loadExpression(cfg);
  const it = st.emojiCollection.find((e) => e.digest === r.digest);
  it.state = 'tagged';
  delete it.taggedAt;
  saveExpression(cfg, st, { force: true });
  const jobs = takeTagJobs(cfg, 1);
  eq(jobs.length, 1);
  eq(jobs[0].kind, 'legacy');
});

console.log(`\n${pass} 过 / ${fail} 挂`);
if (fail) {
  console.log('调试日志条数：', expressionDebugLogs().length);
  process.exit(1);
}
