// 自然语言点唱识别：不打 # 也能认出来（2026-10-26 用户要求「只要叫你唱就行」）
// 只负责判断「这句话是不是在点唱」，歌名/参数解析仍交给 parseCoverParams。

const LEAD = /^(那|就|嗯|哎|谢谢|帮忙|帮我|请你|你|给我)?\s*(翻唱|清唱|来一首|来一段|来首|来段|点一首|点首|点个|唱一首|唱一段|唱首|唱段|唱个|唱)/;
// 明显不是点唱的说法
const BLOCK = /不会唱|别唱|不要唱|不许唱|唱得|唱的吗|好听吗|你唱过|谁唱|什么歌|歌词|唱了多久/;

const ALIAS = /溟月|鲸鱼娘|小鲸鱼|蓝鲸鱼|大肥鱼|哦鲸鲸|DeepSeek酱/i;

function stripLead(raw) {
  return raw
    .replace(/^[@＠]\S+\s*/, '') // 群里的 @某某 前缀
    .replace(/^(溟月|鲸鱼娘|小鲸鱼|蓝鲸鱼|大肥鱼|哦鲸鲸|DeepSeek酱)[，,、！!~～\s]*/i, '')
    .trim();
}

/**
 * @param {string} text 这条消息的文本
 * @param {{isGroup?: boolean, atMe?: boolean}} opts
 * @returns {{body: string, word: '翻唱'|'清唱'}|null}
 */
export function detectSingRequest(text, { isGroup = false, atMe = false } = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 60) return null;
  if (/^[#＃]/.test(raw)) return null; // 打了 # 走命令通道
  if (BLOCK.test(raw)) return null;

  // 群里：不点名就不当点唱，免得把闲聊里的「唱」全抓了
  if (isGroup && !atMe && !ALIAS.test(raw)) return null;

  const head = stripLead(raw);
  if (!head) return null;
  if (!LEAD.test(head)) return null;

  const body = head.replace(LEAD, '').trim().replace(/^[，,、:：\s]+/, '');
  if (!body) return null;

  const word = /清唱/.test(raw) ? '清唱' : '翻唱';
  return { body, word };
}

export default { detectSingRequest };
