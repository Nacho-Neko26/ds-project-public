/**
 * 日记 + 人物关系。
 *
 * 每天写一篇第一人称日记，存到 workspace/diary/YYYY-MM-DD.md。
 * 日记分两段：
 *   1. 正文：她自己回忆今天（模型写）
 *   2. 【今天说过话的人】：名字 / 称呼 / 亲密度 / 说了几句 —— **由程序从真实数据算**，
 *      不让模型瞎编。用户明确要求「记得每个交谈过的群友以及亲密关系」。
 *
 * 换天时补写：不止补昨天，最近 MAX_CATCHUP 天里缺的都会补上，
 * 免得连休几天回来日记断档。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, ensureDir, log } from './util.mjs';
import { loadProfiles, saveProfiles } from './anger.mjs';
import { charName, defaultNick, allNames } from './character.mjs';

const pad = (n) => String(n).padStart(2, '0');
/** 最多补写几天内的空档 */
const MAX_CATCHUP = 7;

/** 本地日期键 YYYY-MM-DD */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function diaryDir(agentCwd) {
  return ensureDir(path.join(agentCwd, 'diary'));
}

function diaryFile(agentCwd, key) {
  return path.join(diaryDir(agentCwd), `${key}.md`);
}

/** 最近一篇日记（按文件名倒序），返回 {key, text} 或 null */
export function latestDiary(agentCwd) {
  const dir = diaryDir(agentCwd);
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  if (!files.length) return null;
  const last = files[files.length - 1];
  const text = fs.readFileSync(path.join(dir, last), 'utf8').trim();
  if (!text) return null;
  return { key: last.replace(/\.md$/, ''), text };
}

/** 读某个日期的日记 */
export function readDiary(agentCwd, key) {
  const f = diaryFile(agentCwd, key);
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8').trim();
  return text || null;
}

export function writeDiary(agentCwd, key, text) {
  const clean = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[\s\u3000]+$/g, ''))
    .filter((l) => l.trim() !== '')
    .join('\n')
    .trim();
  fs.writeFileSync(diaryFile(agentCwd, key), clean + '\n', 'utf8');
  return diaryFile(agentCwd, key);
}

/**
 * 收集某一天所有会话的消息。
 * @returns {Object<string, Array<{role,name,text,t}>>} chatKey -> rows
 */
export function collectDayMessages(dataDir, key) {
  const dir = path.join(dataDir, 'history');
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const chatKey = f.replace(/\.jsonl$/, '');
    const rows = readJsonl(path.join(dir, f), 100000);
    const picked = rows.filter((r) => {
      const d = new Date(Number(r.t));
      return !Number.isNaN(d.getTime()) && dayKey(d) === key;
    });
    if (picked.length) out[chatKey] = picked;
  }
  return out;
}

/* ---------- 人物关系 ---------- */

const INTIMACY_TEXT = { 0: '陌生', 1: '有点印象', 2: '脸熟', 3: '熟了', 4: '很熟', 5: '特别熟' };

/** 号主的 QQ：对号主固定用身份槽位里的默认昵称，不自动生成外号 */
const OWNER_UIDS = new Set([<OWNER_QQ>]);

// 名前的纯修饰词（「最伟大的顾鹤」→「顾鹤」，靠的是「的」；这些是兜底）
const NICK_PREFIX = /^(?:超级|无敌|可爱|帅气|美丽|温柔|英俊|一个|一只|最|很|超|真|好|太|是|我|你|他|她|它|这|那|们|都|也|就|才|又|还)+/;
// 名后的语气尾巴
const NICK_SUFFIX = /(?:啊|呀|吧|呢|吗|啦|哟|哦|喔|捏|哈|嘛|哟|的)+$/;
// 括号里的补充说明（「小明（备胎）」→「小明」）
const NICK_BRACKET = /[（(【\[][^）)】\]]*[）)】\]]/g;

/**
 * 从昵称/名片里挑出最像「名字」的那一段。
 *
 * 不是「小 + 第一个字」——那会把「最伟大的顾鹤」叫成「小最」，
 * 把人家的口头禅当名字（2026-10-23 用户明确要求改）。
 *
 * 规则，从强到弱：
 *   1. 「的」后面那一截最像名字（最伟大的顾鹤 → 顾鹤；浪漫的垃圾桶 → 垃圾桶）
 *   2. 去掉括号备注、emoji、标点
 *   3. 去掉纯修饰前缀（超级/可爱/我/是…）和语气尾巴（啊/吧/呢…）
 *   4. 剩 2~4 个汉字直接用；只有 1 个字才补「小」；超过 4 个字取后 3 个
 *   5. 没有汉字就用拉丁词（Nacho → Nacho）
 */
export function pickNoun(raw, { aliases = [] } = {}) {
  // 角色自己的名字/自称/外号不能拿来当别人的名字
  const ban = new Set([...allNames(), ...(aliases || []).map((x) => String(x))]);

  let s = String(raw || '')
    .replace(NICK_BRACKET, ' ')
    .replace(/[\s\u3000\u200b-\u200f\ufe0f]+/g, '');
  // emoji / 符号
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, '');
  s = s.replace(/[^\u4e00-\u9fa5A-Za-z0-9の]/g, '');
  if (!s) return '';

  // 1) 「的 / の」后面那一截最像名字
  const tail = s.split(/[的の]/).filter(Boolean).pop();
  let body = s;
  if (tail && tail !== s && /[\u4e00-\u9fa5]/.test(tail)) body = tail;

  const collect = (text) => {
    const cands = [];
    const runs = text.match(/[\u4e00-\u9fa5]+/g) || [];
    runs.forEach((run, i) => {
      let h = run.replace(NICK_PREFIX, '').replace(NICK_SUFFIX, '');
      if (!h) return;
      if (ban.has(h)) return;
      if (h.length > 4) h = h.slice(-3);
      if (ban.has(h)) return;
      // 1 个字的排后面（「猫」→「小猫」还是能用的）
      cands.push({ h, order: i, score: h.length === 1 ? 2 : 0 });
    });
    return cands.sort((a, b) => a.score - b.score || a.order - b.order);
  };

  let cands = collect(body);
  if (!cands.length && body !== s) cands = collect(s);

  const latRuns = s.match(/[A-Za-z][A-Za-z0-9_]{1,}/g) || [];
  if (cands.length) {
    const h = cands[0].h;
    return h.length === 1 ? `小${h}` : h;
  }
  if (latRuns.length) {
    const w = latRuns[0];
    return w.length > 12 ? w.slice(0, 12) : w;
  }
  return '';
}

/**
 * 给熟人起外号：从名字里挑名词，而不是「小 + 第一个字」。
 * 找不到像名字的东西就退回身份槽位里的默认昵称（没填就回空串）。
 */
export function generateNick(displayName, cfg) {
  return pickNoun(displayName, { aliases: cfg?.raw?.persona?.aliases || [] });
}

/** 这个 uid 是不是号主 */
function isOwner(uid, cfg) {
  const list = cfg?.raw?.persona?.ownerUids;
  const set = Array.isArray(list) && list.length ? new Set(list.map(Number)) : OWNER_UIDS;
  return set.has(Number(uid));
}

/**
 * 从当天记录里算「跟谁说过话、多熟」，并顺手给档案打上今天的时间戳。
 * 返回 [{ chatKey, uid, name, call, intimacy, intimacyText, msgs, angerLv }]
 *
 * 亲密度：每 5 句 +1，但**每次结算最多涨一格**，免得历史消息一灌就全满。
 * 外号：亲密度 ≥3 且还没有专属外号时生成一个；号主固定用默认昵称。
 */
export function collectDayPeople({ dataDir, agentCwd, key, cfg }) {
  const byChat = collectDayMessages(dataDir, key);
  const out = [];
  for (const [chatKey, rows] of Object.entries(byChat)) {
    const profiles = loadProfiles(agentCwd, chatKey);
    const seen = new Map();
    for (const r of rows) {
      if (r.role !== 'user') continue;
      const uid = Number(r.uid);
      if (!Number.isFinite(uid)) continue;
      const cur = seen.get(uid) || { uid, name: r.name, msgs: 0 };
      cur.msgs += 1;
      cur.name = r.name || cur.name;
      seen.set(uid, cur);
    }
    for (const s of seen.values()) {
      const p = profiles.people[s.uid] ?? (profiles.people[s.uid] = {
        uid: s.uid, displayName: s.name, nickFor: '', intimacy: 2,
      });
      p.displayName = s.name || p.displayName;
      p.lastSeenAt = Date.now();

      const before = Number(p.intimacy ?? 2);
      p.turnsSinceGain = (p.turnsSinceGain || 0) + s.msgs;
      if (p.turnsSinceGain >= 5 && before < 5) {
        p.intimacy = before + 1;            // 一次结算最多 +1
        p.turnsSinceGain -= 5;
      }
      const intimacy = Number(p.intimacy ?? 2);

      // 熟人给专属外号（号主固定默认昵称）；本人/号主点过名的，别再自动改。
      // 每次结算都按当前名片重新挑一次名词——名片改了，叫法跟着改，别留旧的。
      const pinned = p.callOverride && typeof p.callOverride.name === 'string';
      if (!pinned && intimacy >= 3) {
        if (isOwner(s.uid, cfg)) {
          p.nickFor = defaultNick('');
        } else {
          const want = generateNick(p.displayName, cfg);
          if (want && want !== p.nickFor) p.nickFor = want;
        }
      }

      out.push({
        chatKey,
        uid: s.uid,
        name: s.name,
        call: pinned
          ? (p.callOverride.name || p.displayName || '你')
          : (intimacy >= 3 && p.nickFor ? p.nickFor : (p.displayName || '你')),
        intimacy,
        intimacyText: INTIMACY_TEXT[intimacy] ?? '熟了',
        msgs: s.msgs,
        angerLv: Number(p.angerLv ?? 0),
        nickFor: p.nickFor || '',
      });
    }
    saveProfiles(agentCwd, chatKey, profiles);
  }
  // 说得多的排前面
  out.sort((a, b) => b.msgs - a.msgs);
  return out;
}

/** 长期不说话，亲密度每月 -1（在写日记时顺手结算） */
export function decayIntimacy({ agentCwd, chatKeys }) {
  const MONTH = 30 * 24 * 60 * 60 * 1000;
  const changed = [];
  for (const chatKey of chatKeys) {
    const profiles = loadProfiles(agentCwd, chatKey);
    let dirty = false;
    for (const p of Object.values(profiles.people)) {
      const last = Number(p.lastSeenAt || 0);
      if (!last) continue;
      const idle = Date.now() - last;
      if (idle < MONTH) continue;
      const months = Math.floor(idle / MONTH);
      const before = p.intimacy ?? 3;
      if (before <= 0) continue;
      p.intimacy = Math.max(0, before - months);
      dirty = true;
      changed.push(`${p.displayName} ${before}→${p.intimacy}`);
    }
    if (dirty) saveProfiles(agentCwd, chatKey, profiles);
  }
  return changed;
}

/* ---------- 「今天清过没」的持久标记 ---------- */

/**
 * 上一次清空对话记录是哪天。
 * 这个必须落盘——否则桥每重启一次都以为「换天了」，会把当天的记录清空归档。
 * （2026-10-23 真踩过：重启一次，当天 1227 条历史全被归档走。）
 */
export function lastClearDay(agentCwd) {
  const f = path.join(agentCwd, 'diary-state.json');
  try {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).lastClearDay || '';
  } catch { /* 坏了当没清过 */ }
  return '';
}

export function setLastClearDay(agentCwd, key) {
  const f = path.join(agentCwd, 'diary-state.json');
  fs.writeFileSync(f, JSON.stringify({ lastClearDay: key }, null, 2), 'utf8');
}

/** 最近 N 天的日记（跳过今天的，按日期倒序）。返回 [{key, text}] */
export function recentDiaries(agentCwd, days = 3) {
  const dir = diaryDir(agentCwd);
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .slice(-(days + 1));
  const today = dayKey();
  const out = [];
  for (let i = files.length - 1; i >= 0 && out.length < days; i--) {
    const key = files[i].replace(/\.md$/, '');
    if (key === today) continue;
    const text = fs.readFileSync(path.join(dir, files[i]), 'utf8').trim();
    if (text) out.push({ key, text });
  }
  return out;
}

/** 全部日记的日期列表（新→旧） */
export function allDiaryKeys(agentCwd) {
  const dir = diaryDir(agentCwd);
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
    .reverse();
}

const DAY_WORD = /(前天|大前天|上周|星期[一二三四五六日天]|周[一二三四五六日天]|昨天|那天|之前|上一次|上次|几天前)/;
const DATE_RE = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/;

/**
 * 逐日回溯：用户提到更早的事情时，去旧日记里找对应的段落。
 *
 * 只做「找得到就补」，找不到就算了——绝不编。
 * @returns {{hits: Array<{key:string, snippet:string}>, hints: string[]}}
 */
export function backtrackDiaries(agentCwd, text, { days = 3, maxHits = 3 } = {}) {
  const s = String(text || '');
  const hints = [];
  if (DAY_WORD.test(s)) hints.push('提到更早的事了');
  const dm = s.match(DATE_RE);
  if (dm) hints.push(`提到具体日期 ${dm[1]}-${dm[2]}-${dm[3]}`);

  const keys = allDiaryKeys(agentCwd);
  const today = dayKey();
  // 默认只回溯「最近 days 天之外」的旧日记（近的已经注入过了）；
  // 但对方明确点出日期时，那天就算在近三天里也要去查。
  const older = dm
    ? keys.filter((k) => k !== today)
    : keys.filter((k) => k !== today).slice(days);
  if (!older.length) return { hits: [], hints };

  // 从用户这句话里抠关键词。
  // 中文没有空格，直接按 2~4 字滑窗切 n-gram——只取整段 4 字会漏掉「草莓」这种核心词。
  const STOP = new Set([
    '什么', '怎么', '这个', '那个', '今天', '昨天', '前天', '之前', '上次', '你还', '记得',
    '说了', '我说', '不是', '就是', '我们', '他们', '那天', '一次', '那次', '谁带', '带的',
    '干嘛', '什么', '你还', '记不', '得吗', '是不', '不是',
  ]);
  const runs = s.match(/[\u4e00-\u9fa5]+/g) || [];
  const words = new Set();
  for (const run of runs) {
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const w = run.slice(i, i + len);
        if (!STOP.has(w)) words.add(w);
      }
    }
  }
  const wordList = [...words];

  const hits = [];
  for (const key of older) {
    if (hits.length >= maxHits) break;
    // 有具体日期就直接取那一天
    if (dm) {
      const want = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`;
      if (key !== want) continue;
    }
    const text0 = readDiary(agentCwd, key) || '';
    if (!text0) continue;
    const lines = text0.split('\n');
    // 一行里命中几个关键词才算「说的是这事」：1 个 2 字词太容易误伤，要求命中分够
    const score = (l) => wordList.reduce((n, w) => (l.includes(w) ? n + w.length : n), 0);
    const picked = lines.map((l) => ({ l, s: score(l) }))
      .filter((x) => x.s >= 2)
      .sort((a, b) => b.s - a.s)
      .slice(0, 4)
      .map((x) => x.l);
    if (picked.length) hits.push({ key, snippet: picked.join('\n') });
    else if (dm) hits.push({ key, snippet: lines.slice(0, 6).join('\n') }); // 明确指定了日期，整段给它
  }
  return { hits, hints };
}

/** 把回溯结果渲染成 prompt 片段 */
export function renderBacktrack(hits) {
  if (!hits.length) return '';
  const body = hits.map((h) => `【${h.key} 的日记里提到】\n${h.snippet}`).join('\n\n');
  return `${body}\n（这是你自己的旧日记。日记里没写的事就是记不清了，别编——直接说「记不清了」。）`;
}

/** 把人物关系渲染成日记末尾那一段（程序生成，不是模型编的） */
export function renderPeopleSection(people, maxN = 6) {
  if (!people.length) return '';
  // 2026-10-27 用户要求「日记缩减到 500 字每天」：名单只列聊得最多的前几个，
  // 其余并成一句。22 个人全列出来光名单就七百多字，把正文挤得没地方写。
  const top = people.slice(0, maxN);
  const lines = top.map((p) =>
    `- ${p.name}（叫他「${p.call}」·${p.intimacyText}${p.angerLv >= 2 ? '·我还在生他的气' : ''}·${p.msgs} 句）`);
  const rest = people.length - top.length;
  const tail = rest > 0 ? `\n（另外还有 ${rest} 人插过话，聊得少，记不清了）` : '';
  return `【今天说过话的人】\n${lines.join('\n')}${tail}`;
}

/* ---------- 印象档案 ---------- */

/** 对每个人的长期印象，单独一个文件存（2026-10-27 用户要求，不混进日记） */
export function impressionsPath(agentCwd) {
  return path.join(agentCwd, 'impressions.md');
}

export function readImpressions(agentCwd) {
  const f = impressionsPath(agentCwd);
  try {
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

/**
 * 每天日记之后更新印象档案：把今天的新观察并进对每个人的印象里。
 * 输出整份文件而不是增量，这样同一个人的印象会随时间收敛，不会越写越散。
 */
export async function updateImpressions({ runner, cfg, key, byChat, people }) {
  const old = readImpressions(cfg.agentCwd);
  const material = renderDayMaterial(byChat, key, { maxPerChat: 60, maxCharsPerLine: 40 });
  const roster = people.length
    ? people.map((p) => `- ${p.name}，你叫他「${p.call}」，今天说了 ${p.msgs} 句`).join('\n')
    : '（今天没跟人说话）';
  const prompt = [
    '你要更新「对每个人的印象」档案。这不是日记，是长期的人物档案：你对他们的看法会一直留着。',
    '',
    '【现有的印象】',
    old || '（还是一片空白）',
    '',
    '【今天说过话的人】',
    roster,
    '',
    '【今天的记录】',
    material,
    '',
    '要求：',
    '- 输出**整份档案**（不是只写今天这段）。每人一段，格式固定：',
    '  ## 名字（QQ 号；不知道号码就写「群里的人」）',
    '  - 一条一句话，写你对这个人的判断：性格、习惯、爱聊什么、让你记恩或记仇的事、你跟他什么关系',
    '- 每人最多 5 条，只留最有用的。有新发现就改掉旧的或加一条，不许把新旧重复叠着写。',
    '- 今天没有新信息的人，原样保留他那段，一个字都不用改。',
    '- 只写人和你看他的眼光，不写今天发生了什么事——那是日记里的事。',
    '- 全文不超过 1200 字。',
    '- 直接输出档案正文，第一行就是「## 名字」，不要任何前缀、标题说明或解释。',
  ].join('\n');

  const r = await runner.run({ prompt });
  if (!r.ok || !r.text) {
    log('warn', `印象档案更新失败（${key}）`);
    return null;
  }
  const text = r.text.trim();
  ensureDir(cfg.agentCwd);
  fs.writeFileSync(impressionsPath(cfg.agentCwd), text + '\n', 'utf8');
  log('info', `印象档案已更新（${key}，${text.length} 字 / ${people.length} 人）`);
  return text;
}

/* ---------- 生成 ---------- */

/**
 * 均匀抽稀：保留首尾，在整体上等距取 maxN 条。
 * 2026-10-26 加：聊得特别多的一天（10-25 有 1765 条）整个塞进 prompt 会 spawn E2BIG
 * （Linux 单参数上限 128KB，prompt 是走命令行参数传的），日志里只报一句「日记生成失败」。
 * 均匀取比取头尾更能保住一天的性格——早上刚醒、半夜发疯都还在。
 */
function pickEven(rows, maxN) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= maxN || maxN < 2) return list;
  const out = [];
  const step = (list.length - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++) out.push(list[Math.round(i * step)]);
  return out;
}

/**
 * 把一天的记录渲染成给模型看的素材（说话人用【】框住，避免「我」指代混乱）
 * 2026-10-26 用户定：每会话最多取 120 条、每条截到 60 字（防 E2BIG，也省 token）。
 */
export function renderDayMaterial(byChat, key, { maxPerChat = 120, maxCharsPerLine = 60 } = {}) {
  const parts = [];
  let dropped = 0;
  for (const [chatKey, rows] of Object.entries(byChat)) {
    const title = chatKey.startsWith('group:') ? `群 ${chatKey.slice(6)}` : `私聊 ${chatKey.slice(8)}`;
    const picked = pickEven(rows, maxPerChat);
    dropped += (Array.isArray(rows) ? rows.length : 0) - picked.length;
    const lines = picked.map((r) => {
      const d = new Date(Number(r.t));
      // 和 context.mjs 一个口径：bot / assistant / self:true 都算她自己（2026-10-27）
      const who = (r.role === 'bot' || r.role === 'assistant' || r.self === true) ? '我' : (r.name || '别人');
      let body = String(r.text ?? '').replace(/\s+/g, ' ').trim();
      if (body.length > maxCharsPerLine) body = `${body.slice(0, maxCharsPerLine)}…`;
      return `${pad(d.getHours())}:${pad(d.getMinutes())} 【${who}】${body}`;
    });
    parts.push(`## ${title}\n${lines.join('\n')}`);
  }
  const trimmedNote = dropped > 0
    ? `\n\n（这天消息太多，每个会话只均匀取了最多 ${maxPerChat} 条、单条截到 ${maxCharsPerLine} 字，共略过 ${dropped} 条）`
    : '';
  return `（${key} 的聊天记录；【我】是${charName('我')}自己，【别人名字】是对方。对方话里的「我」指他自己）\n\n${parts.join('\n\n')}${trimmedNote}`;
}

/**
 * 生成某天的日记。用桥自己的 AgentRunner 跑一次（带人设）。
 * @returns {Promise<string|null>} 日记正文，失败返回 null
 */
export async function generateDiary({ runner, cfg, key, byChat, people = [] }) {
  const material = renderDayMaterial(byChat, key);
  const who = people.length
    ? `\n今天跟你说过话的人（这些是真实的，别编别人）：\n${people
      .map((p) => `- ${p.name}，你叫他「${p.call}」，今天说了 ${p.msgs} 句`)
      .join('\n')}\n`
    : '';

  const prompt = [
    '你要写今天的日记。这不是给谁看的汇报，是你自己睡前随手记的。',
    `日期：${key}`,
    '下面是今天你和大家的所有聊天记录。',
    '',
    material,
    who,
    '要求：',
    '- 用第一人称，你自己的口吻。**整篇不超过 500 字**（350~500 字最好，超过 500 就算没按要求写）。',
    '- 分几段，每段两三句；短句，口语，不用 Markdown、不用列表、不编号。',
    '- **只记重要的事和有意思的事**：好笑的梗、扎心的话、让你记恩或记仇的事、',
    '  重要的决定和心情拐点。日常寒暄、没话找话、重复的流程都跳过，宁可只写两三件也别凑字。',
    '- 今天说过话的人不用都带到，只挑当天真有事的写。',
    '- **只写今天发生的事，不评价人。**不写「这人怎么样」「关系近了没」「挺喜欢/有点烦」这种总体印象——',
    '  那些另外记在印象里。你在这里只交代：谁说了什么、做了什么、你怎么回应的。',
    '- 关系可以体现在语气里（「那家伙又来了」），但不许下判断、不许总结这个人。',
    '- **只写记录里真实发生过的事。** 天气、别人说过的话、做过的事，记录里没有就一个字都别编。',
    '  今天要是没什么好写的，就写你摸鱼、发呆、想吃饭，也别凑假事件。',
    '- 不要写「今天」开头的套话式流水账，写得像真的在回忆。',
    '- 直接输出日记正文，不要任何前缀、标题、引号。',
  ].join('\n');

  const r = await runner.run({ prompt });
  if (!r.ok || !r.text) {
    log('warn', `日记生成失败（${key}）`);
    return null;
  }
  return r.text.trim();
}

/** 生成并落盘某一天的日记（正文 + 人物关系段） */
export async function buildDiaryFor({ runner, cfg, key }) {
  const byChat = collectDayMessages(cfg.dataDir, key);
  const total = Object.values(byChat).reduce((n, rows) => n + rows.length, 0);
  if (!total) return null;

  const people = collectDayPeople({ dataDir: cfg.dataDir, agentCwd: cfg.agentCwd, key, cfg });
  const body = await generateDiary({ runner, cfg, key, byChat, people });
  if (!body) return null;

  // 2026-10-27 用户要求：日记只记当天发生的事，对人的总体印象另外存进 impressions.md
  writeDiary(cfg.agentCwd, key, body);
  log('info', `日记已写入 ${key}（${total} 条消息 / ${people.length} 人）`);
  try {
    await updateImpressions({ runner, cfg, key, byChat, people });
  } catch (e) {
    log('warn', `印象档案更新异常：${e.message}`);
  }
  return { key, text: body, people };
}

/** 把多篇日记压成摘要（每天一行左右），日常轮次只注入这个，省 token */
export function compactDiaries(list, perDay = 120) {
  if (!list?.length) return '';
  return list.map((d) => {
    const body = d.text.split('【今天说过话的人】')[0].replace(/\s+/g, ' ').trim();
    return `【${d.key}】${body.slice(0, perDay)}${body.length > perDay ? '…' : ''}`;
  }).join('\n');
}

/**
 * 补写最近几天缺的日记（含昨天）。已经有的跳过。
 * @returns {Promise<Array<{key:string,text:string}>>}
 */
export async function catchUpDiaries({ runner, cfg, now = new Date(), days = MAX_CATCHUP }) {
  const made = [];
  const chatKeys = new Set();
  const histDir = path.join(cfg.dataDir, 'history');
  if (fs.existsSync(histDir)) {
    for (const f of fs.readdirSync(histDir)) {
      if (f.endsWith('.jsonl')) chatKeys.add(f.replace(/\.jsonl$/, ''));
    }
  }
  decayIntimacy({ agentCwd: cfg.agentCwd, chatKeys: [...chatKeys] });

  for (let i = 1; i <= days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    if (readDiary(cfg.agentCwd, key)) continue;
    const byChat = collectDayMessages(cfg.dataDir, key);
    if (!Object.keys(byChat).length) continue; // 那天没人说话，不硬写
    try {
      const res = await buildDiaryFor({ runner, cfg, key });
      if (res) made.push(res);
    } catch (e) {
      log('warn', `补写日记失败 ${key}: ${e.message}`);
    }
  }
  return made;
}

/**
 * 兼容老接口：确保「昨天」的日记存在。
 * @returns {Promise<{key:string,text:string}|null>}
 */
export async function ensureYesterdayDiary({ runner, cfg, now = new Date() }) {
  const made = await catchUpDiaries({ runner, cfg, now });
  if (!made.length) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const key = dayKey(y);
    const existed = readDiary(cfg.agentCwd, key);
    return existed ? { key, text: existed } : null;
  }
  return made[made.length - 1];
}
