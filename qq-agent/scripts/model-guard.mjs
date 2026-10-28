#!/usr/bin/env node
/**
 * 模型路线看守（model-guard）
 *
 * 为什么要有它：2026-10-27 用户要求「日常用中转，中转卡死自动切换官方」。
 * 桥在每次跑之前会读 data/model-mode.json 决定走哪条，跑到一半失败也会当场切官方；
 * 但这个看守负责「没人在聊天的时候」——中转悄悄好了，得有人把它切回来，
 * 不然一直白花官方那点余额。
 *
 * 判定：
 *   1. 现在走中转，探测失败 → failStreak++，够了就切官方（桥那头也会自己切，这里是兜底）
 *   2. 现在走官方，探测成功 → okStreak++，连续够次且过了冷却期，切回中转
 *   3. 真的切了才发私聊，别拿噪音烦人
 *
 * 用 systemd timer 每 10 分钟跑一次：qq-model-guard.timer
 * 手动跑：node scripts/model-guard.mjs [--dry-run]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readMode, writeMode, FAIL_THRESHOLD, OK_THRESHOLD, RECOVER_COOLDOWN_MS,
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

/** 探一下中转还活不活。只花 1 个 token，比「切过去才发现死了」便宜得多。 */
async function probeRelay() {
  const key = readCredential('OPENCODE_GO_API_KEY');
  if (!key) return { ok: false, why: '没有 RELAY_API_KEY' };
  const startedAt = Date.now();
  try {
    const res = await fetch(PROBE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-opencode-session': 'ses_model_guard_probe',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = Date.now() - startedAt;
    if (res.ok) return { ok: true, elapsed };
    const body = (await res.text()).slice(0, 200);
    return { ok: false, why: `HTTP ${res.status} ${body}`, elapsed };
  } catch (e) {
    return { ok: false, why: e.message, elapsed: Date.now() - startedAt };
  }
}

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

async function main() {
  const st = readMode(cfg);
  const probe = await probeRelay();
  log(`当前 ${st.mode}；中转探测 ${probe.ok ? `通（${probe.elapsed}ms）` : `不通（${probe.why}）`}`);

  if (DRY) { log('[dry] 不做切换'); return; }

  if (st.mode === 'relay') {
    if (probe.ok) {
      if (st.failStreak) writeMode(cfg, { failStreak: 0, lastProbeAt: Date.now() });
      return;
    }
    const failStreak = st.failStreak + 1;
    if (failStreak < FAIL_THRESHOLD) {
      writeMode(cfg, { failStreak, lastProbeAt: Date.now() });
      log(`中转探测失败 ${failStreak}/${FAIL_THRESHOLD}，先不切`);
      return;
    }
    const next = writeMode(cfg, { mode: 'official', reason: 'probe-failed', lastProbeAt: Date.now() });
    log(`模型路线 → 官方（中转连不上），since ${new Date(next.since).toISOString()}`);
    await notify('中转那边连不上了，我先切到官方顶上，等它好了自己回去。');
    return;
  }

  // 走官方：看看中转活过来没有
  if (!probe.ok) {
    writeMode(cfg, { okStreak: 0, lastProbeAt: Date.now() });
    return;
  }
  const okStreak = st.okStreak + 1;
  const cooled = Date.now() - Number(st.lastSwitchAt || 0) > RECOVER_COOLDOWN_MS;
  if (okStreak < OK_THRESHOLD || !cooled) {
    writeMode(cfg, { okStreak, lastProbeAt: Date.now() });
    log(`中转通了 ${okStreak}/${OK_THRESHOLD}${cooled ? '' : '（还在冷却期）'}，暂不切`);
    return;
  }
  const next = writeMode(cfg, { mode: 'relay', reason: 'probe-recovered', lastProbeAt: Date.now() });
  log(`模型路线 → 中转，since ${new Date(next.since).toISOString()}`);
  await notify('中转缓过来了，切回去了。');
}

main().catch((e) => {
  log(`看守自己出错了：${e?.stack || e}`);
  process.exitCode = 1;
});
