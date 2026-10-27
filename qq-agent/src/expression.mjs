/**
 * 表现层 v1（docs/emotion-v2.md §15）。
 *
 * 只单向读 emotion.mjs 的快照与 favor 输出，绝不反写状态层。
 * 状态层回答「她此刻怎么样」，表现层回答「她怎么说出来」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './util.mjs';

export const MEMEHUB_DEFAULTS = {
  enabled: false,
  joinFormation: false,
  multiSend: false,
  memeWar: false,
  formationN: 3,
  formationChance: 0.6,
  formationCooldownMs: 300000,
  formationMaxPerHour: 2,
  multiSendChance: 0.25,
  multiSendMax: 2,
  multiSendCooldownMs: 180000,
  warWindowMs: 120000,
  warTriggerN: 3,
  warChance: 0.5,
  warMaxPerHour: 2,
  warCooldownMs: 600000,
  reviewPoolEnabled: true,
  reviewPoolMinHits: 2,
  sourceRateLimitPerHour: 10,
  collectionDigestTtlDays: 30,
  tagMin: 3,
  tagMax: 8,
  collectedSubdir: 'collected',
};

export function memeHubConfig(cfg) {
  const raw = cfg?.raw?.expression?.memeHub || {};
  return { ...MEMEHUB_DEFAULTS, ...raw };
}

export const EMOJI_TAGS = ['搞笑', '可爱', '攻击性', '敷衍', '安慰', '日常', '涩涩', '破防', '加油'];

const HARD_BLOCK_TAGS = new Set(['涩涩']);

export const EXPRESSION_DEFAULTS = {
  enabled: true,
  expressionFile: 'data/expression.json',
  speechHabitChars: 120,
  memeMax: 12,
  memeCooldownMs: 45000,
  garrulousThreshold: 3,
  garrulousCooldownMs: 90000,
  historyStyleN: 8,
  diversityThreshold: 0.6,
  collectionMax: 200,
  emojiCooldownMs: 120000,
  emojiMimicWindowMin: 5,
  topicMemoryMax: 8,
  topicMemoryTtlMinutes: 180,
  topicResurfaceEnergy: 0.60,
  maxCharsSoft: 60,
  bubbleChancePerRound: 0.08,
  memeHub: MEMEHUB_DEFAULTS,
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x) => clamp(x, 0, 1);
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const logBuf = [];
function note(level, msg) {
  logBuf.push({ level, msg });
  try { log(level, msg); } catch { /* 单测环境日志失败不影响 */ }
}
export function expressionDebugLogs() { return logBuf.slice(); }

export function expressionConfig(cfg) {
  return { ...EXPRESSION_DEFAULTS, ...(cfg?.raw?.expression || {}) };
}

function stateFile(cfg) {
  const c = expressionConfig(cfg);
  return path.resolve(cfg?.root || process.cwd(), c.expressionFile);
}

/* ---------- §15.5 expression.json ---------- */

function freshExpression(nowMs) {
  return {
    schemaVersion: 1,
    speechHabits: {
      catchphrases: [],
      sentencePatterns: [],
      punctuationPref: { end: '' },
      tailParticles: [],
      updatedAt: 0,
    },
    memeDictionary: [],
    speechState: {
      garrulous: 0,
      lastSpeakAt: 0,
      cooldownUntil: 0,
      memeCooldownUntil: 0,
      emojiCooldownUntil: 0,
      lastStyles: [],
    },
    emojiCollection: [],
    memeHub: freshHub(),
    topicMemory: [],
  };
}

function normalizeExpression(raw, nowMs) {
  const st = freshExpression(nowMs);
  if (!raw || typeof raw !== 'object') return st;
  st.schemaVersion = 1;
  st.speechHabits = {
    catchphrases: Array.isArray(raw.speechHabits?.catchphrases) ? raw.speechHabits.catchphrases : [],
    sentencePatterns: Array.isArray(raw.speechHabits?.sentencePatterns) ? raw.speechHabits.sentencePatterns : [],
    punctuationPref: raw.speechHabits?.punctuationPref && typeof raw.speechHabits.punctuationPref === 'object'
      ? raw.speechHabits.punctuationPref : { end: '' },
    tailParticles: Array.isArray(raw.speechHabits?.tailParticles) ? raw.speechHabits.tailParticles : [],
    updatedAt: num(raw.speechHabits?.updatedAt, 0),
  };
  st.memeDictionary = Array.isArray(raw.memeDictionary) ? raw.memeDictionary : [];
  const ss = raw.speechState || {};
  st.speechState = {
    garrulous: Math.max(0, num(ss.garrulous, 0)),
    lastSpeakAt: num(ss.lastSpeakAt, 0),
    cooldownUntil: num(ss.cooldownUntil, 0),
    memeCooldownUntil: num(ss.memeCooldownUntil, 0),
    emojiCooldownUntil: num(ss.emojiCooldownUntil, 0),
    lastStyles: Array.isArray(ss.lastStyles) ? ss.lastStyles : [],
  };
  st.emojiCollection = Array.isArray(raw.emojiCollection) ? raw.emojiCollection : [];
  st.memeHub = normalizeHub(raw.memeHub);
  st.topicMemory = Array.isArray(raw.topicMemory) ? raw.topicMemory : [];
  return st;
}

export function loadExpression(cfg) {
  const file = stateFile(cfg);
  const nowMs = Date.now();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.schemaVersion === 1) return normalizeExpression(raw, nowMs);
      note('warn', `[expression] schemaVersion 不认识（${raw?.schemaVersion}），重建`);
    }
  } catch (e) {
    note('warn', `[expression] 状态文件损坏，重建：${e.message}`);
  }
  return freshExpression(nowMs);
}

export function saveExpression(cfg, st, meta = {}) {
  const file = stateFile(cfg);
  let old = null;
  try {
    if (fs.existsSync(file)) old = fs.readFileSync(file, 'utf8');
  } catch { /* 读不到就按有变化处理 */ }
  const next = JSON.stringify(st, null, 2);
  if (!meta.force && old !== null && old === next) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- §15.2 三维倾向 ---------- */

export const TENDENCY = {
  happy: { intent: '分享并放大好事，主动追问细节', energy: 0.85, distance: '近' },
  encouraging: { intent: '把注意力放在他的进展上，推一把', energy: 0.75, distance: '近' },
  surprised: { intent: '先给反应，再求证，不急着下结论', energy: 0.70, distance: '中' },
  gentle: { intent: '让对方舒服，把话语权让出去', energy: 0.45, distance: '近' },
  calm: { intent: '就事论事，不加戏', energy: 0.35, distance: '中' },
  confused: { intent: '停在半句，把球踢回去', energy: 0.40, distance: '中' },
  soft: { intent: '降低存在感，先顺着', energy: 0.25, distance: '近' },
  sad: { intent: '收缩表达，不主动起话头', energy: 0.20, distance: '远' },
  sleepy: { intent: '能省则省，两个字解决', energy: 0.10, distance: '远' },
};

export function tendencyOf(emotionName) {
  const t = TENDENCY[emotionName] || TENDENCY.calm;
  return { ...t };
}

const NEGATIVE_EMOTIONS = new Set(['sad', 'soft', 'confused']);
const POSITIVE_EMOTIONS = new Set(['happy', 'encouraging', 'surprised']);

/** §15.3 好感度调制：只动倾向，不改 favor；中间地带不调制 */
export function modulateTendency(base, favor, emotionName) {
  const f = Number(favor ?? 60);
  const out = { ...base };
  if (f < 120 && NEGATIVE_EMOTIONS.has(emotionName)) {
    out.intent = '自我保护：防守、不解释、不求助';
    out.energy = 0.15;
    out.distance = '远';
  } else if (f >= 360 && NEGATIVE_EMOTIONS.has(emotionName)) {
    out.intent = '试探求助：先推一下再拉回来';
    out.energy = Math.min(0.85, Math.max(0.30, 0.40));
    out.distance = '近';
  } else if (f >= 360 && POSITIVE_EMOTIONS.has(emotionName)) {
    out.intent = '共享快乐：放大共同记忆、主动加码';
    out.energy = 0.85;
    out.distance = '近';
  }
  return out;
}

/* ---------- §15.4 防死板 ---------- */

/** 次档：网格里离当前 (v,a) 最近的一个相邻格 */
export function secondaryEmotion(v, a, mainName) {
  const rows = [0.25, 0.5, 0.75];
  const cols = [0.2, 0.45, 0.75];
  const names = [
    ['sad', 'soft', 'confused'],
    ['calm', 'gentle', 'surprised'],
    ['sleepy', 'happy', 'encouraging'],
  ];
  const vi = v < 0.35 ? 0 : v <= 0.65 ? 1 : 2;
  const ai = a < 0.30 ? 0 : a <= 0.60 ? 1 : 2;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === vi && j === ai) continue;
      const d = Math.hypot(v - rows[i], a - cols[j]);
      if (d < bestD) {
        bestD = d;
        best = names[i][j];
      }
    }
  }
  return best && best !== mainName ? best : null;
}

/** 风格指纹：只存形态，不存原文 */
export function styleFingerprint(text, emotion = '') {
  const t = String(text ?? '');
  const lenBucket = t.length <= 20 ? 's' : t.length <= 60 ? 'm' : 'l';
  const punctSet = [...new Set(t.match(/[。！？!?…~～]/g) || [])].sort().join('');
  const tailParticle = (t.match(/(呀|呢|嘛|吧|啊|哦|咯|呗)$/) || [])[1] || '';
  const emojiCount = (t.match(/[🌀-🫿☀-➿️]/gu) || []).length;
  const askBack = /[？?]|[吗嘛呢]$/.test(t) ? '1' : '0';
  return `${lenBucket}|${punctSet}|${tailParticle}|${emojiCount}|${askBack}`;
}

export function fingerprintSimilarity(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const pa = a.split('|');
  const pb = b.split('|');
  let same = 0;
  for (let i = 0; i < 5; i++) if (pa[i] === pb[i]) same += 1;
  return same / 5;
}

/** 返回最新一条指纹对更早各条的最大相似度，以及「从尾部起连续命中」的条数 */
export function checkDiversity(lastStyles, c = EXPRESSION_DEFAULTS) {
  const styles = Array.isArray(lastStyles) ? lastStyles : [];
  if (styles.length < 2) return { triggered: false, maxSim: 0, consecutive: 0 };
  const latest = styles[styles.length - 1]?.fingerprint;
  let maxSim = 0;
  for (let i = 0; i < styles.length - 1; i++) {
    maxSim = Math.max(maxSim, fingerprintSimilarity(latest, styles[i]?.fingerprint));
  }
  let consecutive = 0;
  for (let i = styles.length - 1; i >= 1; i--) {
    const cur = styles[i]?.fingerprint;
    let sim = 0;
    for (let j = 0; j < i; j++) sim = Math.max(sim, fingerprintSimilarity(cur, styles[j]?.fingerprint));
    if (sim >= c.diversityThreshold) consecutive += 1;
    else break;
  }
  return { triggered: maxSim >= c.diversityThreshold, maxSim, consecutive };
}

export function diversityEnergyDelta(lastStyles, c = EXPRESSION_DEFAULTS) {
  return checkDiversity(lastStyles, c).consecutive >= 2 ? -0.05 : 0;
}

/* ---------- §15.6 接梗四态 ---------- */

export function memeStrategyOf(emotionName, energy, angerLv = 0) {
  if (Number(angerLv) >= 2) return { strategy: '拒绝接 / 硬回', moodFactor: 0 };
  if ((emotionName === 'happy' || emotionName === 'encouraging') && energy >= 0.6) {
    return { strategy: '积极接梗 + 造梗', moodFactor: 1.0 };
  }
  if (['happy', 'encouraging', 'calm', 'gentle', 'confused'].includes(emotionName)) {
    return { strategy: '正常接 / 吐个槽', moodFactor: 0.6 };
  }
  return { strategy: '无力接 / 往自嘲引', moodFactor: 0.25 };
}

export function memeProbability(energy, moodFactor, angerLv = 0) {
  if (Number(angerLv) >= 2) return 0;
  return clamp01(0.25 + 0.55 * clamp01(energy)) * moodFactor;
}

/* ---------- §15.7 话痨抑制器 ---------- */

export function bumpGarrulous(ss, c = EXPRESSION_DEFAULTS, nowMs = Date.now(), { overlong = false } = {}) {
  ss.garrulous = Math.max(0, ss.garrulous) + 1 + (overlong ? 1 : 0);
  if (ss.garrulous >= c.garrulousThreshold && nowMs >= (ss.cooldownUntil || 0)) {
    ss.cooldownUntil = nowMs + c.garrulousCooldownMs;
  }
  return ss;
}

export function respondToSpeech(ss) {
  ss.garrulous = Math.max(0, (ss.garrulous || 0) - 1);
  return ss;
}

export function allowInitiate(ss, nowMs = Date.now()) {
  return !(Number(nowMs) < Number(ss?.cooldownUntil || 0));
}

/* ---------- §15.8 表情选用（纯函数，增量层） ---------- */

/* 老四因子公式（§15.8）按 B 方案退役：3.2 已定「直接替换、不并存」。
   保留函数名只为兼容调用方，内部一律走 scoreEmojiV2。 */
export function scoreEmojis(collection, opts = {}) {
  return scoreEmojiV2(collection, opts);
}

export function pickEmoji(collection, opts = {}) {
  const list = Array.isArray(collection) ? collection : [];
  if (!list.length) return { emoji: null, fallback: true, reason: 'empty' };
  const now = Number(opts.now ?? Date.now());
  const cooldownUntil = Number(opts.emojiCooldownUntil ?? 0);
  // 冷却门优先：冷却期内永不选中（也不去动老库）
  if (now < cooldownUntil) return { emoji: null, fallback: false, reason: 'cooldown' };
  // 冷启动兜底：全未验证时沿用现有表情库
  if (list.every((e) => !e.verified)) return { emoji: null, fallback: true, reason: 'unverified' };
  let r = scoreEmojis(list, opts);
  // 新库全在 pending/tagged 时（还没打标到 active），退回「非 discarded」全库打分，
  // 不然刚部署的头几天一个表情都选不出来
  if (r.fallback && r.reason === 'no-active') r = scoreEmojis(list, { ...opts, includeInactive: true });
  if (!r.scores.length || r.scores.every((s) => s.score === 0)) return { emoji: null, fallback: false, reason: 'cooldown' };
  return { emoji: r.scores[0].emoji, score: r.scores[0].score, fallback: false };
}

/* ---------- §15.9 话题延续 ---------- */

export function noteTopic(st, text, nowMs, c = EXPRESSION_DEFAULTS) {
  const t = String(text ?? '').trim();
  if (!t) return st;
  const list = st.topicMemory || (st.topicMemory = []);
  const existing = list.find((x) => x.text === t);
  if (existing) {
    existing.turnsSeen += 1;
    existing.at = nowMs;
    return st;
  }
  list.push({ id: `t${nowMs}-${list.length + 1}`, text: t, at: nowMs, done: false, turnsSeen: 1 });
  const ttl = c.topicMemoryTtlMinutes * 60000;
  for (let i = list.length - 1; i >= 0; i--) {
    if (nowMs - list[i].at > ttl) list.splice(i, 1);
  }
  if (list.length > c.topicMemoryMax) list.splice(0, list.length - c.topicMemoryMax);
  return st;
}

export function pickTopic(st, nowMs, energy, c = EXPRESSION_DEFAULTS) {
  if (energy < c.topicResurfaceEnergy) return null;
  const list = (st.topicMemory || []).filter((t) => !t.done && nowMs - t.at <= c.topicMemoryTtlMinutes * 60000);
  if (!list.length) return null;
  list.sort((a, b) => b.turnsSeen - a.turnsSeen);
  return list[0];
}

/* ---------- §15.10 句长软目标 ---------- */

export function lenSoftOf(energy, distance, maxCharsSoft = EXPRESSION_DEFAULTS.maxCharsSoft) {
  const df = distance === '近' ? 0.2 : distance === '中' ? 0.5 : 0.8;
  return clamp(Math.round(10 + 50 * clamp01(energy) * (1 - df)), 8, maxCharsSoft);
}

/* ---------- §15.11 渲染 ---------- */

export function renderSpeechHabits(habits, maxChars = EXPRESSION_DEFAULTS.speechHabitChars) {
  const h = habits || {};
  const parts = [
    ...(Array.isArray(h.catchphrases) ? h.catchphrases : []),
    ...(Array.isArray(h.sentencePatterns) ? h.sentencePatterns : []),
    ...(Array.isArray(h.tailParticles) ? h.tailParticles : []),
  ];
  return parts.filter(Boolean).join('、').slice(0, maxChars);
}

export function renderRecentMemes(memes, max = EXPRESSION_DEFAULTS.memeMax) {
  const list = (Array.isArray(memes) ? memes : []).slice();
  list.sort((a, b) => Number(b?.lastUsedAt || 0) - Number(a?.lastUsedAt || 0));
  const used = list.filter((m) => Number(m?.lastUsedAt || 0) > 0).slice(0, max);
  if (!used.length) return '';
  return used.map((m) => m.text).filter(Boolean).join('、');
}

export function renderExpressionBlock(info) {
  const d = info || {};
  const name = d.emotionName || 'calm';
  const secondary = d.secondaryEmotion && d.secondaryEmotion !== name ? d.secondaryEmotion : '';
  const energy = Number(d.energyLevel ?? 0.35).toFixed(2);
  const distance = d.distanceTendency || '中';
  const lines = ['【表现层状态】'];
  lines.push(`情绪：${name}${secondary ? `（次档：${secondary}）` : ''}｜语言能量：${energy}｜社交距离：${distance}`);
  const emojiPart = `表情库：${Number(d.collectionSize ?? 0)} 条（匹配：${d.matchedCategories || '无'}）`;
  const cooldownPart = Number(d.cooldownCount ?? 0) > 0 ? `｜冷却：${d.cooldownCount} 项生效中` : '';
  lines.push(`接梗姿态：${d.memeStrategy || '正常接 / 吐个槽'}｜${emojiPart}${cooldownPart}`);
  lines.push(`句长参考：${Number(d.lenSoft ?? 60)} 字以内（软目标，不是硬限制）`);
  if (d.speechHabits) lines.push(`【你的口癖】（你自己养成的，自然用，别刻意）${d.speechHabits}`);
  if (d.recentMemes) lines.push(`【最近用过的梗】${d.recentMemes}`);
  if (d.diversityHint) lines.push(`【避免雷同】${d.diversityHint}`);
  if (d.memeHint) lines.push(d.memeHint);
  lines.push('以上仅为倾向描述，不是规则——可以同时存在相反的倾向（比如又累又有点开心），按这一轮对话挑一个合适的落笔，不必逐条满足。');
  return lines.join('\n');
}

/* ---------- 管线入口：prompt 组装前算一次 ---------- */

export function updateExpression({ cfg, now = new Date(), snapshot, favor, anger, text = '', respondedTo = false, chatKey = '' }) {
  const c = expressionConfig(cfg);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const st = loadExpression(cfg);
  const ss = st.speechState;

  if (respondedTo && ss.lastSpeakAt > 0) {
    ss.garrulous = Math.max(0, ss.garrulous - 1);
  }

  const emoName = snapshot?.emotionName || snapshot?.emotion || snapshot?.name || 'calm';
  const base = tendencyOf(emoName);
  const mod = modulateTendency(base, favor, emoName);
  const secondary = secondaryEmotion(num(snapshot?.valence, 0.5), num(snapshot?.arousal, 0.35), emoName);
  const div = checkDiversity(ss.lastStyles, c);
  const energy = clamp01(mod.energy + diversityEnergyDelta(ss.lastStyles, c));
  const angerLv = Number(anger?.lv ?? 0);
  const meme = memeStrategyOf(emoName, energy, angerLv);
  // §16.4 B 方案：六因子是唯一打分器，老四因子已退役（scoreEmojis 只是薄壳）
  const hub = memeHubConfig(cfg);
  const ctxTags = contextTagsOf(text);
  const emojiRes = scoreEmojiV2(st.emojiCollection, {
    emotionName: emoName,
    secondary: secondary || '',
    now: nowMs,
    emojiCooldownUntil: ss.emojiCooldownUntil,
    tagOverlapTags: ctxTags,
    mimicWindowMs: c.emojiMimicWindowMin * 60000,
  });
  const matched = new Set();
  for (const s of emojiRes.scores.slice(0, 3)) {
    if (Number(s.score) <= 0) continue;
    for (const t of (s.emoji?.tags || [])) matched.add(t);
  }
  for (const s of emojiRes.scores) {
    for (const m of (s.emoji?.associatedMood || [])) {
      if (m === emoName || m === secondary) matched.add(m);
    }
  }
  const cooldownCount = [ss.cooldownUntil, ss.memeCooldownUntil, ss.emojiCooldownUntil]
    .filter((t) => Number(t) > nowMs).length;

  const info = {
    emotionName: emoName,
    secondaryEmotion: secondary || '',
    energyLevel: Number(energy.toFixed(2)),
    distanceTendency: mod.distance,
    memeStrategy: meme.strategy,
    memeProbability: memeProbability(energy, meme.moodFactor, angerLv),
    collectionSize: activeCountOf(st.emojiCollection) || st.emojiCollection.length,
    matchedCategories: [...matched].join('、'),
    cooldownCount,
    lenSoft: lenSoftOf(energy, mod.distance, c.maxCharsSoft),
    speechHabits: renderSpeechHabits(st.speechHabits, c.speechHabitChars),
    recentMemes: renderRecentMemes(st.memeDictionary, c.memeMax),
    diversityHint: div.triggered ? '这一轮换个说法，别重复上一轮的句式' : '',
    memeHint: hub.enabled ? renderMemeHint(planMemeAction({ cfg, chatKey, now: nowMs, emotionName: emoName, energy })) : '',
  };

  note('debug', `[expression] 相似度 max=${div.maxSim.toFixed(2)} consecutive=${div.consecutive}；garrulous=${ss.garrulous}；cooldownUntil=${ss.cooldownUntil}`);
  saveExpression(cfg, st, { now: nowMs });
  return info;
}

/* ---------- 模型输出后回写 speechState ---------- */

export function recordSpeech({ cfg, now = new Date(), text = '', emotion = '', lenSoft = 0 }) {
  const c = expressionConfig(cfg);
  const st = loadExpression(cfg);
  const ss = st.speechState;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const overlong = lenSoft > 0 && String(text).length > lenSoft * 1.5;
  bumpGarrulous(ss, c, nowMs, { overlong });
  ss.lastSpeakAt = nowMs;
  ss.lastStyles.push({ at: nowMs, emotion: emotion || '', fingerprint: styleFingerprint(text, emotion) });
  if (ss.lastStyles.length > c.historyStyleN) {
    ss.lastStyles = ss.lastStyles.slice(-c.historyStyleN);
  }
  note('debug', `[expression] 回写 garrulous=${ss.garrulous} cooldownUntil=${ss.cooldownUntil} lastSpeakAt=${ss.lastSpeakAt}`);
  saveExpression(cfg, st, { now: nowMs });
  return st;
}

/* ---------- §16 表情中枢 memeHub：入库 / 打标 / 检索 / 斗图 ---------- */

/** 群图入库后的落盘目录（相对 agentCwd） */
function agentCwdOf(cfg) {
  return cfg?.agentCwd || path.resolve(cfg?.root || process.cwd(), 'workspace');
}

function collectedDirOf(cfg, c) {
  return path.join(agentCwdOf(cfg), 'stickers', c.collectedSubdir || 'collected');
}

function freshHub() {
  return { pendingTag: [], sightings: [], counters: { formation: {}, war: {}, multiSend: {} }, lastTagAt: 0 };
}

function ensureHub(st) {
  if (!st.memeHub || typeof st.memeHub !== 'object') st.memeHub = freshHub();
  const hub = st.memeHub;
  if (!Array.isArray(hub.pendingTag)) hub.pendingTag = [];
  if (!Array.isArray(hub.sightings)) hub.sightings = [];
  if (!hub.counters || typeof hub.counters !== 'object') hub.counters = { formation: {}, war: {}, multiSend: {} };
  for (const k of ['formation', 'war', 'multiSend']) {
    if (!hub.counters[k] || typeof hub.counters[k] !== 'object') hub.counters[k] = {};
  }
  return hub;
}

function normalizeHub(raw) {
  const hub = freshHub();
  if (!raw || typeof raw !== 'object') return hub;
  hub.pendingTag = Array.isArray(raw.pendingTag) ? raw.pendingTag.filter((x) => typeof x === 'string') : [];
  hub.sightings = Array.isArray(raw.sightings)
    ? raw.sightings.filter((s) => s && typeof s.digest === 'string').map((s) => ({
      digest: s.digest,
      uid: num(s.uid, 0),
      name: String(s.name || ''),
      chatKey: String(s.chatKey || ''),
      at: num(s.at, 0),
    })) : [];
  hub.lastTagAt = num(raw.lastTagAt, 0);
  for (const k of ['formation', 'war', 'multiSend']) {
    const src = raw.counters?.[k];
    if (src && typeof src === 'object') {
      for (const [key, arr] of Object.entries(src)) {
        if (Array.isArray(arr)) hub.counters[k][key] = arr.map((t) => num(t, 0)).filter((t) => t > 0);
      }
    }
  }
  return hub;
}

export function digestOfFile(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return null; }
}

/** §16.3 标签归一：只认词表内、去重、截到 tagMax */
export function normalizeTagList(tags, c = MEMEHUB_DEFAULTS) {
  const list = Array.isArray(tags) ? tags : [];
  const out = [];
  for (const t of list) {
    const s = String(t ?? '').trim();
    if (!s || !EMOJI_TAGS.includes(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out.slice(0, Number(c.tagMax ?? 8));
}

function normalizeMoods(list) {
  const arr = Array.isArray(list) ? list : [];
  const allowed = new Set([...Object.keys(TENDENCY)]);
  const out = [];
  for (const m of arr) {
    const s = String(m ?? '').trim();
    if (allowed.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

const STOPWORDS = new Set(['的', '了', '我', '你', '他', '她', '它', '在', '是', '都', '就', '也', '和', '这', '那', '吧', '啊', '吗', '呢', '不', '有', '个', '上', '们', '好', '很']);

/** 上下文实词，用于 tagOverlap（Jaccard） */
export function contextTagsOf(text) {
  const t = String(text ?? '');
  const out = [];
  const re = /[\u4e00-\u9fa5]{2,4}|[a-zA-Z]{2,}/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const w = m[0];
    if (STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 20) break;
  }
  return out;
}

function itemAbsFile(cfg, item) {
  if (!item?.file) return null;
  return path.isAbsolute(item.file) ? item.file : path.join(agentCwdOf(cfg), item.file);
}

function pruneSightings(hub, now, keepMs) {
  const cutoff = now - keepMs;
  hub.sightings = (hub.sightings || []).filter((s) => Number(s.at) >= cutoff);
  if (hub.sightings.length > 400) hub.sightings = hub.sightings.slice(-400);
}

function enforceCollectionMax(st, c, now) {
  const list = st.emojiCollection || [];
  const ttlMs = Number(c.collectionDigestTtlDays ?? 30) * 86400000;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].state === 'discarded' && now - Number(list[i].firstSeenAt || 0) > ttlMs) list.splice(i, 1);
  }
  const max = Number(c.collectionMax ?? 200);
  while (list.length > max) {
    let worst = -1;
    let worstScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.state === 'active') continue;
      const s = Number(it.frequency || 0) - Number(it.selfUsedCount || 0) * 0.1;
      if (s < worstScore) { worstScore = s; worst = i; }
    }
    if (worst < 0) {
      let old = 0;
      for (let i = 1; i < list.length; i++) if (Number(list[i].lastUsedAt || 0) < Number(list[old].lastUsedAt || 0)) old = i;
      list.splice(old, 1);
    } else list.splice(worst, 1);
  }
}

/**
 * §16.2 入库：内容去重 + 四态机 + 审核池 + 速率限制。只做登记，不打标（不打标就不烧 token）。
 * @returns {{ok:boolean, reason:string, state?:string, digest?:string}}
 */
export function ingestImage({ cfg, file, digest = '', meta = {}, now = Date.now() }) {
  const c = memeHubConfig(cfg);
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  if (!file || !fs.existsSync(file)) return { ok: false, reason: 'nofile' };
  const d = digest || digestOfFile(file);
  if (!d) return { ok: false, reason: 'nodigest' };

  const st = loadExpression(cfg);
  const hub = ensureHub(st);
  pruneSightings(hub, now, Math.max(3600000, Number(c.warWindowMs || 120000)));

  const uid = Number(meta.uid || 0);
  const chatKey = String(meta.chatKey || '');
  const trustedSource = meta.trusted === true;
  // 2026-10-24 用户定：@ 机器人发的 / 明确让存的图，跳过「被见 N 次」门槛
  const force = meta.atMe === true || meta.wantsSave === true;

  const existing = st.emojiCollection.find((e) => e.digest === d);
  if (existing) {
    existing.frequency = Number(existing.frequency || 0) + 1;
    existing.lastSeenByPeerAt = now;
    hub.sightings.push({ digest: d, uid, name: String(meta.name || ''), chatKey, at: now });
    // 审核池：见过够多次才值得花钱打标
    if (existing.state === 'pending' && !hub.pendingTag.includes(d)
      && (force || !c.reviewPoolEnabled || Number(existing.frequency || 0) >= Number(c.reviewPoolMinHits ?? 3))) {
      hub.pendingTag.push(d);
    }
    saveExpression(cfg, st, { now });
    return { ok: true, reason: 'seen', state: existing.state, digest: d };
  }

  const hourAgo = now - 3600000;
  const recentNew = hub.sightings.filter((s) => Number(s.at) > hourAgo).length;
  if (recentNew >= Number(c.sourceRateLimitPerHour ?? 10)) {
    return { ok: false, reason: 'ratelimit', digest: d };
  }

  const dir = collectedDirOf(cfg, c);
  const ext = path.extname(file) || '.jpg';
  const dest = path.join(dir, `${d}${ext}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, dest);
  } catch (e) {
    note('warn', `[memeHub] 入库复制失败：${e.message}`);
    return { ok: false, reason: 'copyfail', digest: d };
  }

  const item = {
    digest: d,
    file: path.relative(agentCwdOf(cfg), dest).split(path.sep).join('/'),
    state: 'pending',
    summary: '',
    tags: [],
    moodHints: [],
    associatedMood: [],
    source: { uid, name: String(meta.name || ''), favor: Number(meta.favor ?? 60), trusted: trustedSource },
    firstSeenAt: now,
    lastSeenByPeerAt: now,
    frequency: 1,
    lastUsedAt: 0,
    selfUsedCount: 0,
    verified: false,
    retries: 0,
  };
  st.emojiCollection.push(item);
  hub.sightings.push({ digest: d, uid, name: String(meta.name || ''), chatKey, at: now });
  if (force || !c.reviewPoolEnabled || trustedSource) hub.pendingTag.push(d);
  enforceCollectionMax(st, c, now);
  saveExpression(cfg, st, { now });
  note('info', `[memeHub] 入库 ${d}（${trustedSource ? '可信来源，直接打标' : '进审核池'}）`);
  return { ok: true, reason: 'new', state: 'pending', digest: d };
}

/** 取待打标任务（不落盘）。每轮只给 1 个，锁住视觉成本。 */
export function takeTagJobs(cfg, limit = 1) {
  const c = memeHubConfig(cfg);
  if (!c.enabled) return [];
  const st = loadExpression(cfg);
  const hub = ensureHub(st);
  const jobs = [];
  for (const d of hub.pendingTag) {
    const it = st.emojiCollection.find((e) => e.digest === d);
    if (!it || it.state !== 'pending' || Number(it.retries || 0) >= 3) continue;
    jobs.push({ digest: d, file: itemAbsFile(cfg, it), kind: 'new', name: it.source?.name || '' });
    if (jobs.length >= limit) return jobs;
  }
  for (const it of st.emojiCollection) {
    if (it.state !== 'tagged' || it.taggedAt) continue;
    jobs.push({ digest: it.digest, file: itemAbsFile(cfg, it), kind: 'legacy', name: it.source?.name || '' });
    if (jobs.length >= limit) break;
  }
  return jobs;
}

/** 打标结果落库。failed=true 时累计重试，三次后丢弃。 */
export function tagEmoji({ cfg, digest, summary = '', tags = [], moodHints = [], failed = false, now = Date.now() }) {
  const c = memeHubConfig(cfg);
  const st = loadExpression(cfg);
  const hub = ensureHub(st);
  const item = st.emojiCollection.find((e) => e.digest === digest);
  if (!item) return { ok: false, reason: 'missing' };
  const dropPending = () => { hub.pendingTag = hub.pendingTag.filter((d) => d !== digest); };

  if (failed) {
    item.retries = Number(item.retries || 0) + 1;
    if (item.retries >= 3) { item.state = 'discarded'; dropPending(); }
    saveExpression(cfg, st, { now });
    return { ok: true, reason: 'retry', retries: item.retries, state: item.state };
  }

  const clean = normalizeTagList(tags, c);
  const blocked = clean.some((t) => HARD_BLOCK_TAGS.has(t));
  item.summary = String(summary || '').slice(0, 120);
  item.moodHints = normalizeMoods(moodHints);
  item.associatedMood = [...new Set([...(item.associatedMood || []), ...item.moodHints])];
  item.taggedAt = now;
  item.retries = 0;
  if (blocked) {
    // 2026-10-24 用户定：涩涩也要存，不再删文件，只打标记
    item.tags = clean;
    item.nsfw = true;
    item.state = 'active';
    note('info', `[memeHub] ${digest} 命中涩涩标签，仍入库（nsfw）`);
  } else {
    item.tags = clean;
    item.state = clean.length ? 'active' : 'tagged';
  }
  dropPending();
  saveExpression(cfg, st, { now });
  return { ok: true, reason: 'tagged', state: item.state, tags: item.tags };
}

export function activeCountOf(collection) {
  return (Array.isArray(collection) ? collection : []).filter((e) => !e?.state || e.state === 'active').length;
}
/* ---------- §16.4 六因子检索 ---------- */

export const EMOJI_V2_WEIGHTS = {
  moodMatch: 0.34, tagOverlap: 0.22, freshness: 0.16, mimic: 0.14, sourceFavor: 0.08, recency: 0.06,
};

export function scoreEmojiV2(collection, opts = {}) {
  const list = Array.isArray(collection) ? collection : [];
  const {
    emotionName = '',
    secondary = '',
    now = Date.now(),
    emojiCooldownUntil = 0,
    tagOverlapTags = [],
    favorOf = () => 60,
    mimicWindowMs = 5 * 60000,
    includeInactive = false,
  } = opts;
  if (!list.length) return { scores: [], fallback: true, reason: 'empty' };
  const active = includeInactive
    ? list.filter((e) => e?.state !== 'discarded')
    : list.filter((e) => !e?.state || e.state === 'active');
  if (!active.length) return { scores: [], fallback: true, reason: 'no-active' };
  const inCooldown = now < Number(emojiCooldownUntil);
  const ctxTags = new Set((Array.isArray(tagOverlapTags) ? tagOverlapTags : []).map(String));
  const W = EMOJI_V2_WEIGHTS;
  const scored = active.map((emoji, index) => {
    if (inCooldown) return { index, emoji, score: 0, parts: {} };
    const moods = Array.isArray(emoji.associatedMood) ? emoji.associatedMood
      : (Array.isArray(emoji.moodHints) ? emoji.moodHints : []);
    const moodMatch = moods.includes(emotionName) ? 1
      : (secondary && moods.includes(secondary) ? 0.5 : 0);
    const tags = Array.isArray(emoji.tags) ? emoji.tags : [];
    let inter = 0;
    for (const t of tags) if (ctxTags.has(t)) inter += 1;
    const uni = tags.length + ctxTags.size - inter;
    const hasTags = tags.length > 0 && ctxTags.size > 0;
    const tagOverlap = uni > 0 ? inter / uni : 0;
    const freshness = 1 / (1 + Number(emoji.selfUsedCount || 0));
    const seen = Number(emoji.lastSeenByPeerAt || 0);
    const mimic = seen > 0 && now - seen <= mimicWindowMs ? 1 : 0;
    const favorSrc = Number(favorOf(emoji?.source?.uid) ?? emoji?.source?.favor ?? 60);
    const sourceFavor = clamp01(favorSrc / 2400);
    const lastUsed = Number(emoji.lastUsedAt || 0);
    const recency = lastUsed > 0 ? 1 / (1 + (now - lastUsed) / 86400000) : 0.5;
    const rest = W.moodMatch * moodMatch + W.freshness * freshness + W.mimic * mimic
      + W.sourceFavor * sourceFavor + W.recency * recency;
    // 这条没标签（或当前没实词可比）时 tagOverlap 无从计算：把 0.22 的权重
    // 按比例摊给其余五因子，免得老库/未打标条目一律被压到 0.78 顶上
    const score = hasTags ? rest + W.tagOverlap * tagOverlap : rest / (1 - W.tagOverlap);
    return { index, emoji, score, parts: { moodMatch, tagOverlap: hasTags ? tagOverlap : null, freshness, mimic, sourceFavor, recency } };
  }).sort((x, y) => (y.score - x.score) || (x.index - y.index));
  return { scores: scored, fallback: false };
}
/* ---------- §16.5 斗图三行为（只出建议，不自己发） ---------- */

export function planMemeAction({ cfg, chatKey = '', now = Date.now(), emotionName = '', energy = 0.35, rand = Math.random } = {}) {
  const c = memeHubConfig(cfg);
  const plan = { lines: [], formation: null, memeWar: false, multiSend: 0 };
  if (!c.enabled || !/^group/.test(String(chatKey))) return plan;
  const st = loadExpression(cfg);
  const hub = ensureHub(st);
  const win = Number(c.warWindowMs || 120000);
  const recent = (hub.sightings || []).filter((s) => s.chatKey === chatKey && now - Number(s.at) <= win);

  const hourly = (bucket) => (hub.counters[bucket][chatKey] || []).filter((t) => now - t < 3600000);
  const slotFree = (bucket, cooldownMs, maxPerHour) => {
    const arr = hourly(bucket);
    const last = arr.length ? Math.max(...arr) : 0;
    if (last && now - last < cooldownMs) return false;
    return arr.length < maxPerHour;
  };
  const burn = (bucket) => {
    const arr = hourly(bucket);
    arr.push(now);
    hub.counters[bucket][chatKey] = arr;
  };

  if (c.joinFormation) {
    const byDigest = new Map();
    for (const s of recent) {
      const set = byDigest.get(s.digest) || new Set();
      set.add(s.uid);
      byDigest.set(s.digest, set);
    }
    for (const [d, uids] of byDigest) {
      if (uids.size < Number(c.formationN ?? 3)) continue;
      if (!slotFree('formation', Number(c.formationCooldownMs ?? 300000), Number(c.formationMaxPerHour ?? 2))) break;
      if (rand() >= Number(c.formationChance ?? 0.6)) break;
      plan.formation = { digest: d, count: uids.size };
      burn('formation');
      plan.lines.push(`【斗图】${uids.size} 个人在刷同一张图（编号取 ${d.slice(0, 6)}），队形已经成了——想跟就把同一张发出去，别配字。`);
      break;
    }
  }

  if (c.memeWar) {
    const digs = new Set(recent.map((s) => s.digest));
    if (digs.size >= Number(c.warTriggerN ?? 3)
      && slotFree('war', Number(c.warCooldownMs ?? 600000), Number(c.warMaxPerHour ?? 2))
      && rand() < Number(c.warChance ?? 0.5)) {
      plan.memeWar = true;
      burn('war');
      plan.lines.push('【斗图】群里已经打起来了（一轮里出了好几张不同的图）——挑一张最贴气氛的压回去。');
    }
  }

  if (c.multiSend && Number(energy) >= 0.6
    && slotFree('multiSend', Number(c.multiSendCooldownMs ?? 180000), 99)
    && rand() < Number(c.multiSendChance ?? 0.25)) {
    plan.multiSend = clamp(Math.round(1 + rand()), 1, Number(c.multiSendMax ?? 2));
    burn('multiSend');
    plan.lines.push(`【连发】这轮可以从表情库挑 ${plan.multiSend} 张连着发（每张单独一行 __SEND_STICKER__）。`);
  }

  if (plan.lines.length) saveExpression(cfg, st, { now });
  return plan;
}

export function renderMemeHint(plan) {
  return (plan?.lines || []).join('\n');
}

/** §16.3 解析 describeImage 的返回：优先一行 JSON，坏了退回纯文本（绝不抛） */
export function parseDescPayload(raw) {
  const text = String(raw ?? '').trim();
  const out = { text: text.slice(0, 200), tags: [], moodHints: [] };
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return out;
  try {
    const obj = JSON.parse(text.slice(a, b + 1));
    const body = obj.summary || obj.text || obj.desc || '';
    if (body) out.text = String(body).slice(0, 200);
    if (Array.isArray(obj.tags)) out.tags = obj.tags.map((t) => String(t));
    if (Array.isArray(obj.moodHints)) out.moodHints = obj.moodHints.map((m) => String(m));
  } catch { /* 不是 JSON 就按纯文本用 */ }
  return out;
}
