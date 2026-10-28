/**
 * 情绪引擎 v2（docs/emotion-v2.md §2~§5、§13、§14）。
 *
 * 只算数、只读 anger/favor 的既有输出，不 import index.mjs：
 * 这样单测不会把整个机器人拉起来。
 *
 * 与 config.mjs 的 DEFAULTS.emotion 同源（config.mjs 不 export DEFAULTS），
 * 两处改动必须同步，否则会出现「默认值看起来是 A、实际生效是 B」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripAtLabels } from './render.mjs';
import { log, stripCallBeforeHash } from './util.mjs';

export const EMOTION_DEFAULTS = {
  enabled: true,
  baseline: { valence: 0.55, arousal: 0.35 },
  decayPerMinute: 0.002,
  inertia: 0.62,
  residualHalfLifeMinutes: 20,
  maxModelDelta: 0.2,
  angerClamp: { lv2: 0.40, lv3: 0.25 },
  stateFile: 'data/emotion.json',
};

/** 代码常量：不进 config（改了会牵动单测） */
const DELTA_MAX = 0.35;        // 单轮 Δ（含余温叠加）每轴上限
const KEYWORD_CLAMP = 0.25;    // 关键词单轮每轴 clamp

/* ---------- 通用 ---------- */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x) => clamp(x, 0, 1);
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** note()：日志同时进 util.log 与内存缓冲，单测用 emotionDebugLogs() 读 */
const logBuf = [];
function note(level, msg) {
  logBuf.push({ level, msg });
  try { log(level, msg); } catch { /* 单测环境下日志失败不影响计算 */ }
}
export function emotionDebugLogs() { return logBuf.slice(); }
export function clearEmotionDebugLogs() { logBuf.length = 0; }

export function emotionConfig(cfg) {
  return { ...EMOTION_DEFAULTS, ...(cfg?.raw?.emotion || {}) };
}

function stateFile(cfg) {
  const c = emotionConfig(cfg);
  return path.resolve(cfg?.root || process.cwd(), c.stateFile);
}

/* ---------- 状态读写（tmp+rename，有变化才写） ---------- */

function freshState(nowMs) {
  return {
    schemaVersion: 1,
    valence: EMOTION_DEFAULTS.baseline.valence,
    arousal: EMOTION_DEFAULTS.baseline.arousal,
    updatedAt: new Date(nowMs).toISOString(),
    emotion: 'calm',
    residual: { valence: 0, arousal: 0 },
    pendingModelDelta: { valence: 0, arousal: 0 },
    residualAt: nowMs,
    lastDelta: null,
  };
}

function normalizeState(raw, nowMs) {
  const st = freshState(nowMs);
  st.valence = clamp01(num(raw.valence, st.valence));
  st.arousal = clamp01(num(raw.arousal, st.arousal));
  st.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : st.updatedAt;
  st.emotion = typeof raw.emotion === 'string' ? raw.emotion : st.emotion;
  st.residual = {
    valence: num(raw.residual?.valence, 0),
    arousal: num(raw.residual?.arousal, 0),
  };
  st.pendingModelDelta = {
    valence: num(raw.pendingModelDelta?.valence, 0),
    arousal: num(raw.pendingModelDelta?.arousal, 0),
  };
  st.residualAt = Number.isFinite(raw.residualAt) ? raw.residualAt : nowMs;
  st.lastDelta = raw.lastDelta && typeof raw.lastDelta === 'object' ? raw.lastDelta : null;
  return st;
}

export function loadEmotion(cfg) {
  const file = stateFile(cfg);
  const nowMs = Date.now();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.schemaVersion === 1) return normalizeState(raw, nowMs);
      note('warn', `[emotion] schemaVersion 不认识（${raw?.schemaVersion}），整份回落到基线`);
    }
  } catch (e) {
    note('warn', `[emotion] 状态文件损坏，回落到基线：${e.message}`);
  }
  return freshState(nowMs);
}

/** 惰性写盘判定只看语义字段，不看时间戳；有变化才写。 */
function semanticSignature(st) {
  return JSON.stringify({
    v: st.valence, a: st.arousal, e: st.emotion,
    rv: num(st.residual?.valence), ra: num(st.residual?.arousal),
    pv: num(st.pendingModelDelta?.valence), pa: num(st.pendingModelDelta?.arousal),
  });
}

export function saveEmotion(cfg, st, meta = {}) {
  const file = stateFile(cfg);
  const nowMs = meta.now ?? Date.now();
  let oldSig = null;
  try {
    if (fs.existsSync(file)) {
      oldSig = semanticSignature(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch { /* 读不到就按有变化处理 */ }
  const newSig = semanticSignature(st);
  if (!meta.force && oldSig !== null && oldSig === newSig) return;
  // 第 8 步：写盘时 updatedAt / residualAt 一起更新（§13 C-12）
  st.updatedAt = new Date(nowMs).toISOString();
  st.residualAt = nowMs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- 第 1 步：余温半衰期衰减 ---------- */

export function decayResidual(st, now, c = EMOTION_DEFAULTS) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const prev = Number.isFinite(st.residualAt) ? st.residualAt : nowMs;
  const minutes = Math.max(0, (nowMs - prev) / 60000);
  const k = Math.pow(0.5, minutes / c.residualHalfLifeMinutes);
  st.residual = {
    valence: num(st.residual?.valence) * k,
    arousal: num(st.residual?.arousal) * k,
  };
  st.residualAt = nowMs;
  return st;
}

/* ---------- 第 2 步：关键词增量（逐轴，各自 clamp ±0.25） ---------- */

/** 与 anger.mjs 的 JOKE_ABOUT_ANGER 同源（未 export），改动需同步 */
const JOKE_ABOUT_ANGER = /((看|瞧)(你|把你)(气|急)的?(样子|样|模样)).*|((逗|气|惹|耍)你(玩|一下))|(生气的样子(真|好)(好玩|可爱|有意思)|气死你|就爱看你炸毛)/;

const KEYWORDS = [
  { name: '强夸', re: /(最喜欢|爱你|喜欢你|最可爱|最棒|最厉害)/, dv: 0.10, da: 0.05 },
  { name: '一般夸', re: /(厉害|好棒|棒|好看|可爱|乖|牛|强|优秀|聪明|真好|不错)/, dv: 0.05, da: 0 },
  { name: '说胖', re: /(大肥鱼|肥鱼|胖|肥)/, dv: -0.12, da: 0.10 },
  { name: '辱骂', re: /(你滚|闭嘴|傻|笨|丑|垃圾|废物|你没用|你就是个程序|只是程序)/, dv: -0.18, da: 0.12 },
  { name: '拿生气开玩笑', re: JOKE_ABOUT_ANGER, dv: -0.10, da: 0.15 },
  { name: '催', re: /(快点|赶紧|还没|催)/, dv: 0, da: 0.06 },
  // 日常正向互动：招呼、亲昵、被叫到。以前只认「夸」，普通聊天一分不动，
  // 情绪就永远贴着基线（2026-10-25 用户反馈"情绪一直不太好"）。
  { name: '日常亲近', re: /(在吗|在不在|早上好|晚上好|早安|晚安|哈喽|嗨|抱抱|贴贴|摸摸|辛苦|谢谢)/, dv: 0.04, da: 0.02 },
];
const POUR_RE = /(累|烦|难过|开心|高兴|兴奋)/;
const POUR_LEN = 200;

/* 引号/代码块里的内容多半是引用或举例，不当作冲她说的（2026-10-27 用户定：
   「那些只是我在教学中语气所使用的例子，不是我想对你说的话」）。
   长材料（整份人格卡、文档、代码）同理，整条不计分。 */
const QUOTED_SRC = [
  [/```[\s\S]*?```/g, ' '],
  [/`[^`]*`/g, ' '],
  [/「[^」]*」/g, ' '],
  [/『[^』]*』/g, ' '],
  [/“[^”]*”/g, ' '],
  [/‘[^’]*’/g, ' '],
  [/"[^"\n]{1,300}"/g, ' '],
  [/'[^'\n]{1,300}'/g, ' '],
  [/《[^》]*》/g, ' '],
];
const TEACHING_RE = /(?:举例|例子|比如|示例|例如|示范|教你|这种话|这几句|台词|原文|引用|素材|范文|模板|改写|设定|语气)/;
const MATERIAL_LEN = 400;

function stripQuotedSrc(text) {
  let out = text;
  for (const [re, rep] of QUOTED_SRC) out = out.replace(re, ' ');
  return out;
}

export function scoreKeywords(text) {
  const src = String(text ?? '');
  const isMaterial = src.length > MATERIAL_LEN;
  const isTeaching = TEACHING_RE.test(src) && /[「『“‘"']/.test(src);
  const body = isMaterial || isTeaching ? '' : stripQuotedSrc(src);
  const lines = body.split(/\r?\n/).filter((l) => l.trim() !== '');
  let dv = 0;
  let da = 0;
  const hits = {};
  for (const line of lines) {
    for (const kw of KEYWORDS) {
      if (kw.re.test(line)) {
        dv += kw.dv;
        da += kw.da;
        hits[kw.name] = true;
      }
    }
    if (line.length > POUR_LEN && POUR_RE.test(line)) {
      dv += 0.06;
      da -= 0.05;
      hits['深度倾诉'] = true;
    }
  }
  dv = clamp(dv, -KEYWORD_CLAMP, KEYWORD_CLAMP);
  da = clamp(da, -KEYWORD_CLAMP, KEYWORD_CLAMP);
  return { dvalence: dv, darousal: da, hits, pouring: Boolean(hits['深度倾诉']) };
}

/* ---------- 第 3 步：合成 Δ（关键词 + __MOOD__ 先 clamp，再叠加余温后 clamp） ---------- */

export function combineDelta(st, kb, pending, c = EMOTION_DEFAULTS) {
  const pv = clamp(num(kb?.dvalence) + num(pending?.valence), -KEYWORD_CLAMP, KEYWORD_CLAMP);
  const pa = clamp(num(kb?.darousal) + num(pending?.arousal), -KEYWORD_CLAMP, KEYWORD_CLAMP);
  const dv = clamp(pv + num(st.residual?.valence), -DELTA_MAX, DELTA_MAX);
  const da = clamp(pa + num(st.residual?.arousal), -DELTA_MAX, DELTA_MAX);
  return { dv, da, target: { valence: pv, arousal: pa } };
}

/* ---------- 第 4/5 步：吸收（惯性逐轴）与记回余温 ---------- */

export function absorb(st, { dv, da }, c = EMOTION_DEFAULTS) {
  const k = 1 - c.inertia;
  st.valence = clamp01(st.valence + num(dv) * k);
  st.arousal = clamp01(st.arousal + num(da) * k);
  st.residual = { valence: num(dv) * c.inertia, arousal: num(da) * c.inertia };
  return st;
}

/* ---------- 第 6 步：朝基线线性衰减（只动 v / a） ---------- */

function stepToward(x, base, d) {
  const diff = base - x;
  if (diff === 0) return x;
  return x + Math.sign(diff) * Math.min(d, Math.abs(diff));
}

export function decayToBaseline(st, now, c = EMOTION_DEFAULTS) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const prev = new Date(st.updatedAt).getTime();
  const minutes = Number.isFinite(prev) ? Math.max(0, (nowMs - prev) / 60000) : 0;
  const d = c.decayPerMinute * minutes;
  st.valence = stepToward(st.valence, c.baseline.valence, d);
  st.arousal = stepToward(st.arousal, c.baseline.arousal, d);
  st.updatedAt = new Date(nowMs).toISOString();
  return st;
}

/* ---------- 第 7 步：怒气 / 生理 clamp（只压上限） ---------- */

export function applyContextClamp(st, { angerLv = 0, hunger = '', hour = -1, c = EMOTION_DEFAULTS } = {}) {
  const lv = Number(angerLv) || 0;
  if (lv >= 2) st.valence = Math.min(st.valence, c.angerClamp.lv2);
  if (lv >= 3) st.valence = Math.min(st.valence, c.angerClamp.lv3);
  if (hunger === '饿') st.arousal = Math.min(st.arousal, 0.55);
  if (hour >= 0 && hour < 6) st.arousal = Math.min(st.arousal, 0.25);
  return st;
}

/* ---------- 第 5 节：9 档映射 ---------- */

export const EMOTION_NOTE = {
  happy: '句子短、尾音上扬，一条最多两句；可以带一个 emoji，整段最多这一个',
  sad: '句子拖长、多用「……」和「嗯」，回复长度砍一半；不主动开话头，不追问',
  surprised: '开头先一个短感叹（「啊？」「真的假的」），再追一句细节；别一口气把结论说完',
  gentle: '语速放慢，句子里带上称呼，多用「呀」「呢」；一行只说一件事，不堆信息',
  calm: '陈述句，不加语气词，标点齐全；问什么答什么，别延伸，别反问',
  confused: '先重复对方的关键词再反问（「你是说……？」）；允许句子断在半句、允许没有句号',
  encouraging: '先点出他做的具体那件事，再推一把（「这不就成了」「接着来」）；不许空喊「加油」',
  sleepy: '句子残缺、标点消失、允许错别字；能用两个字就不用四个字，回复慢半拍',
  soft: '音量放低、句子变短，多用省略号和「嗯」「好」；先顺着，不顶嘴，不解释',
};

export const EMOTION_GRID = [
  ['sad', 'soft', 'confused'],
  ['calm', 'gentle', 'surprised'],
  ['sleepy', 'happy', 'encouraging'],
];

function gridName(v, a) {
  const vi = v < 0.35 ? 0 : v <= 0.65 ? 1 : 2;
  const ai = a < 0.30 ? 0 : a <= 0.60 ? 1 : 2;
  return EMOTION_GRID[vi][ai];
}

export function pickEmotion(st, { angerLv = 0, pouring = false, hour = -1 } = {}) {
  const v = clamp01(num(st?.valence, 0.5));
  const a = clamp01(num(st?.arousal, 0.35));
  const lv = Number(angerLv) || 0;
  // 覆盖优先级：凌晨 > 怒气 > 倾诉 > 网格（§5.2）
  if (hour >= 0 && hour < 6) return 'sleepy';
  if (lv >= 2 && (v < 0.35 || a > 0.60)) return a > 0.60 ? 'confused' : 'sad';
  if (pouring) return 'soft';
  return gridName(v, a);
}

/* ---------- __MOOD__ 解析与暂存（次轮生效，不动 v/a） ---------- */

export function parseMoodDirective(payload) {
  let v = payload;
  if (typeof payload === 'string') {
    const s = String(payload || '').trim();
    if (!s) return { error: '空的' };
    const cleaned = s
      .replace(/^```(?:json)?/i, '').replace(/```$/, '')
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .trim();
    try {
      v = JSON.parse(cleaned);
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!v || typeof v !== 'object') return { error: '不是对象' };
  const dvalence = num(v.dvalence);
  const darousal = num(v.darousal);
  if (!Number.isFinite(dvalence) || !Number.isFinite(darousal)) return { error: '数值不合法' };
  return { delta: { dvalence, darousal }, why: typeof v.why === 'string' ? v.why : '' };
}

export function applyModelDelta(st, delta, c = EMOTION_DEFAULTS) {
  const dv = clamp(num(delta?.dvalence), -c.maxModelDelta, c.maxModelDelta);
  const da = clamp(num(delta?.darousal), -c.maxModelDelta, c.maxModelDelta);
  st.pendingModelDelta = { valence: dv, arousal: da };
  return st;
}

/* ---------- 八步管线总入口 ---------- */

export function updateEmotion({ cfg, now, text, angerLv = 0, hunger = '' }) {
  const c = emotionConfig(cfg);
  if (!c.enabled) return null;
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const hour = new Date(nowMs).getHours();

  // 1. 读状态 + 余温时间衰减
  let st = loadEmotion(cfg);
  st = decayResidual(st, nowMs, c);

  // 2. 本轮即时增量：关键词 + 上一轮 __MOOD__，三层 clamp（关键词 ±0.25 → __MOOD__ maxModelDelta → 相加后 ±0.25）
  const kb = scoreKeywords(text);
  const pending = {
    valence: num(st.pendingModelDelta?.valence),
    arousal: num(st.pendingModelDelta?.arousal),
  };
  const preV = kb.dvalence + pending.valence;
  const preA = kb.darousal + pending.arousal;
  const targetV = clamp(preV, -KEYWORD_CLAMP, KEYWORD_CLAMP);
  const targetA = clamp(preA, -KEYWORD_CLAMP, KEYWORD_CLAMP);
  note('debug', `[emotion] Δtarget(pre-clamp) v=${preV.toFixed(4)} a=${preA.toFixed(4)}`);
  note('debug', `[emotion] Δtarget(post-clamp) v=${targetV.toFixed(4)} a=${targetA.toFixed(4)}`);

  // 3. 合成并逐轴夹紧（Δv 只进 v，Δa 只进 a）
  const delta = combineDelta(st, { dvalence: targetV, darousal: targetA }, { valence: 0, arousal: 0 }, c);

  // 4/5. 吸收 + 记回余温
  const vOld = st.valence;
  const aOld = st.arousal;
  st = absorb(st, delta, c);
  note('debug', `[emotion] v ${vOld.toFixed(4)} → ${st.valence.toFixed(4)}；a ${aOld.toFixed(4)} → ${st.arousal.toFixed(4)}；residual v=${st.residual.valence.toFixed(4)} a=${st.residual.arousal.toFixed(4)}`);

  // 6. 朝基线衰减（只动 v / a）
  st = decayToBaseline(st, nowMs, c);

  // 7. 怒气 / 生理 clamp
  st = applyContextClamp(st, { angerLv, hunger, hour, c });

  // 本轮已吸收掉上一轮的 __MOOD__，清零；lastDelta 只进日志
  st.pendingModelDelta = { valence: 0, arousal: 0 };
  st.lastDelta = { dvalence: delta.dv, darousal: delta.da, why: '', at: new Date(nowMs).toISOString() };
  st.emotion = pickEmotion(st, { angerLv, pouring: kb.pouring, hour });

  // 8. 惰性写盘
  saveEmotion(cfg, st, { now: nowMs });

  return { name: st.emotion, valence: st.valence, arousal: st.arousal, residual: { ...st.residual } };
}

/* ---------- 注入块（expression.enabled=false 时退回 §6.2 直接注入） ---------- */

const HUNGER_NOTES = {
  饿: '话可以少点、提不起劲，但别不耐烦、别凶人；用语气带出一点懒，别挂「饿了」这种尾巴，也别拿饭挡正事',
  饱: '难得话多，愿意聊天，可主动起话头',
  正常: '',
};

export function renderAngerLine(anger) {
  if (!anger) return '';
  const lv = Number(anger.lv ?? 0);
  const name = anger.name || `Lv${lv}`;
  const suffix = /^Lv\d+/.test(name) ? '' : `（Lv${lv}）`;
  if (!suffix) note('debug', `[emotion] angerName 已带 Lv 前缀，抑制重复（Lv${lv}）`);
  return `【怒气档位】${name}${suffix}——${anger.text || ''}`;
}

export function renderEmotionBlock(s) {
  const emo = s?.emotion || { name: 'calm', valence: 0.5, arousal: 0.35 };
  const hunger = s?.hunger || '正常';
  const hungerNote = HUNGER_NOTES[hunger] ?? '';
  const date = s?.date || '';
  const time = s?.time || '';
  const lines = [
    `【当前状态】${date ? `${date} ` : ''}${time}｜饱腹：${hunger}｜情绪：${emo.name}（valence ${Number(emo.valence).toFixed(2)} / arousal ${Number(emo.arousal).toFixed(2)}）｜场景：${s?.groupName || '私聊'}`,
    hungerNote
      ? `【她这会儿的劲头】${EMOTION_NOTE[emo.name] || ''}；${hungerNote}`
      : `【她这会儿的劲头】${EMOTION_NOTE[emo.name] || ''}`,
  ];
  const angerLine = renderAngerLine(s?.anger);
  if (angerLine) lines.push(angerLine);
  return lines.join('\n');
}

/* ---------- #心情 ---------- */

export function parseMoodCommand(text) {
  // 群里「溟月 #心情」这种，先把行首那声称呼剥掉再认指令（2026-10-28）
 const t = stripCallBeforeHash(String(text ?? ''), ['溟月']);
  if (!t.includes('@你') && /@(?:号主|群友|全体成员)/.test(t)) return false;
  return /^[#＃]\s*心情$/.test(stripAtLabels(t));
}

export function renderMoodCard(st, { anger, favor } = {}) {
  if (!st) return '情绪引擎已关闭，现在的状态看 #好感度';
  const name = st.emotion || pickEmotion(st, {});
  const lines = [
    `情绪：${name}（valence ${Number(st.valence).toFixed(2)} / arousal ${Number(st.arousal).toFixed(2)}）`,
  ];
  if (anger && (anger.lv != null || anger.name)) {
    lines.push(`怒气档位：${anger.name || `Lv${anger.lv}`}`);
  }
  if (favor != null) lines.push(`当前好感：${Number(favor)}/2400`);
  return lines.join('\n');
}

/* ---------- §14.2 只读契约 ---------- */

export function readEmotionSnapshot(cfg) {
  const c = emotionConfig(cfg);
  if (!c.enabled) {
    return {
      valence: c.baseline.valence,
      arousal: c.baseline.arousal,
      emotionName: 'calm',
      residual: { valence: 0, arousal: 0 },
      updatedAt: null,
      residualAt: null,
      enabled: false,
    };
  }
  const st = loadEmotion(cfg);
  return {
    valence: st.valence,
    arousal: st.arousal,
    emotionName: st.emotion || pickEmotion(st, {}),
    residual: { ...(st.residual || { valence: 0, arousal: 0 }) },
    updatedAt: st.updatedAt,
    residualAt: st.residualAt,
    enabled: true,
  };
}

/* ---------- §14.4 三个回路的阈值判定（纯函数，单测用） ---------- */

export function saturationRate(values) {
  const arr = Array.isArray(values) ? values.slice(0, 20) : [];
  if (!arr.length) return 0;
  const hits = arr.filter((v) => Math.abs(num(v, 0.5) - 0.5) >= 0.28).length;
  return hits / arr.length;
}

export function isSaturated(values) {
  return saturationRate(values) >= 0.6;
}

export function passThrough(vOld, vNew, dv) {
  if (Math.abs(num(dv)) < 1e-12) return 0;
  return Math.abs(num(vNew) - num(vOld)) / Math.abs(num(dv));
}

export const MISMATCH_SET = new Set(['happy', 'encouraging', 'surprised']);

export function isMismatch(angerLv, emotionName) {
  return Number(angerLv) >= 2 && MISMATCH_SET.has(emotionName);
}
