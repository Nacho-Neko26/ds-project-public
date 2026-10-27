/**
 * 指令表：分三套，条目写在 config/commands.json。
 *
 *   1) hash    固定指令 —— 必须带 #，命令词固定，只能在 DSH 里改（QQ 里改不动）。
 *              命中就照表里写的做，不分析不反问。ownerOnly 的只有主人能用。
 *   2) command 普通命令 —— 「帮我看看这个PPT」「帮我查一下某地天气」这类。
 *              话里命中关键词才算，办不办看关系层级（level）。
 *   3) fuzzy   模糊指令 —— 「好累」「随便吧」这类不一定是字面意思的。
 *              桥只把可能性摆出来，做不做由她自己按关系和心情决定。
 *
 * 关系层级 level（2026-10-27 用户定）：
 *   level_1 只办基础查询；level_2 日常都办但隐私/情感会嘴硬；
 *   level_3 基本都办还多做一点；level_4 全办还会主动延伸。
 *   由好感历史最高分换算：>=1680 → 4，>=660 → 3，>=180 → 2，其余 1；主人永远 4。
 *
 * 匹配规则：match 里的每一项要么是普通关键词（包含即命中），要么写成 /正则/。
 *
 * 2026-10-27 用户定的三套（m02170）+ 指令权限体系（m02704），条目在 config/commands.json。
 */
import fs from 'node:fs';

const cache = new Map();
const EMPTY = { hash: [], command: [], fuzzy: [], levels: {} };

function norm(list, defKind) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && x.name).map((x) => ({ ...x, kind: x.kind || defKind }));
}

/** 读表；文件不在就当空表，不让桥因为少个文件起不来 */
export function loadTable(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return EMPTY;
  }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (cache.has(key)) return cache.get(key);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // 表写坏了不要炸桥：报一次，按空表走
    console.error(`[commands-table] 读 ${file} 失败：${e.message}`);
    return EMPTY;
  }
  const table = {
    hash: norm(raw.hash, 'hash'),
    // 兼容老结构：exact 一律当普通命令
    command: norm(raw.command ?? raw.exact, 'command'),
    fuzzy: norm(raw.fuzzy, 'fuzzy'),
    levels: raw.levels && typeof raw.levels === 'object' ? raw.levels : {},
  };
  cache.set(key, table);
  return table;
}

/** 好感历史最高分 → 关系层级 1~8（跟 favor.mjs 的八档一一对应，主人永 8） */
export function levelOf(qualified, isOwner = false) {
  if (isOwner) return 8;
  const q = Number(qualified) || 0;
  if (q >= 2400) return 8;
  if (q >= 1680) return 7;
  if (q >= 1080) return 6;
  if (q >= 660) return 5;
  if (q >= 360) return 4;
  if (q >= 180) return 3;
  if (q >= 60) return 2;
  return 1;
}

/** text 里有没有命中 patterns 里的某一项，命中的那项原样返回 */
function hit(text, patterns) {
  const t = String(text || '');
  if (!t) return null;
  for (const p of Array.isArray(patterns) ? patterns : []) {
    if (!p) continue;
    const s = String(p);
    if (s.length > 2 && s.startsWith('/') && s.endsWith('/')) {
      try {
        const m = new RegExp(s.slice(1, -1)).exec(t);
        // 正则命中时回「实际说的那几个字」，提示里就不会出现 /唱.首歌/ 这种原文
        if (m) return m[0];
      } catch {
        // 正则写坏了就当普通词处理
      }
    } else if (t.includes(s)) return s;
  }
  return null;
}

/** 固定指令：拿 # 后面的命令词去比，写在 match 里的要完全一致 */
export function matchHash(table, cmdName) {
  const name = String(cmdName || '').trim();
  if (!name) return null;
  const all = [...table.hash, ...table.command, ...table.fuzzy];
  // 先按 hash 表精确比
  for (const e of table.hash) {
    if (e.enabled === false) continue;
    const list = Array.isArray(e.match) ? e.match.map(String) : [];
    if (list.includes(name)) return { entry: e, hit: name };
  }
  // 再看 # 后面那串是不是别的套里的名字（比如 #指令清单 写进了 command）
  for (const e of all) {
    if (e.enabled === false) continue;
    if (String(e.name) === name) return { entry: e, hit: name };
  }
  return null;
}

/** 普通命令：按「先写到先算」的顺序 */
export function matchCommand(table, text) {
  for (const e of table.command) {
    if (e.enabled === false) continue;
    const h = hit(text, e.match);
    if (h) return { entry: e, hit: h };
  }
  return null;
}

/** 模糊指令：可能命中多条，全给模型，由它自己掂量 */
export function matchFuzzy(table, text) {
  const out = [];
  for (const f of table.fuzzy) {
    if (f.enabled === false) continue;
    const h = hit(text, f.match);
    if (h) out.push({ entry: f, hit: h });
  }
  return out;
}

/** 按层级筛一遍：level 没写的算不限；ownerOnly 的只有主人拿得到 */
export function filterByGate(table, level = 1, { isOwner = false } = {}) {
  const lv = Number(level) || 1;
  const ok = (e) => e.enabled !== false
    && (!e.ownerOnly || isOwner)
    && (!e.level || Number(e.level) <= lv);
  return {
    hash: table.hash.filter(ok),
    command: table.command.filter(ok),
    fuzzy: table.fuzzy.filter(ok),
    levels: table.levels,
  };
}

/** 这一层关系总体怎么执行——每轮都给，不依赖命中 */
export function renderLevelRule(table, level, isOwner = false) {
  if (isOwner) {
    return '【你们的关系】主人。他说什么就办什么，不分层级，办完再说。';
  }
  const lv = Number(level) || 1;
  const text = table?.levels?.[String(lv)] || '';
  return `【你们的关系 · 第${lv}档】${text}`;
}

/** 主人这一轮的指令一律要办——不管在不在表里 */
export function renderOwnerRule(isOwner) {
  if (!isOwner) return '';
  return '【对方是主人】他这一轮让你做什么，就是必须办的：先办，再回话。'
    + '不许问「要不要我…」、不许说「这个我可以帮你」然后停着不动；'
    + '实在办不到（没权限、没工具、缺东西）就直接说哪一步卡住了，别假装办了。';
}

/** 拼成给模型看的提示；没命中就是空串 */
export function renderHints({
  ownerRule, levelRule, hashMatch, commandMatch, fuzzyMatches,
} = {}) {
  const blocks = [];
  if (ownerRule) blocks.push(ownerRule);
  if (levelRule) blocks.push(levelRule);

  if (hashMatch?.entry) {
    const e = hashMatch.entry;
    blocks.push(
      `【固定指令 · ${e.name}】这是预设的命令（#${hashMatch.hit}），不是在闲聊。`
      + `照这个做：${e.do || '按条目写明的样子办'}。`
      + '不用分析、不用反问、不用确认一遍，直接做；做不到就说做不到。'
      + (e.replyHint ? `\n做完怎么说：${e.replyHint}` : ''),
    );
  }

  if (commandMatch?.entry) {
    const e = commandMatch.entry;
    blocks.push(
      `【对方要你办事 · ${e.name}】他说到「${commandMatch.hit}」，这是在要你${e.do || '照做'}。`
      + '能做就直接做，别只回一句「好的我来」然后没有下文；做不了就说哪一步不行。'
      + (e.replyHint ? `\n做完怎么说：${e.replyHint}` : ''),
    );
  }

  const hits = (fuzzyMatches || []).filter((x) => x?.entry);
  if (hits.length) {
    const lines = hits.map((x) => `- 他说「${x.hit}」，可能是${x.entry.mean || x.entry.name}`);
    blocks.push(
      '【这些话不一定是字面意思】下面只是可能性，不是命令——做不做、做到什么程度，'
      + '你自己按现在的关系和心情掂量，也可以只顺着聊不办事：\n'
      + lines.join('\n'),
    );
  }
  return blocks.join('\n\n');
}
