import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, hhmm, safeFileName } from './util.mjs';
import { defaultNick } from './character.mjs';

/**
 * 每天一条 QQ 空间说说。
 *
 * 到点（默认 23:20）做三件事：
 *   1. 把今天的素材收一收：和号主的私聊、最近几天的日记、各群的滚动摘要；
 *   2. 让模型以人设口吻写一条几十字的说说（挑一件有意思的小事）；
 *   3. 走 SnowLuma 的 send_qzone_msg 发出去，tid 存下来。
 *
 * 为什么素材不放群聊原文：说说谁都看得见，群友说的话不能搬出去。
 * 摘要本来就是压过的、不带原话，私聊是号主自己的，日记是它自己写的。
 */

const DEFAULTS = {
  enabled: true,
  hour: 23,
  minute: 20,
  ugcRight: 1,          // 1 所有人可见
  maxChars: 90,
  minChars: 15,
  maxInputChars: 6000,
  maxAttempts: 3,
  privacyGuard: true,   // 写出带人名/机构/联系方式的，重写；重写不干净就不发
  maxRegenerate: 2,
};

export function qzoneConfig(cfg) {
  return { ...DEFAULTS, ...(cfg.raw.qzone || {}) };
}

function stateFile(cfg) {
  return path.join(cfg.dataDir, 'qzone.json');
}

function loadState(cfg) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(cfg), 'utf8'));
    if (s && typeof s === 'object') return { posts: [], ...s };
  } catch { /* 第一次跑 */ }
  return { lastDay: '', posts: [] };
}

function saveState(cfg, st) {
  const file = stateFile(cfg);
  const tmp = `${file}.tmp`;
  st.posts = (st.posts || []).slice(-30);
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function dayKeyLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 收集今天的素材。
 * @returns {{text:string, chars:number, sources:string[]}}
 */
export function collectDigest({ cfg, now = new Date() }) {
  const conf = qzoneConfig(cfg);
  const dayStart = new Date(now.getTime());
  dayStart.setHours(0, 0, 0, 0);
  const since = dayStart.getTime();
  const parts = [];
  const sources = [];

  // 1) 和号主的私聊（今天）
  for (const uid of (cfg.raw.persona?.ownerUids || [])) {
    const file = path.join(cfg.dataDir, 'history', `${safeFileName(`private:${uid}`)}.jsonl`);
    const rows = readJsonl(file, 20000).filter((r) => Number(r.t) >= since);
    if (!rows.length) continue;
    const lines = rows.slice(-100).map((r) => {
      const who = r.role === 'bot' ? '我' : (r.name || '他');
      return `${hhmm(r.t)}【${who}】${r.text}`;
    });
    parts.push(`【和号主的私聊】\n${lines.join('\n')}`);
    sources.push(`private:${uid}`);
  }

  // 2) 最近两天的日记（它自己写的，最像「今天发生了什么」）
  try {
    const dir = path.join(cfg.agentCwd, 'diary');
    const files = fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .slice(-2)
      .reverse();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').trim().slice(0, 900);
      if (text) {
        parts.push(`【${f.replace('.md', '')} 的日记】\n${text}`);
        sources.push(`diary:${f.replace('.md', '')}`);
      }
    }
  } catch { /* 还没日记 */ }

  // 3) 各群的滚动摘要（压过的，不带原话）
  try {
    const dir = path.join(cfg.agentCwd, 'summary');
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 2);
    for (const { f } of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').trim().slice(-700);
      if (text) {
        parts.push(`【某群的聊天摘要】\n${text}`);
        sources.push(`summary:${f}`);
      }
    }
  } catch { /* 还没摘要 */ }

  let text = parts.join('\n\n');
  if (text.length > conf.maxInputChars) text = text.slice(-conf.maxInputChars);
  // 从源头先遮一道：材料里的人名一律换成「某人」，模型想抄也没得抄
  for (const n of collectPrivateNames(cfg)) {
    if (n.length >= 2) text = text.split(n).join('某人');
  }
  return { text, chars: text.length, sources };
}

const PROMPT_HEAD = [
  '下面是你今天真实经历过的材料（聊天记录、日记、群摘要）。',
  '挑一件真正有意思、能对外说的小事，用你自己的口吻写一条 QQ 空间说说。',
  '',
  '要求：',
  '- 40~80 个字，一两句话，第一人称，口语，像随口记一下',
  '- 具体到一个画面或一件小事（吃了什么、看到什么、被谁说了一句什么），别写空泛的感想',
  '- **不许出现任何具体的人名/昵称**，提到人一律用「他」「朋友」「有个家伙」代替；',
  '  也不写学校、公司、班级、宿舍、地址、电话、微信、QQ 号，不搬别人的原话',
  '- 不加引号、不加话题标签、不用颜文字；最多一个表情符号',
  '- 只输出说说正文，不要解释，不要「说说：」这种前缀',
  '',
  '【今天的材料】',
];

/** 让模型写这条说说；失败返回 null。extraRule 用来在重写时追加约束 */
export async function generatePost({ runner, digest, note, extraRule = '' }) {
  const tail = extraRule ? `\n\n（${extraRule}）` : '';
  const prompt = `${PROMPT_HEAD.join('\n')}\n${digest}${tail}\n\n只输出说说正文。`;
  const r = await runner.run({ prompt, toolMode: 'none' });
  if (!r?.ok) {
    note?.('warn', `说说生成失败：${(r?.stderr || '').slice(-300) || '模型没输出'}`);
    return null;
  }
  return cleanPost(r.text, {});
}

/* ---------- 隐私护栏 ---------- */

// 不靠模型自觉：写出来之后再扫一遍，命中就重写，重写还不行就不发。
const PRIVACY_PATTERNS = [
  { re: /\d{5,}/, why: '长串数字（QQ号/电话/学号）' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, why: '邮箱' },
  { re: /https?:\/\/|www\./i, why: '链接' },
  {
    // 只拦「具体到能定位人」的：校名、宿舍号、证件、联系方式。
    // 「学校门口」「公司楼下」这种泛指不算隐私，别为了它反复重写。
    re: /(学院|大学|中学|小学|高中|初中|班级|宿舍|寝室|身份证|银行卡|微信号|手机号|电话号码)/,
    why: '机构/联系方式',
  },
];

/** 从所有人物档案里收集「不能被写进说说」的名字 */
export function collectPrivateNames(cfg) {
  const names = new Set();
  const dir = path.join(cfg.agentCwd, 'profiles');
  if (!fs.existsSync(dir)) return [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    let db;
    try {
      db = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch { continue; }
    for (const p of Object.values(db.people || {})) {
      const dn = String(p.displayName || '').trim();
      if (dn.length >= 2) names.add(dn);
      const ov = p.callOverride?.name;
      if (ov && String(ov).length >= 2) names.add(String(ov));
      const nf = String(p.nickFor || '').trim();
      if (nf.length >= 2 && nf !== defaultNick('')) names.add(nf);
    }
  }
  return [...names];
}

/** 命中了哪些隐私信息 */
export function privacyHits(text, names = []) {
  const t = String(text || '');
  const hits = [];
  for (const n of names) {
    if (n && n.length >= 2 && t.includes(n)) hits.push(`人名「${n}」`);
  }
  for (const { re, why } of PRIVACY_PATTERNS) {
    if (re.test(t)) hits.push(why);
  }
  return [...new Set(hits)];
}

/** 去掉引号/前缀、压掉换行，按 maxChars 截到句号内 */
export function cleanPost(raw, { maxChars = 90 } = {}) {
  let t = String(raw || '').trim();
  // 模型偶尔会带 ``` 或「说说：」
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '');
  t = t.replace(/^\s*(说说|QQ空间说说)\s*[:：]\s*/, '');
  t = t.replace(/^[「『"'“](.*)[」』"'”]$/s, '$1');
  t = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  t = t.replace(/\s{2,}/g, ' ').trim();
  if (t.length > maxChars) {
    // 尽量在标点处断
    const cut = t.slice(0, maxChars);
    const idx = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'));
    t = idx >= maxChars * 0.5 ? cut.slice(0, idx + 1) : cut;
  }
  return t;
}

/** 发出去；返回 {ok, tid} */
export async function postToQzone({ ob, cfg, text }) {
  const conf = qzoneConfig(cfg);
  const data = await ob.sendQzoneMsg({ content: text, ugcRight: conf.ugcRight });
  return { ok: true, tid: data?.tid ?? '' };
}

/**
 * 到点检查一次。force=true 时忽略时间窗（控制台手动发）。
 * @returns {Promise<{posted:boolean, reason?:string, text?:string, tid?:string}>}
 */
export async function maybePostDaily({
  cfg, runner, ob, note, now = new Date(), force = false, dryRun = false,
}) {
  const conf = qzoneConfig(cfg);
  if (!conf.enabled) return { posted: false, reason: 'disabled' };

  // 服务器紧张时后台整理先让路（2026-10-28 用户要求：先保文本回复）。
  // force=true 是号主手动发的，不走这层。
  if (!force) {
    const gate = guardFor(cfg).allow('bg');
    if (!gate.ok) {
      if (typeof note === 'function') note('info', `[说说] ${gate.reason}`);
      return { posted: false, reason: 'busy', detail: gate.reason };
    }
  }

  const day = dayKeyLocal(now);
  const st = loadState(cfg);
  const mins = now.getHours() * 60 + now.getMinutes();
  const target = conf.hour * 60 + conf.minute;

  if (!force) {
    if (st.lastDay === day) return { posted: false, reason: 'already' };
    if (mins < target) return { posted: false, reason: 'not yet' };
    const att = st.attempts || {};
    if (att.day === day && Number(att.n) >= conf.maxAttempts) {
      return { posted: false, reason: 'gave up today' };
    }
  }

  const digest = collectDigest({ cfg, now });
  if (digest.chars < 60) {
    st.lastDay = day;
    st.attempts = { day, n: 0 };
    saveState(cfg, st);
    note?.('info', '今天没什么素材，跳过说说');
    return { posted: false, reason: 'no material' };
  }

  let text = null;
  try {
    text = await generatePost({ runner, digest: digest.text, note });
  } catch (e) {
    note?.('warn', `说说生成异常：${e.message}`);
  }

  const att = st.attempts?.day === day ? Number(st.attempts.n) || 0 : 0;
  if (!text || text.length < conf.minChars) {
    st.attempts = { day, n: att + 1 };
    saveState(cfg, st);
    note?.('warn', `说说没写出来（第 ${att + 1} 次），下次再试`);
    return { posted: false, reason: 'generate failed' };
  }

  text = cleanPost(text, { maxChars: conf.maxChars });

  // 隐私硬闸：写出来之后再扫，命中就重写；重写还不干净就今天不发
  if (conf.privacyGuard) {
    const names = collectPrivateNames(cfg);
    let hits = privacyHits(text, names);
    const tries = Math.max(0, Number(conf.maxRegenerate) || 2);
    for (let i = 0; i < tries && hits.length; i++) {
      note?.('warn', `说说里带了隐私信息（${hits.join('、')}），重写第 ${i + 1} 次`);
      const again = await generatePost({
        runner,
        digest: digest.text,
        note,
        extraRule: `上一版出现了「${hits[0]}」。这一版一个具体的人名、机构、联系方式都不许出现，`
          + '提到人只写「他」「朋友」「有个家伙」。',
      }).catch(() => null);
      if (!again) break;
      text = cleanPost(again, { maxChars: conf.maxChars });
      hits = privacyHits(text, names);
    }
    if (hits.length) {
      st.lastDay = day;
      st.attempts = { day, n: 0 };
      saveState(cfg, st);
      note?.('warn', `说说重写 ${tries} 次仍有隐私（${hits.join('、')}），今天不发`);
      return { posted: false, reason: 'privacy', text };
    }
  }

  if (dryRun) {
    note?.('info', `说说预演（没发）：${text}`);
    return { posted: false, reason: 'dryRun', text };
  }
  try {
    const { tid } = await postToQzone({ ob, cfg, text });
    st.lastDay = day;
    st.lastPost = { day, text, tid, at: Date.now() };
    st.posts = [...(st.posts || []), st.lastPost];
    st.attempts = { day, n: 0 };
    saveState(cfg, st);
    note?.('info', `说说已发（${text.length} 字，tid=${tid || '?'}）：${text.slice(0, 40)}`);
    return { posted: true, text, tid };
  } catch (e) {
    st.attempts = { day, n: att + 1 };
    saveState(cfg, st);
    note?.('warn', `说说发送失败（第 ${att + 1} 次）：${e.message}`);
    return { posted: false, reason: `send failed: ${e.message}`, text };
  }
}

export function qzoneState(cfg) {
  return loadState(cfg);
}
