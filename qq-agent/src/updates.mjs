/**
 * 组件更新检查（2026-10-28）
 *
 * 自己跑着的东西里有两个会单独换代：
 *   · QQ 端 SnowLuma —— 第三方发的，镜像重建才换得上
 *   · dsh 本体 —— npm 上发新版
 * 它们换了代不会自己吭声，得有人隔一阵去看一眼。这里每天看一次，
 * 有新版就私聊号主；同一个版本只提醒一次。查不到（断网、容器没起）
 * 就安静跳过，别拿报错刷屏。
 *
 * 只读：不发请求改任何东西，装不装由人决定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDir, log } from './util.mjs';

const pExec = promisify(execFile);

export const DEFAULT_UPDATES = {
  enabled: true,
  intervalHours: 24,
  startupDelayMs: 180_000,
  quietStartHour: 0,
  quietEndHour: 8,
  container: 'snowluma',
  dshPackage: '/root/.dsh-runtime/dsh/node_modules/@deepseek-ai/dsh/package.json',
  sources: { snowluma: true, dsh: true },
};

export function updatesConfig(cfg) {
  return { ...DEFAULT_UPDATES, ...(cfg?.raw?.updates || {}) };
}

/** 拆成 [major, minor, patch] + 预发布后缀 */
export function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: String(m[4] || '') };
}

/** a>b 返回 1，a<b 返回 -1，相等 0；正式版大于同号预发布版 */
export function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

async function fetchJson(url, timeoutMs = 12_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': 'qq-agent-update-check', accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** QQ 端：容器里的 release.json 是它自己写的版本，GitHub releases 是最新 */
async function probeSnowluma(c) {
  let current = null;
  try {
    const { stdout } = await pExec('docker', ['exec', c.container, 'cat', '/app/runtime/release.json'], { timeout: 12_000 });
    current = JSON.parse(stdout).version || null;
  } catch {
    return null; // 容器没起，不算失败
  }
  let latest = null;
  try {
    const j = await fetchJson('https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest');
    latest = String(j.tag_name || '').replace(/^v/i, '');
  } catch {
    return null; // 断网就算了，下次再看
  }
  return {
    id: 'snowluma',
    label: 'SnowLuma',
    current,
    latest,
    url: 'https://github.com/SnowLuma/SnowLuma/releases',
  };
}

/** dsh 本体：本地装的版本 vs npm 上的 latest */
async function probeDsh(c) {
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(c.dshPackage, 'utf8')).version || null;
  } catch {
    return null;
  }
  let latest = null;
  try {
    latest = String((await fetchJson('https://registry.npmjs.org/@deepseek-ai/dsh/latest')).version || '');
  } catch {
    return null;
  }
  return {
    id: 'dsh',
    label: 'dsh 本体',
    current,
    latest,
    url: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
  };
}

/** 跑一遍检查，只返回查得到的，不抛错 */
export async function runCheck(cfg) {
  const c = updatesConfig(cfg);
  const rows = [];
  if (c.sources?.snowluma !== false) {
    const r = await probeSnowluma(c);
    if (r) rows.push(r);
  }
  if (c.sources?.dsh !== false) {
    const r = await probeDsh(c);
    if (r) rows.push(r);
  }
  for (const r of rows) {
    r.newer = Boolean(r.current && r.latest) && cmpVersion(r.latest, r.current) > 0;
  }
  return rows;
}

/** 把结果说成人话（给 QQ 和 #更新检查 用） */
export function formatReport(rows) {
  if (!rows.length) return '这次一个也没查到（容器没起或者断网了），等下一轮再看。';
  return rows.map((r) => {
    if (!r.current || !r.latest) return `${r.label}：版本没读到`;
    if (r.newer) return `${r.label} 出 ${r.latest} 了，我们现在是 ${r.current}`;
    return `${r.label} ${r.current}，已是最新`;
  }).join('\n');
}

export function createUpdateCheck({ cfg, note, notify }) {
  const conf = () => updatesConfig(cfg);
  const stateFile = path.join(cfg.dataDir, 'updates.json');
  ensureDir(cfg.dataDir);
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* 第一次跑，没有就没有 */ }
  let timer = null;
  let busy = false;

  const save = () => {
    try { fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8'); }
    catch (e) { note('warn', `更新检查状态写入失败: ${e.message}`); }
  };

  function inQuietHours(d = new Date()) {
    const c = conf();
    const h = d.getHours();
    const a = Number(c.quietStartHour) || 0;
    const b = Number(c.quietEndHour) || 0;
    if (a === b) return false;
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }

  async function tick({ force = false, silent = false } = {}) {
    const c = conf();
    if (!c.enabled && !force) return { skipped: 'disabled' };
    if (busy) return { skipped: 'busy' };
    if (!force && Date.now() - (st.lastCheckAt || 0) < c.intervalHours * 3600_000) {
      return { skipped: 'interval' };
    }
    busy = true;
    try {
      const rows = await runCheck(cfg);
      st.lastCheckAt = Date.now();
      st.lastRows = rows;
      st.notified = st.notified || {};

      const fresh = rows.filter((r) => r.newer && st.notified[r.id] !== r.latest);
      for (const r of fresh) st.notified[r.id] = r.latest;

      // 半夜先攒着，等天亮了再喊
      if (fresh.length && !silent) {
        const text = `【组件更新】${formatReport(fresh)}\n要更新跟我说一声。`;
        if (inQuietHours()) {
          st.pending = [text];
          note('info', `更新检查：${fresh.map((r) => r.id).join('、')} 有新版，等天亮再报`);
        } else {
          st.pending = [];
          try { await notify(text); } catch (e) { note('warn', `更新提醒发送失败: ${e.message}`); }
          note('info', `更新检查：${fresh.map((r) => `${r.label} ${r.current}→${r.latest}`).join('，')}`);
        }
      } else if (!fresh.length && Array.isArray(st.pending) && st.pending.length && !silent && !inQuietHours()) {
        // 上次攒着的，现在补报
        for (const text of st.pending) {
          try { await notify(text); } catch { /* 发不出去就算了 */ }
        }
        st.pending = [];
      }

      if (rows.length) {
        note('info', `更新检查：${rows.map((r) => `${r.id}=${r.current}${r.newer ? '(可升 ' + r.latest + ')' : ''}`).join(' ')}`);
      }
      save();
      return { rows, fresh };
    } catch (e) {
      note('warn', `更新检查出错: ${e.message}`);
      return { error: e.message };
    } finally {
      busy = false;
    }
  }

  function start() {
    const c = conf();
    if (!c.enabled) { note('info', '组件更新检查：未启用'); return { stop() {}, tick }; }
    note('info', `组件更新检查：开（每 ${c.intervalHours} 小时看一次 SnowLuma 与 dsh 本体）`);
    const kick = setTimeout(() => { void tick(); }, Math.max(5_000, c.startupDelayMs));
    if (kick.unref) kick.unref();
    timer = setInterval(() => { void tick(); }, Math.max(1, c.intervalHours) * 3600_000);
    if (timer.unref) timer.unref();
    return {
      stop() { clearTimeout(kick); if (timer) clearInterval(timer); timer = null; },
      tick,
    };
  }

  return { start, tick, status: () => ({ ...st, rows: st.lastRows || [] }) };
}
