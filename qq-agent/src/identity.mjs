/**
 * 认人：一个人只有一个 QQ 号，但可能有好多名字。
 *
 * 用户 2026-10-25 的原话：
 *   「一个聊天对象可能有多种昵称外号，你要以 QQ 号为准，同时记下他所有外号，
 *     不管哪个外号都能识别到他的 QQ 号，例如"鲸鱼小屋的（沐·枫逸萧）和
 *     涛涛阿姨的爱心小窝里面的（史莱姆）是同一个人"他们好感度是一样的，
 *     所用的档案，记忆印象也要一样，如果问起他们的关系要能说出是同一个人」
 *
 * 所以身份的唯一键是 QQ 号（uid），名字只是别名：
 *   - 每收到一条消息就把「这个 uid 这个名片」记进 profiles/_identities.json；
 *   - prompt 里给一张认人表，模型看到哪个别名都指回同一个 QQ 号；
 *   - 「关于他」的描述跨群共用 profiles/_about-shared.json（见 favor.mjs）。
 *
 * 好感早就按 uid 统一了（profiles/_favor-shared.json），档案/记事本靠这里补齐。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_ALIASES = 8;        // 一个人最多记几个别名
const MAX_RENDER_PEOPLE = 10; // 一轮 prompt 最多列几个人
const MAX_RENDER_ALIASES = 4; // 每个人最多列几个别名

function profilesDir(agentCwd) {
  return path.join(agentCwd, 'profiles');
}

export function identitiesFile(agentCwd) {
  return path.join(profilesDir(agentCwd), '_identities.json');
}

function sharedAboutFile(agentCwd) {
  return path.join(profilesDir(agentCwd), '_about-shared.json');
}

/* ---------- 身份表 ---------- */

let idCache = { mtime: 0, map: {} };

export function readIdentities(agentCwd) {
  const f = identitiesFile(agentCwd);
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs === idCache.mtime) return idCache.map;
    const map = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    idCache = { mtime: st.mtimeMs, map };
    return map;
  } catch {
    idCache = { mtime: 0, map: {} };
    return {};
  }
}

function writeIdentities(agentCwd, map) {
  const f = identitiesFile(agentCwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  idCache = { mtime: 0, map };
}

/** 名片收拾干净：去空白、限长、纯 QQ 号不当别名 */
export function cleanAlias(name, uid) {
  let s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > 24) s = s.slice(0, 24);
  if (String(uid) === s) return '';
  if (/^[0-9]{5,12}$/.test(s)) return '';
  return s;
}

/**
 * 从一张名片里再拆几个「短叫法」。
 * 群友的名片常常是「阮沐の史莱姆」「麻辣小土豆(づ ●─● )づ」这种，
 * 群里真正会喊的是「史莱姆」「小土豆」——只记全名就认不出来。
 */
export function deriveAliases(raw, uid) {
  const out = [];
  let s = String(raw == null ? '' : raw)
    .replace(/[（(【\[<《「『].*?[）)】\]>》」』]/g, ' ')
    .replace(/[\s\u3000\u200b-\u200f\ufe0f]+/g, '');
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, '');
  s = s.replace(/[^\u4e00-\u9fa5A-Za-z0-9の]/g, '');
  if (!s) return out;
  const push = (v) => {
    const a = cleanAlias(v, uid);
    if (a && a.length >= 2 && !out.includes(a)) out.push(a);
  };
  // 原样名片（「沐·枫逸萧」「Y.C」这种带符号的名字要保留原形）
  const rawName = String(raw == null ? '' : raw).trim();
  if (/^[\u4e00-\u9fa5A-Za-z0-9·•._\- ]+$/.test(rawName)) push(rawName);
  // 去掉符号后和原形只差几个分隔符的话就别重复记一份
  const stripped = rawName.replace(/[·•._\- ]/g, '');
  if (s !== stripped) push(s);
  // 「的 / の」后面那一截
  const tail = s.split(/[的の]/).filter(Boolean).pop();
  if (tail && tail !== s) push(tail);
  // 太长的中文名，末尾 3 个字往往才是群里的叫法（麻辣小土豆 → 小土豆）
  const cn = s.replace(/[A-Za-z0-9]/g, '');
  if (/^[\u4e00-\u9fa5]+$/.test(cn) && cn.length >= 5) push(cn.slice(-3));
  return out;
}

/**
 * 记一次「这个人这次叫什么」。
 * @returns {{aliases:string[],chats:string[],updatedAt:number}|null}
 */
export function recordIdentity(agentCwd, uid, name, { chat = '', at = Date.now() } = {}) {
  const id = Number(uid);
  if (!Number.isFinite(id)) return null;
  const incoming = deriveAliases(name, id);
  const map = { ...readIdentities(agentCwd) };
  const cur = map[id] ?? { aliases: [], chats: [], updatedAt: 0 };
  let dirty = false;
  if (incoming.length) {
    const rest = (cur.aliases || []).filter((a) => !incoming.includes(a));
    const next = [...incoming, ...rest].slice(0, MAX_ALIASES);
    if (next.join('\u0000') !== (cur.aliases || []).join('\u0000')) {
      cur.aliases = next;
      dirty = true;
    }
  }
  if (chat && !(cur.chats || []).includes(chat)) {
    cur.chats = [chat, ...(cur.chats || [])].slice(0, 12);
    dirty = true;
  }
  if (!dirty) return cur;
  cur.updatedAt = at;
  map[id] = cur;
  writeIdentities(agentCwd, map);
  return cur;
}

/** 这个人所有叫法（新的在前），没有就空数组 */
export function aliasesOf(agentCwd, uid) {
  const cur = readIdentities(agentCwd)[Number(uid)];
  return cur?.aliases?.length ? cur.aliases.slice() : [];
}

/* ---------- 关于他（跨群一份） ---------- */

let aboutCache = { mtime: 0, map: {} };

export function readSharedAbout(agentCwd) {
  const f = sharedAboutFile(agentCwd);
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs === aboutCache.mtime) return aboutCache.map;
    const map = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    aboutCache = { mtime: st.mtimeMs, map };
    return map;
  } catch {
    aboutCache = { mtime: 0, map: {} };
    return {};
  }
}

export function writeSharedAbout(agentCwd, uid, about) {
  const id = Number(uid);
  if (!Number.isFinite(id)) return;
  const text = String(about || '').trim();
  if (!text) return;
  const f = sharedAboutFile(agentCwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const map = { ...readSharedAbout(agentCwd) };
  const cur = map[id] ?? { chats: [] };
  cur.about = text;
  cur.updatedAt = Date.now();
  map[id] = cur;
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  aboutCache = { mtime: 0, map };
}

/* ---------- 给 prompt 的片段 ---------- */

/**
 * 认人表。uids 是本轮出现的人（发言人、被 @ 的、被点名的）。
 * @param {Map<number,string>} [nameNow] uid -> 这一轮看到的名片（保证最新的名字一定在）
 */
export function renderIdentityBlock(agentCwd, uids = [], nameNow = null) {
  const map = readIdentities(agentCwd);
  const lines = [];
  const seen = new Set();
  for (const raw of uids) {
    const uid = Number(raw);
    if (!Number.isFinite(uid) || seen.has(uid)) continue;
    seen.add(uid);
    const now = nameNow?.get?.(uid);
    let aliases = (map[uid]?.aliases || []).filter((a) => a);
    if (now && !aliases.includes(now)) aliases = [now, ...aliases];
    aliases = aliases.slice(0, MAX_RENDER_ALIASES);
    if (!aliases.length) continue;
    lines.push(aliases.length > 1
      ? `- QQ ${uid}：${aliases.join('、')} —— 都是同一个人`
      : `- QQ ${uid}：${aliases[0]}`);
    if (lines.length >= MAX_RENDER_PEOPLE) break;
  }
  if (!lines.length) return '';
  return [
    '【认人】（QQ 号才是身份，名字只是叫法。同一个 QQ 号换个群换个名片还是同一个人，',
    '档案、好感、关于他的印象都是同一份；被问「A 和 B 是不是一个人」，看 QQ 号答，',
    '不同 QQ 号就算同名也不是一个人。认不出来的人别硬猜。）',
    ...lines,
  ].join('\n');
}

/** 消息文本里提到了哪些人的别名（用于把「史莱姆」对回 QQ 号） */
export function resolveMentions(agentCwd, text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const map = readIdentities(agentCwd);
  const hits = [];
  for (const [uid, cur] of Object.entries(map)) {
    for (const a of cur.aliases || []) {
      if (!a || a.length < 2) continue;
      if (t.includes(a)) {
        hits.push({ uid: Number(uid), alias: a });
        break;
      }
    }
  }
  return hits;
}
