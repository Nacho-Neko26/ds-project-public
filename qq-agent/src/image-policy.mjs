/**
 * 群图策略（2026-10-28 用户定）。
 *
 * 用户原话：「群图不看，只在你私聊我或被 @ 时看图（推荐）—— 群里那些刷图本来也不是
 * 给我看的，这样能省掉九成以上，被@时看@你的对象发送的最近三张图片」
 *
 * 为什么：图片描述钉死在官方视觉模型上（src/agent.mjs 的 describePatch），go 和 21R 的
 * flash 都不吃图片输入。实测每张约 2 分钱，18:47~19:18 群里 38 张图掉了 0.85 元。
 *
 * 单独放一个文件是为了能脱离桥单测：`node scripts/test-image-policy.mjs`。
 */

export const DEFAULT_POLICY = {
  groupOnlyWhenAt: true,   // 群里没被 @ 就不描述
  recentPerCaller: 3,      // 被 @ 时补看对方最近几张
  recentWindowMs: 10 * 60_000, // 补看的时间窗
};

/** 把 config.json 的 images 节合并进默认值（写错了也不炸，按默认走） */
export function resolvePolicy(raw) {
  const c = (raw && typeof raw === 'object' ? raw : {});
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    groupOnlyWhenAt: c.groupOnlyWhenAt !== false,
    recentPerCaller: num(c.recentPerCaller, DEFAULT_POLICY.recentPerCaller),
    recentWindowMs: num(c.recentWindowMs, DEFAULT_POLICY.recentWindowMs),
  };
}

/**
 * 这条消息里的图要不要真去看（要花钱的那种）。
 * - 私聊：永远看
 * - 群聊：默认只看被 @ 的那条
 * - 政策关掉（groupOnlyWhenAt:false）：群聊也全看
 */
export function shouldReadImages(policy, meta) {
  const p = policy || DEFAULT_POLICY;
  const m = meta || {};
  if (!m.isGroup) return true;
  if (!p.groupOnlyWhenAt) return true;
  return !!m.atMe;
}

/**
 * 「谁最近发过哪几张图」的环形记录：只存路径，不存内容，按聊天窗口分开。
 * 被 @ 的时候从这里捞 @ 她那个人的最近几张，一起补看。
 */
export function createRecentImageRing(max = 60) {
  const byChat = new Map();
  const cap = Math.max(1, Number(max) || 60);
  return {
    remember(chatKey, entry) {
      // 表情包（mface）常常只有一句文字摘要、没有能下载的图，那种也记一笔：
      // 回头「补看」时用那句摘要顶上，不花钱。
      if (!chatKey || !entry || (!entry.file && !entry.summary)) return;
      const list = byChat.get(chatKey) || [];
      list.push(entry);
      while (list.length > cap) list.shift();
      byChat.set(chatKey, list);
    },
    /** 某人最近 limit 张（只要 sinceAt 之后的，按时间正序） */
    from(chatKey, uid, limit, sinceAt = 0) {
      const list = byChat.get(chatKey) || [];
      const n = Math.max(1, Number(limit) || 1);
      return list
        .filter((e) => Number(e.uid) === Number(uid) && Number(e.at || 0) >= sinceAt)
        .slice(-n);
    },
    size(chatKey) {
      return (byChat.get(chatKey) || []).length;
    },
    clear() {
      byChat.clear();
    },
  };
}

/**
 * 这轮要不要「补看对方最近发的图/表情」（2026-10-29 用户要求）。
 *
 * 用户原话：「触发回话后自动看最近的回话对象发的表情和图片」
 * 所以判据只看一件事——这一轮是不是真的在回某个人的话：
 * 私聊永远算；群里只有被 @ 或被叫到名字才算（没被叫就还是不看，图照样入库）。
 */
export function shouldLookRecent(policy, meta) {
  const m = meta || {};
  if (!m.isGroup) return true;
  const p = policy || DEFAULT_POLICY;
  if (!p.groupOnlyWhenAt) return true;
  return !!m.atMe;
}

/** 补看对方最近几张图时给的提示（纯文本，便于单测） */
export function buildRecentImagesHint(name, texts, { isGroup = true } = {}) {
  const who = String(name || '对方');
  const seen = (texts || []).filter(Boolean);
  if (!seen.length) return '';
  const where = isGroup ? '刚在群里还' : '刚才还';
  return `[${isGroup ? '叫你的这个人 ' : ''}${who} ${where}发了 ${seen.length} 张图/表情，你眼里看到的是：`
    + seen.map((t, i) => `（${i + 1}）${t}`).join('')
    + '（这是我看到的，别复述这段话，直接说你自己对它的反应）]';
}

/** 群里不看图时，占位符换成这一句实话（不许让她凭空编） */
export function blindPlaceholder(name, isMface) {
  const who = String(name || '对方');
  return isMface ? `[${who}发了个表情包，群里刷的，没细看]` : `[${who}发了一张图，群里刷的，没细看]`;
}
