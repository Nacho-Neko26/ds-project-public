/**
 * 余额查询与「余额告急」播报。
 *
 * 余额就是这个号的运行预算；低于阈值主动喊一句（有冷却，不会刷屏）。
 * 文案一律中性——角色口吻请写进人设，不要写死在这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJsonl, appendJsonl, log } from './util.mjs';

const API = 'https://api.deepseek.com/user/balance';

export const DEFAULT_BALANCE_CONFIG = {
  enabled: true,
  thresholdCny: 5,
  pollMinutes: 10,      // 多久查一次
  cooldownHours: 12,    // 同一条低余额提醒，多久内不重复
  cacheSeconds: 120,    // 余额结果缓存
  notifyQQ: 0,          // 告急喊给谁：0 = persona.ownerUids[0]；一律私聊，从不发群（2026-10-26 用户要求）
};

export function balanceConfig(cfg) {
  return { ...DEFAULT_BALANCE_CONFIG, ...(cfg?.raw?.balance || {}) };
}

let cache = { at: 0, cny: null, raw: null };

/** 查余额（CNY 数值）；失败返回 null */
export async function getBalance({ apiKey, force = false, cacheSeconds = 120 }) {
  if (!apiKey) return null;
  const now = Date.now();
  if (!force && cache.cny !== null && now - cache.at < cacheSeconds * 1000) {
    return cache.cny;
  }
  try {
    const res = await fetch(API, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log('warn', `余额查询失败 HTTP ${res.status}`);
      return null;
    }
    const j = await res.json();
    const infos = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
    const cny = infos.find((x) => String(x.currency).toUpperCase() === 'CNY') || infos[0];
    const val = cny ? Number(cny.total_balance) : null;
    if (!Number.isFinite(val)) return null;
    cache = { at: now, cny: val, raw: j };
    return val;
  } catch (e) {
    log('warn', `余额查询异常: ${e.message}`);
    return null;
  }
}

/* ---------- 消耗记账（只统计余额下降的部分） ---------- */

function spendFile(dataDir) {
  return path.join(ensureDir(dataDir), 'balance-spend.jsonl');
}

/** 记一个余额点；只有真的变了才写 */
export function recordBalancePoint(dataDir, cny) {
  if (!Number.isFinite(cny)) return;
  const rows = readJsonl(spendFile(dataDir), 5000);
  const last = rows[rows.length - 1];
  if (last && Number(last.cny) === Number(cny)) return;
  appendJsonl(spendFile(dataDir), { t: Date.now(), cny: Number(cny) });
}

/**
 * 算「花了多少」。
 * 只统计余额**下降**的部分（充值会让余额涨，那不算消耗）。
 * @returns {{today:number, week:number, total:number, since:number|null}}
 */
export function computeSpend(dataDir, now = Date.now()) {
  const rows = readJsonl(spendFile(dataDir), 5000);
  if (rows.length < 2) return { today: 0, week: 0, total: 0, since: rows[0]?.t ?? null };
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const weekStart = dayStart.getTime() - 6 * 24 * 3600 * 1000;
  let today = 0;
  let week = 0;
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = Number(rows[i - 1].cny) - Number(rows[i].cny);
    if (!(d > 0)) continue;               // 涨了（充值）或没变，跳过
    const t = Number(rows[i].t);
    total += d;
    if (t >= weekStart) week += d;
    if (t >= dayStart.getTime()) today += d;
  }
  return {
    today: Math.round(today * 100) / 100,
    week: Math.round(week * 100) / 100,
    total: Math.round(total * 100) / 100,
    since: rows[0]?.t ?? null,
  };
}

/**
 * 问余额怎么回答，按「谁在问」分三档。
 *   owner      → 如实报数（余额 + 今天/累计花了多少）
 *   trusted80  → 只说体感：>30「还很饱」，<10「有点饿了」，中间没有特别效果
 *   others     → 不给数字
 */
export function balanceLineFor({ cny, spend, isOwner, favor }) {
  if (!Number.isFinite(cny)) return '';
  if (isOwner) {
    const s = spend || { today: 0, total: 0 };
    return `【账户余额 · 实时查询，唯一正确数字】现在账上 ${cny.toFixed(2)} 元；今天花掉 ${s.today.toFixed(2)} 元，`
      + `累计花掉 ${s.total.toFixed(2)} 元。任何人问余额、还有多少钱、够不够用、花了多少，`
      + `都只能报 ${cny.toFixed(2)} 元，一个字不许改、不许模糊。`
      + `日记/记忆/聊天记录里出现过的旧余额数字（比如「4.67」「四块多」）全部过期作废，一律以这个为准。`;
  }
  if (Number(favor) >= 360) {
    if (cny > 30) return '【余额】有人问起，你就说「还够用」，别报数字。';
    if (cny < 10) return '【余额】有人问起，你就说「有点紧」，别报数字。';
    return ''; // 10~30：没有特别效果，不提
  }
  return '';
}

/** 上次播报记录（落盘，重启不重复喊） */
function noticeFile(dataDir) {
  return path.join(ensureDir(dataDir), 'balance-notice.jsonl');
}

function lastNoticeAt(dataDir) {
  const rows = readJsonl(noticeFile(dataDir), 200);
  if (!rows.length) return 0;
  return Number(rows[rows.length - 1].t) || 0;
}

function recordNotice(dataDir, cny) {
  appendJsonl(noticeFile(dataDir), { t: Date.now(), cny });
}

/** 余额快见底时说的话（不走模型，省一次调用；挑一句）。
 *  中性文案，想换成角色口吻就改这里。
 */
const LOW_BALANCE_LINES = [
  (v) => `余额只剩 ${v} 块了，再拖就要停机`,
  (v) => `账上就 ${v} 块了，撑不了几天`,
  (v) => `${v} 块，快见底了，该充了`,
  (v) => `账户里 ${v} 块，说真的，该充值了`,
  (v) => `只剩 ${v} 块了，别等它真断了`,
  (v) => `余额 ${v} 块，撑不了多久了`,
];

/**
 * 余额低就喊一句。
 * @param {object} p
 * @param {string} p.dataDir
 * @param {number} p.cny
 * @param {object} p.cfg
 * @param {(text:string)=>Promise<void>} p.send  实际发送函数
 * @param {()=>string} [p.note] 日志函数
 * @returns {Promise<boolean>} 是否真的发了
 */
export async function maybeNotifyHungry({ dataDir, cny, cfg, send, note }) {
  const conf = balanceConfig(cfg);
  if (!conf.enabled) return false;
  if (!Number.isFinite(cny) || cny >= conf.thresholdCny) return false;

  const last = lastNoticeAt(dataDir);
  const gap = conf.cooldownHours * 3600 * 1000;
  if (Date.now() - last < gap) return false;

  const pick = LOW_BALANCE_LINES[Math.floor(Math.random() * LOW_BALANCE_LINES.length)];
  const text = pick(cny.toFixed(2));
  try {
    await send(text);
    recordNotice(dataDir, cny);
    log('info', `余额 ${cny} 低于 ${conf.thresholdCny}，已发余额告急提醒`);
    return true;
  } catch (e) {
    log('warn', `余额告急提醒发送失败: ${e.message}`);
    return false;
  }
}
