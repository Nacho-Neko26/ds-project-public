/**
 * 指令行解析。
 *
 * 桥靠「模型单独输出一行 __XXX__ …」来触发副作用，这行不会发给对方。
 * 目前有六种：
 *   __REMIND__ {"at":"...","text":"..."}     定时提醒
 *   __REMIND_CANCEL__ <id>                   取消提醒
 *   __ADMIN__ {"op":"recall"|"mute"|"card",...}  群管理
 *   __MUSIC__ 歌名 - 歌手                    点歌
 *   __NICK__ {"name":"..."}                  称呼
 *   __MOOD__ {"dvalence":0.1,"darousal":-0.05,"why":"..."}  情绪增量（次轮生效）
 *   __QUOTE__                                这句话引用对方那条消息（指向不清时才用）
 *   __SEND_FILE__ <服务器路径>               把这个文件发进当前会话（2026-10-28）
 *     这个不在这张表里解析——它跟 __SEND_STICKER__ / __POKE__ 一样由各自的
 *     extract*Directive 单独摘（见 index.mjs），这里只负责在清洗白名单里放行。
 *
 * 原来每个指令各写一个正则（表情、语音、转发），加到第四个时已经很难读，
 * 这里统一成一个：行首 __名字__ + 剩余内容。
 */

const LINE = /^[ \t]*__(REMIND|REMIND_CANCEL|ADMIN|MUSIC|NICK|MOOD|QUOTE)__[ \t]*(.*?)[ \t]*$/;

/**
 * 模型偶尔把指令写畸形：`__SEND-STICKER--S4`、`__SEND STICKER_ S4`、`__send-sticker__ S4`。
 * 先统一成 `__NAME__ payload`，再交给各个解析器；认不出来的最后由
 * scrubDirectiveLeaks() 从正文里删掉——**指令行宁可丢也不能发出去**。
 */
export function normalizeDirectiveLines(text) {
  return String(text ?? '').replace(
    /(^|\n)([ \t]*)_{1,2}[ \t]*([A-Za-z]+)((?:[-_ ][A-Za-z]+)*)[ \t]*_{0,2}[ \t]*/g,
    (m, pre, sp, head, rest) => {
      const name = [head, ...rest.split(/[-_ ]+/).filter(Boolean)].join('_').toUpperCase();
      if (!/^(SEND|VOICE|REMIND|ADMIN|MUSIC|NICK|MOOD|QUOTE|SYNC)(_|$)/.test(name)) return m;
      // SEND_FILE 是 2026-10-28 新加的（本机处理完把产物发回去），
      // 上面的 SEND 前缀本来就能放行，这里单独点出来免得以后被当成笔误删掉。
      return `${pre}${sp}__${name}__ `;
    },
  );
}

/** 发出去之前的最后一道网：任何残留的指令片段都不许出现在正文里。
 *  指令本来就该独占一行，所以按行整行丢弃——宁可少一句，也不能把 JSON / 编号漏给对面。
 *  **例外**：`__SEND_STICKER__ S3 S8` 这种合法连发行必须留下（正文里可能还写着话），
 *  所以先放行，交给 extractStickerDirective 解析掉。 */
export function scrubDirectiveLeaks(text) {
  const TOKEN = /_{1,2}[ \t]*(?:SEND|VOICE|REMIND|ADMIN|MUSIC|NICK|MOOD|QUOTE|SYNC)[-_A-Za-z]*/;
  const STICKER_OK = /^_{0,2}SEND[-_ ]*STICKER[-_ ]*_{0,2}[:\s]*[-_ ]*[-#sSfF\d\s,，、]+$/i;
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !TOKEN.test(line) || STICKER_OK.test(line.trim()))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}


function parseJson(payload) {
  const s = String(payload || '').trim();
  if (!s) return { error: '空的' };
  // 容错：模型偶尔会包一层 ``` 或中文引号
  const cleaned = s
    .replace(/^```(?:json)?/i, '').replace(/```$/, '')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .trim();
  try {
    const v = JSON.parse(cleaned);
    if (v && typeof v === 'object') return { value: v };
    return { error: '不是对象' };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * @returns {{rest:string, reminds:Array, cancels:string[], admin:Array, music:string[], count:number, errors:string[]}}
 */
export function extractDirectives(text) {
  const src = String(text ?? '');
  const out = {
    rest: src, reminds: [], cancels: [], admin: [], music: [], nicks: [], moods: [],
    quote: false, count: 0, errors: [],
  };
  if (!src.includes('__')) return out;

  const kept = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (!m) { kept.push(line); continue; }
    const [, name, payload] = m;
    out.count += 1;

    if (name === 'REMIND' || name === 'ADMIN' || name === 'NICK' || name === 'MOOD') {
      const r = parseJson(payload);
      if (r.value) {
        if (name === 'REMIND') out.reminds.push(r.value);
        else if (name === 'ADMIN') out.admin.push(r.value);
        else if (name === 'MOOD') out.moods.push(r.value);
        else out.nicks.push(r.value);
      } else {
        out.errors.push(`${name}: ${r.error}`);
      }
      continue;
    }
    // 2026-10-26 用户定：群里默认不引用，只在「指向不清」时由模型自己写一行 __QUOTE__。
    if (name === 'QUOTE') { out.quote = true; continue; }
    if (name === 'REMIND_CANCEL') {
      if (payload) out.cancels.push(payload.trim().split(/\s+/)[0]);
      else out.errors.push('REMIND_CANCEL: 没给编号');
      continue;
    }
    // MUSIC
    if (payload) out.music.push(payload.trim());
    else out.errors.push('MUSIC: 没给歌名');
  }

  out.rest = kept.join('\n');
  if (out.count) out.rest = out.rest.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}
