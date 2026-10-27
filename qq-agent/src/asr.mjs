import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 听语音。
 *
 * QQ 个人号发来的语音是 SILK（`#!SILK_V3`），系统 ffmpeg 解不了。
 * NapCat 自己带了解码器，所以先让它把语音转成 wav（`get_record out_format=wav`），
 * 再统一用 ffmpeg 转成 16k 单声道，交给本机的 SenseVoice 服务转文字。
 *
 * 三步任何一步失败都只是「没听清」，不影响回复——不能因为听不见就把整轮带崩。
 */

const DEFAULTS = {
  enabled: true,
  url: 'http://127.0.0.1:3912/asr',
  timeoutMs: 25000,
  maxSeconds: 120,      // 超过 2 分钟的语音不转（费时又不常出现）
  ffmpeg: 'ffmpeg',
};

export function asrConfig(cfg) {
  return { ...DEFAULTS, ...(cfg.raw.asr || {}) };
}

/** ffmpeg 转成 16k 单声道 wav；失败返回 null */
async function toWav16k(input, dest, ffmpeg = 'ffmpeg') {
  try {
    await execFileAsync(ffmpeg, [
      '-v', 'error', '-y', '-i', input,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest,
    ], { timeout: 30000 });
    return fs.existsSync(dest) && fs.statSync(dest).size > 44 ? dest : null;
  } catch {
    return null;
  }
}

/** 从 NapCat 拿语音文件：优先让它转 wav，退而求其次下载 url 原文件 */
async function fetchRecordSource({ ob, rec, dir, note }) {
  const stamp = crypto.createHash('sha1').update(`${rec.file || ''}|${rec.url || ''}|${Date.now()}`)
    .digest('hex').slice(0, 12);

  if (rec.file && ob) {
    try {
      const r = await ob.call('get_record', { file: rec.file, out_format: 'wav' }, 20000);
      if (r?.base64) {
        const file = path.join(dir, `rec-${stamp}.wav`);
        fs.writeFileSync(file, Buffer.from(String(r.base64), 'base64'));
        return file;
      }
      if (r?.file && fs.existsSync(r.file)) return r.file;
    } catch (e) {
      note?.('debug', `get_record 失败：${e.message}`);
    }
  }

  if (rec.url) {
    try {
      const res = await fetch(rec.url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length) {
          const file = path.join(dir, `rec-${stamp}.raw`);
          fs.writeFileSync(file, buf);
          return file;
        }
      }
    } catch (e) {
      note?.('debug', `语音下载失败：${e.message}`);
    }
  }
  return null;
}

/** 把 wav 交给本机服务转文字 */
async function transcribeFile(file, conf) {
  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: file }),
    signal: AbortSignal.timeout(conf.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ASR HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return String(data.text || '').trim();
}

/**
 * 把消息里的 [[REC:n]] 占位符换成转写结果。
 * 失败就退回原来那句「没听清」。
 */
export async function resolveRecords(text, records, {
  ob, cfg, dir, note,
}) {
  let out = String(text ?? '');
  if (!Array.isArray(records) || !records.length) return out;
  const conf = asrConfig(cfg);

  const FALLBACK = '[对方发了段语音，你没听清]';
  if (!conf.enabled) {
    for (let i = 0; i < records.length; i++) out = out.replace(`[[REC:${i}]]`, FALLBACK);
    return out;
  }

  await Promise.all(records.map(async (rec, i) => {
    try {
      const src = await fetchRecordSource({ ob, rec, dir, note });
      if (!src) throw new Error('没拿到语音文件');

      const wav = path.join(dir, `rec-${crypto.randomBytes(6).toString('hex')}.16k.wav`);
      const converted = await toWav16k(src, wav, conf.ffmpeg);
      if (!converted) throw new Error('转码失败（可能不是能解的音频）');

      const secs = Math.max(0, (fs.statSync(converted).size - 44) / 32000);
      if (secs > conf.maxSeconds) throw new Error(`语音太长（${Math.round(secs)}s）`);

      const t = await transcribeFile(converted, conf);
      if (!t) throw new Error('转写结果为空');
      out = out.replace(`[[REC:${i}]]`, `[语音转写：${t}]`);
      note?.('info', `语音转写：${t.slice(0, 60)}`);
      // 转完的临时文件顺手清掉
      for (const f of [src, converted]) {
        if (f && f.startsWith(dir)) fs.unlink(f, () => {});
      }
    } catch (e) {
      note?.('debug', `语音转写失败：${e.message}`);
      out = out.replace(`[[REC:${i}]]`, FALLBACK);
    }
  }));

  return out;
}
