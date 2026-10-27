/**
 * 目录去重 + 抽样（2026-10-25 用户要求「每次用完表情就换一批」）。
 *
 * 为什么要有抽样：共享图库三百多张，目录每轮只列前 30 条，如果永远取同一批，
 * 模型看见的永远是那几张。这里用一个游标（data/sticker-rotate.json）记住
 * 「上一批抽到了哪些键」，下一批优先挑没进过上一批的，挑完游标前移；
 * 上一批发过图也顺手把游标前移一格，保证下一轮立刻换一批。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_KEYS = 300;

export function usageFile(dataDir) {
  return path.join(dataDir, 'sticker-usage.json');
}

export function loadUsage(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(usageFile(dataDir), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveUsage(dataDir, usage) {
  const entries = Object.entries(usage || {})
    .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
    .slice(0, MAX_KEYS);
  const tmp = `${usageFile(dataDir)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(tmp, usageFile(dataDir));
  } catch { /* 台账写坏了不该影响发图 */ }
}

/** 记一次「发出去了」。key 用文件名，跨机器/跨路径都稳定。 */
export function recordUse(dataDir, key, now = Date.now()) {
  const k = String(key || '').trim();
  if (!k) return;
  const usage = loadUsage(dataDir);
  usage[k] = { at: now, n: Number(usage[k]?.n || 0) + 1 };
  saveUsage(dataDir, usage);
}

/** 这张是不是刚发过（默认 25 分钟内算「刚」）。 */
export function sentRecently(usage, key, now = Date.now(), windowMs = 25 * 60000) {
  const at = Number(usage?.[String(key || '')]?.at || 0);
  return at > 0 && now - at <= windowMs;
}

/**
 * 目录去重：同一张图只留最新那条编号（同一张图会被收到很多次，编号不同但图一样）。
 * rows 是原始顺序，返回 [{ index, rec, key }]，保持原顺序。
 */
export function uniqueRows(rows, keyOf) {
  const list = Array.isArray(rows) ? rows : [];
  const latest = new Map();
  for (let i = 0; i < list.length; i++) {
    const key = keyOf(list[i]);
    if (key) latest.set(key, i);
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const key = keyOf(list[i]);
    if (key && latest.get(key) !== i) continue;
    out.push({ index: i, rec: list[i], key });
  }
  return out;
}

/* ---------------- 抽样：每次换一批 ---------------- */

export function rotateFile(dataDir) {
  return path.join(dataDir, 'sticker-rotate.json');
}

export function loadRotate(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(rotateFile(dataDir), 'utf8'));
    return {
      cursor: Number(raw?.cursor || 0) | 0,
      last: Array.isArray(raw?.last) ? raw.last.map(String) : [],
    };
  } catch {
    return { cursor: 0, last: [] };
  }
}

export function saveRotate(dataDir, state) {
  const tmp = `${rotateFile(dataDir)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ cursor: Number(state?.cursor || 0) | 0, last: (state?.last || []).slice(0, 60) }));
    fs.renameSync(tmp, rotateFile(dataDir));
  } catch { /* 游标写坏了只是换批不生效，别影响发图 */ }
}

/**
 * 从列表里挑 size 条，避开上一批（state.last），游标顺延。
 * 列表比 size 小就直接全给；能用上一批之外填满就优先用外面的，填不满才回头补。
 * 返回 { picked, state }，state 是新的游标状态（调用方负责 saveRotate）。
 */
export function sampleWindow(list, size, state, keyOf = (x) => String(x?.key ?? '')) {
  const items = Array.isArray(list) ? list : [];
  const n = Math.max(0, Number(size) || 0);
  if (!items.length || !n) return { picked: [], state: state || { cursor: 0, last: [] } };
  if (items.length <= n) return { picked: items, state: { cursor: 0, last: items.map(keyOf) } };
  const st = state || { cursor: 0, last: [] };
  const lastSet = new Set(st.last || []);
  const start = ((Number(st.cursor) || 0) % items.length + items.length) % items.length;
  const picked = [];
  const pickedKeys = new Set();
  const pass = (skipLast) => {
    for (let k = 0; k < items.length && picked.length < n; k++) {
      const it = items[(start + k) % items.length];
      const key = keyOf(it);
      if (pickedKeys.has(key)) continue;
      if (skipLast && lastSet.has(key)) continue;
      picked.push(it);
      pickedKeys.add(key);
    }
  };
  pass(true);
  pass(false);
  const end = (start + Math.max(1, picked.length)) % items.length;
  return { picked, state: { cursor: end, last: picked.map(keyOf).concat([...lastSet]).slice(0, 60) } };
}
