/**
 * 戳一戳（2026-10-28 用户 m03434「可以戳别人，也可以感应别人的戳一戳」，m03600「按你的方案执行」）。
 *
 * 两件事：
 *   ① 感应：NapCat 发来 notice / notify / sub_type=poke / target_id=自己 时，
 *      按关系档位决定要不要有反应，连着戳太多次就烦了。
 *   ② 主动：模型输出一行 `__POKE__`（可选 `__POKE__ @某人`）→ 桥真发一次 send_poke。
 *
 * 这一层只管策略与记账，不认识 session、不认识 prompt：
 *   index.mjs 负责收事件、改 session、拼提示词。
 *
 * 状态文件：<dataDir>/poke-state.json
 *   { "chats": { "private:123": { "in": { "<uid>": {lastReplyAt,count,dayKey} },
 *                                  "out": { "lastAt": 0 } } } }
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_POKE_CONFIG = {
  enabled: true,
  // 同一个人：多久之内最多理他一次（毫秒）
  replyCooldownMs: 10 * 60_000,
  // 一分钟内连着戳几次就算「戳坏了」，之后这一轮不再理
  annoyWithinMs: 60_000,
  annoyCount: 3,
  // 主动戳：同会话每分钟最多一次
  outCooldownMs: 60_000,
  // 各档位「被戳了理不理」的概率（第 1 档 … 第 8 档）
  // 档位足够高就不用掷骰了，直接理；档位低就基本装没看见。
  replyChanceByStage: [0, 0, 0.1, 0.25, 0.5, 0.7, 0.95, 1, 1],
};

export function pokeConfig(cfg) {
  return { ...DEFAULT_POKE_CONFIG, ...(cfg?.raw?.poke || {}) };
}

function stateFile(dataDir) {
  return path.join(dataDir, 'poke-state.json');
}

export function loadPokeState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8')) || { chats: {} };
  } catch {
    return { chats: {} };
  }
}

export function savePokeState(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile(dataDir), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 记不上不影响主流程 */ }
}

export function dayKeyOf(nowMs = Date.now()) {
  // 北京时间当天，格式 2026-10-28
  const d = new Date(nowMs + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

function chatBucket(state, chatKey) {
  state.chats = state.chats || {};
  const b = (state.chats[chatKey] = state.chats[chatKey] || { in: {}, out: { lastAt: 0 } });
  b.in = b.in || {};
  b.out = b.out || { lastAt: 0 };
  return b;
}

/**
 * 收到一次戳，决定这一轮理不理。
 * 返回 { react, reason, count, pokedBack?, switched }
 *   react=false 时 reason 说明为什么装作没看见，日志用。
 */
export function onPoked(dataDir, { chatKey, uid, stage = 3, nowMs = Date.now(), rand = Math.random, cfg = null }) {
  const conf = pokeConfig(cfg);
  const state = loadPokeState(dataDir);
  const b = chatBucket(state, chatKey);
  const today = dayKeyOf(nowMs);
  const rec = (b.in[uid] = b.in[uid] || { lastReplyAt: 0, count: 0, dayKey: today });
  if (rec.dayKey !== today) { rec.dayKey = today; rec.count = 0; rec.total = rec.total || 0; }
  rec.count += 1;
  rec.total = (rec.total || 0) + 1;
  rec.lastAt = nowMs;
  // 一分钟窗口：超出窗口就重开，计数从零算
  if (!rec.burstStart || nowMs - rec.burstStart > conf.annoyWithinMs) {
    rec.burstStart = nowMs;
    rec.burstCount = 0;
  }
  rec.burstCount += 1;

  // 一分钟内戳太多次：这轮不理（不然她能一直陪着玩）
  if (rec.burstCount >= conf.annoyCount) {
    savePokeState(dataDir, state);
    return { react: false, reason: `一分钟内戳了 ${rec.burstCount} 次，装没看见`, count: rec.count };
  }
  if (nowMs - (rec.lastReplyAt || 0) < conf.replyCooldownMs) {
    savePokeState(dataDir, state);
    return { react: false, reason: '还在戳一戳冷却里', count: rec.count };
  }

  const idx = Math.max(0, Math.min(8, Number(stage) || 1));
  const chance = conf.replyChanceByStage[idx] ?? 0;
  const hit = rand() < chance;
  if (hit) rec.lastReplyAt = nowMs;   // 理了就记上，别指望调用方一定来 mark 一次
  savePokeState(dataDir, state);
  if (!hit) return { react: false, reason: `第 ${idx} 档，这轮先不理`, count: rec.count };
  return { react: true, count: rec.count, total: rec.total };
}

/** 记一笔「已经理过这次戳」，避免冷却期内反复回应 */
export function markPokeReplied(dataDir, { chatKey, uid, nowMs = Date.now() }) {
  const state = loadPokeState(dataDir);
  const b = chatBucket(state, chatKey);
  const rec = (b.in[uid] = b.in[uid] || { lastReplyAt: 0, count: 0, dayKey: dayKeyOf(nowMs) });
  rec.lastReplyAt = nowMs;
  rec.burstStart = 0;
  savePokeState(dataDir, state);
}

/** 主动戳之前问一句：这个会话现在能戳吗 */
export function canPokeOut(dataDir, { chatKey, nowMs = Date.now(), cfg = null }) {
  const conf = pokeConfig(cfg);
  const state = loadPokeState(dataDir);
  const b = chatBucket(state, chatKey);
  const last = Number(b.out?.lastAt) || 0;
  if (nowMs - last < conf.outCooldownMs) {
    return { ok: false, leftMs: conf.outCooldownMs - (nowMs - last) };
  }
  return { ok: true, leftMs: 0 };
}

export function markPokedOut(dataDir, { chatKey, nowMs = Date.now() }) {
  const state = loadPokeState(dataDir);
  const b = chatBucket(state, chatKey);
  b.out.lastAt = nowMs;
  savePokeState(dataDir, state);
}

/**
 * 从回复里抽出 __POKE__ 那一行：想戳谁就戳谁。
 *   __POKE__               → 戳当前说话的人（target = 0）
 *   __POKE__ @某人          → 按名字去 speakers 里找 QQ 号
 *   __POKE__ @123456789    → 直接写号也行
 * 认不出名字就退回当前说话的人。没写这一行返回 null。
 * （2026-10-28 从 index.mjs 挪到这里，好单独测）
 */
export function extractPokeDirective(text, speakers = []) {
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  let target = null;
  for (const line of lines) {
    const m = line.trim().match(/^_{0,2}POKE_{0,2}\s*[:：]?\s*(.*)$/i);
    if (!m) { kept.push(line); continue; }
    const arg = m[1].trim().replace(/^[@＠]/, '').trim();
    if (!arg) { target = 0; continue; }
    if (/^\d{5,}$/.test(arg)) { target = Number(arg); continue; }
    const hit = speakers.find((s) => s && s.name && String(s.name).includes(arg));
    target = hit ? Number(hit.uid) : 0;
  }
  if (target === null) return null;
  return { target, rest: kept.join('\n').trim() };
}

/** 给模型看的提示：这轮是被戳进来的，该怎么反应 */
export function renderPokeHint({ name, count, stage }) {
  const times = count > 1 ? `（今天第 ${count} 次）` : '';
  const how = stage >= 7
    ? '关系这么近了，戳回去或者黏一句都行，别客气。'
    : stage >= 5
      ? '回一句短的就好，可以顺口问他戳你干什么。'
      : '关系还没到那份上，甩半句就行，别热情。';
  return `【他戳了你一下】${name} 戳了你一戳${times}。${how}`
    + ' 想戳回去就单独输出一行 __POKE__（想戳别人写 __POKE__ @他，别写 QQ 号）；这一行不会显示成文字。';
}
