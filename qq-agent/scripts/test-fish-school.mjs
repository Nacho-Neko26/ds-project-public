/**
 * 鱼群识别单测（2026-10-28）。
 *
 * 用户要求：「添加鱼群识别功能，当前三十条消息没有真人时自动安静潜水直到触发必须发言规则」
 *
 * 跑法：node scripts/test-fish-school.mjs
 * 纯函数，不碰网络也不碰真记录，Windows 上直接能跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countHumanSpeech, pickGroupMessage } from '../src/agent.mjs';
import { HistoryStore } from '../src/context.mjs';

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  fail += 1;
  fails.push(`${name}${extra ? ' → ' + extra : ''}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---------- countHumanSpeech：谁算「真人说话」 ---------- */
const row = (text, extra = {}) => ({ t: Date.now(), role: 'user', uid: '10086', name: '群友', text, ...extra });
const me = (text) => ({ t: Date.now(), role: 'bot', name: '溧月', text });
const pic = (text) => row(text, { text });

eq('空记录 → 0', countHumanSpeech([]), 0);
eq('她自己在说话，不算有人', countHumanSpeech([me('我在呢'), me('嗯嗯'), me('好的')]), 0);
eq('纯图片占位不算', countHumanSpeech([pic('[图片]'), pic('[表情]'), pic('[文件]')]), 0);
eq('纯标点不算', countHumanSpeech([pic('。'), pic('？'), pic('…'), pic('！！！')]), 0);
eq('单字附和不算', countHumanSpeech([pic('嗯'), pic('哈'), pic('行')]), 0);
eq('正常一句 → 1', countHumanSpeech([row('今天气好热啊')]), 1);
eq('图配文字算（有话说）', countHumanSpeech([row('[图片]这猫真丑')]), 1);
eq('表情后面跟一句也算', countHumanSpeech([row('[表情]笑死我了')]), 1);
eq('混合：3 条真人 + 2 条她 + 图片', countHumanSpeech([
  row('晚上的局算我一个'), me('我也想去'), row('[图片]'), row('在哪儿吃'), me('人都齐了没'),
]), 2);
eq('全是空壳 → 0', countHumanSpeech([
  me('在吗'), pic('[语音转写：]'), pic('  '), pic('[动画表情]'),
]), 0);

/* ---------- pickGroupMessage：quiet 分支的位置 ---------- */
// 掷骰用固定值，避开随机：必中 = [1,1]，必不中 = [0,0]
const cfgHit = { raw: { reply: { groupChance: { default: [1, 1] }, wakeWindowMinutes: 5 } } };
const cfgMiss = { raw: { reply: { groupChance: { default: [0, 0] }, wakeWindowMinutes: 5 } } };
const quietCfg = (extra = {}) => ({ raw: { reply: { groupChance: { default: [1, 1] }, wakeWindowMinutes: 5, ...extra } } });

{
  const r = pickGroupMessage({ cfg: cfgHit, chatKey: 'group:1', recentHuman: 0 });
  ok('没真人：不掷骰，直接潜水', !r.accept && r.reason === 'quiet', `得到 ${r.reason}`);
}
{
  const r = pickGroupMessage({ cfg: cfgMiss, chatKey: 'group:1', recentHuman: 0 });
  ok('没真人时骰子再好也不说话', !r.accept && r.reason === 'quiet');
}
{
  const r = pickGroupMessage({ cfg: cfgHit, chatKey: 'group:1', recentHuman: 2 });
  ok('有真人：照老规矩掷骰', r.accept && r.reason === 'roll');
}
{
  const r = pickGroupMessage({ cfg: cfgMiss, chatKey: 'group:1', recentHuman: 5 });
  ok('有真人但骰子没中：照旧静默', !r.accept && r.reason === '');
}
{
  const r = pickGroupMessage({ cfg: cfgHit, chatKey: 'group:1', calledNow: true, recentHuman: 0 });
  ok('被 @ / 被叫名字：必须发言规则压过潜水', r.accept && r.reason === 'called');
}
{
  const now = Date.now();
  const r = pickGroupMessage({ cfg: cfgHit, chatKey: 'group:1', wakeUntil: now + 60_000, recentHuman: 0, now });
  ok('刚被叫过的窗口内：照常喂', r.accept && r.reason === 'wake');
}
{
  const r = pickGroupMessage({ cfg: quietCfg({ quietWhenNoHuman: false }), chatKey: 'group:1', recentHuman: 0 });
  ok('开关关掉：没真人也掷骰', r.accept && r.reason === 'roll');
}
{
  const r = pickGroupMessage({ cfg: cfgHit, chatKey: 'group:1', recentHuman: null });
  ok('recentHuman=null（没算出来）：fail-open 走骰子', r.accept && r.reason === 'roll');
}
{
  const r = pickGroupMessage({ cfg: cfgHit, chatKey: 'group:1', mode: 'mention', recentHuman: 0 });
  ok('mention 模式的群：仍然只认被叫（不潜水不掷骰）', !r.accept && r.reason === '');
}
{
  const r = pickGroupMessage({ cfg: cfgHit, chatKey: 'group:1' });
  ok('不传 recentHuman（老调用路径）：行为不变', r.accept && r.reason === 'roll');
}

/* ---------- HistoryStore.recentRows：能从文件里捞 30 条 ---------- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fishschool-'));
  try {
    const h = new HistoryStore(dir, { maxMessages: 5 });
    const key = 'group:999';
    for (let i = 0; i < 40; i++) h.append(key, row(`第 ${i} 条`));
    const rows = h.recentRows(key, 30);
    eq('recentRows 拿到 30 条（不受内存窗口 5 限制）', rows.length, 30);
    eq('recentRows 取的是最新的', rows[rows.length - 1].text, '第 39 条');
    eq('内存窗口仍然只有 5 条', h.load(key).length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`[fish-school] pass=${pass} fail=${fail}`);
if (fail) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('[fish-school] 全部通过');
}
