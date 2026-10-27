/**
 * 提醒兜底：模型经常只嘴上答应、不写 __REMIND__（2026-10-26 连着两次抓到——
 * 私聊里说「五分钟后提醒我喝水」「四分钟后叫我一下」，它都回了「行，五分钟后喊你」，
 * 但 reminders.json 一直是空的，压根没设上）。
 *
 * 所以桥自己再从用户原句里解析一次。原则：只认「明确的时间 + 让我做某事」，
 * 把握不准一律返回 null——宁可漏设，也不能半夜突然冒出一条没头没脑的消息。
 */

const ASK = /(提醒|叫我|喊我|叫醒|告诉我|记得|别忘)/;
const NO = /(不用提醒|别提醒|不需要提醒|取消提醒|别叫我|不用叫我|不用喊)/;

const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function toNum(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (CN[raw] !== undefined) return CN[raw];
  let m = raw.match(/^十([一二三四五六七八九])?$/);
  if (m) return 10 + (m[1] ? CN[m[1]] : 0);
  m = raw.match(/^([二三四五六七八九])十([一二三四五六七八九])?$/);
  if (m) return CN[m[1]] * 10 + (m[2] ? CN[m[2]] : 0);
  return null;
}

/**
 * @param {string} text 用户这一条的原话
 * @returns {{at: string, text: string}|null} at 交给 parseWhen 的写法
 */
export function guessReminder(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return null;
  if (!ASK.test(t)) return null;
  if (NO.test(t)) return null;

  const say = t.length > 30 ? `${t.slice(0, 30)}…` : t;

  // 1) 相对分钟：「五分钟后提醒我」「20 分钟之后叫我」
  let m = t.match(/(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:分钟|分)\s*(?:之?后|以后)/);
  if (m) {
    const n = toNum(m[1]);
    if (n && n > 0 && n <= 720) return { at: `+${n}m`, text: say };
  }

  // 2) 相对小时
  m = t.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(?:小时|钟头)\s*(?:之?后|以后)/);
  if (m) {
    const n = toNum(m[1]);
    if (n && n > 0 && n <= 24) return { at: `+${n}h`, text: say };
  }

  // 3) 相对秒（少于 10 秒没意义，不设）
  m = t.match(/(\d{1,3})\s*秒\s*(?:之?后|以后)/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 10 && n <= 3600) return { at: `+${n}s`, text: say };
  }

  // 4) 钟点：必须同时出现「哪天/哪个时段」或明确的「点整/点半」，否则不猜
  const clock = t.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时](?:\s*(半|\d{1,2}|[一二两三四五六七八九十]{1,3})\s*分?)?/);
  const day = t.match(/明天|明早|明晚|今晚|今天|下午|晚上|早上|上午|中午|凌晨/);
  if (clock && (day || /点半|点整/.test(t))) {
    const at = `${day ? day[0] : ''}${clock[0]}`.replace(/\s+/g, '').slice(0, 20);
    return { at, text: say };
  }

  return null;
}
