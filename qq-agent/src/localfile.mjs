// 本机处理（2026-10-28 用户要求）：「传输文件用本机 dsh 操作后再发回」。
//
// 链路：QQ 里发来一个文件 + 一句「用本机把它……」
//   → 桥把文件和任务排进队列
//   → 号主那台 Windows 的 tools/local-agent.py 取走、拉下文件
//   → 本机 dsh（dsh-run.ps1）干活，产物写进专属输出目录
//   → 传回 done/ → 桥把产物发回对应会话。
//
// 和翻唱同一套「拉模式」：本机没有公网入口，只让它自己来拉，桥不去连它。
// 好处是本机休眠/断网时队列只是躺着，不会把桥拖死；坏处是最长 15 秒才被取走。
//
// 目录协议（服务器 data/local 下）：
//   heartbeat.json    本机写 {ts, at}，桥据此判断本机在不在（2 分钟没更新算离线）
//   queue/<id>.json   桥写 {id, chat, by, task, file:{name,path}, out, at}
//   files/<id>-<名>   桥先把输入文件复制到这里（路径稳定，本机 sftp.get 用）
//   done/<id>.json    本机写 {ok:true, files:[{name,bytes}], text, took} / {ok:false, err}
//   done/<id>__<n>__<名>  产物本体
import fs from 'node:fs';
import path from 'node:path';
// util.mjs 的 safeFileName 会把中文全换成下划线，文件名就没法认了；用 files.mjs 这个保留中文的
import { safeDownloadName as safeFileName } from './files.mjs';

// 本机 20 秒写一次心跳，120 秒 = 漏 6 轮，够容忍一次网络抖动，又不会让「不在线」的谎话说太久。
const EXECUTOR_TIMEOUT_MS = 120000;
export { EXECUTOR_TIMEOUT_MS };

function localOf(cfg) {
  const c = cfg.raw.local || {};
  return {
    dir: path.join(cfg.dataDir, 'local'),
    pollMs: Number(c.pollMs) || 15000,
    // 发文件必须先落到这个目录：协议端只认容器内路径（/app/data/voice → /root/snowluma/data/voice）
    voice: c.voiceDir || cfg.raw.voice?.dir || '/root/snowluma/data/voice',
    containerDir: c.containerDir || cfg.raw.voice?.containerDir || '/app/data/voice',
    maxKeep: Number(c.maxKeep) || 20,
    // 一次任务最多回传几个产物、单个最大多少：防止本机把一整个输出目录糊上来
    maxFiles: Number(c.maxFiles) || 8,
    maxBytes: Number(c.maxBytes) || 200 * 1024 * 1024,
    // 队列里躺多久还没被取走就丢掉（本机大概没开）
    staleMs: Number(c.staleMs) || 30 * 60000,
  };
}

function paths(cfg) {
  const c = localOf(cfg);
  return {
    ...c,
    queue: path.join(c.dir, 'queue'),
    done: path.join(c.dir, 'done'),
    files: path.join(c.dir, 'files'),
    sent: path.join(c.dir, 'sent'),
    heartbeat: path.join(c.dir, 'heartbeat.json'),
  };
}

export function ensureLocalDirs(cfg) {
  const p = paths(cfg);
  for (const d of [p.dir, p.queue, p.done, p.files, p.sent]) fs.mkdirSync(d, { recursive: true });
  return p;
}

/** 本机在不在线：看心跳够不够新。文件不存在/坏了/ts 不合法一律算离线，永不抛。 */
export function localExecutorOnline(cfg, nowMs = Date.now()) {
  try {
    const p = paths(cfg);
    const data = JSON.parse(fs.readFileSync(p.heartbeat, 'utf8'));
    const ts = Number(data && data.ts) || 0;
    if (ts > 0 && Number(nowMs) - ts <= EXECUTOR_TIMEOUT_MS) return { online: true, ts };
    return { online: false, ts: ts || 0 };
  } catch {
    return { online: false, ts: 0 };
  }
}

/**
 * 排一个本机任务。
 * @param {object} cfg
 * @param {{task:string, chat:string, by?:number, file?:{name?:string, path:string}|null}} spec
 *   file.path 是服务器上的真实路径；有就复制一份到 files/（本机按稳定路径拉，不怕 incoming 被清）
 * @returns {{id:string, chat:string, task:string, file:object|null, out:string, at:number}}
 */
export function enqueueLocal(cfg, { task, chat, by = 0, file = null }) {
  const p = ensureLocalDirs(cfg);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let input = null;
  if (file && file.path) {
    try {
      if (fs.existsSync(file.path) && fs.statSync(file.path).isFile()) {
        const name = safeFileName(file.name || path.basename(file.path), '文件');
        const dest = path.join(p.files, `${id}-${name}`);
        fs.copyFileSync(file.path, dest);
        input = { name, path: dest, bytes: fs.statSync(dest).size };
      }
    } catch { /* 复制失败就当没有输入文件，任务照排 */ }
  }
  const job = {
    id,
    chat: String(chat || ''),
    by: Number(by) || 0,
    task: String(task || '').slice(0, 4000),
    file: input,
    // 专属输出目录：本机把产物全写进这里，桥照着目录整包收，不靠改时间猜哪个是新的
    out: `D:\\DSH\\output\\local-${id}`,
    at: Date.now(),
  };
  const tmp = path.join(p.queue, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(job), 'utf8');
  fs.renameSync(tmp, path.join(p.queue, `${id}.json`));
  // 桥自己留一份，回传时 meta 里没带会话信息也能找回来
  try {
    fs.writeFileSync(path.join(p.sent, `${id}.json`), JSON.stringify(job), 'utf8');
    const files = fs.readdirSync(p.sent).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - p.maxKeep))) {
      try { fs.unlinkSync(path.join(p.sent, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return job;
}

/** 队列里还剩几个（回话用） */
export function localQueueDepth(cfg) {
  const p = ensureLocalDirs(cfg);
  try {
    return fs.readdirSync(p.queue).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * 记下这个会话「最近收到的那个文件」。
 * 用户的话通常是「文件发过去，再说一句用本机把它怎样」——分两条消息到，
 * 所以收到文件时先记一笔，等 #本机 那条来了再取。
 */
export function rememberLocalInput(cfg, chatKey, file) {
  if (!chatKey || !file || !file.path) return;
  try {
    const dir = path.join(localOf(cfg).dir, 'last');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${safeFileName(String(chatKey), 'chat')}.json`);
    fs.writeFileSync(f, JSON.stringify({
      path: file.path, name: file.name || path.basename(file.path), at: Date.now(),
    }), 'utf8');
  } catch { /* 记不上不影响主流程 */ }
}

/** 取这个会话最近那个文件；超过 maxAgeMs 的算过期（别拿十几分钟前的旧文件去干活） */
export function lastLocalInput(cfg, chatKey, maxAgeMs = 30 * 60000) {
  try {
    const f = path.join(localOf(cfg).dir, 'last', `${safeFileName(String(chatKey), 'chat')}.json`);
    const got = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!got || !got.path || !fs.existsSync(got.path)) return null;
    if (Date.now() - Number(got.at || 0) > maxAgeMs) return null;
    return got;
  } catch {
    return null;
  }
}

/**
 * 抽出 `__SEND_FILE__ <服务器路径>` 这一行（可多行 = 发多个）。
 * 和 __SEND_STICKER__ / __POKE__ 一样是独占一行的副作用指令，行本身不发出去。
 * 只认「工作区、数据目录、voice 目录」底下的文件——模型不该有能力把 /etc/passwd 发给别人。
 */
export function extractFileDirective(text, { roots = [] } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const paths = [];
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    const m = t.match(/^_{0,2}SEND[-_ ]*FILE[-_ ]*_{0,2}[:\s]*(.*)$/i);
    if (!m) { kept.push(line); continue; }
    let raw = String(m[1] || '').trim().replace(/^[`'"“”‘’「」『』]+|[`'"“”‘’「」『』]+$/g, '').trim();
    if (!raw) continue;
    // file:// 前缀、Windows 反斜杠都顺手归一
    raw = raw.replace(/^file:\/\//, '').replace(/\\/g, '/');
    const abs = path.resolve(raw);
    const ok = roots.filter(Boolean).some((r) => {
      const root = path.resolve(r);
      return abs === root || abs.startsWith(root + path.sep);
    });
    if (!ok) continue;
    paths.push(abs);
  }
  return { paths, rest: kept.join('\n').trim() };
}

/**
 * 把一个服务器上的文件发进会话。
 * 必须先进 napcat 的 voice 目录——NapCat 的 upload_*_file 只认容器内路径，
 * 直接给 /root/... 会回「识别URL失败」。名字加 local- 前缀，既避免撞名也方便清理。
 */
export async function sendFileToChat({ ob, cfg, chat, filePath, name }) {
  const p = paths(cfg);
  const target = String(chat || '');
  const m = target.match(/^(private|group):(\d+)$/);
  if (!m) throw new Error('chat 要写成 private:QQ号 或 group:群号');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('文件不见了');
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size <= 0) throw new Error('文件是空的');
  if (st.size > p.maxBytes) throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)}MB）`);
  fs.mkdirSync(p.voice, { recursive: true });
  const safe = safeFileName(name || path.basename(filePath), '文件');
  const sentName = `local-${safe}`;
  const dest = path.join(p.voice, sentName);
  try {
    if (path.resolve(dest) !== path.resolve(filePath)) fs.copyFileSync(filePath, dest);
  } catch (e) {
    throw new Error(`复制到发送目录失败：${e.message}`);
  }
  const remote = `file://${p.containerDir}/${sentName}`;
  if (m[1] === 'group') {
    await ob.call('upload_group_file', { group_id: Number(m[2]), file: remote, name: sentName }, 120000);
  } else {
    await ob.call('upload_private_file', { user_id: Number(m[2]), file: remote, name: sentName }, 120000);
  }
  // 只留最近 10 个本机产物，别把 napcat 卷撑满
  try {
    const old = fs.readdirSync(p.voice).filter((f) => f.startsWith('local-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 10))) {
      try { fs.unlinkSync(path.join(p.voice, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { name: sentName, bytes: st.size };
}

async function sayInChat(ob, chat, text) {
  const t = String(chat || '');
  if (!text) return;
  try {
    if (t.startsWith('group:')) {
      await ob.call('send_group_msg', {
        group_id: Number(t.slice(6)), message: [{ type: 'text', data: { text } }],
      });
    } else if (t.startsWith('private:')) {
      await ob.call('send_private_msg', {
        user_id: Number(t.slice(8)), message: [{ type: 'text', data: { text } }],
      });
    }
  } catch { /* ignore */ }
}

/**
 * 收本机做完的活：扫 done/*.json，把产物发回会话，发完删干净。
 * 约定：done 里的 json 出现 = 可以发了（本机先把产物传完，最后才写 json）。
 */
export function startLocalWatcher({ cfg, ob, note }) {
  const p = ensureLocalDirs(cfg);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let names = [];
      try { names = fs.readdirSync(p.done).filter((f) => f.endsWith('.json')); } catch { names = []; }
      for (const f of names) {
        const file = path.join(p.done, f);
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          continue; // 本机可能正在写，下一轮再看
        }
        const id = f.replace(/\.json$/, '').split('__')[0];
        let job = { id, chat: String(meta.chat || ''), task: String(meta.task || '') };
        // 会话信息优先问本机回传的，其次退回桥自己记的那份
        try {
          const echo = path.join(p.sent, `${id}.json`);
          if (fs.existsSync(echo)) Object.assign(job, JSON.parse(fs.readFileSync(echo, 'utf8')), { chat: meta.chat || job.chat });
        } catch { /* 没有就用默认 */ }

        if (!/^(private|group):\d+$/.test(String(job.chat || ''))) {
          note?.('warn', `[本机] 任务 ${id} 没记下会话，跳过发送`);
        } else if (meta.ok) {
          const list = Array.isArray(meta.files) ? meta.files : [];
          let delivered = 0;
          for (const it of list) {
            const src = path.join(p.done, String(it.stored || ''));
            try {
              await sendFileToChat({ ob, cfg, chat: job.chat, filePath: src, name: it.name });
              delivered += 1;
            } catch (e) {
              note?.('warn', `[本机] ${job.chat} 产物发送失败：${e.message}`);
              await sayInChat(ob, job.chat, `本机做好了，但发不出去：${String(e.message).slice(0, 80)}`);
              break;
            }
          }
          if (!delivered) {
            await sayInChat(ob, job.chat, String(meta.text || '').slice(0, 400) || '本机那边办完了，没产出文件');
          }
          note?.('info', `[本机] ${job.chat} 任务 ${id} 完成：${delivered ? `${delivered} 个产物` : '只有文字'}${meta.took ? `，用时 ${meta.took}s` : ''}`);
        } else {
          note?.('warn', `[本机] 任务 ${id} 失败：${String(meta.err || '').slice(0, 200)}`);
          await sayInChat(ob, job.chat, `本机那边没办成：${String(meta.err || '不知道为啥').slice(0, 120)}`);
        }
        // 清干净：json + 产物 + sent 回执
        try {
          const all = fs.readdirSync(p.done).filter((n) => n.startsWith(id));
          for (const n of all) {
            try { fs.unlinkSync(path.join(p.done, n)); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        try { fs.unlinkSync(path.join(p.sent, `${id}.json`)); } catch { /* ignore */ }
      }
      // 队列里躺太久的丢掉（本机没开，别越堆越多）
      try {
        for (const f of fs.readdirSync(p.queue)) {
          const full = path.join(p.queue, f);
          const st = fs.statSync(full);
          if (Date.now() - st.mtimeMs > p.staleMs) fs.unlinkSync(full);
        }
      } catch { /* ignore */ }
      // files/ 里没人要的输入副本也清掉（按 mtime，超过 1 小时）
      try {
        for (const f of fs.readdirSync(p.files)) {
          const full = path.join(p.files, f);
          const st = fs.statSync(full);
          if (Date.now() - st.mtimeMs > 3600000) fs.unlinkSync(full);
        }
      } catch { /* ignore */ }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, p.pollMs);
  timer.unref?.();
  note?.('info', `[本机] 监听已启动（每 ${Math.round(p.pollMs / 1000)}s）`);
  return timer;
}
