import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.QB_LOG_LEVEL ?? 'info'] ?? 20;

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(level, msg, extra) {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const line = extra === undefined ? msg : `${msg} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  const text = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${line}`;
  if (level === 'error' || level === 'warn') console.error(text);
  else console.log(text);
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

export function readJsonl(file, limit = 1000) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  return lines.slice(-limit).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** 按长度切分消息，尽量在标点/换行处断开 */
export function chunkText(text, maxLen) {
  const out = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = -1;
    for (const ch of ['\n', '。', '！', '？', '…', '，', ' ', '.']) {
      const i = rest.lastIndexOf(ch, maxLen);
      if (i > maxLen * 0.5) { cut = i + 1; break; }
    }
    if (cut === -1) cut = maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * 群聊里「在叫本鲸」判定（2026-10-27）。
 * 只认传进来的专属称呼；通用外号（鲸鱼娘/小鲸鱼/DeepSeek酱…）在别的鲸鱼娘也在的群里不算叫她。
 */
export function nameHit(names, text) {
  const list = (names || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return false;
  const s = String(text || '');
  return list.some((w) => s.includes(w));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function safeFileName(s) {
  return String(s).replace(/[^\w.-]/g, '_');
}

export function nowMs() {
  return Date.now();
}

export function hhmm(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 两行短句的判定：每行不超过这么多字，整段不超过这么多字 */
const SHORT_LINE_MAX = 28;
const SHORT_TOTAL_MAX = 56;

/**
 * 2026-10-26 用户报：「唔…翻唱也一样卡在队列外面呀祈羽，写不进那个目录就是排不上号，要不你等等，
 * 能写了本鲸第一个唱给你听」——这种 48 字的一长条，本该在「号，」后面另发一条。
 * 桥原来只在「正好两行且都很短」时才拆，模型写成一整行就一刀不切（maxCharsPerMessage 是 700）。
 * 这里补一条：40~90 字之间的单条，在 34 字以内最后一个标点处断成两条，像人连发。
 * 上限 90 是故意的——提醒、翻唱回执那种功能性长文不动，免得被切成九段。
 * 34 这个数是对着用户那条原话量的：48 字那句的第二个逗号在 30，正好断在「号，」后面。
 */
export function splitOverlongMessage(text, { softMin = 40, softMax = 90, cut = 34 } = {}) {
  const t = String(text || '').trim();
  if (t.length <= softMin || t.length > softMax) return [t];
  const out = [];
  let rest = t;
  while (rest.length > softMin) {
    let at = -1;
    for (const ch of ['。', '！', '？', '…', '，', '、', '；', ' ']) {
      const i = rest.lastIndexOf(ch, cut);
      if (i >= 12) { at = i + 1; break; }
    }
    if (at === -1) break;
    const head = rest.slice(0, at).trim();
    const tail = rest.slice(at).trim();
    if (!head || !tail) break;
    out.push(head);
    rest = tail;
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * 把模型输出切成多条消息。三种断点都认：
 *   1. 显式标记 `<分>` 或 `|||`
 *   2. 空行（模型自己分段，最常用）
 *   3. 两行短句（没空行也算）——真人连发两条就是这样，别合成一大坨
 * 超出 maxMessages 的并到最后一条。
 */
export function splitMessages(text, { maxMessages = 3, splitShortLines = true } = {}) {
  const raw = String(text || '')
    .split(/(?:\r?\n)?\s*(?:<分>|\|\|\|)\s*(?:\r?\n)?/)
    .flatMap((chunk) => chunk.split(/(?:\r?\n)\s*(?:\r?\n)+/))
    .flatMap((chunk) => {
      if (!splitShortLines) return [chunk];
      const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length !== 2) return [chunk];
      if (chunk.length > SHORT_TOTAL_MAX) return [chunk];
      if (!lines.every((l) => l.length <= SHORT_LINE_MAX)) return [chunk];
      return lines;
    })
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length <= maxMessages) return raw;
  return [...raw.slice(0, maxMessages - 1), raw.slice(maxMessages - 1).join('\n')];
}

// 自动把「一条长回复」在逗号处断成两条（2026-10-26）。
// 缘由：persona 里一直写着「超过 40 字桥会在逗号处替你断开」，但 splitMessages 只认显式
// <分> / 空行，模型又习惯一条写完 —— 于是每条回复都是 30~50 字一整条，看着就"一行半、很统一"。
// 这里补上真正的兜底：只在【已经是一条】且【超过阈值】时才断，切点取最靠近中间的标点。
const AUTO_SPLIT_SEPS = new Set(['，', '；', '。', '？', '！', '、', '…', '~', '～', ',', ';']);

/** 单段切一次：取最靠近中间的标点，太靠边不切。切不动返回 null。 */
function splitOnce(text, cap) {
  const s = String(text || '').trim();
  if (s.length <= cap) return null;
  const mid = s.length / 2;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < s.length; i += 1) {
    if (!AUTO_SPLIT_SEPS.has(s[i])) continue;
    if (i < 5 || i > s.length - 4) continue; // 太靠边不切，切了也是半句
    const d = Math.abs(i - mid);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  const a = s.slice(0, best).trim().replace(/[，、；…~～]+$/, '');
  const b = s.slice(best + 1).trim();
  if (a.length < 5 || b.length < 4) return null;
  return [a, b];
}

/**
 * 把过长的消息在标点处断开（2026-10-26 加，2026-10-27 改成逐段判断）。
 * 旧版有个洞：只要模型自己分过行（parts.length !== 1）就整条跳过长度检查，
 * 于是「17 字、带逗号、但自己写了换行」的那种两段照样原样发出去 —— 正是用户说的「标准两端式」。
 * 现在每一段单独量，超阈值就切，总数不超过 maxMessages 条。
 */
export function autoSplitLong(parts, { limit = 40, maxMessages = 3 } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  const cap = Number(limit);
  if (!cap || cap < 8) return parts;
  const queue = parts.map((p) => String(p ?? ''));
  const out = [];
  let guard = 0;
  while (queue.length && guard < 12) {
    guard += 1;
    const t = queue.shift();
    if (out.length + queue.length + 2 > maxMessages) { out.push(t); continue; }
    const pair = splitOnce(t, cap);
    if (!pair) { out.push(t); continue; }
    queue.unshift(pair[1], pair[0]);
  }
  while (queue.length) out.push(queue.shift());
  return out.filter((s) => String(s).trim());
}
