/**
 * 语音渲染。
 *
 * 目标：把「模型写的语音稿」渲染成一条像是举着手机随口录的语音，
 * 而不是 TTS 把一段书面的字念出来。
 *
 * 三层：
 *   1. 文本层：清掉表情/括号提示，按标点切句；一句太长就在连接词处断开
 *   2. 韵律层：每句单独合成，语速/音高/音量各自抖动；句间停顿按标点给；
 *              整段的音高缓慢下倾，问句句尾升调，最后一句略慢略轻
 *   3. 声学层：拼 PCM 时塞气口，统一过高通/低通/压缩/两段式响度归一，
 *              垫极轻的底噪，输出 24k 单声道 mp3
 *
 * 任何一步失败都往上抛，调用方退回老的「一句话一次合成」。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ensureDir } from './util.mjs';

export const SAMPLE_RATE = 24000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
const BYTES_PER_MS = SAMPLES_PER_MS * 2;

/* ---------- 风格与情绪的韵律参数 ---------- */

const STYLES = {
  natural: {
    rate: 0, pitch: 0, volume: 0,
    jitter: { rate: 3.2, pitch: 2.4, volume: 1.2 },
    decline: 1.1, breath: 0.5, room: -52,
  },
  lively: {
    rate: 5, pitch: 3.5, volume: 1,
    jitter: { rate: 5, pitch: 3.8, volume: 2 },
    decline: 0.9, breath: 0.65, room: -51,
  },
  soft: {
    rate: -7, pitch: -2, volume: -4,
    jitter: { rate: 2, pitch: 1.2, volume: 0.8 },
    decline: 1.0, breath: 0.4, room: -54,
  },
};

const MOODS = {
  正常: { rate: 0, pitch: 0, volume: 0 },
  困: { rate: -9, pitch: -4, volume: -6 },
  生气: { rate: 6, pitch: 6, volume: 3 },
  高兴: { rate: 6, pitch: 5, volume: 2 },
  被夸: { rate: -2, pitch: 1, volume: -1 },
  被说胖: { rate: -4, pitch: -2, volume: -4 },
};

/** 括号里的表演提示：识别出来的按情绪处理，识别不出来的直接删 */
const TAG_MODS = {
  小声: { rate: -4, pitch: -2, volume: -16 },
  轻声: { rate: -4, pitch: -2, volume: -13 },
  笑: { rate: 3, pitch: 4, volume: 1 },
  叹气: { rate: -7, pitch: -3, volume: -6 },
  困: { rate: -8, pitch: -4, volume: -6 },
  生气: { rate: 5, pitch: 5, volume: 3 },
  哈欠: { rate: -8, pitch: -3, volume: -8 },
};

const GAP_MS = {
  '，': 170, '、': 130, '。': 300, '！': 320, '？': 300,
  '；': 220, '…': 520, '—': 260, '：': 180,
};

/** 句间停顿时长（毫秒） */
function gapFor(tail) {
  const ch = tail ? tail[tail.length - 1] : '';
  return GAP_MS[ch] ?? 150;
}

const CONNECTORS = ['但是', '不过', '然后', '就是', '而且', '因为', '所以', '其实', '反正', '结果', '要是', '如果', '不然'];

/* ---------- 小工具 ---------- */

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pct = (v) => { const r = Math.round(v); return `${r >= 0 ? '+' : ''}${r}%`; };
const hz = (v) => { const r = Math.round(v); return `${r >= 0 ? '+' : ''}${r}Hz`; };

function numFrom(s) {
  const n = Number(String(s ?? '').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function runCapture(exe, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`${path.basename(exe)} 超时`));
    }, timeoutMs);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
      if (err.length > 120_000) err = err.slice(-60_000);
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${path.basename(exe)} 退出 ${code}: ${err.slice(-400)}`));
      else resolve({ stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/** 有上限的并发映射 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- 文本层 ---------- */

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/**
 * 清洗语音稿：去掉表情、链接、markdown、括号提示，规整标点，超长截断。
 * 返回 { text, tags }，tags 是括号里识别出来的表演提示。
 */
export function sanitizeScript(raw, maxChars = 60) {
  const tags = [];
  let t = String(raw ?? '');

  t = t.replace(/（([^）]{1,12})）|\(([^)]{1,12})\)|【([^】]{1,12})】|\[([^\]]{1,12})\]/g, (m, a, b, c, d) => {
    const inner = (a || b || c || d || '').trim();
    if (TAG_MODS[inner]) tags.push(inner);
    return ' ';
  });

  t = t.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  t = t.replace(EMOJI, '');
  t = t.replace(/[*_~`^|<>#]+/g, ' ');
  t = t.replace(/\.{3,}/g, '……');
  t = t.replace(/…+/g, '……');
  t = t.replace(/!{2,}/g, '！');
  t = t.replace(/\?{2,}/g, '？');
  t = t.replace(/～/g, '');
  t = t.replace(/[ \t\u3000]+/g, ' ');
  t = t.replace(/^\s*[，、；：]+/, '');
  t = t.trim();

  if (t.length > maxChars) {
    const head = t.slice(0, maxChars);
    const cut = head.match(/^[\s\S]*[，。！？；：…]/);
    t = (cut ? cut[0] : head).replace(/[，、；：]$/, '').trim();
  }

  return { text: t, tags };
}

/** 按标点切句；一句太长时找连接词断开 */
export function splitPhrases(text) {
  const out = [];
  const re = /([^，,。！？；…、：:\n]+)([，,。！？；…、：:\n]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    let tail = (m[2] || '')
      .replace(/,/g, '，').replace(/\?/g, '？').replace(/!/g, '！')
      .replace(/;/g, '；').replace(/:/g, '：');
    if (tail.startsWith('……')) tail = '…';
    out.push({ body, tail });
  }

  const flat = [];
  for (const p of out) {
    if (p.body.length <= 26) { flat.push(p); continue; }
    // 长句：在靠后的连接词处断开，前半句补一个逗号当停顿
    let at = -1;
    for (const c of CONNECTORS) {
      const i = p.body.lastIndexOf(c);
      if (i > 5 && i < p.body.length - 5 && i > at) at = i;
    }
    if (at < 0) { flat.push(p); continue; }
    flat.push({ body: p.body.slice(0, at).trim(), tail: '，' });
    flat.push({ body: p.body.slice(at).trim(), tail: p.tail });
  }
  return flat.filter((p) => p.body);
}

/* ---------- 韵律层 ---------- */

function hourMod(hour) {
  if (hour >= 0 && hour < 6) return { rate: -5, pitch: -1.5, volume: -4 };
  if (hour >= 6 && hour < 9) return { rate: -2, pitch: 0, volume: -1 };
  if (hour >= 22) return { rate: -3, pitch: -1, volume: -2 };
  return { rate: 0, pitch: 0, volume: 0 };
}

function tagMod(tags) {
  const acc = { rate: 0, pitch: 0, volume: 0 };
  for (const t of tags) {
    const m = TAG_MODS[t];
    if (!m) continue;
    acc.rate += m.rate; acc.pitch += m.pitch; acc.volume += m.volume;
  }
  return acc;
}

/**
 * 给每个短句安排韵律参数。
 * baseRate/basePitch 是配置里写死的整体偏移（兼容老配置的 rate/pitch）。
 */
export function makePlan(phrases, opts = {}) {
  const style = STYLES[opts.style] ?? STYLES.natural;
  const mood = MOODS[opts.mood] ?? MOODS.正常;
  const hm = hourMod(Number.isFinite(opts.hour) ? opts.hour : new Date().getHours());
  const tm = tagMod(opts.tags || []);
  const baseRate = numFrom(opts.rate);
  const basePitch = numFrom(opts.pitch);

  const n = phrases.length;
  return phrases.map((p, i) => {
    const isLast = i === n - 1;
    const len = p.body.length;
    const question = /[？?]$/.test(p.tail);
    const exclaim = /[！!]$/.test(p.tail);
    const ellipsis = /…$/.test(p.tail);

    let rate = baseRate + style.rate + mood.rate + hm.rate + tm.rate
      + (isLast ? -1.5 : 0.5)
      + (len <= 4 ? 2.5 : 0)
      + (len >= 14 ? -2 : 0)
      + rnd(-style.jitter.rate, style.jitter.rate);

    let pitch = basePitch + style.pitch + mood.pitch + hm.pitch + tm.pitch
      - i * style.decline
      + (question && isLast ? 9 : 0)
      + (exclaim && isLast ? 4 : 0)
      + (ellipsis ? -2 : 0)
      + rnd(-style.jitter.pitch, style.jitter.pitch);

    let volume = style.volume + mood.volume + hm.volume + tm.volume
      + (isLast ? -2 : 0)
      + rnd(-style.jitter.volume, style.jitter.volume);

    // 别抖过头：变调幅度太大反而像鬼畜
    rate = clamp(rate, -28, 28);
    pitch = clamp(pitch, -45, 45);
    volume = clamp(volume, -35, 10);

    const gap = isLast ? 0 : Math.round(gapFor(p.tail) * rnd(0.85, 1.15));
    const breath = !isLast && gap >= 300 && Math.random() < style.breath;

    return {
      text: (p.body + p.tail).trim(),
      rate, pitch, volume, gapAfter: gap, breath,
    };
  });
}

/* ---------- PCM 小工具 ---------- */

function silence(ms) {
  return Buffer.alloc(Math.max(0, Math.round(ms * BYTES_PER_MS)));
}

function trimPcm(buf, { thresh = 320, headMs = 12, tailMs = 70 } = {}) {
  const n = buf.length >> 1;
  let a = 0;
  let b = n - 1;
  while (a < n && Math.abs(buf.readInt16LE(a * 2)) <= thresh) a++;
  while (b > a && Math.abs(buf.readInt16LE(b * 2)) <= thresh) b--;
  if (a >= b) return Buffer.alloc(0);
  const start = Math.max(0, a - Math.round(headMs * SAMPLES_PER_MS));
  const end = Math.min(n, b + Math.round(tailMs * SAMPLES_PER_MS));
  return buf.subarray(start * 2, end * 2);
}

function fadePcm(buf, inMs = 6, outMs = 24) {
  const out = Buffer.from(buf);
  const n = out.length >> 1;
  const fi = Math.min(n, Math.round(inMs * SAMPLES_PER_MS));
  for (let i = 0; i < fi; i++) {
    const g = i / fi;
    out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * g), i * 2);
  }
  const fo = Math.min(n, Math.round(outMs * SAMPLES_PER_MS));
  for (let i = 0; i < fo; i++) {
    const idx = n - 1 - i;
    const g = i / fo;
    out.writeInt16LE(Math.round(out.readInt16LE(idx * 2) * g), idx * 2);
  }
  return out;
}

function scalePcm(buf, gain) {
  const out = Buffer.alloc(buf.length);
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = Math.round(buf.readInt16LE(i * 2) * gain);
    out.writeInt16LE(clamp(v, -32768, 32767), i * 2);
  }
  return out;
}

/* ---------- 声学层 ---------- */

const breathCache = new Map();

/** 清掉一小时内没动过的临时文件，防止失败时越积越多 */
function cleanTmp(tmp) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(tmp)) {
      const p = path.join(tmp, f);
      try {
        if (now - fs.statSync(p).mtimeMs > 3600_000) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 用粉红噪声做一口「吸气」，缓存成 raw PCM */
async function breathPcm(vcfg, tmpDir) {
  const key = `${vcfg.ffmpeg || 'ffmpeg'}|${tmpDir}`;
  if (breathCache.has(key)) return breathCache.get(key);
  const file = path.join(tmpDir, 'breath.raw');
  if (!fs.existsSync(file)) {
    await runCapture(vcfg.ffmpeg || 'ffmpeg', [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i',
      `anoisesrc=color=pink:amplitude=0.4:duration=0.26:sample_rate=${SAMPLE_RATE}`,
      '-af', 'highpass=f=260,lowpass=f=2400,afade=t=in:st=0:d=0.05,afade=t=out:st=0.14:d=0.12,volume=0.45',
      '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), file,
    ], 10000);
  }
  const buf = fs.readFileSync(file);
  breathCache.set(key, buf);
  return buf;
}

/** 拼 PCM：静音 + 气口 + 每句音频 + 尾静音 */
function assemble(chunks, breath, { headMs = rnd(90, 150), tailMs = rnd(180, 260) } = {}) {
  const parts = [silence(headMs)];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (i > 0) {
      const gap = c.gapBefore ?? 150;
      const breathMs = breath ? breath.length / BYTES_PER_MS : 0;
      if (c.breath && breath && gap >= breathMs + 90) {
        parts.push(silence(45));
        parts.push(scalePcm(breath, 0.5));
        parts.push(silence(gap - 45 - breathMs));
      } else {
        parts.push(silence(gap));
      }
    }
    parts.push(c.pcm);
  }
  parts.push(silence(tailMs));
  return Buffer.concat(parts);
}

const MASTER_CHAIN = 'highpass=f=70,lowpass=f=7600,acompressor=threshold=0.09:ratio=3:attack=6:release=160:makeup=1';

async function measureLoudness(vcfg, rawFile) {
  const { stderr } = await runCapture(vcfg.ffmpeg || 'ffmpeg', [
    '-hide_banner', '-nostdin',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', rawFile,
    '-af', `${MASTER_CHAIN},loudnorm=I=-19:TP=-1.5:LRA=11:print_format=json`,
    '-f', 'null', '-',
  ], 20000);
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const f = (k) => Number(j[k]);
    if (![f('input_i'), f('input_lra'), f('input_tp'), f('input_thresh')].every(Number.isFinite)) return null;
    return j;
  } catch {
    return null;
  }
}

/** 统一响度、限带、压缩、垫底噪，输出 mp3 */
async function master(vcfg, pcm, outFile, tmpDir) {
  const rawFile = path.join(tmpDir, `mix-${crypto.randomBytes(4).toString('hex')}.raw`);
  fs.writeFileSync(rawFile, pcm);
  const durSec = pcm.length / BYTES_PER_MS / 1000;
  const style = STYLES[vcfg._style] ?? STYLES.natural;
  const roomDb = vcfg.roomTone === false ? null : (vcfg._style ? style.room : -52);
  const roomAmp = roomDb == null ? 0 : Math.pow(10, roomDb / 20);

  try {
    const measured = await measureLoudness(vcfg, rawFile);
    const loud = measured
      ? `loudnorm=I=-19:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,aresample=${SAMPLE_RATE}`
      : 'loudnorm=I=-19:TP=-1.5:LRA=11';

    const args = [
      '-hide_banner', '-nostdin', '-y',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', rawFile,
    ];

    if (roomAmp > 0) {
      const fc = [
        `[0:a]${MASTER_CHAIN},${loud}[v]`,
        `anoisesrc=color=pink:amplitude=${roomAmp.toFixed(5)}:duration=${durSec.toFixed(3)}:sample_rate=${SAMPLE_RATE},aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=mono[n]`,
        '[v][n]amix=inputs=2:duration=first:normalize=0[a]',
      ].join(';');
      args.push('-filter_complex', fc, '-map', '[a]');
    } else {
      args.push('-af', `${MASTER_CHAIN},${loud}`);
    }

    args.push('-c:a', 'libmp3lame', '-b:a', '48k', '-ar', String(SAMPLE_RATE), '-ac', '1', outFile);

    try {
      await runCapture(vcfg.ffmpeg || 'ffmpeg', args, 30000);
    } catch (e) {
      // 底噪混流个别 ffmpeg 版本不支持 amix normalize，退回不垫底噪
      if (roomAmp > 0) {
        await runCapture(vcfg.ffmpeg || 'ffmpeg', [
          '-hide_banner', '-nostdin', '-y',
          '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', rawFile,
          '-af', `${MASTER_CHAIN},${loud}`,
          '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', String(SAMPLE_RATE), '-ac', '1', outFile,
        ], 30000);
      } else {
        throw e;
      }
    }
  } finally {
    try { fs.unlinkSync(rawFile); } catch { /* ignore */ }
  }
}

/* ---------- 对外入口 ---------- */

function voiceDir(vcfg) {
  return ensureDir(vcfg.dir || path.join(process.cwd(), 'voice'));
}

function tmpDirOf(dir) {
  return ensureDir(path.join(dir, '.tmp'));
}

function newName() {
  return `v-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp3`;
}

/** 老路径：一句话一次合成，不做任何处理。也用作兜底。 */
export async function renderPlainVoice(vcfg, { text, voice, rate, pitch } = {}) {
  const started = Date.now();
  const dir = voiceDir(vcfg);
  const name = newName();
  const out = path.join(dir, name);
  const say = String(text ?? '').slice(0, vcfg.maxChars ?? 120);
  if (!say.trim()) throw new Error('语音稿是空的');

  // 注意：负值必须写成 `--rate=-2%`，否则 argparse 会把它当成选项
  await runCapture(vcfg.bin || '/opt/tts/bin/edge-tts', [
    '--voice', voice || vcfg.voice || 'zh-CN-XiaoyiNeural',
    `--rate=${rate || vcfg.rate || '+0%'}`,
    `--pitch=${pitch || vcfg.pitch || '+0Hz'}`,
    '--text', say,
    '--write-media', out,
    '--no-progress',
  ], 30000);

  if (!fs.existsSync(out) || fs.statSync(out).size < 800) throw new Error('TTS 没生成有效音频');
  return { file: out, name, ms: Date.now() - started, chunks: 1, style: 'plain' };
}

/* ---------- 情绪语气（本地：只动整体参数 + 句尾标点） ---------- */

/**
 * 每种心情的偏移 = 基础语气 + 心情增量。
 * 基础语气就是用户选中的 2 号：慢一点、高一点、轻一点。
 */
const BASE_TONE = { rate: -5, pitch: 5, volume: -3 };

const MOOD_DELTA = {
  正常: { rate: 0, pitch: 0, volume: 0 },
  高兴: { rate: 10, pitch: 8, volume: 3 },
  撒娇: { rate: 0, pitch: 3, volume: 0 },
  被夸: { rate: 0, pitch: 3, volume: 0 },
  困: { rate: -6, pitch: -5, volume: -4 },
  生气: { rate: 8, pitch: 3, volume: 4 },
  被说胖: { rate: -5, pitch: -4, volume: -3 },
};

/** 情绪引擎 v2 的九档名 → 语音语气键（老的中文档位保留，手动传中文照样生效） */
const EMOTION_MOOD_ALIAS = {
  happy: '高兴', encouraging: '高兴', surprised: '高兴',
  sleepy: '困', sad: '被说胖', soft: '被夸', gentle: '被夸',
  calm: '正常', confused: '正常',
};
const normMood = (m) => EMOTION_MOOD_ALIAS[m] || m;

/** 用标点给语气：句尾是「！」还是「……」对 TTS 的读法影响很大 */
export function moodPunctuation(text, mood) {
  let t = String(text ?? '').trim();
  const mm = normMood(mood);
  if (mm === '高兴' || mm === '生气') {
    t = t.replace(/。$/, '！');
    if (!/[！？…～]$/.test(t)) t += '！';
  } else if (mm === '困') {
    t = t.replace(/！/g, '，');
    if (!/[，…～]$/.test(t)) t += '……';
  } else if (mm === '撒娇' || mm === '被夸') {
    if (!/[～！？…]$/.test(t)) t += '～';
  } else if (mm === '被说胖') {
    if (!/…$/.test(t)) t += '……';
  }
  return t;
}

export function moodVoicePlan(mood, intensity = 1) {
  const d = MOOD_DELTA[normMood(mood)] || MOOD_DELTA.正常;
  return {
    rate: BASE_TONE.rate + d.rate * intensity,
    pitch: BASE_TONE.pitch + d.pitch * intensity,
    volume: BASE_TONE.volume + d.volume * intensity,
  };
}

/**
 * 情绪版：整句一次合成，只改语速/音高/音量，再按心情改句尾标点。
 * 不分句、不拼接、不垫底噪——上次难听就难听在切碎。
 */
export async function renderMoodVoice(vcfg, opts = {}) {
  const started = Date.now();
  const dir = voiceDir(vcfg);
  const mood = MOOD_DELTA[opts.mood] ? opts.mood : '正常';
  const say = moodPunctuation(opts.text, mood).slice(0, vcfg.maxChars ?? 60);
  if (!say.trim()) throw new Error('语音稿是空的');

  const plan = moodVoicePlan(mood, Number(opts.intensity ?? 1));
  const rate = numFrom(opts.rate ?? vcfg.rate) + plan.rate;
  const pitch = numFrom(opts.pitch ?? vcfg.pitch) + plan.pitch;
  const name = newName();
  const out = path.join(dir, name);

  await runCapture(vcfg.bin || '/opt/tts/bin/edge-tts', [
    '--voice', opts.voice || vcfg.voice || 'zh-CN-XiaoyiNeural',
    `--rate=${pct(rate)}`,
    `--pitch=${hz(pitch)}`,
    `--volume=${pct(plan.volume)}`,
    '--text', say,
    '--write-media', out,
    '--no-progress',
  ], 30000);

  if (!fs.existsSync(out) || fs.statSync(out).size < 800) throw new Error('TTS 没生成有效音频');
  return {
    file: out, name, ms: Date.now() - started, chunks: 1, mood,
    text: say, rate: pct(rate), pitch: hz(pitch), volume: pct(plan.volume),
  };
}

/**
 * 手动指定的语气：直接给语速/音高/音量偏移，文本负责标点。
 * 用来在预设之间找中间点，定下来之后再固化成 mood 预设。
 */
export async function renderTunedVoice(vcfg, opts = {}) {
  const started = Date.now();
  const dir = voiceDir(vcfg);
  const say = String(opts.text ?? '').slice(0, vcfg.maxChars ?? 60);
  if (!say.trim()) throw new Error('语音稿是空的');

  const rate = numFrom(vcfg.rate) + Number(opts.rateOffset || 0);
  const pitch = numFrom(vcfg.pitch) + Number(opts.pitchOffset || 0);
  const volume = Number(opts.volumeOffset || 0);
  const name = newName();
  const out = path.join(dir, name);

  await runCapture(vcfg.bin || '/opt/tts/bin/edge-tts', [
    '--voice', opts.voice || vcfg.voice || 'zh-CN-XiaoyiNeural',
    `--rate=${pct(rate)}`,
    `--pitch=${hz(pitch)}`,
    `--volume=${pct(volume)}`,
    '--text', say,
    '--write-media', out,
    '--no-progress',
  ], 30000);

  if (!fs.existsSync(out) || fs.statSync(out).size < 800) throw new Error('TTS 没生成有效音频');
  return {
    file: out, name, ms: Date.now() - started, chunks: 1,
    text: say, rate: pct(rate), pitch: hz(pitch), volume: pct(volume),
  };
}

/** 给音频尾部补一段静音，避免 NapCat/QQ 转码时把最后一个字切掉 */
async function padTailSilence(vcfg, file, seconds) {
  const tmp = file.replace(/\.mp3$/, '.pad.mp3');
  try {
    await runCapture(vcfg.ffmpeg || 'ffmpeg', [
      '-hide_banner', '-nostdin', '-y',
      '-i', file,
      '-af', `apad=pad_dur=${seconds}`,
      // 不写死采样率：TTS 现在出 16kHz，写死 24000 会把它又升回去、多一次重采样
      '-c:a', 'libmp3lame', '-b:a', '96k', '-ac', '1',
      tmp,
    ], 15000);
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * 音量均衡：压上限 + 响度归一 + 峰值软限。
 * 不做到「听清」的 -19 LUFS，做到「像人随口录的」——比原声略提一点，别顶到爆。
 * 实测（8 条样片，云端 ffmpeg）：原始 -21~-23 LUFS / LRA 1.3~3.4 / 峰值 -3~-5 dBFS，
 * 之后按 -17 LUFS 线性归一 + 峰值限到 -2.5，LRA 上限 18（I 提高后 LRA 会自动收窄）。
 * 注意 loudnorm 的 linear=true 是「整体平移」，不会把长停顿压扁。
 */
const BALANCE_CHAIN = 'loudnorm=I=-17:TP=-2.5:LRA=18:linear=true,alimiter=limit=0.75:level=false';

/** 给 QQ 前的成品做响度均衡；失败就原样返回，不影响发送 */
async function balanceVolume(vcfg, file) {
  const tmp = file.replace(/\.mp3$/, '.bal.mp3');
  try {
    await runCapture(vcfg.ffmpeg || 'ffmpeg', [
      '-hide_banner', '-nostdin', '-y',
      '-i', file,
      '-af', BALANCE_CHAIN,
      '-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000', '-ac', '1',
      tmp,
    ], 15000);
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 800) throw new Error('均衡输出为空');
    fs.renameSync(tmp, file);
  } catch {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 量一条 mp3 的响度，返回 { i, lra, tp }；量不出来返回 null */
export async function measureFile(vcfg, file) {
  const { stderr } = await runCapture(vcfg.ffmpeg || 'ffmpeg', [
    '-hide_banner', '-nostdin', '-i', file,
    '-af', 'loudnorm=I=-17:TP=-2.5:LRA=18:print_format=json',
    '-f', 'null', '-',
  ], 15000);
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return { i: Number(j.input_i), lra: Number(j.input_lra), tp: Number(j.input_tp) };
  } catch {
    return null;
  }
}

/** 提取 pcm 的音高曲线（只看浊音帧），用来量「同音调」和「匀速」。需要 numpy：
 *  优先用 /opt/bailian 的 python（已装 numpy），没有就退回系统 python3。 */
export async function pitchCurve(vcfg, file, { fmin = 90, fmax = 400 } = {}) {
  const py = ['/opt/bailian/bin/python3', 'python3'].find((p) => {
    try { spawnSync(p, ['-c', 'import numpy'], { stdio: 'ignore' }); return true; } catch { return false; }
  }) || 'python3';
  const code = `
import json, subprocess, sys
import numpy as np
f, fmin, fmax = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
raw = subprocess.run(['ffmpeg','-hide_banner','-nostdin','-v','error','-i',f,'-f','s16le','-ac','1','-ar','16000','-'],
                     capture_output=True).stdout
x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
sr, win, hop = 16000, 800, 160
f0, rms = [], []
for i in range(0, max(1, len(x) - win), hop):
    fr = x[i:i+win]
    if len(fr) < win: break
    rms.append(float(np.sqrt(np.mean(fr**2))))
    fr = fr - fr.mean()
    if np.sqrt(np.mean(fr**2)) < 0.01: f0.append(0.0); continue
    ac = np.correlate(fr, fr, 'full')[win-1:]
    lo, hi = int(sr/fmax), int(sr/fmin)
    if hi >= len(ac): f0.append(0.0); continue
    seg = ac[lo:hi]
    lag = int(np.argmax(seg)) + lo
    f0.append(float(sr/lag) if seg.max() > 0.3*ac[0] else 0.0)
print(json.dumps({'f0': f0, 'rms': rms, 'hop_s': hop/sr}))
`;
  const { stdout } = await runCapture(py, ['-c', code, file, String(fmin), String(fmax)], 20000);
  return JSON.parse(String(stdout));
}

/**
 * 把模型给的「语境」拼成 TTS 指令。
 * 模型那行写得自由，容易飘（书面词、动作描写、太夸张），这里做一层收紧：
 *   - 截长，只留前 maxSceneChars 字
 *   - 去掉括号里的动作描写
 *   - 气声/停顿只在场景里提到了才追加，免得人人都在气声
 *
 * 除场景外固定补两条表达总则（对应「重音」「别匀速同音调」）：
 *   - emphasis：挑一两个词加重（指令里不写「重音」这种术语）
 *   - vary：情绪和快慢一路有起伏
 * 默认开，conf.emphasis === false / conf.vary === false 可关。
 */
/**
 * 日常语气指令可以写成数组，每次渲染随机挑一条——「混着用」，
 * 免得每句话都用同一种口吻、听多了像复读。
 * 字符串照旧按单条处理。
 */
function pickInstruction(v) {
  if (Array.isArray(v)) {
    const list = v.filter((x) => typeof x === 'string' && x.trim());
    if (!list.length) return '';
    return list[Math.floor(Math.random() * list.length)].trim();
  }
  return String(v ?? '').trim();
}

export function composeInstruction(conf, mood, scene) {
  const perMood = (conf.instructions ?? {})[mood];
  const base = pickInstruction(perMood ?? conf.defaultInstruction);
  const parts = [base].filter(Boolean);

  const s = String(scene ?? '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, Number(conf.maxSceneChars) || 90);
  if (s) parts.push(`录制场景：${s}`);

  if (conf.emphasis !== false) {
    parts.push('一句里挑一两个要紧的词说重一点、慢一点，其余轻轻带过，别每个字一样重');
  }
  if (conf.vary !== false) {
    parts.push('语气和快慢要有起伏，说到一半情绪有点变化，别从头到尾一个调子一个速度');
  }
  // 气声只在场景里提到相关描述时才加
  if (conf.breath !== false && /气声|耳语|小声|鼻音|压着嗓子/.test(s)) {
    parts.push('在「……」和逗号处轻轻换气，偶尔带一点点气声，不要整句都虚着');
  }
  if (conf.pauses !== false && /……|…/.test(conf._text ?? '')) {
    parts.push('「……」处停顿稍长一点，像在想词');
  }
  if (conf.tail) parts.push(conf.tail);
  return parts.join('；') || null;
}

/**
 * 百炼 Qwen-Audio-TTS：交给本机 127.0.0.1:3911 的 Python 服务，
 * 桥只负责传 text / instruction，拿回 mp3。
 */
export async function renderBailianVoice(vcfg, opts = {}) {
  const started = Date.now();
  const dir = voiceDir(vcfg);
  // 字数上限按「去掉标签后的实际字」算，SSML 标签不占额度。
  // 超长就直接退回纯文本截断——硬切 SSML 会把标签切断，喂进去只会变成乱码字。
  const rawText = String(opts.text ?? '');
  const plain = rawText.replace(/<[^>]*>/g, '');
  if (!plain.trim()) throw new Error('语音稿是空的');
  const max = vcfg.maxChars ?? 60;
  const say = plain.length <= max ? rawText : plain.slice(0, max);

  const conf = vcfg.bailian ?? {};
  const instruction = composeInstruction({ ...conf, _text: say }, opts.mood, opts.scene);

  // 模型这一句没给情绪标签时，用配置里的兜底（不然就是纯平读）
  const emo = opts.emotion || conf.defaultEmotion || undefined;
  const intensity = opts.intensity
    ?? (opts.emotion ? undefined : conf.defaultIntensity)
    ?? undefined;

  const body = {
    text: say,
    instruction,
    voice: conf.voice || undefined,
    emotion: emo,
    intensity,
    rate: opts.rate ?? conf.rate ?? undefined,
    // 音高微调：1.0 原调，0.96 左右会明显「不那么高」但不至于变男声
    pitch: opts.pitch ?? conf.pitch ?? undefined,
    // 响度：loud = 推到 -15 LUFS 并压峰，QQ 里听着更响
    loudness: conf.loudness || undefined,
  };
  if (opts.volume != null) body.volume = opts.volume;

  const url = conf.url || 'http://127.0.0.1:3911/tts';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(conf.timeoutMs) || 30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`百炼 TTS ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 800) throw new Error('百炼 TTS 返回空音频');

  const name = newName();
  const out = path.join(dir, name);
  fs.writeFileSync(out, buf);

  // 尾部补 0.5 秒静音：QQ/NapCat 转码会把尾巴吃掉，垫一点就不会切到最后一个字
  const pad = Number(conf.padTailSeconds ?? 0.5);
  if (pad > 0) {
    try { await padTailSilence(vcfg, out, pad); } catch { /* 垫尾失败不影响发送 */ }
  }

  // 响度均衡（见 BALANCE_CHAIN）。默认开，conf.balance === false 可关。
  let loud = null;
  if (conf.balance !== false) {
    await balanceVolume(vcfg, out);
    loud = await measureFile(vcfg, out).catch(() => null);
  }

  return {
    file: out, name, ms: Date.now() - started, chunks: 1, style: 'bailian',
    mood: opts.mood, scene: opts.scene || '', instruction, loud,
  };
}

/**
 * 人性化渲染。
 * @param {object} vcfg    config.voice
 * @param {object} opts    { text, style, voice, mood, hour, rate, pitch, tags }
 */
export async function renderVoice(vcfg, opts = {}) {
  const started = Date.now();
  const style = STYLES[opts.style] ? opts.style : 'natural';
  const maxChars = Math.max(8, Math.min(Number(opts.maxChars ?? vcfg.maxChars ?? 60) || 60, 90));
  const clean = sanitizeScript(opts.text, maxChars);
  if (!clean.text) throw new Error('语音稿是空的');

  const phrases = splitPhrases(clean.text).slice(0, 10);
  if (!phrases.length) throw new Error('切不出句子');

  const plan = makePlan(phrases, {
    style,
    mood: opts.mood,
    hour: opts.hour,
    rate: opts.rate ?? vcfg.rate,
    pitch: opts.pitch ?? vcfg.pitch,
    tags: [...clean.tags, ...(opts.tags || [])],
  });

  const dir = voiceDir(vcfg);
  const tmp = tmpDirOf(dir);
  cleanTmp(tmp);
  const voice = opts.voice || vcfg.voice || 'zh-CN-XiaoyiNeural';

  // 1. 分句并发合成（TTS 是网络 IO，开三条就够）
  const files = plan.map((c, i) => path.join(tmp, `c-${Date.now()}-${i}-${crypto.randomBytes(2).toString('hex')}.mp3`));
  await mapLimit(plan, 3, async (c, i) => {
    await runCapture(vcfg.bin || '/opt/tts/bin/edge-tts', [
      '--voice', voice,
      `--rate=${pct(c.rate)}`,
      `--volume=${pct(c.volume)}`,
      `--pitch=${hz(c.pitch)}`,
      '--text', c.text,
      '--write-media', files[i],
      '--no-progress',
    ], 30000);
    if (!fs.existsSync(files[i]) || fs.statSync(files[i]).size < 800) throw new Error(`第 ${i + 1} 句 TTS 为空`);
  });

  // 2. 解码 → 掐头去尾
  const chunks = await mapLimit(plan, 3, async (c, i) => {
    const { stdout } = await runCapture(vcfg.ffmpeg || 'ffmpeg', [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-i', files[i],
      '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-',
    ], 20000);
    const pcm = trimPcm(stdout);
    if (!pcm.length) throw new Error(`第 ${i + 1} 句解码后是静音`);
    return { ...c, pcm };
  });

  // 3. 拼起来（气口 + 停顿）
  let breath = null;
  if (vcfg.breath !== false && chunks.some((c, i) => i > 0 && c.breath)) {
    breath = await breathPcm(vcfg, tmp);
  }
  for (let i = 1; i < chunks.length; i++) chunks[i].gapBefore = chunks[i - 1].gapAfter;
  const pcm = fadePcm(assemble(chunks, breath));

  // 4. 统一音色质感
  const name = newName();
  const out = path.join(dir, name);
  await master({ ...vcfg, _style: style }, pcm, out, tmp);

  // 5. 清临时文件
  for (const f of files) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

  if (!fs.existsSync(out) || fs.statSync(out).size < 800) throw new Error('渲染后音频为空');

  return {
    file: out,
    name,
    ms: Date.now() - started,
    chunks: chunks.length,
    style,
    voice,
    durationMs: Math.round(pcm.length / BYTES_PER_MS),
  };
}
