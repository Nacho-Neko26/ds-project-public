/**
 * 思考过程泄漏清理（2026-10-25）
 *
 * 症状（真实事故，memory: 用户 22:17 报「私聊最近三条又把思考过程展示出来了」）：
 *   他发了个表情，估计就是随便逗一下。我回一句就好。
 *   就发个「[表情]」，多半是求回应呢……本鲸也甩一张？不过默认先不发，这轮就纯说话，显得有点小傲娇。
 *   嗯，挺短的一句话，简短点回。唔，甩个表情过来就想把本鲸晾在那儿？说句话嘛。
 * 前三行是模型写给自己看的权衡，只有最后一句该发出去。
 *
 * 做法：按行 → 按句逐级判定「自述规划」的片段，命中就丢。
 *   STRONG 单条即判（都是「在决定怎么说」的话，正常正文几乎不会这么写）
 *   WEAK   要凑两条才算（单个词在正常聊天里也会出现）
 * 指令行（__SEND_STICKER__ 这种）不参与判定，原样保留。
 * 清完为空就返回空串——宁可这轮不发，也不能把思考发出去。
 */

const STRONG = [
  /回一句就好|回一句就行|回一句算了/,
  /简短(?:点|地)?(?:回|说)|短一点回|简单(?:点|地)?(?:回|说)一句/,
  /默认(?:先)?不发|先不发(?:了)?|这轮不发了/,
  /甩一张|配一张|来一张吧/,
  /素材(?:当|就)没看见/,
  /应该分两次|分两次(?:发送|发)|分两条(?:发送|发)|不该这样发|这种格式不对/,
];

const WEAK = [
  /估计|多半|大概|说不定|看样子/,
  /这轮|这一轮|下一轮|这回合/,
  /要不要(?:发|甩|配丨回)/,
  /(?:我|本鲸)(?:该|就|先|再)(?:回|说|答|发)/,
  /(?:他|她|对方)(?:发了|在问|这是)/,
];

const MAX_SEG_LEN = 160;

function isDirectiveLine(line) {
  return /^\s*__[A-Z_]+/.test(line) || /^\s*<SKIP>\s*$/i.test(line);
}

function looksLikeSelfTalk(seg) {
  const t = seg.trim();
  if (!t || t.length > MAX_SEG_LEN) return false;
  if (isDirectiveLine(t)) return false;
  if (STRONG.some((re) => re.test(t))) return true;
  let weak = 0;
  for (const re of WEAK) if (re.test(t)) weak += 1;
  return weak >= 2;
}

/** 一句一句地切（保留标点） */
function splitSentences(line) {
  return line.split(/(?<=[。！？!?])/).filter((s) => s.trim());
}

/* ---------- 工具执行报告不许原样进聊天（2026-10-26 事故） ---------- */

/**
 * 事故原文（群 <GROUP_ID_2> 11:33:38，模型把 `#翻唱整首美人鱼` 当成工作项跑，
 * 回报原样发进了群里）：
 *   两次尝试都在同一处失败：沙箱不允许写入 `/root/qq-agent/data/cover/queue/`。
 *
 *   - 我先确认了执行器在线（心跳正常），然后按对应流程走 `enqueueCover` 把整首《美人鱼》排进队列；
 *     它却报错 `EACCES: permission denied, open '.../data/cover/queue/.mvopcb33l3bp.tmp'`。这条路径在 w…
 *
 * 这些是给开发者看的东西：markdown 标题/列表、代码块、反引号路径、报错栈。
 * 群里只需要一句「排不上，写不进队列」。
 */

const ERR_SIG = /\b(?:EACCES|EPERM|ENOENT|EISDIR|ETIMEDOUT|ECONNREFUSED|Traceback|TypeError|ReferenceError|SyntaxError|Exception)\b/;

function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^```/.test(t)) return true;
  if (/^#{1,6}\s/.test(t)) return true;            // markdown 标题
  if (/^\|.*\|$/.test(t)) return true;             // 表格行
  if (/^[-*+]\s*\|/.test(t)) return true;          // 列表包着的表格
  if (/^-{3,}$|^={3,}$/.test(t)) return true;      // 分隔线
  if (/^(?:at\s|File\s"|Traceback\b|Caused by\b)/.test(t)) return true; // 调用栈
  if (/^\$\s/.test(t)) return true;                // shell 回显
  return false;
}

/**
 * 把工具的原始输出/回报收拾成「能发进聊天的一句人话」。
 * @param {string} text
 * @param {{maxChars?: number}} [opts]
 * @returns {string} 收拾后的文本；实在没有可读内容就返回空串（调用方自己兜底）
 */
export function cleanToolReport(text, { maxChars = 160 } = {}) {
  let raw = String(text ?? '');
  if (!raw.trim()) return '';
  raw = raw.replace(/```[\s\S]*?```/g, ' ');        // 整块代码
  const lines = raw.split(/\r?\n/).filter((l) => !isNoiseLine(l));
  let body = lines
    .map((l) => l
      .replace(/^\s*[-*+]\s+/, '')                 // 列表符号
      .replace(/^\s*\d+[.)]\s+/, '')               // 有序列表
      .replace(/`/g, '')                           // 反引号
      .replace(/\*\*/g, '')                        // 粗体
      .trim())
    .filter(Boolean);
  // 报错行平时剔掉；整段只有报错时留一行，免得不说话。
  const noErr = body.filter((l) => !ERR_SIG.test(l));
  const use = noErr.length ? noErr : body;
  let out = use.join('；').replace(/[；;]{2,}/g, '；').replace(/\s{2,}/g, ' ').trim();
  if (!out) return '';
  // 长绝对路径降成末两段：/root/qq-agent/data/cover/queue/ → data/cover/queue
  out = out.replace(/(?:\/[\w.@-]+){2,}/g, (m) => m.split('/').filter(Boolean).slice(-2).join('/'));
  // 只留前两句，太长就截断加省略号
  const sents = out.split(/(?<=[。！？!?])/).filter((s) => s.trim());
  if (sents.length > 2) out = sents.slice(0, 2).join('');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

/**
 * @param {string} text 模型这一轮的输出
 * @returns {string} 清掉思考片段后的文本（可能为空串）
 */
export function stripThinkingLeak(text) {
  let raw = String(text ?? '');
  if (!raw.trim()) return raw;
  // 2026-10-26 事故：「这会儿本鲸的碗还空着（这句话应该分两次发送而不是这种格式）」
  // 括号里的自评命中 STRONG 后整行被丢，正文跟着没了。括号内自评只删括号本身。
  raw = raw.replace(/[\uFF08(]([^\uFF08\uFF09()]{0,60})[\uFF09)]/g, (m, inner) =>
    looksLikeSelfTalk(String(inner ?? '')) ? '' : m,
  );
  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim());
  // 只有一段时不动：思考与正文黏在同一段里，切开的风险大于收益
  if (nonEmpty.length < 2) return raw;

  const kept = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (isDirectiveLine(line)) { kept.push(line); continue; }
    const sentences = splitSentences(line);
    if (sentences.length <= 1) {
      if (!looksLikeSelfTalk(line)) kept.push(line);
      continue;
    }
    const good = sentences.filter((s) => !looksLikeSelfTalk(s));
    if (good.length) kept.push(good.join(''));
  }
  return kept.join('\n');
}
