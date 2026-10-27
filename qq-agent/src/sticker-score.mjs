// 表情挑选打分：移植 dsh-nekowhale-stickers 的 search.ts 机制
// 思路：查询词按权重命中各字段（名字 6 / 标签 5 / 情绪 4 / 用途 3 / 描述 1 …），
// 多词查询再乘「命中覆盖率²」——只命中一个词的图会被压下去。
const WEIGHTS = [
  ['name', 6],
  ['tagsJoined', 5],
  ['emotion', 4],
  ['text', 4],
  ['use', 3],
  ['en', 2],
  ['desc', 1],
  ['dir', 2],
];

/**
 * 新收录的图给一点额外权重（2026-10-25 用户要求「给新收录的图加一些权重」）。
 * 权重是加在总分上的固定加分，不是乘系数：否则查询词一个都没命中的新图
 * 会乘 0 又变回 0，等于白加。同时它是一张软票——新图排得靠前，但不会
 * 盖过「名字/标签真的命中」的那种硬匹配（最大 +4）。
 * 老库里的行没有 t 字段，按 0 分算，永远不加。
 */
const FRESH_BONUS_MAX = 4;
const FRESH_BONUS_DAYS = 3;
// 2026-10-25 之前入库的行 t 是导入时间，不是「被偷的时间」，不能算新
const FRESH_BONUS_FLOOR = Date.parse('2026-10-25T00:00:00+08:00');

export function freshBonus(row, now = Date.now()) {
  const t = Date.parse(row?.t || '');
  if (!Number.isFinite(t) || t < FRESH_BONUS_FLOOR) return 0;
  const age = now - t;
  if (age < 0) return FRESH_BONUS_MAX;
  const days = age / 86400000;
  if (days >= FRESH_BONUS_DAYS) return 0;
  return FRESH_BONUS_MAX * (1 - days / FRESH_BONUS_DAYS);
}

function fields(row) {
  return {
    name: row.stem || '',
    tagsJoined: Array.isArray(row.tags) ? row.tags.join(' ') : '',
    emotion: row.emotion || '',
    text: row.text || '',
    use: row.use || '',
    en: row.en || '',
    desc: row.seg?.data?.summary || '',
    dir: row.dir || '',
  };
}

export function terms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，。！？、;；]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 || /[a-z]{2,}/i.test(t))
    .slice(0, 8);
}

export function scoreRow(row, qs) {
  if (!qs.length) return 0;
  const f = fields(row);
  let total = 0;
  let matched = 0;
  for (const q of qs) {
    let best = 0;
    for (const [key, w] of WEIGHTS) {
      const v = String(f[key] || '').toLowerCase();
      if (!v) continue;
      if (v.includes(q)) best = Math.max(best, w);
    }
    if (best > 0) matched++;
    total += best;
  }
  return qs.length > 1 ? total * (matched / qs.length) ** 2 : total;
}

/** 按查询给行排序；分数相同保持原顺序（稳定）。新收录的图带一点加分。 */
export function rankRows(rows, query, now = Date.now()) {
  const qs = terms(query);
  return rows
    .map((row, i) => ({ row, i, s: scoreRow(row, qs) + freshBonus(row, now) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.row);
}
