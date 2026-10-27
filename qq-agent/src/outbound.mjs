/**
 * 出站闸（2026-10-28）
 *
 * 模型能读本机文件、能跑命令，所以它说出口的话里可能带着：
 *   · 本机路径（C:\Users\... / /root/qq-agent/...）
 *   · 凭据原文（API key、OneBot token）
 *   · 主人和熟人（受保护的 QQ 号）
 * 这些东西一旦发到群里就收不回来。提示词里写「别说」只是概率约束，
 * 这里做的是确定性的事：出站前扫一遍，能打码的打码。
 *
 * 分级，不是一律拦——整条不发会让她突然哑掉，比说漏一句更像故障：
 *   · 已知令牌原文 → 「〔已隐去〕」
 *   · 本机路径 → 「本地路径」
 *   · 凭据赋值（token=xxx、密码是xxx）→ 值打码，键名留着
 *   · 受保护的 QQ 号 → 123****456
 *
 * 边界（别把这层当万能）：
 *   · 只认**已知**令牌原文，不做「像不像随机串」的通用判定——
 *     32 位十六进制是表情 md5、图片 URL 也长这样，通用判定会误伤正常消息。
 *   · 只认受保护名单里的号，不是所有数字都打（年份、楼层、播放量都该正常说）。
 *   · 只负责「发出去之前」；发出去之后怎么补救不归它管。
 */

// 路径边界：遇到空白、引号、`<>|`、中文标点就停。
// 2026-10-28 接线时测出来：不加中文标点的话，路径后面紧跟「，号」这种没空格的写法
// 会把整句吃掉（连主人号一起变成「本地路径」）——误伤比漏打更糟。

/** 本机盘符路径 / UNC / 常见系统目录 */
const PATH_RE = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s"'<>|，。；：！？、（）【】《》「」『』…—～]{2,}|\\\\[^\\\s"'<>|]{2,}\\[^\s"'<>|，。；：！？、（）【】《》「」『』…—～]{2,}|(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|，。；：！？、（）【】《》「」『』…—～]*)/g;

/** 凭据赋值：键名 + 分隔 + 值 */
const CRED_RE = /((?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?\s*(?:[:=：]|是|为)\s*["']?)([^\s，。；、"']{3,})/gi;

/** 把号码打码：5-6 位留头尾各一，长号留两头三位 */
export function maskId(value) {
  const s = String(value ?? '');
  if (!/^\d{5,}$/.test(s)) return s;
  if (s.length <= 6) return `${s.slice(0, 1)}****${s.slice(-1)}`;
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
}

/**
 * 找受保护号码的命中（只认精确命中，不做模糊）
 * @param {string} text
 * @param {Iterable<string|number>} ids
 * @returns {Array<{kind:string,value:string,index:number}>}
 */
export function findIdentityLeaks(text, ids = []) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const hits = [];
  const seen = new Set();
  for (const value of ids ?? []) {
    const id = String(value ?? '').trim();
    if (!/^\d{5,12}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const index = raw.indexOf(id);
    if (index >= 0) hits.push({ kind: 'known-id', value: id, index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** 出站前扫一遍并改写。返回改写后的正文和命中清单。 */
export function auditOutbound(text, { ids = [], tokens = [] } = {}) {
  let out = String(text ?? '');
  const hits = [];

  // 1) 已知令牌原文：整段换掉（这种最不能留）
  for (const raw of tokens ?? []) {
    const t = String(raw ?? '').trim();
    if (t.length < 12) continue;
    if (out.includes(t)) {
      hits.push({ kind: 'token', value: maskId(t) });
      out = out.split(t).join('〔已隐去〕');
    }
  }

  // 2) 本机路径
  out = out.replace(PATH_RE, (m) => {
    hits.push({ kind: 'path', value: m.slice(0, 24) });
    return '本地路径';
  });

  // 3) 凭据赋值：值打码，键名留给人看
  out = out.replace(CRED_RE, (m, key, value) => {
    hits.push({ kind: 'credential', value: `${key.trim()}…` });
    return `${key}〔已隐去〕`;
  });

  // 4) 受保护的号
  for (const h of findIdentityLeaks(out, ids)) {
    hits.push({ kind: 'qq-id', value: maskId(h.value) });
    out = out.split(h.value).join(maskId(h.value));
  }

  return { text: out, hits };
}

/**
 * CQ 码转义：SnowLuma 用 array 格式，文本段本来不解析 CQ 码，
 * 但这层随手加上——以后换回管得了 CQ 的端（NapCat 的 string 格式）就不会被注入。
 */
export function escapeCq(text) {
  return String(text ?? '').replace(/\[CQ:/g, '[CQ：');
}
