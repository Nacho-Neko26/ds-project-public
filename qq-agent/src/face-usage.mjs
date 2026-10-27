// QQ 黄脸表情（face 段）的使用统计。
// 群里别人发的小黄脸现在只在正文里显示成「[表情]」，从来没被记下来，
// 所以机器人手上没有「这个群习惯用哪几个黄脸」的底子。
// 这里按 id 累计次数，给 prompt 里的目录用；发出去之后走 sticker-usage 的冷却。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'face-usage.json';
const MAX_IDS = 200;

function fileOf(dataDir) {
  return path.join(dataDir, FILE);
}

export function loadFaceUsage(dataDir) {
  try {
    const raw = fs.readFileSync(fileOf(dataDir), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveFaceUsage(dataDir, all) {
  const f = fileOf(dataDir);
  const tmp = `${f}.tmp`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, f);
  } catch {
    // 统计失败不能影响聊天
  }
}

/** 记一次黄脸使用。id 必须是数字串。 */
export function recordFaceUse(dataDir, id, name = '') {
  const idStr = String(id ?? '').trim();
  if (!/^\d+$/.test(idStr)) return;
  const all = loadFaceUsage(dataDir);
  const cur = all[idStr] || { count: 0, lastAt: 0, name: '' };
  cur.count = Number(cur.count || 0) + 1;
  cur.lastAt = Date.now();
  if (name) cur.name = String(name).slice(0, 12);
  all[idStr] = cur;

  const keys = Object.keys(all);
  if (keys.length > MAX_IDS) {
    keys.sort((a, b) => Number(all[a].lastAt || 0) - Number(all[b].lastAt || 0));
    for (const k of keys.slice(0, keys.length - MAX_IDS)) delete all[k];
  }
  saveFaceUsage(dataDir, all);
}

/** 从 OneBot 原始消息段里扫出所有 face 并记账 */
export function recordFaces(dataDir, message, names = {}) {
  if (!Array.isArray(message)) return;
  for (const s of message) {
    if (s?.type !== 'face') continue;
    const id = s.data?.id;
    const name = names[String(id)] || s.data?.raw?.faceText || '';
    recordFaceUse(dataDir, id, name);
  }
}

/** 按「用得多的优先」取前 n 个，返回 [{id, name, count}] */
export function topFaces(usage, n = 10) {
  const rows = Object.entries(usage || {})
    .map(([id, v]) => ({ id, name: v?.name || '', count: Number(v?.count || 0) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  return rows.slice(0, n);
}
