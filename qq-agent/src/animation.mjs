/**
 * 动图拆帧拼片：把 GIF/WebP 动图均匀抽帧，拼成一张从左到右、从上到下的网格图，
 * 让模型用 read_image 一次看完动作。任何一步失败都返回 false/null，退回现状（只看第一帧），
 * 绝不抛异常阻塞回复。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDir } from './util.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_FFMPEG = 'ffmpeg';

// ---------- 纯函数（给测试直接断言参数构造） ----------

/** sha256 内容 hash，取前 16 位十六进制（和 index.mjs 的 hashFile 同风格） */
export function hashContent(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * 拼图输出路径：<原hash>-sheet<帧数>.png，落在 outDir。
 * 帧数要进文件名：否则 8 帧时代的老拼图会被 16 帧直接复用（2026-10-25 加帧数）。
 * 不传 frames 时保持老命名 <hash>-sheet.png（兼容旧调用/测试）。
 */
export function sheetPathFor(fileHash, outDir, frames = null) {
  const tail = frames ? `-sheet${frames}.png` : '-sheet.png';
  return path.join(outDir, `${fileHash}${tail}`);
}

/** 已存在的非空拼图可直接复用 */
export function cachedSheet(sheet) {
  try { return fs.statSync(sheet).size > 0; } catch { return false; }
}

/** 从 totalFrames 里均匀取最多 maxFrames 个帧下标，首尾帧必含 */
export function sampleIndices(totalFrames, maxFrames) {
  const n = Math.max(1, Math.min(totalFrames, maxFrames));
  if (n >= totalFrames) return Array.from({ length: totalFrames }, (_, i) => i);
  if (n === 1) return [0];
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((i * (totalFrames - 1)) / (n - 1)));
  return out;
}

/** 网格列数：最多 4 列，从左到右、从上到下排 */
export function gridDims(frames) {
  const cols = Math.min(Math.max(1, frames), 4);
  const rows = Math.ceil(frames / cols);
  return { cols, rows };
}

/**
 * 拼 ffmpeg 滤镜参数（纯计算，不跑 ffmpeg），便于测试帧数/宽度/抽帧逻辑。
 *
 * 默认 16 帧（4 列 × 4 行）。帧数一多，竖图（9:16）按比例算出来的格子会特别高，
 * 拼图总高能到 2800+，视觉模型会整张压小、反而看不清细节；所以高度也吃一个上限
 * maxHeight（默认 1600）：超出就把格子压矮、用白边补齐（scale 的 decrease + pad 保证不变形）。
 * 这样无论横图竖图，拼图都不超过 maxWidth × maxHeight。
 */
export function buildFilmstripPlan({ totalFrames, width = null, height = null, maxFrames = 16, maxWidth = 1600, maxHeight = 1600 }) {
  const frames = Math.max(1, Math.min(totalFrames, maxFrames));
  const { cols, rows } = gridDims(frames);
  const tileW = Math.max(2, Math.floor(maxWidth / cols));
  const aspect = width && height ? height / width : 1;
  const byAspect = Math.max(2, Math.round(tileW * aspect));
  const hCap = maxHeight ? Math.max(2, Math.floor(maxHeight / rows)) : Infinity;
  const tileH = Math.max(2, Math.min(byAspect, hCap));
  const indices = sampleIndices(totalFrames, frames);
  const selectExpr = indices.length < totalFrames
    ? "select='" + indices.map((n) => 'eq(n\\,' + n + ')').join('+') + "'"
    : null;
  const scalePad = `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:color=white`;
  const tile = `tile=${cols}x${rows}:nb_frames=${frames}`;
  const vf = [selectExpr, scalePad, tile].filter(Boolean).join(',');
  return { frames, cols, rows, tileW, tileH, indices, vf };
}

// ---------- 探测与拆帧（失败一律静默） ----------

function ffprobeBin(ffmpegPath) {
  const p = String(ffmpegPath || DEFAULT_FFMPEG);
  const m = p.match(/^(.*)ffmpeg(\.exe)?$/i);
  return m ? `${m[1] || ''}ffprobe${m[2] || ''}` : null;
}

async function ffprobeJson(probe, file, count) {
  const args = ['-v', 'error', '-select_streams', 'v:0'];
  if (count) args.push('-count_frames');
  args.push('-show_entries', 'stream=nb_frames,nb_read_frames,width,height', '-of', 'json', file);
  const { stdout } = await execFileAsync(probe, args, { timeout: 60000 });
  const s = JSON.parse(stdout)?.streams?.[0] ?? {};
  const asInt = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    frames: asInt(s.nb_read_frames) ?? asInt(s.nb_frames),
    width: asInt(s.width),
    height: asInt(s.height),
  };
}

/** 探测动图帧数与尺寸；探测失败返回 null */
async function probeAnimation(file, ffmpegPath) {
  const probe = ffprobeBin(ffmpegPath);
  if (!probe) return null;
  try {
    let info = await ffprobeJson(probe, file, false);
    if (!info) return null;
    if (info.frames == null) {
      const counted = await ffprobeJson(probe, file, true);
      info = { ...info, ...counted, frames: counted?.frames ?? info.frames };
    }
    return info.frames != null ? info : null;
  } catch {
    return null;
  }
}

/** 探测是否为多帧动图；探测失败或单帧返回 false，不抛异常 */
export async function isAnimated(file, ffmpegPath = DEFAULT_FFMPEG) {
  try {
    const info = await probeAnimation(file, ffmpegPath);
    return !!info && info.frames > 1;
  } catch {
    return false;
  }
}

/**
 * 把动图抽 maxFrames 帧（默认 16 = 4×4）拼成网格图，输出 <原hash>-sheet<帧数>.png。
 * 返回 { sheet, frames }；失败（含单帧/ffmpeg 缺失/命令出错）返回 null，绝不抛异常。
 */
export async function buildFilmstrip(file, outDir, { ffmpegPath = DEFAULT_FFMPEG, maxFrames = 16, maxWidth = 1600, maxHeight = 1600 } = {}) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const info = await probeAnimation(file, ffmpegPath);
    if (!info || info.frames < 2) return null;

    const dir = outDir || path.dirname(file);
    ensureDir(dir);
    const hash = hashContent(fs.readFileSync(file));
    const frames = Math.min(info.frames, Math.max(1, maxFrames));
    const sheet = sheetPathFor(hash, dir, frames);
    if (cachedSheet(sheet)) return { sheet, frames };

    const plan = buildFilmstripPlan({ totalFrames: info.frames, width: info.width, height: info.height, maxFrames, maxWidth, maxHeight });
    await execFileAsync(ffmpegPath, [
      '-v', 'error', '-y', '-vsync', '0', '-i', file,
      '-vf', plan.vf,
      '-frames:v', '1', '-pix_fmt', 'rgba',
      sheet,
    ], { timeout: 120000 });

    return cachedSheet(sheet) ? { sheet, frames: plan.frames } : null;
  } catch {
    return null;
  }
}

/** 按文件头判断这是不是 gif/webp；不是（或读不到）返回 'other'，免得白跑一次 ffprobe。 */
export function imageKindOf(file) {
  if (!file || !fs.existsSync(file)) return 'other';
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(16);
    const n = fs.readSync(fd, b, 0, 16, 0);
    fs.closeSync(fd);
    if (n >= 12) {
      if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
      if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
      if (b[0] === 0x89 && b[1] === 0x50) return 'png';
    }
  } catch { /* 读不到就走扩展名兜底 */ }
  const ext = path.extname(file || '').toLowerCase();
  if (ext === '.gif') return 'gif';
  if (ext === '.webp') return 'webp';
  return 'other';
}

/**
 * resolveImages 的动图分支：只看文件头是不是 gif/webp（不看扩展名——QQ 的图片 url
 * 多半没有后缀，历史下载的文件可能都叫 .jpg），是才探测帧数，多帧才拆帧拼图。
 * deps 可注入假函数，方便测试提示文本替换；任何异常都返回 null（走原图逻辑）。
 */
export async function resolveAnimatedSheet(file, outDir, { ffmpegPath = DEFAULT_FFMPEG, maxFrames = 16, maxWidth = 1600, maxHeight = 1600, isAnimatedFn = isAnimated, buildFilmstripFn = buildFilmstrip, imageKindFn = imageKindOf } = {}) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const kind = imageKindFn(file);
    if (kind !== 'gif' && kind !== 'webp') return null;
    if (!(await isAnimatedFn(file, ffmpegPath))) return null;
    return await buildFilmstripFn(file, outDir, { ffmpegPath, maxFrames, maxWidth, maxHeight });
  } catch {
    return null;
  }
}

/**
 * 可信用户：让模型自己 read_image 看拼图。
 * 2026-10-26 用户抱怨「十六张一块儿砸过来」——`${frames} 张图` 的说法一定要压住：
 * 这是【一张】动图的 ${frames} 帧，不是 ${frames} 张图。
 */
export function trustedAnimatedHint(sheetRel, frames) {
  return `[对方发来的是【一张】动图（一个 GIF，不是 ${frames} 张图），共 ${frames} 帧，已按时间顺序拼成一张网格图存到 ${sheetRel}；`
    + `第 1 帧在左上、最后一帧在右下；用 read_image 看它再据此回应，别把这一张说成「${frames} 张图」]`;
}

/** 非可信用户：桥先描述拼图，再把描述塞进 prompt（口径同上：一张动图的多帧） */
export function describeAnimatedHint(frames, body) {
  return `[对方发来的是【一张】动图（一个 GIF，不是 ${frames} 张图），桥把这一张拆成 ${frames} 帧按时间顺序看完了，整个过程是：${body}]`;
}
