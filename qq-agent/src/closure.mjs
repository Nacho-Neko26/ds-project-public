/**
 * 会话收尾判断（2026-10-28，照 surfcore 的 conversation-closure 搬过来的规则版）
 *
 * 目的：聊完了就别硬接话。对方回一句「嗯」、或者互道晚安之后，
 * 再追一句"我刚才想到……"就是骚扰，不是陪伴。
 *
 * 为什么不调模型：这个判断每个会话每分钟都要跑，调一次模型比聊天本身还贵。
 * surfcore 那边也是纯规则算完给建议，最终由模型自己决定；我们干脆只留规则，
 * 因为我们的主动开口本来就由目的引擎派单，这里只负责"能不能选它"。
 *
 * 判据两条线：
 *   ① 提问线——最后一句是问句/求助开头，绝对不算聊完（哪怕隔了半天，那也是没答）
 *   ② 收尾线——最后一句是终结语（嗯/好/晚安/谢谢），或者双方都只剩短语
 */

export const DEFAULT_CLOSURE = {
  enabled: true,
  quietMinutes: 8,       // 静了这么久才谈得上「聊完」
  cooldownMinutes: 25,   // 判成聊完之后，再晾这么久才考虑开口
  maxFinalChars: 30,     // 超过这个长度的话不算终结语
  shortChars: 6,         // 双方都短于这个长度 = 散了
};

export function closureConfig(cfg) {
  return { ...DEFAULT_CLOSURE, ...(cfg?.raw?.closure || {}) };
}

// 终结语：对方或者我自己都可能用它散场
const CLOSERS = /^(嗯+|哦+|好+|好的|好滴|好呀|行|可以|收到|明白|了解|知道了|懂了|晚安|晚安啦|睡了|去睡了|拜拜|再见|88|bye|ok|没事|没事了|谢谢|谢啦|感谢|辛苦|哈哈|笑死)[。.!！~～…、\s]*$/i;

// 提问线：问号、疑问语气词、求助口吻
const QUESTION = /[?？]\s*$|(吗|呢|吧)[。.!！~～…]*\s*$|怎么|为什么|咋办|咋整|怎么办|能不能|可不可以|是不是|有没有|帮我|帮看|求|教教我|你觉得|你说说/;

function textOf(e) {
  return String(e?.text == null ? '' : e.text).trim();
}

/** 这一句像不像「说到这儿就完了」 */
export function looksFinal(text, cfg = DEFAULT_CLOSURE) {
  const s = String(text || '').trim().replace(/^[，,、\s]+/, '');
  if (!s) return true;
  if (s.length > cfg.maxFinalChars) return false;
  if (QUESTION.test(s)) return false;
  return CLOSERS.test(s);
}

/**
 * 判断这段对话是不是聊完了。
 * @param {Array} entries 该会话的历史记录（老→新），每条 { t, text, self?, uid? }
 * @returns {{ closed: boolean, reason: string, until?: number }}
 */
export function judgeClosure(entries, now, cfg = DEFAULT_CLOSURE) {
  if (!cfg.enabled) return { closed: false, reason: 'off' };
  const list = (entries || []).filter((e) => e && e.text != null && String(e.text).trim());
  if (!list.length) return { closed: false, reason: 'empty' };

  const last = list[list.length - 1];
  const lastT = Number(last.t) || 0;
  const gapMin = lastT ? (now - lastT) / 60000 : Infinity;

  // 刚说完话，还热着
  if (gapMin < cfg.quietMinutes) return { closed: false, reason: 'still-talking' };

  const lastText = textOf(last);
  // 提问线最高优先级：最后一句是问句，哪怕隔一天也还没聊完
  if (QUESTION.test(lastText)) return { closed: false, reason: 'open-question' };

  // 收尾线：最后一句是终结语
  if (looksFinal(lastText, cfg)) {
    return { closed: true, reason: last.self ? 'i-closed' : 'they-closed', until: lastT + cfg.cooldownMinutes * 60000 };
  }

  // 双方都只剩几个字，也算散了
  const prev = list[list.length - 2];
  if (prev && lastText.length <= cfg.shortChars && textOf(prev).length <= cfg.shortChars) {
    return { closed: true, reason: 'both-short', until: lastT + cfg.cooldownMinutes * 60000 };
  }

  return { closed: false, reason: 'unclear' };
}

/**
 * 给主动开口用：这个会话现在能不能选。
 * @returns {{ ok: boolean, reason: string, waitMin?: number }}
 */
export function canWake(entries, lastActivityAt, now, cfg = DEFAULT_CLOSURE) {
  if (!cfg.enabled) return { ok: true, reason: 'off' };
  const j = judgeClosure(entries, now, cfg);
  if (!j.closed) return { ok: true, reason: j.reason };
  const base = Number(lastActivityAt) || Number(entries?.[entries.length - 1]?.t) || 0;
  const until = Math.max(j.until || 0, base + cfg.cooldownMinutes * 60000);
  if (now < until) {
    return { ok: false, reason: `chat-closed(${j.reason})`, waitMin: Math.ceil((until - now) / 60000) };
  }
  return { ok: true, reason: `closed-cooldown-over(${j.reason})` };
}
