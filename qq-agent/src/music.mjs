import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadImage } from './media.mjs';

const execFileAsync = promisify(execFile);

/**
 * 点歌。
 *
 * 模型单独输出一行：__MUSIC__ 晴天 周杰伦
 * 桥去网易云搜歌，然后按 `music.mode` 发：
 *   voice（默认）→ 截一段当语音消息发出去：聊天里直接有播放键，点一下就放，不跳链接
 *   card          → 音乐卡片（封面 + 播放键，点开走播放器）
 *   both          → 卡片 + 语音片段
 * 都失败才退回「封面图 + 链接」。
 *
 * 为什么默认语音片段：QQ 里「点了就能放」的只有语音气泡。音乐卡片在部分客户端
 * 只渲染成「封面 + 链接」，用户看到的就是一张图加个链接（2026-10-23 反馈）。
 * 语音气泡是 QQ 自己的播放器，稳。
 *
 * 踩过的坑：
 *   - {type:"music",data:{type:"163",id}} → retcode 1200「消息体无法解析」。
 *     原因是 NapCat 把这段丢给 musicSignUrl 签名时只给了 id，签名服务回「缺少 title」，
 *     回来的是残缺 ark，QQ 拒收。自己把 title/singer/封面/音频直链填齐走 type:"custom" 才签得出来。
 *   - 音乐卡片发出去了 retcode=0，也不代表点开能播；别把「发送成功」当「能播放」。
 */

const DEFAULTS = {
  enabled: true,
  mode: 'voice',       // voice | card | both
  timeoutMs: 12000,
  maxQueryChars: 40,
  sendCover: true,     // 全失败时的降级：封面图 + 链接
  voice: {
    seconds: 60,       // 片段多长
    startSeconds: 20,  // 从第几秒开始截（跳过前奏）
  },
};

export function musicConfig(cfg) {
  const raw = cfg.raw.music || {};
  return { ...DEFAULTS, ...raw, voice: { ...DEFAULTS.voice, ...(raw.voice || {}) } };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 搜一首歌；搜不到返回 null */
export async function searchSong(query, { timeoutMs = 12000 } = {}) {
  const q = String(query || '').trim().slice(0, 40);
  if (!q) return null;
  const url = 'https://music.163.com/api/search/get/web'
    + `?s=${encodeURIComponent(q)}&type=1&limit=6&offset=0`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': UA,
      referer: 'https://music.163.com/',
      accept: 'application/json,text/plain,*/*',
    },
  });
  if (!res.ok) throw new Error(`网易云搜索 HTTP ${res.status}`);
  const data = await res.json();
  const songs = data?.result?.songs ?? [];
  if (!songs.length) return null;

  // 排序：名字带括号/后缀的（翻唱、Live、DJ 版）往后放；太短的（试听片段）也往后放
  const score = (s) => {
    const name = String(s.name || '');
    let n = 0;
    if (/[（(]/.test(name)) n += 2;
    if (Number(s.duration || 0) < 60000) n += 3;
    if (!(s.duration || 0)) n += 1;
    return n;
  };
  const s = [...songs].sort((a, b) => score(a) - score(b))[0];
  const artists = (s.artists || s.ar || []).map((a) => a.name).filter(Boolean).join(' / ');
  const album = s.album || s.al || {};
  let cover = album.picUrl || s.picUrl || '';
  const id = s.id;
  // 搜索接口常常不给封面（只给 picId），补一次详情
  if (!cover && id) {
    try {
      const r2 = await fetch(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify([{ id }]))}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': UA, referer: 'https://music.163.com/' },
      });
      if (r2.ok) {
        const d2 = await r2.json();
        cover = d2?.songs?.[0]?.al?.picUrl || '';
      }
    } catch { /* 没封面也能发 */ }
  }
  return {
    id,
    name: s.name || '',
    artists: artists || '未知歌手',
    album: album.name || '',
    durationMs: s.duration || s.dt || 0,
    cover,
    url: `https://music.163.com/song?id=${id}`,
    audio: `https://music.163.com/song/media/outer/url?id=${id}.mp3`,
  };
}

export function songLine(song) {
  const dur = song.durationMs
    ? `  ${Math.floor(song.durationMs / 60000)}:${String(Math.floor((song.durationMs % 60000) / 1000)).padStart(2, '0')}`
    : '';
  return `🎵 ${song.name} — ${song.artists}${dur}\n${song.url}`;
}

/** 直链是不是真能下（VIP 独占曲会 404，或者只回一段试听） */
export async function checkAudio(url, { timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    const type = String(res.headers.get('content-type') || '');
    const len = Number(res.headers.get('content-length') || 0);
    // 只要拿到响应头就够了，正文别真下
    await res.body?.cancel?.().catch?.(() => {});
    if (!res.ok) return false;
    if (!/audio|octet-stream|mpeg/i.test(type)) return false;
    // 网易云对没版权的曲子会回一个几百字节的占位/试听，挡掉
    return len === 0 || len > 100_000;
  } catch {
    return false;
  }
}

/** 把整首歌下到本地；失败返回 null（VIP 独占曲在这里断） */
export async function downloadAudio(song, { timeoutMs = 30000, dir = os.tmpdir() } = {}) {
  try {
    const res = await fetch(song.audio, {
      headers: { 'user-agent': UA, referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '');
    if (!/audio|octet-stream|mpeg/i.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100_000) return null;   // 几百字节 = 没版权
    const file = path.join(dir, `song-src-${song.id}-${Date.now()}.mp3`);
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}

/** 截一段、压成语音能用的 mp3；seconds<=0 表示整首 */
export async function makeClip(src, dest, { startSeconds = 20, seconds = 60, ffmpeg = 'ffmpeg' } = {}) {
  const whole = !(seconds > 0);
  try {
    const args = ['-v', 'error', '-y'];
    if (whole) args.push('-i', src);
    else {
      args.push('-ss', String(Math.max(0, startSeconds)));
      args.push('-t', String(Math.max(5, seconds)));
      args.push('-i', src);
    }
    args.push('-ac', '1', '-ar', '24000', '-b:a', '48k', dest);
    await execFileAsync(ffmpeg, args, { timeout: 90000 });
    return fs.existsSync(dest) && fs.statSync(dest).size > 10_000;
  } catch {
    return false;
  }
}

/**
 * 发一段能直接播放的语音片段。
 * 语音文件要先落到 NapCat 容器能读到的目录（config.voice.dir → containerDir）。
 */
async function sendSongVoice({ ob, cfg, session, song, note }) {
  const conf = musicConfig(cfg);
  const vcfg = cfg.raw.voice || {};
  const voiceDir = vcfg.dir || '/root/snowluma/data/voice';
  const containerDir = vcfg.containerDir || '/app/data/voice';
  try {
    fs.mkdirSync(voiceDir, { recursive: true });
  } catch { /* 目录不通就走下面的失败分支 */ }

  const src = await downloadAudio(song).catch(() => null);
  if (!src) {
    note?.('info', `[${session.key}] 点歌：直链下不来（VIP/无版权），换卡片`);
    return false;
  }

  const name = `song-${song.id}-${Date.now().toString(36)}.mp3`;
  const dest = path.join(voiceDir, name);
  const whole = !(conf.voice.seconds > 0);
  const ok = await makeClip(src, dest, {
    startSeconds: conf.voice.startSeconds,
    seconds: conf.voice.seconds,
    ffmpeg: vcfg.ffmpeg || 'ffmpeg',
  }).catch(() => false);
  try { fs.unlinkSync(src); } catch { /* ignore */ }

  if (!ok) {
    note?.('warn', `[${session.key}] 点歌：片段转码失败`);
    return false;
  }

  try {
    const seg = { type: 'record', data: { file: `${containerDir}/${name}` } };
    if (session.kind === 'group') await ob.sendGroup(session.id, [seg]);
    else await ob.sendPrivate(session.id, [seg]);
    note?.('info', `[${session.key}] 点歌（语音${whole ? '整首' : `片段 ${conf.voice.seconds}s`}）：${song.name} — ${song.artists}`);
  } catch (e) {
    note?.('warn', `[${session.key}] 点歌语音发送失败：${e.message}`);
    return false;
  }

  // 只留最近 20 个点歌片段
  try {
    const files = fs.readdirSync(voiceDir).filter((f) => f.startsWith('song-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) {
      fs.unlinkSync(path.join(voiceDir, f));
    }
  } catch { /* ignore */ }

  return true;
}

/** 发音乐卡片（封面 + 播放键）；失败返回 false */
async function sendSongCard({ ob, session, song, note }) {
  const playable = await checkAudio(song.audio).catch(() => false);
  if (!playable) return false;
  try {
    const seg = {
      type: 'music',
      data: {
        type: 'custom',
        url: song.url,
        audio: song.audio,
        title: song.name,
        image: song.cover || 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg',
        content: song.artists,
      },
    };
    if (session.kind === 'group') await ob.sendGroup(session.id, [seg]);
    else await ob.sendPrivate(session.id, [seg]);
    note?.('info', `[${session.key}] 点歌（卡片）：${song.name} — ${song.artists}`);
    return true;
  } catch (e) {
    note?.('warn', `[${session.key}] 音乐卡片发送失败：${e.message}`);
    return false;
  }
}

/**
 * 点歌主入口。按 music.mode 依次尝试，全不行再退「封面 + 链接」。
 * @returns {Promise<{ok:boolean, song?:object, mode?:string, message?:string}>}
 */
export async function sendSong({
  ob, cfg, session, query, incomingDir, note,
}) {
  const conf = musicConfig(cfg);
  if (!conf.enabled) return { ok: false, message: '点歌功能已关闭' };
  const q = String(query || '').trim().slice(0, conf.maxQueryChars);
  if (!q) return { ok: false, message: '没说要听什么歌' };

  let song = null;
  try {
    song = await searchSong(q, { timeoutMs: conf.timeoutMs });
  } catch (e) {
    note?.('warn', `点歌搜索失败：${e.message}`);
    return { ok: false, message: `搜歌出错了：${e.message}` };
  }
  if (!song) return { ok: false, message: `没搜到「${q}」` };

  const send = (segs) => (session.kind === 'group'
    ? ob.sendGroup(session.id, segs)
    : ob.sendPrivate(session.id, segs));

  const mode = String(conf.mode || 'voice');
  let sent = false;
  let used = '';

  if (mode === 'voice' || mode === 'both') {
    sent = await sendSongVoice({ ob, cfg, session, song, note });
    if (sent) used = 'voice';
  }
  if ((mode === 'card' || mode === 'both') || (!sent && mode !== 'link')) {
    if (await sendSongCard({ ob, session, song, note })) {
      sent = true;
      used = used ? `${used}+card` : 'card';
    }
  }

  if (sent) return { ok: true, song, mode: used };

  // 全失败：封面 + 链接
  try {
    if (conf.sendCover && song.cover) {
      const file = await downloadImage(song.cover, incomingDir).catch(() => null);
      if (file) {
        const b64 = fs.readFileSync(file).toString('base64');
        await send([{ type: 'image', data: { file: `base64://${b64}` } }]);
      }
    }
    await send([{ type: 'text', data: { text: songLine(song) } }]);
  } catch (e) {
    note?.('warn', `点歌发送失败：${e.message}`);
    return { ok: false, message: `发不出去：${e.message}` };
  }
  note?.('info', `[${session.key}] 点歌（链接）：${song.name} — ${song.artists}`);
  return { ok: true, song, mode: 'link' };
}

/** 给 prompt 的一行说明 */
export function musicHint() {
  return '[点歌] 有人点歌（「放首xx」「唱个xx」）就单独输出一行：__MUSIC__ 歌名 歌手\n'
    + '（桥会发一段能直接点的语音片段；别自己贴链接、也别编歌词。）';
}
