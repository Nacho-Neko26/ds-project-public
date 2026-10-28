// 自然语言点唱识别：不打 # 也能认出来（2026-10-26 用户要求「只要叫你唱就行」）
// 只负责判断「这句话是不是在点唱」，歌名/参数解析仍交给 parseCoverParams。

const LEAD = /^(那|就|嗯|哎|谢谢|帮忙|帮我|请你|你|给我)?\s*(翻唱|清唱|来一首|来一段|来首|来段|点一首|点首|点个|点歌|唱一首|唱一段|唱首|唱段|唱个|唱)/;
// 明显不是点唱的说法
const BLOCK = /不会唱|别唱|不要唱|不许唱|唱得|唱的吗|好听吗|你唱过|谁唱|什么歌|歌词|唱了多久/;

const ALIAS = /溟月|鲸鱼娘|小鲸鱼|蓝鲸鱼|大肥鱼|哦鲸鲸|DeepSeek酱/i;

// 只说了「唱」没给歌名：「唱歌」「来一首」「点歌」这种 body 会被当成歌名，
// 排进队列会去搜一首叫「歌」的歌然后失败。2026-10-28 用户定：这种情况先问要唱什么。
export function isVagueSong(song) {
  const s = String(song || '').replace(/[\s，,、。.!！?？~～…—\-]/g, '');
  if (!s) return true;
  return /^(歌|唱歌|首歌|一首|一首歌|歌儿|点歌|来一首|来一段|一段|一段歌|小段|一小段|个歌|个|首|段|歌吧|曲)$/.test(s);
}

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

  // 群里：不点名就不当点唱，免得把闲聊里的「唱」全抓了。
  // 2026-10-28 修：桥把 @ 渲染成「@你」，消息对象上又没带 atMe（enqueue 漏字段），
  // 于是「@你 清唱认真的雪」被判成闲聊、落到模型那儿，模型只会去点原唱卡片或者念两句歌词。
  // 现在开头有 @ 也算点了名（atMe 那条路同时补上）。
  if (isGroup && !atMe && !ALIAS.test(raw) && !/^[@＠]/.test(raw)) return null;

  const head = stripLead(raw);
  if (!head) return null;
  if (!LEAD.test(head)) return null;

  // 「唱一下认真的雪」「来一首起风了」：动词后面那截口语要剥掉，不然歌名会变成「一下认真的雪」
  const body = head.replace(LEAD, '').trim()
    .replace(/^[，,、:：\s]+/, '')
    .replace(/^(一首歌|一下|一首|一个|首|段|个)/, '')
    .trim();
  const word = /清唱/.test(raw) ? '清唱' : '翻唱';
  // 「来一首」「你唱一首」这种剥完动词就没歌名了，也算点唱、只是没给名字：
  // 交回去让桥问一句「想听哪首」，别当没听见（2026-10-28 用户定）。
  if (!body) return { body: '', word, vague: true };

  return { body, word, vague: isVagueSong(body) };
}

/**
 * 「能不能点一首」这种征求许可的说法（2026-10-28 用户定：按好感度回，
 * 够格就让他说想听什么，不够就婉拒）。历史坑：史莱姆 16:59 说「我可以点翻唱吗」，
 * detectSingRequest 只认句首是唱/翻唱，这句被当闲聊回掉了。
 * @returns {{word: '翻唱'|'清唱'}|null}
 */
export function detectSingAsk(text, { isGroup = false, atMe = false } = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 40) return null;
  if (/^[#＃]/.test(raw)) return null;
  if (BLOCK.test(raw)) return null;
  if (/不(能|许|要|准|行)/.test(raw)) return null;
  if (!/翻唱|清唱|点歌|点首|点一首|点个|唱歌|唱一首|听你唱|你唱/.test(raw)) return null;
  if (!/(可以|可不可以|能不能|能否|行不行|行吗|好不好|能点|可以点|允许|让我)/.test(raw)) return null;
  if (isGroup && !atMe && !ALIAS.test(raw)) return null;
  return { word: /清唱/.test(raw) ? '清唱' : '翻唱' };
}

export default { detectSingRequest, detectSingAsk, isVagueSong };
