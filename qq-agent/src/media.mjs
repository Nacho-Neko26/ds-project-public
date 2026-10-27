/**
 * 媒体处理：下载 QQ 图片到本地，调用 headless dsh 的 read_image 生成文字描述。
 * 这样桥本身不依赖任何额外视觉 provider，复用 DSH 自己的图片通路。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, log } from './util.mjs';

/** 用消息里的 url 把图片下载到 destDir，返回本地绝对路径；失败返回 null。 */
export async function downloadImage(url, destDir, timeoutMs = 20000) {
  if (!url || !/^https?:/i.test(url)) return null;
  ensureDir(destDir);
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);

  // 命中缓存：先按 url 猜的名字找，找不到就按 hash 前缀扫一遍（内容嗅探过，扩展名可能被改过）
  const cached = findCached(hash, destDir);
  if (cached) return cached;

  // 从 url 猜扩展名（QQ 的图片 url 大多数没有后缀，只能兜底成 jpg）
  const extMatch = url.match(/\.(jpe?g|png|gif|webp)(?:[?#]|$)/i);
  const urlExt = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      log('warn', `图片下载失败 HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    // 落盘前用文件头定真身：QQ 送来的动图 url 常无后缀，猜成 .jpg 会让后面的
    // 动图拆帧（animation.mjs 按扩展名判断）整个失效。
    const ext = sniffImageExt(buf) || urlExt;
    const file = path.join(destDir, `${hash}.${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  } catch (e) {
    log('warn', `图片下载异常: ${e.message}`);
    return null;
  }
}

/** 按文件头嗅探真实图片格式，返回扩展名（不含点）；认不出返回 null。 */
export function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';   // GIF8
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';   // \x89PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';                    // JPEG SOI
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'; // RIFF....WEBP
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';                                     // BM
  return null;
}

/** 读本地文件前 16 字节做嗅探；读不到返回 null。 */
export function sniffFileExt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return sniffImageExt(buf.subarray(0, n));
  } catch {
    return null;
  }
}

/**
 * 找同一个 url 下过的文件：优先 hash.ext，其次扫目录里 hash.*。
 * 扫到的文件若扩展名和文件头不符（老版本一律存成了 .jpg），就地改对名字，
 * 这样历史下载的动图不用重新下载也能被拆帧。
 */
function findCached(hash, destDir) {
  const same = () => {
    let names = [];
    try { names = fs.readdirSync(destDir); } catch { return null; }
    return names.filter((n) => n.startsWith(hash + '.')).sort().map((n) => path.join(destDir, n));
  };
  const first = same();
  if (!first) return null;
  for (const f of first) {
    try {
      if (fs.statSync(f).size <= 0) continue;
    } catch { continue; }
    const real = sniffFileExt(f);
    const ext = path.extname(f).slice(1).toLowerCase();
    if (!real || real === ext || (real === 'jpg' && ext === 'jpeg')) return f;
    const fixed = path.join(destDir, `${hash}.${real}`);
    try {
      fs.renameSync(f, fixed);
      return fixed;
    } catch {
      return f;
    }
  }
  return null;
}
