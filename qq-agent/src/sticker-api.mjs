/**
 * 表情库管理（2026-10-28，把 tools/sticker-admin.mjs 的 CLI 逻辑搬进控制台）
 *
 * 只在本机用：控制台本来就只监听 127.0.0.1，云上访问要开隧道。
 * 数据就是云上那份 _shared.jsonl（346 条），改完立刻生效，不用重启桥。
 *
 * 两条规矩跟 CLI 版一致：
 *   ① 删不是真删——图移到 memes/.trash/，整行追加到 _trash.jsonl，能拉回来
 *   ② 改之前把原文件存一份 _shared.jsonl.bak-<时间>，改坏了能回退
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.join(ROOT, 'workspace');
const SHARED = path.join(WORKSPACE, 'stickers', '_shared.jsonl');
const TRASH = path.join(WORKSPACE, 'stickers', '_trash.jsonl');
const TRASH_DIR = path.join(WORKSPACE, 'memes', '.trash');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

function readRows() {
  let raw = '';
  try { raw = fs.readFileSync(SHARED, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 坏行跳过 */ }
  }
  return rows;
}

function writeRows(rows) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try { fs.copyFileSync(SHARED, `${SHARED}.bak-${stamp}`); } catch { /* 首次没有就算了 */ }
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const tmp = `${SHARED}.new`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, SHARED);
}

function dataOf(row) {
  return row?.seg?.data && typeof row.seg.data === 'object' ? row.seg.data : {};
}

function brief(row, i) {
  const d = dataOf(row);
  return {
    i,
    digest: row.digest || '',
    tag: row.tag || '',
    summary: d.summary || '',
    use: Array.isArray(d.use) ? d.use : [],
    tags: Array.isArray(d.tags) ? d.tags : [],
    mood: Array.isArray(d.moodHints) ? d.moodHints : [],
    ocr: d.ocr || '',
    t: row.t || '',
    hasImg: Boolean(row.local && fs.existsSync(row.local)),
  };
}

/** 列表：支持按摘要/分类/用途模糊搜 */
export function listStickers({ grep = '', offset = 0, limit = 60 } = {}) {
  const rows = readRows();
  const q = String(grep || '').trim();
  const picked = [];
  rows.forEach((row, i) => {
    if (q) {
      const d = dataOf(row);
      const hay = [row.tag, d.summary, (d.use || []).join(','), (d.tags || []).join(','), d.ocr].join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase())) return;
    }
    picked.push(brief(row, i));
  });
  const start = Math.max(0, Number(offset) || 0);
  const n = Math.min(200, Math.max(1, Number(limit) || 60));
  return { total: picked.length, totalAll: rows.length, offset: start, rows: picked.slice(start, start + n) };
}

/** 图片：按行号取原图 */
export function stickerImage(i) {
  const rows = readRows();
  const row = rows[Number(i)];
  if (!row || !row.local) return null;
  const file = path.isAbsolute(row.local) ? row.local : path.join(ROOT, row.local);
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  return { file, mime: MIME[ext] || 'application/octet-stream' };
}

function applyPatch(row, patch) {
  const d = { ...dataOf(row) };
  if (typeof patch.summary === 'string') d.summary = patch.summary.trim();
  if (Array.isArray(patch.use)) d.use = patch.use.map((x) => String(x).trim()).filter(Boolean);
  else if (typeof patch.use === 'string') d.use = patch.use.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
  if (typeof patch.tags === 'string') d.tags = patch.tags.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(patch.tags)) d.tags = patch.tags.map((x) => String(x).trim()).filter(Boolean);
  if (typeof patch.ocr === 'string') d.ocr = patch.ocr.trim();
  const next = { ...row, seg: { ...(row.seg || {}), data: d } };
  if (typeof patch.tag === 'string' && patch.tag.trim()) next.tag = patch.tag.trim();
  return next;
}

/** 改描述 / 用途 / 分类 */
export function updateSticker(patch = {}) {
  const rows = readRows();
  const i = Number(patch.i);
  if (!Number.isInteger(i) || !rows[i]) throw new Error('没这条');
  rows[i] = applyPatch(rows[i], patch);
  writeRows(rows);
  return brief(rows[i], i);
}

/** 删：图挪进 .trash，行记进 _trash.jsonl，能 restore */
export function deleteSticker({ i }) {
  const rows = readRows();
  const idx = Number(i);
  if (!Number.isInteger(idx) || !rows[idx]) throw new Error('没这条');
  const row = rows[idx];
  try { fs.mkdirSync(TRASH_DIR, { recursive: true }); } catch { /* ignore */ }
  let moved = '';
  if (row.local && fs.existsSync(row.local)) {
    const dest = path.join(TRASH_DIR, `${row.digest || Date.now()}${path.extname(row.local)}`);
    try { fs.renameSync(row.local, dest); moved = dest; } catch { /* 挪不动就只删索引 */ }
  }
  try {
    fs.appendFileSync(TRASH, `${JSON.stringify({ ...row, trashedAt: new Date().toISOString(), moved })}\n`, 'utf8');
  } catch { /* ignore */ }
  rows.splice(idx, 1);
  writeRows(rows);
  return { removed: row.digest || '', moved };
}

/** 从回收站拉回来 */
export function restoreSticker({ digest }) {
  const key = String(digest || '').trim();
  if (!key) throw new Error('要 digest');
  let raw = '';
  try { raw = fs.readFileSync(TRASH, 'utf8'); } catch { throw new Error('回收站是空的'); }
  const rows = readRows();
  const lines = raw.split('\n');
  for (let j = lines.length - 1; j >= 0; j--) {
    const s = lines[j].trim();
    if (!s) continue;
    let item;
    try { item = JSON.parse(s); } catch { continue; }
    if (item.digest !== key) continue;
    if (item.moved && fs.existsSync(item.moved)) {
      const back = item.local || path.join(WORKSPACE, 'memes', 'restored', path.basename(item.moved));
      try { fs.mkdirSync(path.dirname(back), { recursive: true }); fs.renameSync(item.moved, back); item.local = back; } catch { /* ignore */ }
    }
    const { trashedAt, moved, ...clean } = item;
    rows.push(clean);
    writeRows(rows);
    lines.splice(j, 1);
    fs.writeFileSync(TRASH, lines.join('\n'), 'utf8');
    return brief(clean, rows.length - 1);
  }
  throw new Error('回收站里没这个 digest');
}

export const stickerPaths = { SHARED, TRASH, WORKSPACE };
