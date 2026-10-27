// 翻唱：QQ 里点一首歌 → 桥把任务排进队列 → 本机（有显卡那台）的
// tools/cover-agent.py 取走、跑完、把 mp3 传回 → 桥再发进会话。
//
// 为什么要绕这一圈：翻唱流水线吃显卡，服务器是纯 CPU（一首歌几十分钟），
// 真正的算力在这台 Windows 机上；而本机没有公网入口，所以只让它「拉」任务，
// 不需要桥去连它。
//
// 目录协议（服务器端，都在 data/cover 下）：
//   queue/<id>.json  桥写：{id, song, voice, chat, by, at}
//   done/<id>.json   本机写：{ok:true, file, title, seconds, took} / {ok:false, err}
//   done/<id>.mp3    本机传的成品（json 出现 = 可以发了）
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'data/cover';

function cfgOf(cfg) {
  const c = cfg.raw.cover || {};
  return {
    dir: path.join(cfg.dataDir, 'cover'),
    pollMs: Number(c.pollMs) || 15000,
    voice: c.voice || cfg.raw.voice?.dir || '/root/snowluma/data/voice',
    containerDir: c.containerDir || cfg.raw.voice?.containerDir || '/app/data/voice',
    maxKeep: Number(c.maxKeep) || 20,
    // 多长的成品还发「语音条」。实测（2026-10-26）QQ 连 5 分半的整首歌都收得下
    // （NapCat 会转成 silk，retcode 0），所以默认放到 180 秒，短歌直接就是一条语音；
    // 想全发语音条把 config.json 的 cover.voiceMaxSeconds 调大（0 = 一律发语音条）。
    voiceMaxSeconds: c.voiceMaxSeconds === undefined ? 180 : Number(c.voiceMaxSeconds),
  };
}

function paths(cfg) {
  const c = cfgOf(cfg);
  return { ...c, queue: path.join(c.dir, 'queue'), done: path.join(c.dir, 'done') };
}

export function ensureCoverDirs(cfg) {
  const p = paths(cfg);
  for (const d of [p.dir, p.queue, p.done]) fs.mkdirSync(d, { recursive: true });
  return p;
}

/** 排一个翻唱任务，返回任务 id（桥回话要用）
 *  mode: 'vocal'（人声+伴奏）| 'acappella'（清唱，只出人声）
 *  params: {vocalGain, instGain, backingGain, transpose}（增益是百分比，100=原样） */
export function enqueueCover(cfg, { song, chat, by = 0, voice = 'keroro', mode = 'vocal', params = null, segment = null, engine = '', redo = false }) {
  const p = ensureCoverDirs(cfg);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const clean = {};
  for (const k of ['vocalGain', 'instGain', 'backingGain', 'transpose', 'indexRate']) {
    const v = params && params[k];
    if (v === undefined || v === null || v === '') continue;
    const num = Number(v);
    if (Number.isFinite(num)) clean[k] = num;
  }
  // 片段：{chorus:true} 自动挑副歌 40~60 秒；{start,seconds} 指定；null = 整首
  let seg = null;
  if (segment && typeof segment === 'object') {
    if (segment.chorus) seg = { chorus: true };
    else if (segment.full) seg = null;
    else {
      const s = Number(segment.start);
      const d = Number(segment.seconds);
      const out = {};
      if (Number.isFinite(s) && s > 0) out.start = s;
      if (Number.isFinite(d) && d > 0) out.seconds = d;
      if (Object.keys(out).length) seg = out;
    }
  }
  const job = {
    id, song: String(song || '').slice(0, 120), voice,
    engine: engine === 'rvcmax' ? 'rvcmax' : '',
    mode: mode === 'acappella' ? 'acappella' : 'vocal',
    // redo=true 时本机执行器不查翻唱库，强制重跑
    redo: !!redo,
    params: clean,
    segment: seg,
    chat: chat || '', by, at: Date.now(),
  };
  const tmp = path.join(p.queue, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(job), 'utf8');
  fs.renameSync(tmp, path.join(p.queue, `${id}.json`));
  return job;
}

/** 排队里还有几个（QQ 里回话用） */
export function queueDepth(cfg) {
  const p = ensureCoverDirs(cfg);
  try {
    return fs.readdirSync(p.queue).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// 心跳多久没更新就算本机不在了。写死在代码里，不进 config.json：
// 本机 15 秒写一次，90 秒 = 漏 5 轮，够容忍一次网络抖动，又不会拖太久。
const EXECUTOR_TIMEOUT_MS = 90000;

/** 本机（跑翻唱那台 Windows）在不在线：看它写的心跳够不够新。
 *  返回 {online, ts}。文件不存在 / 读不动 / 坏了 / ts 不合法，一律算离线，永不抛异常。 */
export function executorOnline(cfg, nowMs = Date.now()) {
  try {
    // 心跳在本机的 data/cover/heartbeat.json（跟 queue/done 同目录）
    const file = path.join(cfg.dataDir, 'cover', 'heartbeat.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ts = Number(data && data.ts) || 0;
    if (ts > 0 && Number(nowMs) - ts <= EXECUTOR_TIMEOUT_MS) return { online: true, ts };
    return { online: false, ts: ts || 0 };
  } catch {
    return { online: false, ts: 0 };
  }
}

function fmtSecs(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

/** 把成品发进会话：短的当语音，长的当文件（QQ 语音太长会被压坏） */
async function deliver({ ob, cfg, job, meta, note }) {
  const p = paths(cfg);
  const name = meta.file;
  const src = path.join(p.done, name);
  if (!fs.existsSync(src)) throw new Error('成品文件不见了');
  fs.mkdirSync(p.voice, { recursive: true });
  const dest = path.join(p.voice, name);
  fs.copyFileSync(src, dest);
  const remote = `file://${p.containerDir}/${name}`;
  const target = String(job.chat || '');
  const secs = Number(meta.seconds) || 0;
  const limit = p.voiceMaxSeconds;
  // 手工从翻唱工作台发来的会带 asVoice（True=语音条 / False=文件），优先听它的
  const asVoice = typeof meta.asVoice === 'boolean'
    ? meta.asVoice
    : (limit === 0 ? true : secs > 0 && secs <= limit);

  if (target.startsWith('group:')) {
    const gid = Number(target.slice(6));
    if (asVoice) {
      await ob.call('send_group_msg', {
        group_id: gid,
        message: [{ type: 'record', data: { file: `${p.containerDir}/${name}` } }],
      }, 60000);
    } else {
      await ob.call('upload_group_file', { group_id: gid, file: remote, name }, 120000);
    }
  } else {
    const uid = Number(target.slice(8)) || Number(job.by) || 0;
    if (asVoice) {
      await ob.call('send_private_msg', {
        user_id: uid,
        message: [{ type: 'record', data: { file: `${p.containerDir}/${name}` } }],
      }, 60000);
    } else {
      await ob.call('upload_private_file', { user_id: uid, file: remote, name }, 120000);
    }
  }
  const tag = job.mode === 'acappella' ? '清唱' : '翻唱';
  note?.('info', `[${tag}] ${target} 《${meta.title || job.song}》 ${fmtSecs(secs)} 用时 ${meta.took}s → ${name}`);
  // 只留最近 10 首成品，别把 napcat 卷撑满（一首 7~10MB）
  try {
    const files = fs.readdirSync(p.voice).filter((f) => f.startsWith('cover-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 10))) {
      fs.unlinkSync(path.join(p.voice, f));
    }
  } catch { /* ignore */ }
}

/** 每 pollMs 扫一次 done 目录，发完就删 */
export function startCoverWatcher({ cfg, ob, note }) {
  const p = ensureCoverDirs(cfg);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let names = [];
      try {
        names = fs.readdirSync(p.done).filter((f) => f.endsWith('.json'));
      } catch {
        names = [];
      }
      for (const f of names) {
        const file = path.join(p.done, f);
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          continue; // 本机可能正在写，下一轮再看
        }
        const jobId = f.replace(/\.json$/, '').replace(/^cover-/, '');
        const job = { id: jobId, chat: meta.chat || '', by: meta.by || 0, song: meta.song || '' };
        // 任务的会话信息由桥在写队列时带上，本机回传时原样带回来；没有就退回状态记录
        try {
          // 本机回传的文件名是 cover-<id>.*，而 sent/ 里存的是 <id>.json（两种都认）
          for (const cand of [`${jobId}.json`, `cover-${jobId}.json`]) {
            const queueEcho = path.join(p.dir, 'sent', cand);
            if (fs.existsSync(queueEcho)) {
              Object.assign(job, JSON.parse(fs.readFileSync(queueEcho, 'utf8')));
              break;
            }
          }
        } catch { /* 没有就用默认 */ }
        if (!styleHasTarget(job)) {
          note?.('warn', `[翻唱] 任务 ${jobId} 没记下会话，跳过发送`);
        } else if (meta.ok) {
          try {
            await deliver({ ob, cfg, job, meta, note });
          } catch (e) {
            note?.('warn', `[翻唱] 发送失败：${e.message}`);
            await sendText(ob, job, `${job.mode === 'acappella' ? '清唱' : '翻唱'}好了但发不出去：${e.message}`);
          }
        } else {
          await sendText(ob, job, `${job.mode === 'acappella' ? '清唱' : '翻唱'}失败：${String(meta.err || '').slice(0, 120)}`);
        }
        for (const ext of ['.json', '.mp3']) {
          try {
            fs.unlinkSync(path.join(p.done, jobId + ext));
          } catch { /* ignore */ }
          try {
            fs.unlinkSync(path.join(p.done, 'cover-' + jobId + ext));
          } catch { /* ignore */ }
        }
      }
      // 队列里超过 30 分钟没被取走的（本机没开）就别堆着了
      try {
        for (const f of fs.readdirSync(p.queue)) {
          const full = path.join(p.queue, f);
          const st = fs.statSync(full);
          if (Date.now() - st.mtimeMs > 30 * 60000) fs.unlinkSync(full);
        }
      } catch { /* ignore */ }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, p.pollMs);
  timer.unref?.();
  note?.('info', `[翻唱] 监听已启动（每 ${Math.round(p.pollMs / 1000)}s）`);
  return timer;
}

function styleHasTarget(job) {
  const t = String(job.chat || '');
  return t.startsWith('group:') || t.startsWith('private:');
}

async function sendText(ob, job, text) {
  const t = String(job.chat || '');
  try {
    if (t.startsWith('group:')) {
      await ob.call('send_group_msg', { group_id: Number(t.slice(6)), message: [{ type: 'text', data: { text } }] });
    } else if (t.startsWith('private:')) {
      await ob.call('send_private_msg', { user_id: Number(t.slice(8)), message: [{ type: 'text', data: { text } }] });
    }
  } catch { /* ignore */ }
}

/** 本机取任务时要连带会话信息，所以桥在排任务后复制一份到 sent/ */
export function rememberCoverJob(cfg, job) {
  const p = ensureCoverDirs(cfg);
  const dir = path.join(p.dir, 'sent');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, `${job.id}.json`), JSON.stringify(job), 'utf8');
  } catch { /* ignore */ }
  // 只留最近 maxKeep 份
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - p.maxKeep))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* ignore */ }
}
