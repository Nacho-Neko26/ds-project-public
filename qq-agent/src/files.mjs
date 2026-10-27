/**
 * QQ 文件接收：把消息里 file 段（别人发来的文件）落到本地，给模型一个能读的路径。
 *
 * 两个来源（2026-10-27 读 napcat.mjs 确认）：
 *  - 段里带 url：NapCat 的 PacketApi 启用时会给（日志 `[Core] [Packet] 使用 NativePacketClient`），直接 fetch 即可；
 *  - 段里只有 file_id：调 OneBot `get_file` 让 NapCat 下到容器 temp，再按挂载关系换成宿主路径拷出来。
 *
 * 单独一个文件是为了能写单测：index.mjs 一 import 就会连 NapCat、起服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, log } from './util.mjs';

/** 单个文件上限。群里有人甩个 2G 的压缩包，不能把它整个读进内存。 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** 文件名最长保留多少字：太长会让落盘路径超限，也让提示词里一行塞不下。 */
const NAME_MAX = 80;

/**
 * 把 QQ 给的文件名洗成能落盘的名字。
 * 只取 basename（防止 `../..` 这种路径穿越），去掉 Windows 不认的字符。
 */
export function safeDownloadName(name, fallback = '文件') {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).trim();
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, NAME_MAX);
  return cleaned || fallback;
}

export function humanSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 同名不覆盖：`说明.md` → `说明-1.md`。
 * 群文件柜里同一个名字可以被不同人传很多次，直接覆盖等于把上一份悄悄吃了。
 */
export function uniquePath(dir, name) {
  const safe = safeDownloadName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'file';
  let file = path.join(dir, safe);
  let i = 1;
  while (fs.existsSync(file)) {
    file = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
    if (i > 200) { file = path.join(dir, `${stem}-${Date.now()}${ext}`); break; }
  }
  return file;
}

/**
 * 下载一个 QQ 文件到 destDir，返回 { file, size }；失败返回 null。
 * 不抛异常：调用方是消息处理主链路，一个文件下不动不能连带把整条回复吞了。
 */
export async function downloadFile(url, destDir, name, timeoutMs = 60000) {
  if (!url || !/^https?:/i.test(url)) return null;
  ensureDir(destDir);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      log('warn', `[文件] 下载失败 HTTP ${res.status}`);
      return null;
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_FILE_BYTES) {
      log('warn', `[文件] 太大（${humanSize(declared)}），不下载`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    if (buf.length > MAX_FILE_BYTES) {
      log('warn', `[文件] 太大（${humanSize(buf.length)}），丢弃`);
      return null;
    }
    const file = uniquePath(destDir, name);
    fs.writeFileSync(file, buf);
    return { file, size: buf.length };
  } catch (e) {
    log('warn', `[文件] 下载异常：${e.message}`);
    return null;
  }
}

/** 把 NapCat 已经下好的文件（容器内路径已换成宿主路径）拷进 destDir。 */
export function copyLocalFile(src, destDir, name) {
  if (!src || !fs.existsSync(src)) return null;
  try {
    const size = fs.statSync(src).size;
    if (!size) return null;
    if (size > MAX_FILE_BYTES) {
      log('warn', `[文件] 太大（${humanSize(size)}），不接收`);
      return null;
    }
    ensureDir(destDir);
    const file = uniquePath(destDir, name || path.basename(src));
    fs.copyFileSync(src, file);
    return { file, size };
  } catch (e) {
    log('warn', `[文件] 转存失败：${e.message}`);
    return null;
  }
}

/** 能当文本读的扩展名。其余一律只说「存到哪了」，别把二进制塞进 prompt。 */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.tsv', '.log',
  '.html', '.htm', '.css', '.sh', '.bat', '.ps1', '.c', '.h', '.cpp', '.hpp', '.java',
  '.go', '.rs', '.sql', '.xml', '.env', '.gitignore',
]);

/** 文本预览的字数上限：再长就让模型自己去读文件。 */
const PREVIEW_MAX = 1200;

/**
 * 小文本文件的预览。返回 null 表示「不给预览」（二进制 / 太大 / 读不出来）。
 * 这样群友甩一个 .md 或 .txt，模型这一轮就能直接说到内容，不用再花一次 tool 调用。
 */
export function textPreview(file, maxChars = PREVIEW_MAX) {
  try {
    const ext = path.extname(String(file || '')).toLowerCase();
    if (!TEXT_EXT.has(ext)) return null;
    const size = fs.statSync(file).size;
    if (!size || size > 64 * 1024) return null;
    const raw = fs.readFileSync(file);
    if (raw.includes(0)) return null; // 有 NUL 就当二进制
    let s = raw.toString('utf8').replace(/\r\n/g, '\n').trim();
    if (!s) return null;
    if (s.length > maxChars) s = `${s.slice(0, maxChars)}…（后面还有 ${s.length - maxChars} 字，要看自己读文件）`;
    return s;
  } catch {
    return null;
  }
}
