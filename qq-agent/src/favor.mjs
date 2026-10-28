/**
 * 好感度系统 v2 —— 双轴（2026-10-27 用户拍板）+ 记事本
 *
 * 一句话规则：
 *   好感 affection（0~2400，**只增不减**）管「累计处了多少」；
 *   信任 trust（0~100，可涨可跌）管「这段关系的资格在不在」。
 *   八档（名字按用户 m01043 定的）：
 *     看见就不爽 / 陌生人 / 眼熟的一般人 / 会交谈的熟人 /
 *     普通朋友 / 关系很好的朋友 / 朋友之上恋人未满 / 恋人爱人。
 *   升档要分数和信任都够；掉信任不会掉档，只是升不上去。
 *
 * 旧百分制的换算（用户 m00831 更正后的口径：原 90 分 = 第五档「普通朋友」）：
 *   每个旧门槛正好压在一档起点上，所以「谁能干什么」一寸没动。
 *     旧 20 → 12      旧 35 → 25（信任门槛，语音）
 *     旧 50 → 60      旧 70 → 180     旧 80 → 360
 *     旧 90 → 660     旧 100 → 1080
 *   不扣分、没人归零，第 7、8 档留给以后成长。
 *
 * 防刷（从 Aibond 移植，用户要求保留）：
 *   · 软区：日额度 120 以内全额，120~150 按 25% 折算，150 硬顶。
 *   · 周上限 500：一周（自然周）最多挣 500，防周末突击。
 *   · 半速：信任不到该档门槛一半的人，涨速打五折。
 *
 * 技能门槛（和旧体系一一对应，只是换成档位语言）：
 *   语音 ≥ 50（第一档）· 表情 ≥ 60（第二档）· 指令 ≥ 180（第三档）
 *   点歌 ≥ 360（第四档）· 点唱 ≥ 660（第五档）
 *
 * 兼容：外部代码（index.mjs 等）继续读写 `person.favor`——
 * 它就是新的好感值，字段名没变，量程从 0~100 变成 0~2400。
 */
import fs from 'node:fs';
import path from 'node:path';
import { selfRef } from './character.mjs';
import { readSharedFavors, favorIsShared } from './anger.mjs';
import { readSharedAbout, writeSharedAbout } from './identity.mjs';

/* ---------- 关系锁（#锁定关系，2026-10-27 m02704） ---------- */

// 进程级开关：index.mjs 每轮开头按 data/owner-state.json 同步一次。
// 锁住时好感和信任都冻住——加不加、扣不扣，一条都不动。
let RELATION_LOCKED = false;

export function setRelationLocked(v) {
  RELATION_LOCKED = !!v;
}

export function isRelationLocked() {
  return RELATION_LOCKED;
}

/* ---------- 常量 ---------- */

export const FAVOR = {
  // 门槛（正好对齐八档：旧 20/35/50/70/80/90/100 换算而来）
  init: 60,        // 新人起点 = 第二档起点（旧 50）
  hate: 12,        // 低于这个数看到这人就别扭（旧 20）
  half: 60,        // 半速线
  voice: 50,       // 能发语音（旧 35）
  friend: 180,     // 旧 70 → 第三档：熟人，肯认真帮忙
  obey: 360,       // 旧 80 → 第四档：朋友，指令/点歌/记事本
  sing: 660,       // 旧 90 → 第五档：交情，可以点她唱
  max: 2400,

  // 每次加多少
  praiseGain: 5,          // 被夸一次
  dailyChatGain: 25,      // 每天 04:00 日结（前一天标记是 +）
  hourlyChatGain: 6,      // 每聊一小时
  hourlyDailyCap: 30,     // 小时结算一天最多 30

  // 日/周节奏
  dailyGainCap: 120,      // 软区起点
  dailyHardCap: 150,      // 软区折算后的硬顶
  weekGainCap: 500,       // 一周最多（用户定）
  softRate: 0.25,         // 超出软区部分按 25% 折算
  slowFactor: 0.5,        // 半速

  // 信任轴
  trustMax: 100,
  trustDailyCap: 10,
  trustWeekCap: 40,
  persuadeTrustGain: 4,   // 劝和：恢复的是资格
  perHelperDailyCap: 1,
  persuadeTotalCap: 2,    // 一人一天最多被劝 2 次
  boundaryTrustLoss: 15,  // 越界（骂去死/傻逼）
  angerTrustGroup: 10,    // 生气：群里
  angerTrustPrivate: 6,   // 生气：私聊
  angerPersuadeTimes: 2,
  trustRestoreRate: 0.6,  // 消气时恢复已扣信任的比例

  // 旧字段保留（外部还在读，别删）
  offendLoss: 0,
  boundaryLoss: 15,   // 越界骂人：applyFavor 收到负数会转成扣信任，这里就是信任的扣量
  dailyLossCap: 0,
  slowGainCap: 60,
  persuadeGain: 4,

  memoryChars: 1000,
  notebookChars: 200,
};

/** 八档：门槛 / 需要的信任 / 名字 / 感觉 */
export const STAGES = [
  { idx: 1, min: 0,    trust: 0,  gain: 1,   key: 'stranger',    name: '看见就不爽',       text: '看你就不顺眼，爱答不理',
    perms: ['不想理你', '想怼就怼'] },
  { idx: 2, min: 60,   trust: 12, gain: 1,   key: 'known',       name: '陌生人',           text: '客气但生分',
    perms: ['客气回你两句'] },
  { idx: 3, min: 180,  trust: 25, gain: 1,   key: 'acquaintance',name: '眼熟的一般人',     text: '认得出是谁，能配合两句',
    perms: ['能接你的话', '能给你发表情'] },
  { idx: 4, min: 360,  trust: 40, gain: 1,   key: 'friend',      name: '会交谈的熟人',     text: '能正常聊天、能发语音',
    perms: ['正常聊天', '能给你发语音'] },
  { idx: 5, min: 660,  trust: 55, gain: 1,   key: 'closeness',   name: '普通朋友',         text: '会主动找他、能点歌',
    perms: ['我主动找你说话', '能点我唱歌'] },
  { idx: 6, min: 1080, trust: 68, gain: 0.9, key: 'important',   name: '关系很好的朋友',   text: '听他的话，记事本、能点唱',
    perms: ['听你指令干活', '给你记记事本', '给你点唱'] },
  { idx: 7, min: 1680, trust: 82, gain: 0.8, key: 'confidant',   name: '朋友之上恋人未满', text: '会吃醋、会撒娇，亲近不设防',
    perms: ['公共场合轻轻抱一下、趁人不注意亲一下', '在家靠着你、一起吃饭互相喂',
            '你病了我照顾你', '只有我们俩懂的暗语、我给你起个外号',
            '偷偷给你准备小礼物', '贴贴：做饭时从背后抱住你、看电视把腿搭你身上、走路十指紧扣',
            '你忙的时候凑过去亲你脸打岔、用头发蹭你脖子'] },
  { idx: 8, min: 2400, trust: 92, gain: 0.7, key: 'bond',        name: '恋人爱人',         text: '彻底是自己人，没有瞒他的事',
    perms: ['孩子式撒娇：叠字说话、装哭要你关注、赖你身上不肯起来',
            '叫你专属的昵称（宝贝、老公、小胖猪这种）', '学你说话学你走路、突然用偶像剧腔跟你表白'] },
];
// gain：这一档的人拿好感的系数。第五档以前 1.0，往上每档 ×0.9，
// 也就是「到第五档以后，往上的获取难度低增」——用户 m01078 原话。

/** 旧接口 key → 新档位（tierOf 兼容用） */
const LEGACY_TIER = {
  hated: 'stranger',
  normal: 'known',
  friend: 'acquaintance',
  obey: 'friend',
  sing: 'closeness',
};

/* ---------- 状态初始化与旧档升级 ---------- */

const OLD_A = [[0, 0], [20, 12], [35, 25], [50, 60], [70, 180], [80, 360], [90, 660], [100, 1080]];
const OLD_T = [[0, 0], [20, 12], [35, 25], [50, 40], [70, 55], [80, 68], [90, 82], [100, 92]];

function interp(anchors, x) {
  const maxX = anchors[anchors.length - 1][0];
  x = Math.max(0, Math.min(maxX, Number(x) || 0));
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
  }
  return anchors[anchors.length - 1][1];
}

/** 旧百分值 → 新双轴（迁移脚本没跑到的老档案就地升级） */
export function upgradeLegacy(favor, penalty = 0) {
  const real = Math.min(100, (Number(favor) || 0) + (Number(penalty) || 0));
  return { favor: Math.round(interp(OLD_A, real)), trust: Math.round(interp(OLD_T, real) * 10) / 10 };
}

const INTIMACY_TO_FAVOR = { 0: 30, 1: 40, 2: 50, 3: 62, 4: 72, 5: 80 };

/** 确保 person 上有双轴字段，返回当前好感 */
export function ensureFavor(p) {
  if (!p) return 0;
  // 1) 连 favor 都没有：老档案的 intimacy，或干脆新人
  if (typeof p.favor !== 'number' || Number.isNaN(p.favor)) {
    const old = Number(p.intimacy);
    p.favor = Number.isFinite(old) && INTIMACY_TO_FAVOR[old] != null
      ? INTIMACY_TO_FAVOR[old]
      : FAVOR.init;
    p._schema = 2;
  }
  // 2) 还是旧的百分制（<=100 且没升过）：就地换算，别让人凭空掉分
  if (p._schema !== 2 && p.favor <= 100) {
    const up = upgradeLegacy(p.favor, p.tempPenalty || 0);
    p.favor = up.favor;
    if (typeof p.trust !== 'number') p.trust = up.trust;
    p.tempPenalty = 0;
    p._schema = 2;
  }
  p.favor = Math.max(0, Math.min(FAVOR.max, Math.round(p.favor)));
  if (typeof p.trust !== 'number' || Number.isNaN(p.trust)) p.trust = 0;
  p.trust = Math.max(0, Math.min(FAVOR.trustMax, p.trust));
  if (typeof p.tempPenalty !== 'number') p.tempPenalty = 0;
  // 历史最高分：资格按它算，分掉了档位不收回
  if (!Number.isFinite(p.favorPeak)) p.favorPeak = p.favor;
  else if (p.favor > p.favorPeak) p.favorPeak = p.favor;
  return p.favor;
}

/** 历史最高好感（算资格用） */
export function qualifiedFavor(p) {
  if (typeof p === 'number') return Math.max(0, Math.min(FAVOR.max, Math.round(p)));
  if (!p) return 0;
  const now = ensureFavor(p);
  return Math.max(now, Number(p.favorPeak) || 0);
}

/** 这人是半速吗：信任不到「分数所在那一档」门槛的一半 */
export function slowGrowth(p) {
  ensureFavor(p);
  const st = stageByFavor(qualifiedFavor(p));
  const need = st.trust;
  if (!need) return false;
  return p.trust < need / 2;
}

/** 当天的正向上限（半速的人砍半） */
export function dailyGainCapFor(p) {
  return slowGrowth(p) ? Math.round(FAVOR.dailyGainCap / 2) : FAVOR.dailyGainCap;
}

/* ---------- 档位 ---------- */

/** 只按分数判断的档（不看信任） */
export function stageByFavor(favor) {
  const f = Number(favor) || 0;
  let cur = STAGES[0];
  for (const s of STAGES) if (f >= s.min) cur = s;
  return cur;
}

/** 分数 + 信任都够才升档 */
export function stageOfPerson(p) {
  if (!p || typeof p === 'number') return stageByFavor(p);
  const q = qualifiedFavor(p);
  ensureFavor(p);
  let cur = STAGES[0];
  for (const s of STAGES) if (q >= s.min && p.trust >= s.trust) cur = s;
  return cur;
}

export function stageIndex(p) {
  return stageOfPerson(p).idx;
}

/** 旧接口：返回档位 key（内部已换成八档 key） */
export function tierOf(favor) {
  return stageByFavor(favor).key;
}

export function tierOfPerson(p) {
  return stageOfPerson(p).key;
}

/** 给模型看的一句话描述 */
export function tierText(favor) {
  const s = stageByFavor(favor);
  return `${s.name}：${s.text}`;
}

/* ---------- 给用户看的好感卡片 ---------- */

/** 好感卡片：参数可以是 person 对象，也可以沿用 (favor, qualified, trust) 三个数字 */
export function renderFavorCard(favorOrPerson, qualifiedArg, trustArg, opts = {}) {
  const isPerson = !!favorOrPerson && typeof favorOrPerson === 'object';
  let favorNow; let gateNow; let trustNow;
  if (isPerson) {
    ensureFavor(favorOrPerson);
    favorNow = favorOrPerson.favor;
    gateNow = qualifiedFavor(favorOrPerson);
    trustNow = favorOrPerson.trust;
  } else {
    favorNow = Number(favorOrPerson) || 0;
    gateNow = Number(qualifiedArg ?? favorNow) || 0;
    trustNow = trustArg == null ? null : Number(trustArg);
  }
  const gate = Math.max(0, Math.min(FAVOR.max, Math.round(gateNow)));
  const isOwner = !!opts.isOwner;
  // 主人保底第六档：分数没到也按第六档给权限（用户 m01126「主人在任何情况下都享有至少六档的权限」）
  const eff = isOwner ? Math.max(gate, STAGES[5].min) : gate;
  const st = stageByFavor(eff);
  const tr = trustNow == null || !Number.isFinite(Number(trustNow))
    ? null
    : Math.max(0, Math.min(100, Number(trustNow)));
  const lines = [];
  lines.push(`你在我心里：${st.name}`);
  lines.push(`现在做得到的：${(st.perms || []).join('、')}`);
  const next = STAGES.find((s) => s.min > eff);
  if (next) {
    const peek = (next.perms || []).slice(0, 2).join('、');
    lines.push(`还没到：${peek}`);
  } else {
    lines.push('已经到头了，别得寸进尺');
  }
  if (tr != null) {
    const mood = tr >= st.trust + 10 ? '我挺信你的'
      : tr >= st.trust ? '我信你'
      : tr >= st.trust / 2 ? '我还有点拿不准'
      : '我不太信你';
    lines.push(next ? `${mood}；想再往上，得先让我更信你` : mood);
  }
  // 用户 2026-10-28：卡片结尾那行括号（「对外只讲关系和能做什么…」）不要了。
  // 硬约束改为只写在代码注释里：查好感只说关系和能做什么，不许报分数、门槛、距离（m01126）。
  return lines.join('\n');
}

/* ---------- 时间 ---------- */

/** 北京时间的日期键（YYYY-MM-DD）与小时/分钟；不依赖服务器时区 */
export function beijingNow(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    key: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    hhmm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
  };
}

/** 自然周的键（YYYY-Www），周上限靠它判断 */
export function beijingWeek(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 开新的一天：当天计数归零，周计数按周滚 */
export function rollDay(p, dayKey, weekKey) {
  ensureFavor(p);
  const wk = weekKey || beijingWeek();
  if (p.weekKey !== wk) {
    p.weekKey = wk;
    p.weekGain = 0;
    p.weekTrust = 0;
  }
  if (p.dayKey === dayKey) return false;
  p.prevDayKey = p.dayKey;
  p.prevDayChatted = Boolean(p.dayChatted);
  p.prevDayAngered = Boolean(p.dayAngered);
  p.prevDayMark = p.dayMark ?? (p.dayChatted ? (p.dayAngered ? '-' : '+') : null);
  p.dayKey = dayKey;
  p.dayGain = 0;
  p.dayLoss = 0;
  p.dayTrust = 0;
  p.dayChatted = false;
  p.dayAngered = false;
  p.dayMark = null;
  p.helpedBy = {};
  p.persuadeGainToday = 0;
  p.hourKey = null;
  p.hourlyGainToday = 0;
  return true;
}

/* ---------- 好感：只增 ---------- */

/**
 * 加好感（带软区 + 日上限 + 周上限 + 半速）。
 * 传负数不扣好感——好感只增，越界扣信任（返回 applied 0）。
 */
export function applyAffection(p, delta, { dayKey, ignoreSlow = false, ignoreCap = false } = {}) {
  ensureFavor(p);
  if (dayKey) rollDay(p, dayKey);
  const before = p.favor;
  const want = Math.trunc(delta);
  // #锁定关系（2026-10-27 m02704）：锁住以后好感一分不动，加也不加、扣也不扣
  if (RELATION_LOCKED) {
    return { before, after: p.favor, applied: 0, capped: false, slow: false, reason: '关系已锁定' };
  }
  if (!(want > 0)) {
    return { before, after: p.favor, applied: 0, capped: true, slow: false, reason: '好感只增不减' };
  }

  let d = want;
  const slow = !ignoreSlow && slowGrowth(p);
  if (slow) {
    p.slowAcc = (p.slowAcc || 0) + d * FAVOR.slowFactor;
    d = Math.floor(p.slowAcc);
    p.slowAcc -= d;
  }

  // 档位系数：第五档已经站稳的人，往上每升一档，同样的事拿到的少一点。
  // 用累加器是为了不让 0.9 这种小数被 floor 吃掉（攒够 1 分再给）。
  const stageGain = stageOfPerson(p).gain ?? 1;
  if (!ignoreSlow && stageGain < 1) {
    p.gainAcc = (p.gainAcc || 0) + d * stageGain;
    d = Math.floor(p.gainAcc);
    p.gainAcc -= d;
  }

  let capped = false;
  if (!ignoreCap) {
    // 周上限
    const weekRoom = Math.max(0, FAVOR.weekGainCap - (p.weekGain || 0));
    if (d > weekRoom) { d = weekRoom; capped = true; }
    // 软区：日额度内全额，超出 25%，硬顶 150
    const dayGain = p.dayGain || 0;
    const roomHard = Math.max(0, FAVOR.dailyHardCap - dayGain);
    if (roomHard <= 0) { d = 0; capped = true; }
    else if (d > 0) {
      const roomFull = Math.max(0, FAVOR.dailyGainCap - dayGain);
      const full = Math.min(d, roomFull);
      const rest = d - full;
      const softTake = Math.min(rest, Math.max(0, roomHard - full));
      const eff = full + Math.floor(softTake * FAVOR.softRate);
      if (softTake < rest) capped = true;
      d = eff;
    }
  } else {
    d = Math.max(0, d);
  }

  p.favor = Math.max(0, Math.min(FAVOR.max, before + d));
  p.dayGain = (p.dayGain || 0) + d;
  p.weekGain = (p.weekGain || 0) + d;
  if (p.favor > (p.favorPeak || 0)) p.favorPeak = p.favor;
  if (p.favor < FAVOR.hate) p.everBelow20 = true;
  return { before, after: p.favor, applied: d, capped, slow };
}

/* ---------- 信任：可涨可跌 ---------- */

/** 加/扣信任。负向不设日额度（犯错就是犯错），正向受日/周上限。 */
export function applyTrust(p, delta, { dayKey, reason = '' } = {}) {
  ensureFavor(p);
  if (dayKey) rollDay(p, dayKey);
  const before = p.trust;
  // #锁定关系（m02704）：信任也一起冻住
  if (RELATION_LOCKED) {
    return { before, after: p.trust, applied: 0, capped: false, reason: '关系已锁定' };
  }
  let d = Math.trunc(delta);
  let capped = false;
  if (d > 0) {
    const dayRoom = Math.max(0, FAVOR.trustDailyCap - (p.dayTrust || 0));
    const weekRoom = Math.max(0, FAVOR.trustWeekCap - (p.weekTrust || 0));
    d = Math.min(d, dayRoom, weekRoom);
    if (d < Math.trunc(delta)) capped = true;
    p.dayTrust = (p.dayTrust || 0) + d;
    p.weekTrust = (p.weekTrust || 0) + d;
  }
  p.trust = Math.max(0, Math.min(FAVOR.trustMax, before + d));
  return { before, after: p.trust, applied: d, capped, reason };
}

/**
 * 兼容入口（外部都调这个）：
 *   正数 → 加好感（软区/周上限）
 *   负数 → 扣信任（好感一根不动）
 */
export function applyFavor(p, delta, opts = {}) {
  const d = Math.trunc(delta);
  if (d < 0) {
    const r = applyTrust(p, d, { dayKey: opts.dayKey, reason: opts.reason || '扣分' });
    return { ...r, favor: ensureFavor(p), capped: r.capped, slow: false };
  }
  const r = applyAffection(p, d, opts);
  return { ...r, favor: r.after };
}

/* ---------- 第 7/8 档独占（用户 m01108） ---------- */

export const EXCLUSIVE = {
  bondMin: 2400,        // 第八档门槛
  bondTrust: 92,
  demoteTo: 1679,       // 第六档最高分（被压的人封顶在这里）
  fallTo: 1079,         // 第五档最高分（第八档掉档后落到这里）
  confidantTrust: 82,
  confidantDrop: 300,   // 第七档信任腰斩扣的好感
  belowWindowDays: 5,
  belowNeedDays: 3,
};

/**
 * 第八档独占的同步。每轮结算后调一次。
 *   有人到第八档 → 其他人封顶 1679，原来的分数先存进 demotedFrom
 *   第八档的人五天里三天信任跌破一半 → 自己掉到 1079，独占解除，被压的人分数还原
 * map 就是 profiles.people（顶层 _exclusive 存共享状态）。
 */
export function syncExclusive(map, { nowMs = Date.now(), dayKey = null } = {}) {
  if (!map || typeof map !== 'object') return [];
  const notes = [];
  const list = Object.values(map).filter((v) => v && typeof v === 'object' && typeof v.favor === 'number' && v.uid != null);
  if (!list.length) return notes;

  let ex = map._exclusive && typeof map._exclusive === 'object' && map._exclusive.uid ? map._exclusive : null;

  // 1) 谁在第八档
  const bond = list.filter((p) => { ensureFavor(p); return p.favor >= EXCLUSIVE.bondMin; });
  if (bond.length) {
    const top = bond.sort((a, b) => b.favor - a.favor)[0];
    if (!ex || Number(ex.uid) !== Number(top.uid)) {
      ex = { uid: Number(top.uid), since: nowMs, days: {} };
      map._exclusive = ex;
      notes.push(`${top.displayName || top.uid} 到第八档，独占成立`);
    }
  }
  if (!ex) return notes;

  const holder = list.find((p) => Number(p.uid) === Number(ex.uid));
  if (!holder) { delete map._exclusive; return notes; }

  // 2) 记今天持有者信任有没有跌破一半
  const half = EXCLUSIVE.bondTrust / 2;
  const dk = dayKey || beijingNow().key;
  ex.days = ex.days || {};
  if (Number(holder.trust) < half) ex.days[dk] = 1;
  const keep = Object.keys(ex.days).sort().slice(-EXCLUSIVE.belowWindowDays);
  ex.days = Object.fromEntries(keep.map((k) => [k, ex.days[k]]));
  const badDays = Object.values(ex.days).filter(Boolean).length;

  // 3) 五天里三天跌破 → 掉到第五档，独占解除，被压的人还原
  if (badDays >= EXCLUSIVE.belowNeedDays) {
    if (holder.favor > EXCLUSIVE.fallTo) holder.favor = EXCLUSIVE.fallTo;
    if (holder.favor > (holder.favorPeak || 0)) holder.favorPeak = holder.favor;
    notes.push(`${holder.displayName || holder.uid} 五天里三次掉信任，掉到第五档，独占解除`);
    for (const p of list) {
      if (Number(p.uid) === Number(ex.uid)) continue;
      if (p.demotedFrom != null) {
        p.favor = Math.max(Number(p.demotedFrom) || 0, p.favor);
        delete p.demotedFrom;
        notes.push(`${p.displayName || p.uid} 的分数还原`);
      }
    }
    delete map._exclusive;
    return notes;
  }

  // 4) 独占生效：别人封顶在第六档最高分
  for (const p of list) {
    if (Number(p.uid) === Number(ex.uid)) continue;
    ensureFavor(p);
    if (p.favor > EXCLUSIVE.demoteTo) {
      if (p.demotedFrom == null) p.demotedFrom = p.favor;
      p.favor = EXCLUSIVE.demoteTo;
      notes.push(`${p.displayName || p.uid} 被封顶到第六档最高`);
    }
  }
  return notes;
}

/**
 * 第七档的人信任跌破一半 → 扣一大笔好感（只扣一次，涨回去再跌才重新算）。
 * 这是好感会下跌的第二个例外。
 */
export function applyConfidantTrustDrop(p) {
  ensureFavor(p);
  // 档位按分数算（qualifiedFavor 记的是历史最高，解锁过的档不收回）——
  // 用 stageOfPerson 会掉进死循环：信任不够就判不成第七档，这条永远不触发。
  const st = stageByFavor(qualifiedFavor(p));
  if (st.idx < 7) return null;
  const half = STAGES[6].trust / 2;
  if (Number(p.trust) >= half) { p.confidantArmed = true; return null; }
  if (p.confidantArmed === false) return null;
  p.confidantArmed = false;
  const before = p.favor;
  p.favor = Math.max(0, p.favor - EXCLUSIVE.confidantDrop);
  return { before, favor: p.favor, favorLoss: EXCLUSIVE.confidantDrop };
}

/* ---------- 信任见底：重罚 + 冷处理（用户 m01155） ---------- */


export const TRUST_ZERO_PENALTY = { favorLoss: 100, silenceHours: 12, cooldownHours: 6 };

/**
 * 信任掉到 0 之后的处罚：扣 100 好感 + 12 小时不理他。
 * 好感在这里是例外地往下掉——用户 m01155 原话「下降至零以后将会扣除100好感并短期内不与之对话」。
 * 6 小时内不重复罚，避免一句话连发把他一次打死。
 */
export function checkTrustZero(p, nowMs = Date.now()) {
  ensureFavor(p);
  if (p.trust > 0) return null;
  if (p.lastTrustZeroAt && nowMs - p.lastTrustZeroAt < TRUST_ZERO_PENALTY.cooldownHours * 3600 * 1000) return null;
  p.lastTrustZeroAt = nowMs;
  p.favor = Math.max(0, p.favor - TRUST_ZERO_PENALTY.favorLoss);
  if (p.favor > (p.favorPeak || 0)) p.favorPeak = p.favor;
  p.silenceUntil = nowMs + TRUST_ZERO_PENALTY.silenceHours * 3600 * 1000;
  return { favorLoss: TRUST_ZERO_PENALTY.favorLoss, silenceUntil: p.silenceUntil, favor: p.favor };
}

/** 还在冷处理期里吗 */
export function isSilenced(p, nowMs = Date.now()) {
  return !!(p && p.silenceUntil && Number(p.silenceUntil) > nowMs);
}

/* ---------- 结算 ---------- */

/** 每小时结算：这一小时聊过天且当天标记是 + 的人加分 */
export function settleHourlyChat(p, dayKey, hourKey, nowMs = Date.now()) {
  ensureFavor(p);
  if (p.hourKey === hourKey) return { gained: 0 };
  if (p.dayMark !== '+') return { gained: 0 };
  const last = Number(p.lastChatAt || 0);
  if (!last || nowMs - last > 3600_000) return { gained: 0 };
  if ((p.hourlyGainToday || 0) >= FAVOR.hourlyDailyCap) return { gained: 0 };
  p.hourKey = hourKey;
  const room = FAVOR.hourlyDailyCap - (p.hourlyGainToday || 0);
  const step = Math.min(FAVOR.hourlyChatGain, room);
  const r = applyFavor(p, step, { dayKey });
  if (r.applied > 0) p.hourlyGainToday = (p.hourlyGainToday || 0) + r.applied;
  return { gained: r.applied };
}

/** 每天 04:00 结算：昨天标记是 + 的人签到加分（顺带给一点信任） */
export function settleDailyChat(p, dayKey) {
  if (p.settledDayKey === dayKey) return { gained: 0 };
  p.settledDayKey = dayKey;
  const prevMark = p.dayKey && p.dayKey !== dayKey
    ? (p.dayMark ?? (p.dayChatted ? (p.dayAngered ? '-' : '+') : null))
    : (p.prevDayMark ?? (p.prevDayChatted ? (p.prevDayAngered ? '-' : '+') : null));
  if (prevMark !== '+') return { gained: 0 };
  const r = applyFavor(p, FAVOR.dailyChatGain, { dayKey });
  applyTrust(p, 1, { dayKey, reason: '日常签到' });
  return { gained: r.applied };
}

/** 劝说：劝和恢复的是「资格」——加信任，不加好感 */
export function applyPersuade(target, helperUid, dayKey) {
  rollDay(target, dayKey);
  const helper = String(helperUid);
  target.helpedBy = target.helpedBy || {};
  if (target.helpedBy[helper]) return { ok: false, reason: '这个帮手今天已经帮过了' };
  if ((target.persuadeGainToday || 0) + 1 > FAVOR.persuadeTotalCap) {
    return { ok: false, reason: '今天被劝的次数用完了' };
  }
  target.helpedBy[helper] = true;
  target.persuadeGainToday = (target.persuadeGainToday || 0) + 1;
  const r = applyTrust(target, FAVOR.persuadeTrustGain, { dayKey, reason: '群友劝和' });
  return { ok: true, ...r, applied: r.applied };
}

/** 「越界」判定：不是普通难听，是冲着人来的恶意 */
export const BOUNDARY = /(去死|傻逼|煞笔|傻叉|废物|垃圾东西|滚出去|fuck you|kill yourself)/i;

/* ---------- 睡觉时间 ---------- */

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 把「十一点半」「11:30」「十点」「凌晨两点」解析成 {hour, minute}；解析不出返回 null */
export function parseClock(text) {
  const s = String(text || '');
  let m = s.match(/(\d{1,2})\s*[点:：]\s*(半|\d{1,2})?/);
  if (m) {
    let h = Number(m[1]);
    let mi = 0;
    if (m[2] === '半') mi = 30;
    else if (m[2]) mi = Number(m[2]);
    if (h <= 24 && mi < 60) return { hour: h, minute: mi };
  }
  m = s.match(/([零一二两三四五六七八九十]{1,3})\s*点\s*(半|[零一二三四五六七八九十]{1,2})?/);
  if (m) {
    const num = (t) => {
      if (!t) return 0;
      if (t === '十') return 10;
      if (t.length === 1) return CN_NUM[t] ?? 0;
      if (t[0] === '十') return 10 + (CN_NUM[t[1]] ?? 0);
      if (t[1] === '十') return (CN_NUM[t[0]] ?? 0) * 10 + (CN_NUM[t[2]] ?? 0);
      return CN_NUM[t[0]] ?? 0;
    };
    let h = num(m[1]);
    let mi = 0;
    if (m[2] === '半') mi = 30;
    else if (m[2]) mi = num(m[2]);
    if (h >= 0 && h <= 24 && mi < 60) return { hour: h, minute: mi };
  }
  return null;
}

/** 从一句话里判断「这人说自己几点睡」 */
export function parseSleepMention(text) {
  const s = String(text || '');
  if (!/(睡|躺下|上床|休息了|去睡了|晚安)/.test(s)) return null;
  const clock = parseClock(s);
  if (!clock) return null;
  let { hour } = clock;
  const { minute } = clock;
  const isPM = /(下午|晚上|夜|今晚|傍晚)/.test(s);
  const isAM = /(凌晨|早上|清晨|天亮)/.test(s);
  if (hour >= 1 && hour <= 5) {
    if (isPM) hour += 12;
  } else if (hour >= 6 && hour <= 11) {
    if (!isAM) hour += 12;
  }
  if (isAM && hour === 12) hour = 0;
  return { hour, minute, nap: isPM && hour <= 14 };
}

/** 这个点该不该给这人发晚安 */
export function goodnightAt(person, nowHour, nowMinute) {
  const t = person?.sleepAt;
  if (!t) return false;
  return t.hour === nowHour && Math.abs(t.minute - nowMinute) < 10;
}

/* ---------- 只读好感表 ---------- */

/**
 * 只读出「uid → 好感」这一张表（定时任务用，不构造对象）。
 */
export function readFavorMap(agentCwd, chatKey) {
  const f = path.join(agentCwd, 'profiles', `${String(chatKey).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  const shared = favorIsShared(chatKey) ? readSharedFavors(agentCwd) : {};
  try {
    if (!fs.existsSync(f)) return {};
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const out = {};
    for (const [uid, p] of Object.entries(raw.people || {})) {
      if (typeof p?.favor === 'number') {
        out[uid] = (p._schema === 2 || p.favor > 100)
          ? p.favor
          : upgradeLegacy(p.favor, p.tempPenalty || 0).favor;
      } else if (typeof p?.intimacy === 'number') out[uid] = p.intimacy * 20;
      else out[uid] = FAVOR.init;
    }
    for (const [uid, s] of Object.entries(shared)) {
      if (typeof s?.favor === 'number') {
        out[uid] = (s._schema === 2 || s.favor > 100)
          ? s.favor
          : upgradeLegacy(s.favor, s.tempPenalty || 0).favor;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/* ---------- 生气：改扣信任 ---------- */

/**
 * 生气瞬间：扣信任（群 10 / 私聊 6），好感一根不动。
 * 返回结构保持旧样子，调用方不用改。
 */
export function applyAngerPenalty(p, { isPrivate = false } = {}) {
  ensureFavor(p);
  const base = isPrivate ? FAVOR.angerTrustPrivate : FAVOR.angerTrustGroup;
  if (Number(p.angerTrustHeld || 0) > 0) {
    return { applied: 0, favor: ensureFavor(p), trust: p.trust, already: true };
  }
  const r = applyTrust(p, -base, { reason: '生气' });
  p.angerTrustHeld = base;
  return { applied: r.applied, favor: ensureFavor(p), trust: p.trust, before: r.before };
}

/** 消气了：把这次扣的信任还回一部分（不是全额，说过的话留点痕） */
export function restoreAngerPenalty(p) {
  ensureFavor(p);
  const back = Math.round(Number(p.angerTrustHeld || 0) * FAVOR.trustRestoreRate);
  if (!back) return { restored: 0, favor: ensureFavor(p), trust: p.trust };
  const r = applyTrust(p, back, { reason: '消气恢复' });
  p.angerTrustHeld = 0;
  return { restored: r.applied, favor: ensureFavor(p), trust: p.trust, before: r.before };
}

/* ---------- 记事本 ---------- */

function notebookFile(agentCwd, chatKey) {
  const dir = path.join(agentCwd, 'notebook');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(chatKey).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function loadNotebook(agentCwd, chatKey) {
  try {
    const f = notebookFile(agentCwd, chatKey);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* 坏了当空 */ }
  return { people: {} };
}

export function saveNotebook(agentCwd, chatKey, data) {
  fs.writeFileSync(notebookFile(agentCwd, chatKey), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 给某人写记事本 / 改对他的描述。只有好感 >=360（第四档朋友）才有资格。
 */
export function writeNotebook({ agentCwd, chatKey, uid, favor, text, about }) {
  const nb = loadNotebook(agentCwd, chatKey);
  const cur = nb.people[uid] ?? (nb.people[uid] = { notes: [], about: '' });
  const fv = ensureFavor({ favor, _schema: 2 });
  if (fv < FAVOR.obey) {
    return { ok: false, reason: `好感 ${fv} 不到 ${FAVOR.obey}，还不给他记事本` };
  }
  if (typeof text === 'string' && text.trim()) {
    const line = text.trim().slice(0, 120);
    cur.notes = [line, ...(cur.notes || [])].slice(0, 12);
    let total = 0;
    cur.notes = cur.notes.filter((n) => { total += n.length; return total <= FAVOR.notebookChars; });
  }
  if (typeof about === 'string' && about.trim()) {
    cur.about = about.trim().slice(0, FAVOR.memoryChars);
    try { writeSharedAbout(agentCwd, uid, cur.about); } catch { /* 共享表坏了不影响本地 */ }
  }
  nb.people[uid] = cur;
  saveNotebook(agentCwd, chatKey, nb);
  return { ok: true, notes: cur.notes, about: cur.about };
}

/** 渲染给 prompt 的记事本片段 */
export function renderNotebook(agentCwd, chatKey, uid, favor) {
  if (Number(favor) < FAVOR.obey) return '';
  const nb = loadNotebook(agentCwd, chatKey);
  const cur = nb.people[uid];
  const shared = readSharedAbout(agentCwd)[Number(uid)];
  if (!cur && !shared?.about) return '';
  const parts = [];
  const about = shared?.about || cur?.about || '';
  if (about) parts.push(`【关于他】（按 QQ 号记的，不分群，你可以信）\n${about}`);
  if (cur?.notes?.length) {
    parts.push(`【记事本·他交代过的事】\n${cur.notes.map((n) => `- ${n}`).join('\n')}\n（到点就提醒他，别忘了。）`);
  }
  return parts.join('\n\n');
}
