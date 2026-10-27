import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 定时提醒。
 *
 * 模型想在将来某个点说话时，单独输出一行：
 *   __REMIND__ {"at":"2026-10-24T08:00:00+08:00","text":"叫他起床"}
 *   __REMIND_CANCEL__ r8s3k
 *
 * 桥把它落到 data/reminders.json，到点由 ticker 主动发出去。
 * 不依赖 dsh 进程活着——跟 selfwake 一样，活在这条桥里。
 *
 * 为什么让模型自己算时间：它每轮都能看到【当前时间】，也会读「明天早上八点」
 * 这种说法。桥只做两件事：校验这个时间点是否合法、是否在合理范围里。
 */

const DEFAULTS = {
  enabled: true,
  maxPerChat: 20,      // 一个会话最多挂多少条待发
  maxAheadDays: 180,   // 最多提前多久
  keepFiredDays: 7,    // 已触发的记录留几天（方便排查）
  tickSeconds: 30,
};

export function remindersConfig(cfg) {
  return { ...DEFAULTS, ...(cfg.raw.reminders || {}) };
}

function storeFile(cfg) {
  return path.join(cfg.dataDir, 'reminders.json');
}

function loadStore(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(cfg), 'utf8'));
    if (raw && Array.isArray(raw.items)) return { v: 1, items: raw.items };
  } catch { /* 没有就从空开始 */ }
  return { v: 1, items: [] };
}

function saveStore(cfg, db) {
  const file = storeFile(cfg);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const pad = (n) => String(n).padStart(2, '0');

/** 把 ms 渲染成「10-24 08:00」；按服务器本地时区（云上是 Asia/Shanghai） */
export function fmtAt(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "8" / "八" / "十二" / "二十三" → 数字；认不出返回 null */
function cnNum(s) {
  const t = String(s).trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t === '十') return 10;
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (t.length === 1 && t in CN_DIGITS) return CN_DIGITS[t];
  return null;
}

function nextOccurrence(hour, minute, now) {
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null;
  const d = new Date(now.getTime());
  d.setHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t <= now.getTime()) t += 86400_000;
  return t;
}

/** 认「八点」「8点半」「晚上9点20」里的钟点，返回 {hour, minute} 或 null */
function parseClock(text) {
  const m = String(text).match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时](?:\s*(\d{1,2}|半|[一二两三四五六七八九十]{1,3})\s*分?)?/);
  if (!m) return null;
  let hour = cnNum(m[1]);
  if (hour === null) return null;
  const part = String(text).match(/凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|今晚|明晚|昨夜/);
  if (part && hour < 12) {
    const w = part[0];
    if (w === '下午' || w === '傍晚' || w === '晚上' || w === '夜里' || w === '今晚' || w === '明晚' || w === '昨夜') hour += 12;
    else if (w === '中午' && hour <= 2) hour += 12;
  }
  if (hour > 23) return null;
  let minute = 0;
  if (m[2] === '半') minute = 30;
  else if (m[2] !== undefined) {
    const mm = cnNum(String(m[2]).replace('分', ''));
    if (mm === null || mm > 59) return null;
    minute = mm;
  }
  return { hour, minute };
}

/**
 * 解析模型给的时间。依次尝试：
 *   1) "YYYY-MM-DD HH:mm[:ss]"（按服务器本地时区）
 *   2) "YYYY-MM-DD"（没给钟点，按当天 09:00 算——提醒一般指早上）
 *   3) 标准 ISO（带 +08:00 / Z）
 *   4) "HH:mm" / "八点半"（接下来最近的一次）
 *   5) 相对："30分钟"、"+2h"、"1d"
 *   6) 自然说法兜底："明天早上八点"「后天晚上9点半」
 * 解析不出来返回 null——宁可漏设，也别设错。
 */
export function parseWhen(input, now = new Date()) {
  if (input === undefined || input === null || input === '') return null;
  const raw = String(input).trim();
  if (!raw || raw.length > 40) return null;

  // 1) 日期 + 时间
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, y, mo, d, h = '9', mi = '0', sec = '0'] = m;
    const t = new Date(+y, +mo - 1, +d, +h, +mi, +sec).getTime();
    return Number.isNaN(t) ? null : t;
  }

  // 2) 只给钟点
  m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return nextOccurrence(+m[1], +m[2], now);
  if (/[点时]/.test(raw) && raw.length <= 12 && !/明天|后天|今天|明早|明晚/.test(raw)) {
    const c = parseClock(raw);
    if (c) return nextOccurrence(c.hour, c.minute, now);
  }

  // 3) 相对时长
  m = raw.match(/^\+?\s*(\d+)\s*(s|sec|秒|m|min|分钟|分|h|小时|时|d|天)$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'd' || unit === '天' ? n * 86400_000
      : unit === 'h' || unit === '小时' || unit === '时' ? n * 3600_000
        : unit === 'm' || unit === 'min' || unit === '分钟' || unit === '分' ? n * 60_000
          : n * 1000;
    return now.getTime() + ms;
  }

  // 4) 自然说法：明天/后天 + 早中晚 + 几点
  const dayOff = /后天/.test(raw) ? 2 : (/明天|明早|明晚/.test(raw) ? 1 : 0);
  const clock = parseClock(raw);
  if (clock) {
    const base = new Date(now.getTime());
    if (dayOff) base.setDate(base.getDate() + dayOff);
    base.setHours(clock.hour, clock.minute, 0, 0);
    let t = base.getTime();
    if (!dayOff && t <= now.getTime()) t += 86400_000; // 只说了几点且已过 → 明天
    return t;
  }

  // 5) 标准 ISO（带时区）
  if (/[T ]\d{1,2}:\d{2}/.test(raw) || /Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const iso = Date.parse(raw);
    if (!Number.isNaN(iso)) return iso;
  }

  return null;
}

export function addReminder(cfg, { chat, at, text, from, now = new Date() }) {
  const conf = remindersConfig(cfg);
  if (!conf.enabled) return { ok: false, error: '提醒功能已关闭' };
  const when = parseWhen(at, now);
  if (when === null) return { ok: false, error: `时间看不懂：${at}` };
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '没说提醒什么' };
  if (body.length > 120) return { ok: false, error: '提醒的话太长了' };
  if (when <= now.getTime() + 3_000) return { ok: false, error: '这个时间已经过去了' };
  if (when > now.getTime() + conf.maxAheadDays * 86400_000) {
    return { ok: false, error: `太远了（${conf.maxAheadDays} 天以内）` };
  }

  const db = loadStore(cfg);
  const mine = db.items.filter((x) => x.chat === chat && !x.firedAt);
  if (mine.length >= conf.maxPerChat) return { ok: false, error: `这个会话已经挂满 ${conf.maxPerChat} 条了` };

  const item = {
    id: `r${Date.now().toString(36).slice(-5)}${crypto.randomInt(10, 99)}`,
    chat,
    at: when,
    text: body,
    from: from ? { uid: from.uid, name: from.name } : null,
    createdAt: now.getTime(),
  };
  db.items.push(item);
  saveStore(cfg, db);
  return { ok: true, id: item.id, at: when, text: body };
}

/** 按 id 或 id 前缀取消；只允许取消本会话的 */
export function cancelReminder(cfg, chat, idLike) {
  const db = loadStore(cfg);
  const key = String(idLike || '').trim().replace(/^#/, '');
  if (!key) return { ok: false, error: '没给要取消哪条' };
  const hit = db.items.find((x) => x.chat === chat && !x.firedAt && (x.id === key || x.id.startsWith(key)));
  if (!hit) return { ok: false, error: '没找到这条提醒' };
  db.items = db.items.filter((x) => x !== hit);
  saveStore(cfg, db);
  return { ok: true, id: hit.id, at: hit.at, text: hit.text };
}

export function listReminders(cfg, chat, now = new Date()) {
  const db = loadStore(cfg);
  return db.items
    .filter((x) => x.chat === chat && !x.firedAt && x.at > now.getTime() - 60_000)
    .sort((a, b) => a.at - b.at);
}

/** 取出到点的（并标记已触发），顺手清掉太老的已触发记录 */
export function takeDueReminders(cfg, now = new Date()) {
  const conf = remindersConfig(cfg);
  const db = loadStore(cfg);
  const due = db.items.filter((x) => !x.firedAt && x.at <= now.getTime());
  const cut = now.getTime() - conf.keepFiredDays * 86400_000;
  if (!due.length) {
    // 只在真有东西可清时才写盘，避免每 30 秒戳一次文件
    if (db.items.some((x) => x.firedAt && x.createdAt < cut)) {
      db.items = db.items.filter((x) => !x.firedAt || x.createdAt >= cut);
      saveStore(cfg, db);
    }
    return [];
  }
  return due;
}

/**
 * 只有真的发出去才记账（2026-10-26 用户要求：「过了约定时间才可以删去」）。
 * 以前是先标 firedAt 再发，发失败这条提醒就没了——那正是「答应了又忘」的来源之一。
 */
export function markFired(cfg, id, now = new Date()) {
  const db = loadStore(cfg);
  const it = db.items.find((x) => x.id === id);
  if (!it) return false;
  it.firedAt = now.getTime();
  const cut = now.getTime() - 24 * 3600_000;
  db.items = db.items.filter((x) => !x.firedAt || x.createdAt >= cut);
  saveStore(cfg, db);
  return true;
}

/** 发送失败记一次；连续 3 次才放弃，免得每 30 秒重试一辈子 */
export function markAttempt(cfg, id, maxAttempts = 3) {
  const db = loadStore(cfg);
  const it = db.items.find((x) => x.id === id);
  if (!it) return { retry: false, attempts: 0 };
  it.attempts = (Number(it.attempts) || 0) + 1;
  if (it.attempts >= maxAttempts) it.firedAt = Date.now();
  saveStore(cfg, db);
  return { retry: it.attempts < maxAttempts, attempts: it.attempts };
}

/** 写进 prompt 的那一段 */
export function renderReminders(cfg, chat, now = new Date()) {
  const list = listReminders(cfg, chat, now);
  if (!list.length) return '';
  const lines = list.map((x) => `- [${x.id}] ${fmtAt(x.at)}  ${x.text}`);
  return [
    '【你自己挂着的提醒】（到点桥会替你发出去，不用你盯着）',
    ...lines,
    '（不想发了就单独输出一行：__REMIND_CANCEL__ <中括号里那串>）',
  ].join('\n');
}

/** 当前一共挂了多少条待发（启动日志用） */
export function countPending(cfg) {
  return loadStore(cfg).items.filter((x) => !x.firedAt).length;
}

/**
 * 起一个 ticker，到点回调 send(item)。
 * send 抛错不影响后面的提醒，只记一笔。
 */
export function startReminderTicker({ cfg, note, send }) {
  const conf = remindersConfig(cfg);
  if (!conf.enabled) {
    note?.('info', '定时提醒已关闭');
    return () => {};
  }
  const every = Math.max(10, Number(conf.tickSeconds) || 30) * 1000;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const due = takeDueReminders(cfg);
      for (const item of due) {
        try {
          await send(item);
          markFired(cfg, item.id);
          note?.('info', `[${item.chat}] 提醒已发：${item.text}`);
        } catch (e) {
          const r = markAttempt(cfg, item.id);
          const tail = r.retry ? '，稍后重试' : '，已放弃';
          note?.('warn', `[${item.chat}] 提醒发送失败（第 ${r.attempts} 次）：${e.message}${tail}`);
        }
      }
    } catch (e) {
      note?.('warn', `提醒 ticker 出错：${e.message}`);
    } finally {
      running = false;
    }
  }, every);
  timer.unref?.();
  const pending = countPending(cfg);
  note?.('info', `定时提醒已启用（每 ${every / 1000}s 检查一次）${pending ? `，当前 ${pending} 条待发` : ''}`);
  return () => clearInterval(timer);
}
