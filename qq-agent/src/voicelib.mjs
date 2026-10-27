/**
 * 语音库：歌和长音频都存在号主那台 Windows 的 D:\DSH\voice-library。
 * 云端不存全量，只存按需推上来的缓存（workspace/voices）。
 * 列目录与推文件都走 win 通道（反向隧道到本机 server.cjs）。
 */
import { execFile } from 'node:child_process';

const WIN = '/usr/local/bin/win';
const LIB = 'D:\\DSH\\voice-library';
const REMOTE_PREFIX = '/root/qq-agent/workspace/voices/';
const CACHE_MS = 10 * 60 * 1000;
const AUDIO_RE = /\.(mp3|wav|flac|m4a|ogg|silk)$/i;

let cache = { at: 0, items: [] };
let lastError = '';

function runWin(cmd, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(
      WIN,
      [cmd],
      {
        timeout: timeout + 15000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, WIN_TIMEOUT: String(timeout) },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? String(err.message || err) : '',
        });
      },
    );
  });
}

/** 本机目录里有哪些音频。失败返回上次的缓存（可能是空）。 */
export async function listVoices(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.items;
  const cmd = `Get-ChildItem '${LIB}' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + '|' + $_.Length }`;
  const r = await runWin(cmd, 45000);
  if (!r.ok) {
    lastError = (r.stderr || r.error || 'win 通道没响应').trim().slice(0, 160);
    return cache.items;
  }
  const items = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.includes('|')) continue;
    const idx = t.lastIndexOf('|');
    const name = t.slice(0, idx).trim();
    const bytes = Number(t.slice(idx + 1).trim()) || 0;
    if (!name || !AUDIO_RE.test(name)) continue;
    items.push({ name, bytes });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  cache = { at: Date.now(), items };
  lastError = '';
  return items;
}

export function voicesError() {
  return lastError;
}

/** 把本机某个文件推到云端缓存，返回云端绝对路径。 */
export async function ensureRemote(name) {
  const safe = String(name || '').replace(/[\\"'`$]/g, '').trim();
  if (!safe) return { ok: false, msg: '名字是空的' };
  const cached = REMOTE_PREFIX + safe;
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "D:\DSH\tools\remote-exec\push-file.ps1" -Path "D:\DSH\voice-library\${safe}"`;
  const r = await runWin(cmd, 600000);
  const tail = r.stdout
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .pop() || '';
  if (!tail.startsWith(REMOTE_PREFIX)) return { ok: false, msg: tail || r.stderr.trim() || '没推上来' };
  return { ok: true, path: cached };
}

/** 从名字或序号里挑一首。序号从 1 开始。 */
export async function pickVoice(input) {
  const items = await listVoices();
  const raw = String(input || '').trim();
  if (!items.length) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
  const kw = raw.replace(/\s+/g, '');
  if (!kw) return null;
  return (
    items.find((it) => it.name.replace(/\.[^.]+$/, '').replace(/\s+/g, '') === kw) ||
    items.find((it) => it.name.replace(/\.[^.]+$/, '').replace(/\s+/g, '').includes(kw)) ||
    null
  );
}
