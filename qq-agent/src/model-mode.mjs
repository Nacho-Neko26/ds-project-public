/**
 * 模型走哪条路（go / 中转 / 官方）的状态机。
 *
 * 2026-10-28 用户要求：「现在云端改成默认go，不要自动切回中转了，go坏了切官方，中转要指令才切换」。
 * 于是三条线分成两类：
 *   自动线： go（默认，opencode-go） ⇄ official（deepseek-official，go 不通时顶着）
 *   手动线： relay（21R 中转，只有 #模型 中转 才进；进去了 guard 也不再动它）
 *
 * 旧版（2026-10-27）只有 relay/official 两种模式，relay 当时其实是「日常那条」；
 * 现在 relay 明确指 21R 中转，日常那条改叫 go。老状态文件里读到不认识的 mode 一律按 go。
 *
 * 状态文件：data/model-mode.json
 *   mode             'go' | 'relay' | 'official'   当前走哪条
 *   since            上次切换时间（ms）
 *   reason           'default' | 'manual' | 'run-failed' | 'probe-failed' | 'probe-recovered'
 *   failStreak       guard 连续探测失败次数
 *   okStreak         guard 连续探测成功次数
 *   lastProbeAt      上次探测时间（ms）
 *   lastSwitchAt     上次切换时间（ms），用来看冷却
 *
 * 设计取舍：宁可多留一会儿官方，也不要在 go 还没活的时候切回去——
 * 一次错切就是用户发一句话石沉大海。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.mjs';

export const MODES = ['go', 'relay', 'official'];
/** 没有状态文件（或文件写坏）时走这条 */
export const DEFAULT_MODE = 'go';
/** 只有人下指令才进、guard 永远不自动进也不自动出的路线 */
export const MANUAL_MODES = ['relay'];

/** 路线挂了之后，至少隔这么久才允许 probe 把它切回来 */
export const RECOVER_COOLDOWN_MS = 10 * 60_000;
/** guard 连续失败几次才切官方 */
export const FAIL_THRESHOLD = 2;
/** guard 连续成功几次才切回 go */
export const OK_THRESHOLD = 3;

export function statePath(cfg) {
  return path.join(cfg.dataDir, 'model-mode.json');
}

export function readMode(cfg) {
  const file = statePath(cfg);
  const base = {
    mode: DEFAULT_MODE,
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
    const mode = MODES.includes(raw.mode) ? raw.mode : DEFAULT_MODE;
    return {
      ...base,
      ...raw,
      mode,
      failStreak: Number(raw.failStreak) || 0,
      okStreak: Number(raw.okStreak) || 0,
    };
  } catch {
    // 文件写坏了就当没切过——默认 go，和 patch 里的默认值一致
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

/** 给人看的一行说明（#模型 指令回报用，不进日志） */
export function describeMode(mode) {
  if (mode === 'go') return 'go（opencode.ai）';
  if (mode === 'relay') return '21R 中转（手动选的）';
  if (mode === 'official') return 'DeepSeek 官方（go 不通时顶着）';
  return String(mode || '未知');
}

/**
 * 这次失败像不像「这条路本身的事」？
 * 只看 provider 层的错——写代码写崩了不算，别把模型问题赖到线路上。
 */
export function looksLikeProviderFailure(stderr, timedOut) {
  const s = String(stderr || '');
  if (timedOut) return true; // 卡死是线路挂掉最典型的样子，没有别的线索时按它算
  // 2026-10-28 补：opencode-go 挂的时候 dsh 报的是
  //   `dsh: AUTH: 401: {"type":"server_error","message":"Upstream request failed: Invalid credential"}`
  // 是老正则里没有的写法（带空格、带 AUTH: 前缀），所以 go 挂了根本不触发切换。
  return /MISSING_CREDENTIAL|INVALID_CREDENTIAL|invalid credential|invalid api key|QUOTA|RATE_LIMIT|UNKNOWN_MODEL|\b401\b|\b403\b|unauthori[sz]ed|AUTH:|llm-pi-ai|llm-deepseek|no available channel|无可用|渠道|503|502|504|500|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|network error/i.test(s);
}
