#!/usr/bin/env node
/**
 * 循环看守（loop-guard）——每 3 分钟问一句：它是在干活，还是卡在循环里空转
 *
 * 2026-10-29 用户要求：「制作一个自动化任务，自动检测智能体在工作时有没有陷入循环
 * （摸鱼，浪费资源），每三分钟一次，检测是否活着正常工作」。
 *
 * 它看七件事，全是只读，动作只有两种（杀超时 dsh / 重启桥），都带冷却：
 *   1. 桥活着吗（systemd 状态 + /api/status 的 connected）
 *   2. 一轮是不是卡死了（busy 连续几次检查都是 1，日志十几分钟没有新回复落地）
 *   3. 有没有单轮跑好几分钟不结束（那是挂住，不是慢）
 *   4. 同一句话反复回（复读环）、同一条错误反复刷（错误环）
 *   5. token 在烧、回复一个没出来（空转）；消息一直进、模型一次没跑（哑了）
 *   6. 机器被撑爆：内存见底 / 负载过高 / dsh 进程活过 15 分钟
 *   7. 看守自己有没有停过（心跳断了 = 这个功能本身失效，要报人）
 *
 * 定时：qq-loop-guard.timer（每 3 分钟）。手动：node scripts/loop-guard.mjs [--dry-run]
 * 单测：node scripts/test-loop-guard.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.QQ_AGENT_ROOT || '/root/qq-agent';
const CTRL = process.env.QQ_CTRL || 'http://127.0.0.1:3899';
const DRY = process.argv.includes('--dry-run');
const STATE_FILE = path.join(ROOT, 'data', 'loop-guard.json');
const OUT_LOG = path.join(ROOT, 'logs', 'loop-guard.log');
const CHECK_GAP_MS = 180_000; // 定时器间隔，用来把「连续几次检查」换算成分钟

export const LIMITS = {
  slowTurnMs: 180_000, // 一轮超过 3 分钟：慢，但先记着
  stuckBusyChecks: 3, // 连续 3 次检查（≈9 分钟）都在忙
  stuckNoReplyMs: 600_000, // 且最后一次回复在 10 分钟以前 → 判定卡死
  errorRepeat: 15, // 同一条错误 5 分钟内刷 15 次
  errorWindowMs: 5 * 60_000,
  repeatReplyRun: 4, // 同一个会话连着 4 条回复，字数、条数都一样
  repeatGapMs: 90_000,
  zombieSec: 900, // dsh 活过 15 分钟就是挂住
  memWarnMb: 300,
  loadRatio: 1.6,
  burnStreakWarn: 4, // 连续 4 次检查都在烧 token 没回复
  restartCooldownMs: 30 * 60_000,
  notifyGapMs: 10 * 60_000,
  selfGapMs: 9 * 60_000,
  quietFrom: 3, // 凌晨 3~6 点只报 critical
  quietTo: 6,
  // 本机执行器（号主 Windows 上的 dsh）：它每 30 秒报一次 health.json
  localStaleMs: 8 * 60_000, // 8 分钟没上报就当它挂了（心跳正常是 30 秒一次）
  localTaskWarnSec: 600, // 一个任务跑 10 分钟：慢
  localTaskCriticalSec: 1800, // 跑 30 分钟：必挂（和它自己的硬上限一致）
  localRepeatWarn: 3, // 同一个任务半小时内塞 3 次：像在循环里重试
  localFailStreak: 3, // 连着 3 个任务失败：像在原地打转
};

/* ================= 纯函数：解析 ================= */

/** 把消息里的数字抹掉，用来判断「是不是同一条」 */
export function normalizeMsg(msg) {
  return String(msg ?? '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** journalctl -o cat 的输出 → {lines, replies, errors}（时间统一按 +08:00 解析） */
export function parseJournal(raw) {
  const out = { lines: [], replies: [], errors: [] };
  for (const rawLine of String(raw ?? '').split('\n')) {
    const m = rawLine.match(/^\[(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)\]\s+([A-Z]+)\s+(.*)$/);
    if (!m) continue;
    const ts = Date.parse(`${m[1]}T${m[2]}+08:00`);
    if (!Number.isFinite(ts)) continue;
    const line = { ts, level: m[3], msg: m[4] };
    out.lines.push(line);
    // 每轮回复落地时的那一行：[key] N 条 / M 字…（Xms = 准备 … + 模型 …）
    const r = line.msg.match(/^\[([^\]]+)\]\s+(\d+)\s+条\s*\/\s*(\d+)\s*字[\s\S]*?（(\d+)ms/);
    if (r) out.replies.push({ ts, key: r[1], parts: Number(r[2]), chars: Number(r[3]), ms: Number(r[4]) });
    if (line.level === 'WARN' || line.level === 'ERROR') {
      out.errors.push({ ts, level: line.level, norm: normalizeMsg(line.msg), msg: line.msg });
    }
  }
  return out;
}

/** ps -eo pid,ppid,etimes,pcpu,rss,args → 进程对象数组 */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      etimes: Number(m[3]),
      pcpu: Number(m[4]),
      rssKb: Number(m[5]),
      args: m[6],
    });
  }
  return rows;
}

export function parseMemAvailableMb(meminfo) {
  const m = String(meminfo ?? '').match(/^MemAvailable:\s*(\d+)\s*kB/m);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

export function parseLoad1(loadavg) {
  const v = Number(String(loadavg ?? '').trim().split(/\s+/)[0]);
  return Number.isFinite(v) ? v : null;
}

/* ================= 纯函数：判定 ================= */

/** 桥活着吗；QQ 掉线不算桥的错，是登录态没了，只能报人 */
export function detectLiveness({ bridgeActive, status, connectFails = 0 }) {
  const findings = [];
  if (bridgeActive === false) {
    findings.push({
      id: 'bridge-down',
      level: 'critical',
      text: 'qq-bridge 服务没在跑（systemd 说 inactive）',
      action: { kind: 'restart-bridge' },
    });
  }
  if (status && status.connected === false) {
    findings.push({
      id: 'qq-offline',
      level: 'critical',
      text: '桥进程活着但没连上 QQ（登录态可能过期，要扫码）',
    });
  }
  if (status && status.connected === false && connectFails + 1 >= 2) {
    findings.push({ id: 'qq-offline-sustained', level: 'critical', text: `已经连续 ${connectFails + 1} 次检查没连上 QQ` });
  }
  return findings;
}

/** 一轮卡死：连续好几次检查都在忙，日志又很久没有新回复 */
export function detectStuckTurn({ busyStreak = 0, replies = [], now = Date.now() }) {
  const findings = [];
  if (busyStreak < LIMITS.stuckBusyChecks) return findings;
  const last = replies.length ? replies[replies.length - 1].ts : 0;
  const quiet = last ? now - last : null;
  const quietEnough = quiet === null || quiet > LIMITS.stuckNoReplyMs;
  if (!quietEnough) return findings;
  const mins = qualityMinutes(busyStreak);
  findings.push({
    id: 'stuck-turn',
    level: 'critical',
    text: `桥上连着 ${busyStreak} 次检查（≈${mins} 分钟）都是忙的，${quiet === null ? '日志里找不到回复' : `最后一次回复在 ${Math.round(quiet / 60_000)} 分钟前`}`,
    action: { kind: 'restart-bridge' },
  });
  return findings;
}

function qualityMinutes(checks) {
  return Math.max(1, Math.round((checks * CHECK_GAP_MS) / 60_000));
}

/** 单轮太长：不是慢，是挂住了 */
export function detectSlowTurns({ replies = [], now = Date.now(), windowMs = 20 * 60_000 }) {
  const slow = replies.filter((r) => r.ms > LIMITS.slowTurnMs && now - r.ts < windowMs);
  if (!slow.length) return [];
  const worst = slow.reduce((a, b) => (b.ms > a.ms ? b : a), slow[0]);
  return [{
    id: 'slow-turn',
    level: worst.ms > 2 * LIMITS.slowTurnMs ? 'warn' : 'info',
    text: `最近 ${slow.length} 轮里有 ${slow.length === 1 ? '一轮' : `${slow.length} 轮`} 超过 ${Math.round(LIMITS.slowTurnMs / 60_000)} 分钟，最久一轮 ${Math.round(worst.ms / 1000)} 秒（${worst.key}）`,
  }];
}

/** 错误环：同一条警告/报错在窗口内刷太多次 */
export function detectErrorLoop({ errors = [], now = Date.now() }) {
  const recent = errors.filter((e) => now - e.ts < LIMITS.errorWindowMs);
  const groups = new Map();
  for (const e of recent) groups.set(e.norm, (groups.get(e.norm) ?? 0) + 1);
  const findings = [];
  for (const [norm, count] of groups) {
    if (count < LIMITS.errorRepeat) continue;
    const sample = recent.find((e) => e.norm === norm);
    findings.push({
      id: 'error-loop',
      level: 'warn',
      text: `同一条${{ ERROR: '报错', WARN: '警告' }[sample.level] ?? '日志'} ${Math.round(LIMITS.errorWindowMs / 60_000)} 分钟内出现 ${count} 次：${sample.msg.slice(0, 80)}`,
    });
  }
  return findings;
}

/** 复读环：同一个会话连着好几条回复，条数和字数完全一样，间隔还很密 */
export function detectRepeatReply({ replies = [], now = Date.now() }) {
  const recent = replies.filter((r) => now - r.ts < 15 * 60_000);
  const findings = [];
  let run = [];
  const flush = () => {
    if (run.length >= LIMITS.repeatReplyRun) {
      const first = run[0];
      const last = run[run.length - 1];
      const span = Math.round((last.ts - first.ts) / 1000);
      const dense = run.slice(1).every((r, i) => r.ts - run[i].ts < LIMITS.repeatGapMs);
      if (dense && span <= 15 * 60_000) {
        findings.push({
          id: 'repeat-reply',
          level: 'warn',
          text: `${last.key} 连着 ${run.length} 条回复都是 ${last.parts} 条 / ${last.chars} 字（${span} 秒内），像卡在复读`,
        });
      }
    }
    run = [];
  };
  for (const r of recent) {
    const prev = run[run.length - 1];
    if (prev && prev.key === r.key && prev.parts === r.parts && prev.chars === r.chars) run.push(r);
    else { flush(); run = [r]; }
  }
  flush();
  return findings;
}

/** 空转：模型跑了几轮、一条回复都没落地；或者消息一直进、模型一次没跑 */
export function detectTokenBurn({ status, prev, burnStreak = 0 }) {
  const findings = [];
  if (!status?.stats) return { findings, burnStreak, delta: null };
  const pick = (k) => Number(status.stats[k] ?? 0);
  const before = prev ?? {};
  const delta = {
    turns: pick('turns') - Number(before.turns ?? pick('turns')),
    received: pick('received') - Number(before.received ?? pick('received')),
    replied: pick('replied') - Number(before.replied ?? pick('replied')),
    ignored: pick('ignored') - Number(before.ignored ?? pick('ignored')),
    tokensIn: pick('tokensIn') - Number(before.tokensIn ?? pick('tokensIn')),
  };
  // 群里没叫她的消息会算进 received 但直接 ignored（正常静默），别把它当成「哑了」
  const realReceived = delta.received - delta.ignored;
  let next = burnStreak;
  if (delta.turns > 0 && delta.replied <= 0) next += 1;
  else if (delta.turns > 0) next = 0;
  if (next >= LIMITS.burnStreakWarn) {
    findings.push({
      id: 'token-burn',
      level: 'warn',
      text: `连续 ${next} 次检查模型都在跑（这一轮 +${delta.turns} 轮 / +${delta.tokensIn} token）却一条回复没发出`,
    });
  }
  if (realReceived >= 3 && delta.turns === 0 && delta.replied === 0) {
    findings.push({ id: 'mute-flow', level: 'warn', text: `这一段进来了 ${realReceived} 条该她接的消息，模型一轮都没跑` });
  }
  return { findings, burnStreak: next, delta };
}

/** 撑爆机器：内存见底 / 负载过高 / dsh 活过 15 分钟 */
export function detectResources({ memAvailMb, load1, cpus, procs = [], now = Date.now() }) {
  const findings = [];
  if (memAvailMb !== null && memAvailMb !== undefined && memAvailMb < LIMITS.memWarnMb) {
    findings.push({ id: 'mem-low', level: 'critical', text: `可用内存只剩 ${memAvailMb}MB` });
  }
  if (load1 !== null && load1 !== undefined && cpus && load1 > cpus * LIMITS.loadRatio) {
    findings.push({ id: 'load-high', level: 'warn', text: `负载 ${load1.toFixed(2)}，是 ${cpus} 核的 ${(load1 / cpus).toFixed(1)} 倍` });
  }
  for (const p of procs) {
    if (!/dsh/.test(p.args)) continue;
    if (/loop-guard|test-|guard\.mjs/.test(p.args)) continue;
    if (p.etimes < LIMITS.zombieSec) continue;
    findings.push({
      id: 'zombie-dsh',
      level: 'critical',
      text: `有个 dsh 进程已经跑了 ${Math.round(p.etimes / 60)} 分钟还没退（pid ${p.pid}，占 ${Math.round(p.rssKb / 1024)}MB）`,
      action: { kind: 'kill', pid: p.pid },
    });
  }
  return findings;
}

/** 看守自己断过没有：心跳断了说明定时器没在跑，这个功能本身就失效了 */
export function detectSelfGap({ lastRunAt, now = Date.now() }) {
  if (!lastRunAt) return [];
  if (now - lastRunAt < LIMITS.selfGapMs) return [];
  return [{
    id: 'guard-gap',
    level: 'warn',
    text: `看守自己停了 ${Math.round((now - lastRunAt) / 60_000)} 分钟（上一次检查在 ${new Date(lastRunAt).toISOString()}），定时器可能没在跑`,
  }];
}

/* ================= 本机执行器（2026-10-29 用户要求纳入检测） ================= */

/**
 * 本机（号主 Windows）那个 dsh 执行器也会陷进去：一个任务跑半小时、同一个任务被反复塞进来、
 * 连着挂几次。它自己每 30 秒把 health.json 报上来，这边跟着一起判。
 * 服务器上杀不了本机进程，所以只报人、不动手。
 */
export function detectLocal({ health, now = Date.now() } = {}) {
  const findings = [];
  if (!health || typeof health !== 'object') {
    findings.push({ id: 'local-silent', level: 'info', text: '本机执行器还没上报过体检（没开，或者刚启动）' });
    return findings;
  }
  const ts = Number(health.ts ?? 0);
  const age = ts ? now - ts : Infinity;
  if (age > LIMITS.localStaleMs) {
    const mins = Number.isFinite(age) ? Math.round(age / 60_000) : '?';
    findings.push({
      id: 'local-stale',
      level: 'warn',
      text: `本机执行器 ${mins} 分钟没上报了（可能挂了，也可能网络断了）`,
    });
  }
  const cur = health.current;
  const elapsed = Number(cur?.elapsed ?? 0);
  if (cur && elapsed >= LIMITS.localTaskCriticalSec) {
    findings.push({
      id: 'local-task-stuck',
      level: 'critical',
      text: `本机 dsh 任务 ${cur.id || '?'} 已经跑了 ${Math.round(elapsed / 60)} 分钟（硬上限 ${Math.round(Number(health.max_task_sec || 1800) / 60)} 分钟）`,
    });
  } else if (cur && elapsed >= LIMITS.localTaskWarnSec) {
    findings.push({
      id: 'local-task-long',
      level: 'warn',
      text: `本机 dsh 任务 ${cur.id || '?'} 跑了 ${Math.round(elapsed / 60)} 分钟还没结束`,
    });
  }
  for (const r of Array.isArray(health.repeats) ? health.repeats : []) {
    if (Number(r?.count ?? 0) < LIMITS.localRepeatWarn) continue;
    findings.push({
      id: 'local-repeat',
      level: 'warn',
      text: `本机同一个任务半小时内被塞了 ${r.count} 次：${String(r.task || '').slice(0, 40)}`,
    });
  }
  if (Number(health.fail_streak ?? 0) >= LIMITS.localFailStreak) {
    findings.push({
      id: 'local-fails',
      level: 'warn',
      text: `本机连着 ${health.fail_streak} 个任务失败`,
    });
  }
  return findings;
}

/** 本机执行器自己报上来的体检快照；没有就是 null */
export function readLocalHealth() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'data', 'local', 'health.json'), 'utf8'));
  } catch { return null; }
}

/** 一句话说清本机在干嘛（给日志用） */
export function describeLocal(health) {
  if (!health) return '本机 无上报';
  const cur = health.current;
  if (cur) return `本机 忙(${cur.id || '?'} ${Math.round(Number(cur.elapsed ?? 0))}s)`;
  return `本机 闲(${Number(health.jobs ?? 0)} 单)`;
}

/* ================= 现场采集 ================= */

function sh(cmd, args, timeout = 20_000) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
}

async function readStatus() {
  try {
    const res = await fetch(`${CTRL}/api/status`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function readBridgeActive() {
  try {
    return sh('systemctl', ['is-active', 'qq-bridge']).trim() === 'active';
  } catch { return false; }
}

function readProcs() {
  try { return parsePs(sh('ps', ['-eo', 'pid,ppid,etimes,pcpu,rss,args'])); } catch { return []; }
}

function readMemAvailMb() {
  try { return parseMemAvailableMb(readFileSync('/proc/meminfo', 'utf8')); } catch { return null; }
}

function readLoad1() {
  try { return parseLoad1(readFileSync('/proc/loadavg', 'utf8')); } catch { return null; }
}

function readJournal() {
  try { return parseJournal(sh('journalctl', ['-u', 'qq-bridge', '--since', '-16min', '--no-pager', '-o', 'cat'])); } catch { return parseJournal(''); }
}

/* ================= 状态与动作 ================= */

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  if (DRY) return;
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { log(`状态写不进去：${e.message}`); }
}

function log(msg) {
  const stamp = new Date().toISOString();
  process.stdout.write(`[${stamp}] ${msg}\n`);
  if (DRY) return;
  try {
    mkdirSync(path.dirname(OUT_LOG), { recursive: true });
    appendFileSync(OUT_LOG, `[${stamp}] ${msg}\n`);
  } catch { /* 日志写不进去也不能让看守挂掉 */ }
}

function cooled(state, key, now, ms) {
  const last = Number(state.incidents?.[key] ?? 0);
  return !last || now - last > ms;
}

function markIncident(state, key, now) {
  state.incidents = state.incidents ?? {};
  state.incidents[key] = now;
}

function inQuietHours(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Shanghai' }).format(now));
  return h >= LIMITS.quietFrom && h < LIMITS.quietTo;
}

function ownerUid() {
  try {
    const c = JSON.parse(readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
    return Number(c?.persona?.ownerUids?.[0] || 0);
  } catch { return 0; }
}

async function notifyOwner(text) {
  const uid = ownerUid();
  if (!uid || DRY) return false;
  try {
    const res = await fetch(`${CTRL}/api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'text', chat: `private:${uid}`, by: uid, text }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch { return false; }
}

function restartBridge() {
  if (DRY) { log('[dry] 本该重启 qq-bridge'); return false; }
  try {
    sh('systemctl', ['restart', 'qq-bridge'], 90_000);
    log('已重启 qq-bridge');
    return true;
  } catch (e) {
    log(`重启 qq-bridge 失败：${e.message}`);
    return false;
  }
}

function killPid(pid) {
  if (DRY) { log(`[dry] 本该杀掉 pid ${pid}`); return false; }
  try {
    process.kill(pid, 'SIGTERM');
    log(`已给 pid ${pid} 发 SIGTERM（挂住太久）`);
    return true;
  } catch (e) {
    log(`杀 pid ${pid} 失败：${e.message}`);
    return false;
  }
}

/* ================= 主流程 ================= */

async function main() {
  const now = Date.now();
  const state = loadState();
  const findings = [];
  const blind = [];

  const [status] = await Promise.all([readStatus()]);
  const bridgeActive = readBridgeActive();
  const journal = readJournal();
  const procs = readProcs();
  const memAvailMb = readMemAvailMb();
  const load1 = readLoad1();
  const localHealth = readLocalHealth();
  const cpus = os.cpus().length || 2;
  if (!status) blind.push('拿不到 /api/status');

  const connectFails = status && status.connected === false ? Number(state.connectFails ?? 0) : 0;
  findings.push(...detectLiveness({ bridgeActive, status, connectFails }));
  findings.push(...detectSelfGap({ lastRunAt: Number(state.lastRunAt ?? 0), now }));
  findings.push(...detectLocal({ health: localHealth, now }));

  const busyNow = status && Number(status.busy ?? 0) > 0;
  const busyStreak = busyNow ? Number(state.busyStreak ?? 0) + 1 : 0;
  findings.push(...detectStuckTurn({ busyStreak, replies: journal.replies, now }));
  findings.push(...detectSlowTurns({ replies: journal.replies, now }));
  findings.push(...detectErrorLoop({ errors: journal.errors, now }));
  findings.push(...detectRepeatReply({ replies: journal.replies, now }));
  findings.push(...detectResources({ memAvailMb, load1, cpus, procs, now }));

  const burn = detectTokenBurn({ status, prev: state.prevStats, burnStreak: Number(state.burnStreak ?? 0) });
  findings.push(...burn.findings);

  // —— 动作：每个 id 各自冷却，避免抖动 ——
  const actions = [];
  for (const f of findings) {
    if (!f.action) continue;
    const key = f.id;
    if (!cooled(state, key, now, LIMITS.restartCooldownMs)) {
      log(`「${key}」还在冷却期，这次只记不动`);
      continue;
    }
    if (f.action.kind === 'restart-bridge') {
      if (restartBridge()) { markIncident(state, key, now); actions.push('重启桥'); }
    } else if (f.action.kind === 'kill' && f.action.pid) {
      if (killPid(f.action.pid)) { markIncident(state, key, now); actions.push(`杀掉 pid ${f.action.pid}`); }
    }
  }

  // —— 报人：一次说清，10 分钟一小口，深夜只报 critical ——
  const warnOrWorse = findings.filter((f) => f.level !== 'info');
  let notified = false;
  if (warnOrWorse.length) {
    const quiet = inQuietHours(new Date(now));
    const critical = warnOrWorse.some((f) => f.level === 'critical');
    const gapOk = !state.lastNotifyAt || now - Number(state.lastNotifyAt) > LIMITS.notifyGapMs;
    if ((!quiet || critical) && gapOk && !DRY) {
      const head = actions.length ? `看守动手了（${actions.join('、')}），先说一声。` : '看守看了一眼，有点不对劲。';
      const body = warnOrWorse.map((f) => `· ${f.text}`).join('\n');
      if (await notifyOwner(`${head}\n${body}`)) {
        state.lastNotifyAt = now;
        notified = true;
      }
    }
  }

  // —— 落状态 ——
  state.lastRunAt = now;
  state.busyStreak = busyStreak;
  state.burnStreak = burn.burnStreak;
  state.connectFails = status && status.connected === false ? connectFails + 1 : 0;
  if (status?.stats) {
    state.prevStats = {
      turns: Number(status.stats.turns ?? 0),
      received: Number(status.stats.received ?? 0),
      replied: Number(status.stats.replied ?? 0),
      tokensIn: Number(status.stats.tokensIn ?? 0),
    };
  }
  saveState(state);

  // —— 一行日志 ——
  const head = findings.length ? (warnOrWorse.length ? 'ALERT' : 'warn') : 'ok';
  const detail = findings.length ? findings.map((f) => `${f.id}:${f.text}`).join(' | ') : `正常（busy=${status ? status.busy : '?'} 回复 ${journal.replies.length} 条 错误 ${journal.errors.length} 条 内存 ${memAvailMb ?? '?'}MB 负载 ${load1 ?? '?'} ${describeLocal(localHealth)}）`;
  log(`${head} ${detail}${blind.length ? ` | 读不到：${blind.join('、')}` : ''}${notified ? ' | 已私聊报人' : ''}`);

  return { head, findings, actions };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((e) => {
    log(`看守自己出错了：${e?.stack || e}`);
    process.exitCode = 1;
  });
}

export { main };
