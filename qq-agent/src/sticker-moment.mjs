/**
 * 这句话里有没有「值得配张图」的情绪点；有就返回类型词，没有返回空。
 * 2026-10-26 起**不再当门槛用**（用户改回「想发就发」），保留函数只为兼容旧测试/别处引用。
 */
export function stickerMoment(text = '') {
  const t = String(text);
  if (/无语|服了|离谱|麻了|醉了|好家伙|绷不住|emmm|emm|……|\.\.\./i.test(t)) return '无语';
  if (/哈哈|笑死|笑不活|好耶|太棒|绝了|牛啊|厉害|哇[啊！!]|激动|燃|冲啊|666|yyds/.test(t)) return '激动';
  return '';
}

/**
 * 自发表情的门：只卡「距上次发图满 1 分钟」这一条。
 * 2026-10-26 用户改回「想发就发」：不再限定无语/激动两类情绪，也不再掷骰子
 * （原来的 0.35 概率已删）——有合适的就发，唯一限制是每分钟最多一张。
 */
export const SELF_STICKER_GAP_MS = 60 * 1000;

export function stickerSelfGate(lastAt = 0, now = Date.now()) {
  const last = Number(lastAt) || 0;
  if (last > 0 && now - last < SELF_STICKER_GAP_MS) return false;
  return true;
}

/** 从 usage 台账里找最近一次发图时间（毫秒时间戳，没有就 0）。 */
export function lastStickerAt(usage = {}) {
  let max = 0;
  for (const v of Object.values(usage || {})) {
    const at = Number(v?.at || 0);
    if (at > max) max = at;
  }
  return max;
}
