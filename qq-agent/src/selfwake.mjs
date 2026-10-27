/**
 * 主动开口（self-wake）。
 *
 * 桥是「收到消息才跑」的，所以主动说话只能由桥自己定时发起：
 * 每隔一阵子挑一个最近聊过、又安静了挺久的会话，让模型自己说一两句。
 *
 * 五道闸（跟 dsh-selfwake 的设定对齐，但活在桥里，不受 dsh 一次性进程限制）：
 *   ① 距上次主动开口 ≥ intervalMinutes ± jitterMinutes（按未回话次数加权拉长）
 *   ② 那个会话安静 ≥ minIdleMinutes
 *   ③ 连续未回次数 < maxUnanswered（有人回话就归零）
 *   ④ 不在静默时段（quietStartHour–quietEndHour）
 *   ⑤ 今天主动开口次数 < dailyMax
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, log } from './util.mjs';
import { extractVoiceDirective } from './voice-intent.mjs';

export const DEFAULT_SELFWARE = {
  enabled: false,
  dryRun: false,
  tickSeconds: 60,
  intervalMinutes: 25,
  jitterMinutes: 10,
  minIdleMinutes: 20,
  maxUnanswered: 3,
  backoffPerUnanswered: 0.6,
  replyWindowMinutes: 10,
  dailyMax: 8,
  quietStartHour: 0,
  quietEndHour: 7,
  maxChars: 120,
};

export function selfwakeConfig(cfg) {
  return { ...DEFAULT_SELFWARE, ...(cfg?.raw?.selfwake || {}) };
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** 把上一次的「说了啥」写进历史，下一轮她自己能看到 */
function recordSpoken(history, session, text) {
  try {
    history.append(session.key, {
      t: Date.now(), role: 'bot', name: '我', text,
    });
  } catch { /* ignore */ }
}

export function buildSelfwakePrompt(session, transcript, idleMinutes, { voice = false } = {}) {
  const where = session.kind === 'group'
    ? `群聊「${session.title}」（群里还有别人，你说的话所有人都看得到）`
    : `私聊（对方是你认识的人）`;
  const lines = [
    `【场景】${where}`,
    `【现在】${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    transcript ? `【之前的聊天记录】（以「我」开头的是你自己说过的话）\n${transcript}` : '',
    `（你自己想开口，不是对方在跟你说话。那边已经 ${idleMinutes} 分钟没动静了。）`,
    '',
    '现在按你平时的说话方式，自己说一两句：',
    '- 只能拿真有的东西开口：现在的时间、你自己真实的状态、刚才真聊过的事。',
    '- 不许编造任何具体的事件、场景、对话或数字。',
    '- 不要问「在干嘛」；不要一口气问几个问题；不要连环追问。',
    '- 不要说「主动」「定时」「系统」这类词，也别解释自己为什么突然开口。',
    '- 不是等他回，只是你自己想说；一两句就停。',
    '- 这会儿实在没什么想说的，就只输出 <SKIP>。',
  ];
  if (voice) {
    lines.push(
      '',
      '【这次也可以只发语音】懒得打字就发一条，写两行（都不显示成文字）：',
      '__VOICE_META__ {"emotion":"gentle","intensity":0.5,"scene":"深夜"}',
      '__SEND_VOICE__ 嗯……还没睡呢',
      '- 语音和文字别重复说同一句，发语音就别再打一遍。',
    );
  }
  return lines.filter(Boolean).join('\n');
}

/** 把主动开口里的工具指令清掉（她可能顺手写 __SEND_STICKER__） */
export function cleanSelfwakeText(text, maxChars) {
  const lines = String(text || '').split(/\r?\n/)
    .filter((l) => !/^\s*__(SEND_STICKER|SEND_MEDIA)__/.test(l));
  const body = lines.join('\n').trim();
  if (!body) return '';
  return body.length > maxChars ? body.slice(0, maxChars) : body;
}

export function createSelfwake({
  cfg, sessions, history, runner, sendText, sendVoice, canVoice, note, paused, audit,
}) {
  const conf = () => selfwakeConfig(cfg);
  const stateFile = path.join(cfg.dataDir, 'selfwake.json');
  ensureDir(cfg.dataDir);
  let st = loadState(stateFile);
  let timer = null;
  let busy = false;

  const save = () => {
    try { fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8'); }
    catch (e) { note('warn', `selfwake 状态写入失败: ${e.message}`); }
  };

  /** 今天说过几次（跨天自动清零） */
  function todayCount() {
    const k = dayKey();
    if (st.day !== k) { st.day = k; st.count = 0; save(); }
    return st.count || 0;
  }

  function inQuietHours(d = new Date()) {
    const c = conf();
    const h = d.getHours();
    const a = Number(c.quietStartHour) || 0;
    const b = Number(c.quietEndHour) || 0;
    if (a === b) return false;
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }

  /** 挑一个「聊过、但安静了」的会话 */
  function pickTarget(now) {
    const c = conf();
    if (!sessions.size) return null;
    const list = [...sessions.values()]
      .filter((s) => !s.busy && Number(s.lastActivityAt) > 0)
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    for (const s of list) {
      const idleMin = (now - s.lastActivityAt) / 60000;
      if (idleMin < c.minIdleMinutes) continue;
      return { session: s, idleMin: Math.round(idleMin) };
    }
    return null;
  }

  /** 到了点就开口（导出给测试用） */
  async function tick({ force = false } = {}) {
    const c = conf();
    if (!c.enabled && !force) return { skipped: 'disabled' };
    if (busy) return { skipped: 'busy' };
    if (paused?.()) return { skipped: 'paused' };
    const now = Date.now();
    if (!force && inQuietHours()) return { skipped: 'quiet' };
    if (!force && todayCount() >= c.dailyMax) return { skipped: 'daily-max' };

    const unanswered = Number(st.unanswered) || 0;
    if (!force && unanswered >= c.maxUnanswered) return { skipped: 'unanswered' };

    const interval = (c.intervalMinutes + (Math.random() * 2 - 1) * c.jitterMinutes)
      * (1 + unanswered * c.backoffPerUnanswered);
    const sinceLast = st.lastSpokeAt ? (now - st.lastSpokeAt) / 60000 : Infinity;
    if (!force && sinceLast < interval) return { skipped: 'interval', waitMin: Math.round(interval - sinceLast) };

    const target = pickTarget(now);
    if (!target) return { skipped: 'no-target' };

    busy = true;
    try {
      const { session, idleMin } = target;
      const { transcript } = history.transcript(session.key);
      const voiceOk = typeof canVoice === 'function' ? Boolean(canVoice(session)) : false;
      const prompt = buildSelfwakePrompt(session, transcript, idleMin, { voice: voiceOk });
      const startedAt = Date.now();
      const r = await runner.run({ prompt, withTools: false });
      if (!r.ok) { note('warn', `[${session.key}] 主动开口生成失败`); return { skipped: 'failed' }; }

      const raw = String(r.text || '').trim();
      if (!raw || raw.includes('<SKIP>') || raw.startsWith(cfg.raw.reply.silenceToken)) {
        note('info', `[${session.key}] 主动开口：选择不说话`);
        st.lastSpokeAt = now; st.unanswered = unanswered + 1;
        save();
        return { skipped: 'silent' };
      }

      const vc = extractVoiceDirective(raw);
      const text = cleanSelfwakeText(vc ? vc.rest : raw, c.maxChars);
      if (!text && !vc) return { skipped: 'empty' };

      st.lastSpokeAt = now;
      st.lastText = text || `[语音] ${vc.text}`;
      st.lastChat = session.key;
      st.count = todayCount() + 1;
      st.unanswered = unanswered + 1;
      st.day = dayKey();
      save();

      if (c.dryRun) {
        note('info', `[dryRun] 本来会主动说：${text}${vc ? ` + 语音「${vc.text}」` : ''}`);
      } else {
        if (text) await sendText(session, text);
        if (vc && sendVoice) {
          try {
            await sendVoice(session, vc.text, {
              mood: session.moodState?.lastMood,
              scene: vc.scene, emotion: vc.emotion, intensity: vc.intensity,
            });
          } catch (e) { note('warn', `[${session.key}] 主动语音发送失败：${e.message}`); }
        }
        recordSpoken(history, session, text || `[语音] ${vc.text}`);
        session.lastReplyAt = Date.now();
        note('info', `[${session.key}] 主动开口（${Math.round((Date.now() - startedAt) / 1000)}s）：${text.slice(0, 40)}${vc ? ' + 语音' : ''}`);
      }
      audit?.(session, [], `${text}${vc ? ` + [语音] ${vc.text}` : ''}`, c.dryRun ? 'selfwake-dry' : 'selfwake', Date.now() - startedAt, r.usage);
      return { spoken: text, voice: vc?.text, dryRun: !!c.dryRun };
    } catch (e) {
      note('warn', `[selfwake] 出错: ${e.message}`);
      return { skipped: 'error' };
    } finally {
      busy = false;
    }
  }

  /** 有人说话了：未回计数归零（他接话了） */
  function noteHumanActivity(chatKey) {
    if (!st.lastChat || st.lastChat === chatKey) {
      if (st.unanswered) { st.unanswered = 0; save(); }
    }
  }

  function start() {
    const c = conf();
    if (!c.enabled) { note('info', '主动开口：未启用'); return { stop() {} }; }
    note('info', `主动开口已启动：每 ${c.tickSeconds}s 检查，间隔 ${c.intervalMinutes}±${c.jitterMinutes} 分，安静 ${c.minIdleMinutes} 分才开口，静默 ${c.quietStartHour}-${c.quietEndHour} 点，每天最多 ${c.dailyMax} 次${c.dryRun ? '（dryRun，只记不发）' : ''}`);
    timer = setInterval(() => { void tick(); }, Math.max(10, c.tickSeconds) * 1000);
    if (timer.unref) timer.unref();
    return { stop() { clearInterval(timer); timer = null; } };
  }

  return { start, tick, noteHumanActivity, state: () => ({ ...st }) };
}
