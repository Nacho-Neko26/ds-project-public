#!/usr/bin/env node
/**
 * 模型路线看守（model-guard）
 *
 * 2026-10-28 用户要求：「云端改成默认go，不要自动切回中转了，go坏了切官方，中转要指令才切换」。
 * 所以这个看守只管 go ⇄ 官方这一对：
 *   1. 现在走 go，探测失败 → failStreak++，够了就切官方（桥那头也会当场切，这里是兜底）
 *   2. 现在走官方，go 探测成功 → okStreak++，连续够次且过了冷却期，切回 go
 *   3. 现在走 relay（21R 中转）→ 一个字都不动：那是人下 #模型 中转 才进来的，只有人再下指令才出去
 *   4. 真的切了才发私聊，别拿噪音烦人
 *
 * 用 systemd timer 每 10 分钟跑一次：qq-model-guard.timer
 * 手动跑：node scripts/model-guard.mjs [--dry-run]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { httpsJsonPost } from '../src/vision.mjs';
import {
  readMode, writeMode, FAIL_THRESHOLD, OK_THRESHOLD, RECOVER_COOLDOWN_MS, MANUAL_MODES,
} from '../src/model-mode.mjs';

const ROOT = process.env.QQ_AGENT_ROOT || '/root/qq-agent';
const CTRL = process.env.QQ_CTRL || 'http://127.0.0.1:3899';
const DRY = process.argv.includes('--dry-run');
const cfg = { dataDir: path.join(ROOT, 'data') };

const PROBE_URL = 'https://opencode.ai/inference/go/openai/v1/chat/completions';
const PROBE_MODEL = 'deepseek-v4.1-flash';

function readCredential(name) {
  if (process.env[name]) return process.env[name];
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const file = path.join(home, '.credentials.yaml');
  if (!existsSync(file)) return '';
  const m = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm'));
  return m ? m[1] : '';
}

function ownerUid() {
  try {
    const c = JSON.parse(readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
    return Number(c?.persona?.ownerUids?.[0] || 0);
  } catch { return 0; }
}

async function notify(text) {
  const uid = ownerUid();
  if (!uid) return false;
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

/** 探一下 go 还活不活。只花 1 个 token，比「切过去才发现死了」便宜得多。 */
async function probeGo() {
  const key = readCredential('OPENCODE_GO_API_KEY');
  if (!key) return { ok: false, why: '没有 OPENCODE_GO_API_KEY' };
  const startedAt = Date.now();
  // 2026-10-28：别再用全局 fetch。这台机器 opencode.ai 只给 IPv6，ECS 没有 IPv6 路由，
  // fetch 会随机 1 秒后报 `fetch failed`（实测 8 次错 4 次），看守就误判 go 挂了反复切换。
  const res = await httpsJsonPost({
    url: PROBE_URL,
    timeoutMs: 30_000,
    body: JSON.stringify({
      model: PROBE_MODEL,
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1,
      stream: false,
    }),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'x-opencode-session': 'ses_model_guard_probe',
    },
  });
  const elapsed = Date.now() - startedAt;
  if (res.error) return { ok: false, why: res.error, elapsed };
  if (res.status >= 200 && res.status < 300) return { ok: true, elapsed };
  return { ok: false, why: `HTTP ${res.status} ${String(res.text).slice(0, 200)}`, elapsed };
}

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

async function main() {
  const st = readMode(cfg);

  // 手动线：21R 中转是人选的，看守不许自己进也不许自己出
  if (MANUAL_MODES.includes(st.mode)) {
    log(`当前 ${st.mode}（手动选中转），看守不动它`);
    return;
  }

  const probe = await probeGo();
  log(`当前 ${st.mode}；go 探测 ${probe.ok ? `通（${probe.elapsed}ms）` : `不通（${probe.why}）`}`);

  if (DRY) { log('[dry] 不做切换'); return; }

  if (st.mode === 'go') {
    if (probe.ok) {
      if (st.failStreak) writeMode(cfg, { failStreak: 0, lastProbeAt: Date.now() });
      return;
    }
    const failStreak = st.failStreak + 1;
    if (failStreak < FAIL_THRESHOLD) {
      writeMode(cfg, { failStreak, lastProbeAt: Date.now() });
      log(`go 探测失败 ${failStreak}/${FAIL_THRESHOLD}，先不切`);
      return;
    }
    const next = writeMode(cfg, { mode: 'official', reason: 'probe-failed', lastProbeAt: Date.now() });
    log(`模型路线 → 官方（go 连不上），since ${new Date(next.since).toISOString()}`);
    await notify('go 那边连不上了，我先切到官方顶上，等它好了自己回来。');
    return;
  }

  // 走官方：看看 go 活过来没有（官方不会自动切回中转，中转只认指令）
  if (!probe.ok) {
    writeMode(cfg, { okStreak: 0, lastProbeAt: Date.now() });
    return;
  }
  const okStreak = st.okStreak + 1;
  const cooled = Date.now() - Number(st.lastSwitchAt || 0) > RECOVER_COOLDOWN_MS;
  if (okStreak < OK_THRESHOLD || !cooled) {
    writeMode(cfg, { okStreak, lastProbeAt: Date.now() });
    log(`go 通了 ${okStreak}/${OK_THRESHOLD}${cooled ? '' : '（还在冷却期）'}，暂不切`);
    return;
  }
  const next = writeMode(cfg, { mode: 'go', reason: 'probe-recovered', lastProbeAt: Date.now() });
  log(`模型路线 → go，since ${new Date(next.since).toISOString()}`);
  await notify('go 缓过来了，切回 go 了。');
}

main().catch((e) => {
  log(`看守自己出错了：${e?.stack || e}`);
  process.exitCode = 1;
});
