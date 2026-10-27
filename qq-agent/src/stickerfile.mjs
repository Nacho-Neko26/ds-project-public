/**
 * 素材物化路径解析（§16 P0）。纯函数，方便单测。
 * 优先级：rec.file（相对 stashDir）→ rec.local（绝对或相对）→ null。
 * 今天的老库只有 local（Windows 绝对路径），Linux 上必然取不到，所以加了 file 相对路径。
 */
import fs from 'node:fs';
import path from 'node:path';

export function resolveStickerPath(rec, stashDir, { exists = (p) => fs.existsSync(p) } = {}) {
  const cands = [];
  if (rec?.file) cands.push(path.isAbsolute(rec.file) ? rec.file : path.join(stashDir, rec.file));
  if (rec?.local) cands.push(path.isAbsolute(rec.local) ? rec.local : path.join(stashDir, rec.local));
  for (const c of cands) if (c && exists(c)) return c;
  return null;
}
