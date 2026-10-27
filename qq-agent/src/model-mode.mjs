/**
 * 模型走哪条路（中转 / 官方）的状态机。
 *
 * 2026-10-27 用户要求：「日常用中转，中转卡死自动切换官方」。
 * 中转不稳（10-27 20:23 卡死过一次，只能人工切回官方），所以这里存一份状态，
 * 让桥每轮读、让 guard 定时探——两边改的是同一个文件。
 *
 * 状态文件：data/model-mode.json
 *   mode             'relay' | 'official'   当前走哪条
 *   since            上次切换时间（ms）
 *   reason           为什么切（'manual' | 'run-failed' | 'probe-failed' | 'probe-recovered'）
 *   failStreak       guard 连续探测失败次数
 *   okStreak         guard 连续探测成功次数
 *   lastProbeAt      上次探测时间（ms）
 *   lastSwitchAt     上次切换时间（ms），用来看冷却
 *
 * 设计取舍：宁可多留一会儿官方，也不要在中转还没活的时候切回去——
 * 一次错切就是用户发一句话石沉大海。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.mjs';

export const MODES = ['relay', 'official'];

/** 中转挂了之后，至少隔这么久才允许 probe 把它切回来 */
export const RECOVER_COOLDOWN_MS = 10 * 60_000;
/** guard 连续失败几次才切官方 */
export const FAIL_THRESHOLD = 2;
/** guard 连续成功几次才切回中转 */
export const OK_THRESHOLD = 3;

export function statePath(cfg) {
  return path.join(cfg.dataDir, 'model-mode.json');
}

export function readMode(cfg) {
  const file = statePath(cfg);
  const base = {
    mode: 'relay',
    since: 0,
    reason: 'default',
    failStreak: 0,
    okStreak: 0,
    lastProbeAt: 0,
    lastSwitchAt: 0,
  };
  try {
    if (!fs.existsSync(file)) return base;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mode = MODES.includes(raw.mode) ? raw.mode : 'relay';
    return {
      ...base,
      ...raw,
      mode,
      failStreak: Number(raw.failStreak) || 0,
      okStreak: Number(raw.okStreak) || 0,
    };
  } catch {
    // 文件写坏了就当没切过——默认中转，和拼在 patch 里的默认值一致
    return base;
  }
}

export function writeMode(cfg, next) {
  ensureDir(cfg.dataDir);
  const cur = readMode(cfg);
  const merged = { ...cur, ...next };
  if (next.mode && next.mode !== cur.mode) {
    merged.since = Date.now();
    merged.lastSwitchAt = Date.now();
    merged.failStreak = 0;
    merged.okStreak = 0;
  }
  fs.writeFileSync(statePath(cfg), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/**
 * 这次失败像不像「中转这边的事」？
 * 只看 provider 层的错——写代码写崩了、超时了不算，别把模型问题赖到中转头上。
 */
export function looksLikeProviderFailure(stderr, timedOut) {
  const s = String(stderr || '');
  if (timedOut) return true; // 卡死是中转最典型的样子，没有别的线索时按它算
  return /MISSING_CREDENTIAL|INVALID_CREDENTIAL|QUOTA|RATE_LIMIT|UNKNOWN_MODEL|llm-pi-ai|llm-deepseek|no available channel|无可用|渠道|503|502|504|500|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|network error/i.test(s);
}
