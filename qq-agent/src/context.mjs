import fs from 'node:fs';
import path from 'node:path';
import {
  appendJsonl, readJsonl, ensureDir, safeFileName, hhmm,
} from './util.mjs';

/**
 * 身份只按 QQ 号认（历史记录里存的就是 uid），昵称随时会改，不能拿来当主键。
 * 这里给一段记录算出「内部身份」，渲染标签时不看它、只用它做去重。
 */
export function speakerKey(e) {
  const uid = String(e?.uid ?? '').replace(/\D/g, '');
  if (uid) return uid;
  return `name:${String(e?.name || '').trim()}`;
}

/**
 * 别人的显示标签：有昵称就用昵称，没有就用「有人」。
 * 2026-10-27 用户定：记录里按 QQ 号认人，但聊天消息里不要出现 QQ 号，
 * 一律用这个人对应的昵称，认不出来就用泛称。
 */
export function speakerLabel(e) {
  return String(e?.name || '').trim() || '有人';
}

/** 是不是她自己说的话。写历史的地方口径不统一（bot / assistant / self:true），这里一次收口。 */
export function isSelfEntry(e) {
  return e?.role === 'bot' || e?.role === 'assistant' || e?.self === true;
}

/**
 * 每个聊天（私聊 / 群）一份 JSONL 历史，落在 data/history/ 下。
 * 每次调用 dsh 时把最近 N 条拼成 transcript 塞进 prompt，
 * 因为 dsh headless 每次都是全新进程，本身不保留会话。
 */
export class HistoryStore {
  constructor(dataDir, { maxMessages = 14, maxChars = 2800, maxAgeMinutes = 40 } = {}) {
    this.dir = ensureDir(path.join(dataDir, 'history'));
    this.maxMessages = maxMessages;
    this.maxChars = maxChars;
    this.maxAgeMinutes = maxAgeMinutes;
    this.cache = new Map();
  }

  file(chatKey) {
    return path.join(this.dir, `${safeFileName(chatKey)}.jsonl`);
  }

  load(chatKey) {
    if (!this.cache.has(chatKey)) {
      const rows = readJsonl(this.file(chatKey), this.maxMessages * 4);
      this.cache.set(chatKey, rows.slice(-this.maxMessages));
    }
    return this.cache.get(chatKey);
  }

  append(chatKey, entry) {
    const list = this.load(chatKey);
    list.push(entry);
    while (list.length > this.maxMessages) list.shift();
    appendJsonl(this.file(chatKey), entry);
  }

  /**
   * 渲染成给模型看的一段记录。
   * 三条闸门，从新往旧取：时间窗（太久以前的不算「正在聊」）、条数、字数。
   * 长期的事有日记/记忆兜底，这里只负责「刚才在说什么」。
   *
   * 说话人用【】框起来再写内容，别用「名字: 内容」——
   * 后者和句子里的「我」长得太像，模型会把别人说的「我」当成自己
   * （2026-10-23 用户反馈的真实 bug）。
   * 返回 { transcript, count }
   */
  transcript(chatKey, { excludeLast = 0 } = {}) {
    const all = this.load(chatKey);
    const list = all.slice(0, all.length - excludeLast);
    const cutoff = this.maxAgeMinutes > 0 ? Date.now() - this.maxAgeMinutes * 60_000 : 0;
    const picked = [];
    let chars = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (cutoff && picked.length >= 2 && Number(e.t) < cutoff) break;
      // 一条记录里可能有换行（<分> 拆出来的两截、或者原文就带换行），
      // 不压成一行的话，后面那截会顶格出现、看着像别人说的。压成 ⏎，一条记录一行。
      const body = String(e.text == null ? '' : e.text).replace(/\s*\r?\n+\s*/g, ' ⏎ ');
      const approx = body.length + 12;
      if (chars + approx > this.maxChars && picked.length > 0) break;
      picked.unshift({ e, body });
      chars += approx;
    }
    // 标签唯一化：同一个人（按 QQ 号认）永远同一个标签；两个人撞了昵称就给后一个加②③。
    // 2026-10-27 用户定：记录里用 QQ 号认人，聊天消息里不出数字，只用昵称或泛称。
    const labelByKey = new Map();
    const used = new Set();
    const MARKS = '②③④⑤⑥⑦⑧⑨';
    const lines = picked.map(({ e, body }) => {
      if (isSelfEntry(e)) return `${hhmm(e.t)} 【你】${body}`;
      const key = speakerKey(e);
      let label = labelByKey.get(key);
      if (!label) {
        const base = speakerLabel(e);
        label = base;
        let n = 0;
        while (used.has(label)) {
          n += 1;
          label = `${base}${MARKS[n - 1] || `(${n + 1})`}`;
        }
        labelByKey.set(key, label);
        used.add(label);
      }
      return `${hhmm(e.t)} 【${label}】${body}`;
    });
    return { transcript: lines.join('\n'), count: lines.length };
  }

  reset(chatKey) {
    this.cache.delete(chatKey);
  }

  /**
   * 归档并清空所有对话记录（每 24 小时一次，在日记写完之后调）。
   * 原文件改名成 .YYYY-MM-DD-HHmm 留在 archive/ 里，别直接删——出问题还能查。
   * @returns {number} 归档了多少条
   */
  archiveAndClear(now = new Date()) {
    const archiveDir = ensureDir(path.join(this.dir, 'archive'));
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    let total = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const src = path.join(this.dir, f);
      const rows = readJsonl(src, 1000000);
      total += rows.length;
      fs.renameSync(src, path.join(archiveDir, `${f}.${stamp}`));
    }
    this.cache.clear();
    return total;
  }
}
