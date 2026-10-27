/**
 * purpose.mjs —— 目的引擎（原型，只观察不开口）
 *
 * 灵感来自 surfcore 的 src/purpose-engine.js，但重写成能直接挂在这套桥上的版本：
 *   · 只读本机已有的东西（会话历史、记忆库、情绪、日记），不额外调模型、不花钱
 *   · 每 tick 算一遍「现在最想干什么、为什么、多想要」，只写状态和日志
 *   · 一句话都不发。等日志看着像人了，再由上层决定接不接发送
 *
 * CLI:
 *   node src/purpose.mjs tick     算一次，打印结论
 *   node src/purpose.mjs status   打印当前状态（不推进时间）
 *   node src/purpose.mjs reset    清空状态
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const DATA_DIR = path.join(ROOT, 'data');
const WS_DIR = path.join(ROOT, 'workspace');
const STATE_FILE = path.join(DATA_DIR, 'purpose-state.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

export const DEFAULTS = {
  enabled: true,
  tickMs: 60000,
  gapMinMs: 2.5 * 3600e3,
  gapMaxMs: 5 * 3600e3,
  initialDelayMinMs: 30 * 60000,
  dailyMax: 4,
  // 安静时段：quietEnabled=false 就是全天；null = 没配时段，同样不静默
  quietEnabled: true,
  quietStartMin: null,
  quietEndMin: null,
  idleThresholdMs: 30 * 60000,
  materialWindowHours: 72,
  minMaterials: 2,
  maxGoals: 24,
  driveHalfLifeMs: 8 * 3600e3,
  driveBaseline: 0.4,
};

/** 九种想要，0~1。默认值偏低，靠衰减慢慢回到基线。 */
const DRIVE_KEYS = ['play', 'install', 'learn', 'connect', 'care', 'share', 'identity', 'create', 'consume'];

/** 驱动 → 中文，日志里好读。 */
const DRIVE_CN = {
  play: '想玩', install: '想装', learn: '想知道', connect: '想找人',
  care: '想关心', share: '想分享', identity: '想被看见', create: '想动手做', consume: '想看点东西',
};

/** 情绪 → 需求加成。跟 surfcore 那套一致：情绪只影响倾向，不直接变成话。 */
const EMOTION_BIAS = {
  lonely: { connect: 0.35 },
  bored: { play: 0.3, consume: 0.25 },
  curious: { learn: 0.3 },
  excited: { share: 0.35, create: 0.2 },
  proud: { identity: 0.3, share: 0.2 },
  affectionate: { care: 0.35, connect: 0.2 },
  amused: { share: 0.2, play: 0.15 },
  envious: { install: 0.25, identity: 0.15 },
  worried: { care: 0.25 },
  content: {},
  sleepy: { consume: 0.15 },
  angry: { identity: 0.2 },
};

const STOP = new Set([
  '这个', '那个', '什么', '怎么', '就是', '不是', '可以', '一下', '我们', '你们', '他们',
  '但是', '然后', '所以', '因为', '还是', '已经', '现在', '时候', '一个', '没有', '知道',
  '觉得', '感觉', '真的', '应该', '需要', '东西', '问题', '这样', '那样', '这里', '那里',
  '好像', '有点', '可能', '如果', '而且', '或者', '不过', '其实', '一起', '自己', '别人',
]);

const now = () => Date.now();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJsonl(file, limit = 400) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* 坏行跳过 */
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function pickConfig() {
  const cfg = readJson(path.join(ROOT, 'config', 'config.json'), {});
  const ownerUids = cfg?.persona?.ownerUids || [];
  const p = cfg?.purpose || {};
  return { ownerUids, cfg: { ...DEFAULTS, ...p } };
}

function defaultDrives() {
  const d = {};
  for (const k of DRIVE_KEYS) d[k] = DEFAULTS.driveBaseline;
  d.connect = 0.45;
  d.learn = 0.45;
  return d;
}

function blankState() {
  return {
    schemaVersion: 1,
    drives: defaultDrives(),
    drivesAt: now(),
    goals: [],
    observations: [],
    seenIds: [],
    lastTickAt: 0,
    nextFireAt: 0,
    todayDate: '',
    todayCount: 0,
    lastOwnerMsgAt: 0,
    lastOutputAt: 0,
    pendingOutput: [],
  };
}

export function loadState() {  const s = readJson(STATE_FILE, null);
  if (!s || s.schemaVersion !== 1) return blankState();
  s.drives = { ...defaultDrives(), ...(s.drives || {}) };
  s.goals ||= [];
  s.observations ||= [];
  s.seenIds ||= [];
  s.pendingOutput ||= [];
  return s;
}

function saveState(s) {
  writeJson(STATE_FILE, s);
}

/** 她自己要安静（__WAKE__ off）：写进 state，下一轮 tick 直接跳过派单 */
export function purposeSetMuted(untilTs) {
  const s = loadState();
  s.mutedUntil = Number(untilTs) || 0;
  saveState(s);
  return s.mutedUntil;
}

/** 需求按半衰期向基线回落——人不会一直惦记同一件事。 */
function decayDrives(state, t) {
  const dt = Math.max(0, t - (state.drivesAt || t));
  const half = DEFAULTS.driveHalfLifeMs;
  if (dt > 0) {
    const k = Math.pow(0.5, dt / half);
    for (const key of DRIVE_KEYS) {
      const base = DEFAULTS.driveBaseline;
      const cur = Number(state.drives[key] ?? base);
      state.drives[key] = clamp01(base + (cur - base) * k);
    }
  }
  state.drivesAt = t;
  return state.drives;
}

/** 多久没跟主人说上话，想找他的劲儿就往上顶，自己会累下来（封顶 0.95）。 */
function nudgeConnect(state, t) {
  const last = state.lastOwnerMsgAt || 0;
  if (!last) return;
  const hours = Math.max(0, (t - last) / 3600e3);
  const add = Math.min(0.5, hours / 12 * 0.5);
  state.drives.connect = clamp01(Math.max(state.drives.connect, 0.45 + add));
}

// ── 材料 ─────────────────────────────────────────────────────────

function collectMaterials(t, cfg) {
  const since = t - cfg.materialWindowHours * 3600e3;
  const ownerUids = new Set(cfg.ownerUids.map(String));

  const ownerMessages = [];
  const groupMessages = [];
  let lastOwnerAt = 0;

  let files = [];
  try {
    files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {
    /* 没有历史就空着 */
  }

  for (const f of files) {
    const rows = readJsonl(path.join(HISTORY_DIR, f));
    for (const r of rows) {
      const at = Number(r.t || r.at || r.time || 0);
      if (!at || at < since) continue;
      const uid = String(r.userId ?? r.user_id ?? r.uid ?? '');
      const text = String(r.text ?? r.raw ?? r.message ?? '').trim();
      if (!text) continue;
      const isOwner = ownerUids.has(uid);
      if (isOwner) {
        ownerMessages.push({ at, text, scope: f.replace('.jsonl', '') });
        if (at > lastOwnerAt) lastOwnerAt = at;
      } else if (f.startsWith('group_')) {
        groupMessages.push({ at, text, uid, scope: f.replace('.jsonl', '') });
      }
    }
  }

  const memories = readJsonl(path.join(WS_DIR, 'memory', 'memories.jsonl')).filter((m) => {
    const at = Number(m.t || 0);
    return at >= since && m.text;
  });

  const emotion = readJson(path.join(DATA_DIR, 'emotion.json'), { emotion: 'content', curiosity: 0.5 });

  return { ownerMessages, groupMessages, memories, emotion, lastOwnerAt, since };
}

function tokenize(text) {
  const clean = String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ').trim();
  const out = new Set();
  for (const chunk of clean.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[A-Za-z0-9]+$/.test(chunk)) {
      if (chunk.length >= 3) out.add(chunk.toLowerCase());
      continue;
    }
    for (let i = 0; i + 2 <= chunk.length; i += 1) {
      const bigram = chunk.slice(i, i + 2);
      if (STOP.has(bigram)) continue;
      out.add(bigram);
    }
  }
  return out;
}

/** 反复出现的词才叫话题；只出现一次的是噪音。 */
function topTopics(items, n = 8) {
  const freq = new Map();
  const first = new Map();
  for (const it of items) {
    for (const tok of tokenize(it.text)) {
      freq.set(tok, (freq.get(tok) || 0) + 1);
      if (!first.has(tok)) first.set(tok, it);
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, count]) => ({ word, count, sample: first.get(word) }));
}

// ── 打分 ─────────────────────────────────────────────────────────

/**
 * 一个目标值多少分：三轴分开算，别揉成一个。
 * confidence 我有多确信他真在意；value 值不值得开口；urgency 拖不起吗。
 */
function scoreGoal(goal, state, t) {
  const drives = state.drives;
  const drive = Number(goal.drive ? drives[goal.drive] : 0.4) || 0.4;
  const selfRel = goal.owner === 'self' ? 1 : goal.owner === 'owner' ? 0.8 : 0.45;
  const repeat = Math.min(1, (goal.sightings || 1) / 3);
  const sourceW = goal.source === 'owner' ? 0.9 : goal.source === 'self' ? 0.8 : goal.source === 'bili' ? 0.55 : 0.45;

  const confidence = clamp01(
    0.15 + 0.22 * selfRel + 0.20 * repeat + 0.10 * 0.5 + 0.10 * sourceW + 0.08 * drive,
  );
  const value = clamp01(0.3 + 0.35 * drive + 0.2 * selfRel + 0.15 * repeat);
  const urgency = clamp01(0.15 + 0.35 * (goal.owner === 'owner' ? 1 : 0) + 0.2 * (goal.unresolved ? 1 : 0) + 0.1 * (goal.explicit ? 1 : 0));

  const ageH = Math.max(0, (t - (goal.createdAt || t)) / 3600e3);
  const fresh = clamp01(1 - ageH / 72);
  const risk = goal.risk || 0;

  const total = clamp01(
    0.35 * value + 0.25 * confidence + 0.2 * urgency + 0.1 * fresh + 0.1 * repeat - 0.25 * risk
    // 已经记下的旧事没什么好惦记的；问过没答的、拖着没办的才占分量
    + (goal.kind === 'memory' ? -0.14 : goal.kind === 'question' ? 0.10 : 0)
    + (goal.unresolved ? 0.10 : 0),
  );
  return { confidence, value, urgency, risk, fresh, total };
}

const ACTIONS = ['share', 'ask', 'invite', 'confide', 'curiosity', 'follow'];
const ACTION_CN = {
  share: '说说', ask: '问问', invite: '约一下', confide: '诉个苦', curiosity: '探个究竟', follow: '接着聊',
};

function pickAction(goal, state, scored) {
  // 只是「想起了某件旧事」不构成开口的理由——惦记归惦记，没话就先别说
  if (goal.kind === 'memory') return null;
  const d = state.drives;
  if (scored.risk >= 0.55) return 'ask'; // 花钱、麻烦别人这类，只能问不能自己干
  if (goal.owner === 'owner' && scored.value > 0.6) return 'ask';
  if (d.connect > 0.7) return 'follow';
  if (d.share > 0.6 || (goal.kind === 'topic' && scored.value > 0.55)) return 'share';
  if (d.learn > 0.6) return 'curiosity';
  if (d.care > 0.6) return 'confide';
  if (d.play > 0.6) return 'invite';
  return 'share';
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 从一句话猜她在这件事上想要什么。猜不准就归到「想知道」。 */
function guessDrive(text) {
  const s = String(text);
  if (/装|插件|配置|版本|报错|代码|脚本/.test(s)) return 'install';
  if (/游戏|直播|视频|番|看|听/.test(s)) return 'play';
  if (/吃|饿|饭|睡|累|难受|哭|心疼/.test(s)) return 'care';
  if (/喜欢|抱|想他|多久没|好久/.test(s)) return 'connect';
  if (/画|写|做|搭|建/.test(s)) return 'create';
  if (/夸|厉害|本事|牛/.test(s)) return 'identity';
  return 'learn';
}

/**
 * 目标来自「已经成句的东西」，不是词频碎词：
 *   1. 记忆库里她记下的整句 —— 本来就值得惦记
 *   2. 主人问过、还没答的问句 —— 未解决，优先级最高
 *   3. 群里反复出现的话题句 —— 别人的事，权重最低
 * 词频只用来在同类里排序，不直接当目标。
 */
function buildGoals(materials, state, t, cfg) {
  const existing = new Map(state.goals.map((g) => [g.object, g]));
  const out = [];
  const seen = new Set();

  const push = (goal) => {
    if (seen.has(goal.object)) return;
    seen.add(goal.object);
    const prev = existing.get(goal.object);
    const rec = prev
      ? { ...prev, sightings: Math.max(prev.sightings || 1, goal.sightings || 1), updatedAt: t }
      : { id: goal.object, createdAt: t, updatedAt: t, attempts: 0, state: 'open', sightings: 1, ...goal };
    // 别人的事被反复提到，才升成「我自己的」
    if (rec.owner === 'member' && rec.sightings >= 3) rec.owner = 'self';
    out.push(rec);
  };

  for (const m of materials.memories) {
    const text = String(m.text || '').trim();
    if (text.length < 6 || text.length > 120) continue;
    // 记忆里混着转录痕迹（「他引用的是…」「[图：…]」），这些不是她惦记的事
    if (/^[\[［【]/.test(text) || /^(他|她|对方)(引用|说|发)/.test(text)) continue;
    const scope = String(m.scope || '');
    const fromOwner = scope.startsWith('private');
    push({
      owner: fromOwner ? 'owner' : 'self',
      object: 'mem:' + hashStr(text),
      text,
      source: fromOwner ? 'owner' : 'self',
      drive: guessDrive(text),
      kind: 'memory',
      unresolved: /[?？]|怎么|为什么|要不要|是不是/.test(text),
    });
  }

  for (const m of materials.ownerMessages) {
    const text = String(m.text || '').trim();
    if (text.length < 4) continue;
    const isQuestion = /[?？]|吗|呢|怎么|什么|能不能|要不要/.test(text);
    if (!isQuestion && text.length < 10) continue;
    push({
      owner: 'owner',
      object: 'ask:' + hashStr(text),
      text,
      source: 'owner',
      drive: isQuestion ? 'care' : guessDrive(text),
      kind: isQuestion ? 'question' : 'remark',
      unresolved: isQuestion,
      explicit: isQuestion,
    });
  }

  // 群里聊得最多的前几个话题，取出现它的那句话当目标
  for (const tp of topTopics(materials.groupMessages.map((m) => ({ text: m.text, source: 'member' })), 5)) {
    const text = String(tp.sample?.text || tp.word).trim();
    if (text.length < 4) continue;
    push({
      owner: 'member',
      object: 'grp:' + hashStr(text),
      text,
      source: 'member',
      drive: 'play',
      kind: 'topic',
      sightings: tp.count,
    });
  }

  for (const g of state.goals) {
    if (seen.has(g.object)) continue;
    out.push(g);
  }

  return out
    .sort((a, b) => (b.sightings || 1) - (a.sightings || 1) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, cfg.maxGoals);
}

// ── 择时 ─────────────────────────────────────────────────────────

function inQuietHours(t, cfg) {
  const { quietStartMin: s, quietEndMin: e } = cfg;
  if (cfg.quietEnabled === false) return false;
  // 没配（null）就是不设安静时段，全天都能想事
  if (s === null || e === null || s === undefined || e === undefined) return false;
  const d = new Date(t);
  const min = d.getHours() * 60 + d.getMinutes();
  return s > e ? (min >= s || min < e) : (min >= s && min < e);
}

/** 什么时候允许"想"这件事被端上台面。返回 null = 现在不该。 */
function gateReason(state, materials, t, cfg) {
  if (!cfg.enabled) return { ok: false, why: '引擎关着' };
  if (inQuietHours(t, cfg)) return { ok: false, why: '安静时段' };
  const idle = materials.lastOwnerAt ? t - materials.lastOwnerAt : Infinity;
  if (idle < cfg.idleThresholdMs) return { ok: false, why: '主人刚说完话，用不着主动' };
  const today = new Date(t).toISOString().slice(0, 10);
  if (state.todayDate !== today) {
    state.todayDate = today;
    state.todayCount = 0;
  }
  if (state.todayCount >= cfg.dailyMax) return { ok: false, why: `今天已经主动 ${state.todayCount} 次，够了` };
  const n = materials.ownerMessages.length + materials.memories.length + materials.groupMessages.length;
  if (n < cfg.minMaterials) return { ok: false, why: '材料太少，没什么可惦记的' };
  if (state.lastOutputAt && t - state.lastOutputAt < cfg.gapMinMs) {
    return { ok: false, why: '离上次还太近' };
  }
  return { ok: true, why: '' };
}

function nextFireAt(t, cfg) {
  const span = Math.max(1, cfg.gapMaxMs - cfg.gapMinMs);
  const gap = cfg.gapMinMs + Math.floor(Math.random() * span);
  return t + gap;
}

// ── 主循环 ───────────────────────────────────────────────────────

/**
 * 推进一 tick。
 * 返回 { changed, gate, top, drives } —— 不开任何口子，只供上层读。
 */
/**
 * 反馈闭环（2026-10-28）：上一次开口，主人接没接。
 * 接了说明这条路走得对，那个需求再涨一点；一整天没人理，说明想岔了，往下压。
 * 不做这条，驱动值永远只在"越久没说话越高"里打转，学不到东西。
 */
const FEEDBACK_WINDOW_MS = 24 * 3600_000;

export function applyFeedback(state, materials, t) {
  const list = Array.isArray(state.pendingOutput) ? state.pendingOutput : [];
  if (!list.length) return;
  const ownerMsgs = (materials.ownerMessages || []).filter((m) => Number(m.at) > 0);
  let changed = false;
  for (const item of list) {
    if (!item || !item.spokenAt || item.verdict) continue;
    // 她开口之后，主人有没有再说话（留一分钟余量，别把自己的回声算进来）
    const hit = ownerMsgs.find((m) => Number(m.at) > item.spokenAt + 60_000
      && Number(m.at) <= item.spokenAt + FEEDBACK_WINDOW_MS);
    if (hit) {
      item.verdict = 'confirmed';
      item.verdictAt = hit.at;
      if (item.drive) state.drives[item.drive] = clamp01((state.drives[item.drive] || 0) + 0.15);
      changed = true;
    } else if (t - item.spokenAt > FEEDBACK_WINDOW_MS) {
      item.verdict = 'expired';
      item.verdictAt = t;
      if (item.drive) state.drives[item.drive] = clamp01((state.drives[item.drive] || 0) - 0.08);
      changed = true;
    }
  }
  if (changed) state.pendingOutput = list.slice(-40);
}

export function tick({ force = false, log = true } = {}) {
  const { cfg: rawCfg, ownerUids } = pickConfig();
  const cfg = { ...rawCfg, ownerUids };
  const state = loadState();
  const t = now();

  // 她自己要安静（__WAKE__ off 120）：这段时间不派单，到点自动恢复
  if (!force && (Number(state.mutedUntil) || 0) > t) {
    return { skipped: 'muted', mutedUntil: state.mutedUntil };
  }

  const materials = collectMaterials(t, cfg);
  if (materials.lastOwnerAt) state.lastOwnerMsgAt = Math.max(state.lastOwnerMsgAt || 0, materials.lastOwnerAt);

  decayDrives(state, t);
  nudgeConnect(state, t);

  // 情绪影响需求倾向
  const emo = String(materials.emotion?.emotion || 'content');
  const bias = EMOTION_BIAS[emo] || {};
  for (const [k, v] of Object.entries(bias)) {
    state.drives[k] = clamp01((state.drives[k] || 0) + v * 0.25);
  }

  applyFeedback(state, materials, t);

  state.goals = buildGoals(materials, state, t, cfg);

  const scored = state.goals
    .map((g) => ({ goal: g, scored: scoreGoal(g, state, t) }))
    .sort((a, b) => b.scored.total - a.scored.total);

  const gate = gateReason(state, materials, t, cfg);
  const top = scored[0] || null;

  let fired = null;
  const due = force || (gate.ok && state.nextFireAt && t >= state.nextFireAt && top && top.scored.total >= 0.45);
  if (due && top) {
    const action = pickAction(top.goal, state, top.scored);
    if (!action) {
      gate.why = '最想的只是件旧事，没什么要开口的';
    } else {
      fired = {
        id: `${t}-${Math.random().toString(36).slice(2, 6)}`,
        at: t,
        goal: top.goal.object,
        text: top.goal.text,
        owner: top.goal.owner,
        action,
        actionCn: ACTION_CN[action] || action,
        drive: top.goal.drive,
        driveCn: DRIVE_CN[top.goal.drive] || top.goal.drive,
        ...top.scored,
      };
      state.pendingOutput.push(fired);
      state.pendingOutput = state.pendingOutput.slice(-20);
      state.lastOutputAt = t;
      state.todayCount += 1;
      state.nextFireAt = nextFireAt(t, cfg);
    }
  } else if (!state.nextFireAt) {
    state.nextFireAt = t + cfg.initialDelayMinMs;
  }

  state.lastTickAt = t;

  const result = {
    at: new Date(t).toISOString(),
    emotion: emo,
    drives: state.drives,
    gates: gate,
    fired,
    top: top ? { text: top.goal.text, owner: top.goal.owner, ...top.scored } : null,
    alternatives: scored.slice(1, 4).map((s) => ({ text: s.goal.text, owner: s.goal.owner, total: Number(s.scored.total.toFixed(3)) })),
    counts: {
      ownerMessages: materials.ownerMessages.length,
      groupMessages: materials.groupMessages.length,
      memories: materials.memories.length,
      goals: state.goals.length,
    },
    nextFireAt: new Date(state.nextFireAt).toISOString(),
  };

  // 每分钟一行会把日志灌满：结论没变就不重复打，只在「想的事变了 / 分数动了 / 闸门原因变了 / 真开口了」时记一笔
  const sig = [
    result.top ? result.top.text : '-',
    result.top ? result.top.total.toFixed(2) : '-',
    result.gates.why,
    fired ? fired.action : '-',
  ].join('|');
  const shouldLog = log && sig !== state.lastLoggedSig;
  state.lastLoggedSig = sig;
  saveState(state);
  if (shouldLog) logTick(result);
  return result;
}

const OWNER_CN = { self: '自己', owner: '主人', member: '群里' };

function short(s, n = 20) {
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function logTick(r) {
  const top = r.top
    ? `最想：${short(r.top.text, 24)}\n     （${OWNER_CN[r.top.owner] || r.top.owner}的事 · 值 ${r.top.value.toFixed(2)} / 确信 ${r.top.confidence.toFixed(2)} / 急 ${r.top.urgency.toFixed(2)} / 合计 ${r.top.total.toFixed(2)}）`
    : '最想：暂时没有';
  const other = r.alternatives.length
    ? `\n  备选：${r.alternatives.map((a) => short(a.text, 16)).join(' ｜ ')}`
    : '';
  const fired = r.fired ? `\n  ▶ 该开口了：${r.fired.actionCn}「${short(r.fired.text, 24)}」` : `\n  ▶ 先不说（${r.gates.why || '没到点'}）`;
  const drives = DRIVE_KEYS.map((k) => `${DRIVE_CN[k]} ${(r.drives[k] || 0).toFixed(2)}`).join(' ');
  console.log(`[目的 ${r.at.slice(11, 19)}] 情绪 ${r.emotion}\n  ${top}${other}${fired}\n  ${drives}`);
}

/**
 * 取出一条排队中的「该开口」，交给发送侧。
 * 取走即标 consumed，同一条不会给第二遍。
 */
export function takePending() {
  const state = loadState();
  const list = Array.isArray(state.pendingOutput) ? state.pendingOutput : [];
  const idx = list.findIndex((x) => x && !x.consumed);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], consumed: true, consumedAt: Date.now() };
  state.pendingOutput = list;
  saveState(state);
  return list[idx];
}

/** 真发出去了：记一笔时间，下次 tick 用来判断到底有没有人接 */
export function markSpoken(id) {
  const state = loadState();
  const list = Array.isArray(state.pendingOutput) ? state.pendingOutput : [];
  const item = list.find((x) => x && x.id === id);
  if (!item) return null;
  item.spokenAt = Date.now();
  // 说出口本身就吃掉一部分需求，否则同一件事会被反复端上来
  if (item.drive) state.drives[item.drive] = clamp01((state.drives[item.drive] || 0) * 0.45);
  state.pendingOutput = list;
  saveState(state);
  return item;
}

/** 给控制台用：目标 + 当前三轴评分（只读，不改状态） */
export function goalsSnapshot(limit = 80) {
  const state = loadState();
  const t = Date.now();
  const list = (state.goals || []).map((g) => ({ ...g, ...scoreGoal(g, state, t) }));
  list.sort((a, b) => (b.value * 0.6 + b.urgency * 0.4) - (a.value * 0.6 + a.urgency * 0.4));
  return list.slice(0, limit);
}

export function status() {
  const state = loadState();
  return {
    drives: state.drives,
    nextFireAt: state.nextFireAt ? new Date(state.nextFireAt).toISOString() : null,
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
    todayCount: state.todayCount,
    todayDate: state.todayDate,
    goals: state.goals.length,
    pendingOutput: state.pendingOutput.slice(-5),
  };
}

function main() {
  const cmd = process.argv[2] || 'tick';
  if (cmd === 'tick') {
    tick({ force: process.argv.includes('--force') });
  } else if (cmd === 'status') {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === 'reset') {
    saveState(blankState());
    console.log('状态已清空');
  } else {
    console.log('用法: node src/purpose.mjs [tick|status|reset] [--force]');
  }
}

if (process.argv[1] && process.argv[1].endsWith('purpose.mjs')) main();
