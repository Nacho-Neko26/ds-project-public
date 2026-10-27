/**
 * 角色身份槽位（单一来源）。
 *
 * 2026-10-24 用户要求：把具体人设（名字/自称/昵称/外号/世界观）清空，
 * 只保留框架，之后自己填新的。所以这里**只放槽位**，不放任何具体设定。
 *
 * 取值优先级：config.json → persona.character → 这里的中性兜底。
 * 值是 "{{...}}" 占位符、空串、或根本没写 → 一律走兜底，
 * **绝不会把 {{...}} 原文发到聊天里**。
 *
 * 用法：桥启动时 initCharacter(cfg) 一次；之后各处用下面的 getter。
 */

const PLACEHOLDER = /^\s*\{\{[^{}]*\}\}\s*$/;

/** 取一个字符串槽位；占位符/空 → fallback */
function slot(v, fallback = '') {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || PLACEHOLDER.test(s)) return fallback;
  return s;
}

const EMPTY = {
  name: '',
  selfRef: '',
  defaultNick: '',
  ownerTitle: '',
  aliases: [],
  improvWorld: '',
};

let CHAR = { ...EMPTY };

/**
 * 从配置里装载身份槽位。可在重载配置后重复调用。
 * @returns 当前生效的槽位
 */
export function initCharacter(cfg) {
  const c = cfg?.raw?.persona?.character || {};
  const aliasRaw = Array.isArray(c.aliases) ? c.aliases : (cfg?.raw?.persona?.aliases || []);
  CHAR = {
    // 角色名；没填 → 空（代码里再退成「我」或不提名字）
    name: slot(c.name),
    // 自称；没填 → 空（getter 退成「我」）
    selfRef: slot(c.selfRef),
    // 默认昵称（叫号主/熟人的固定叫法）；没填 → 空（退成对方名片名）
    defaultNick: slot(c.defaultNick),
    // 对号主的称呼；没填 → 「你」
    ownerTitle: slot(c.ownerTitle),
    // 外号 / 别名（用于「是不是在叫我」的判断、写日记时避开的名字）
    aliases: aliasRaw.map((x) => String(x ?? '').trim()).filter((x) => x && !PLACEHOLDER.test(x)),
    // 群聊里「被叫到」的专属称呼（2026-10-27）：群里还有别的鲸鱼娘，
    // aliases 里的通用外号不算叫她，只有这里列的才算；没填 → 只认真名。
    groupCallNames: (Array.isArray(c.groupCallNames) ? c.groupCallNames : [])
      .map((x) => String(x ?? '').trim())
      .filter((x) => x && !PLACEHOLDER.test(x)),
    // 可以自由发挥的设定域（种族/世界观/癖好），拼进「别编事实」那段
    improvWorld: slot(c.improvWorld),
  };
  return CHAR;
}

/** 当前生效的全部槽位（只读用） */
export function char() {
  return CHAR;
}

/** 角色名；没填返回 fallback */
export function charName(fallback = '') {
  return CHAR.name || fallback;
}

/** 自称；永远有个能用的值 */
export function selfRef(fallback = '我') {
  return CHAR.selfRef || fallback;
}

/** 对号主的称呼 */
export function ownerTitle(fallback = '你') {
  return CHAR.ownerTitle || fallback;
}

/** 默认昵称；没填就用对方名片名 */
export function defaultNick(fallback = '') {
  return CHAR.defaultNick || fallback;
}

/** 名字 + 外号 + 自称，去重；用于「在叫我吗」判断和回复前缀清理 */
export function allNames() {
  const out = new Set();
  for (const v of [CHAR.name, CHAR.selfRef, ...CHAR.aliases]) {
    const s = String(v || '').trim();
    if (s) out.add(s);
  }
  return [...out];
}

/** 把一段文字里的正则元字符转义，用于按名字构造正则 */
export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}