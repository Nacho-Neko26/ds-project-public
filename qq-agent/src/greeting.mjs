/**
 * 早安排程（2026-10-28，照 surfcore 的 greeting-schedule 搬过来）
 *
 * 到点自己打个招呼——不是闹钟那种准点报时，是她醒过来发现天亮了，
 * 想跟主人说句话。所以：
 *   ① 时间带抖动（每天用日期做种子，稳定但不精确到分，看着不像定时器）
 *   ② 一天一次，过了就过
 *   ③ 说什么交给模型（hint 只给方向，不给台词）
 *   ④ 走 selfwake 的发送链路，语音/表情/分条这些规矩全都照旧
 *
 * 状态存 data/greeting.json：{ lastDay: '2026-10-28' }，重启不会重发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, log } from './util.mjs';

export const DEFAULT_GREETING = {
  enabled: false,
  at: '08:00',          // 基准时间
  jitterMinutes: 20,    // ± 这么多分钟的日级抖动
  hint: '',             // 空 = 用代码里的默认提示
};

export function greetingConfig(cfg) {
  return { ...DEFAULT_GREETING, ...(cfg?.raw?.greeting || {}) };
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 当天的目标时刻：基准时间 + 用日期做种子的稳定抖动 */
export function greetingTimeFor(day, c) {
  const [hh, mm] = String(c.at || '08:00').split(':').map((x) => Number(x) || 0);
  const seed = Number(String(day).replace(/-/g, '')) || 0;
  const jitter = c.jitterMinutes > 0 ? (seed % (c.jitterMinutes * 2 + 1)) - c.jitterMinutes : 0;
  const at = new Date();
  at.setHours(hh, mm, 0, 0);
  at.setMinutes(at.getMinutes() + jitter);
  return at;
}

export const DEFAULT_GREETING_HINT = [
  '天亮了。主动跟主人打个招呼——像刚醒过来的人那样，一句到两句。',
  '别提"日程""提醒""今天要做什么"，也别报时间；不是闹钟，是想说句话。',
  '他昨天可能聊到很晚，困就说困，别硬撑欢快；如果觉得不说更好，就回 <SKIP>。',
].join('\n');

export function createGreeting({ cfg, note = log, speak, canWake, tickSeconds = 60 }) {
  const c = greetingConfig(cfg);
  const stateFile = path.join(cfg.dataDir, 'greeting.json');
  ensureDir(cfg.dataDir);
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { /* 首次 */ }
  let timer = null;
  let busy = false;

  const save = () => {
    try { fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8'); }
    catch (e) { note('warn', `greeting 状态写入失败: ${e.message}`); }
  };

  /** 到点了就打招呼（导出给测试用：传 now 可以模拟任意时刻） */
  async function check({ now = new Date(), force = false } = {}) {
    if (!c.enabled && !force) return { skipped: 'disabled' };
    if (busy) return { skipped: 'busy' };
    // 她自己要安静（__WAKE__ off）：早安排程也让路
    if (typeof canWake === 'function' && !canWake()) return { skipped: 'muted' };
    const day = dayKey(now);
    if (!force && st.lastDay === day) return { skipped: 'already-today' };
    const at = greetingTimeFor(day, c);
    if (!force && now < at) return { skipped: 'not-yet', at: at.toTimeString().slice(0, 5) };

    busy = true;
    try {
      const hint = String(c.hint || '').trim() || DEFAULT_GREETING_HINT;
      const r = await speak(hint);
      if (r?.spoken) {
        st.lastDay = day;
        st.lastAt = now.toISOString();
        st.lastText = r.spoken;
        save();
        note('info', `早安排程：${r.spoken.slice(0, 40)}`);
        return { spoken: r.spoken };
      }
      // 撞上别的开口 / 会话还没建起来 / 出过错：今天还没过完，下个 tick 再试
      if (r?.skipped === 'busy' || r?.skipped === 'no-session' || r?.skipped === 'error') {
        note('info', `早安排程：这次没轮到（${r.skipped}），等下一个 tick`);
        return { skipped: r.skipped, retry: true };
      }
      // 她选择不说话 / 生成失败：算今天过完了，别一直重试骚扰
      st.lastDay = day;
      st.lastAt = now.toISOString();
      st.lastText = '';
      save();
      note('info', `早安排程：这次没说（${r?.skipped || 'silent'}）`);
      return { skipped: r?.skipped || 'silent' };
    } catch (e) {
      note('warn', `早安排程出错：${e.message}`);
      return { skipped: 'error', error: e.message };
    } finally {
      busy = false;
    }
  }

  function start() {
    if (!c.enabled) { note('info', '早安排程：未启用'); return { stop() {} }; }
    note('info', `早安排程：每天 ${c.at} ±${c.jitterMinutes} 分自己打个招呼`);
    timer = setInterval(() => { void check(); }, Math.max(30, tickSeconds) * 1000);
    if (timer.unref) timer.unref();
    return { stop() { clearInterval(timer); timer = null; } };
  }

  return { start, check, state: () => ({ ...st }) };
}
