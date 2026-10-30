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
  // 写作指令式的祈使句：正常聊天不会对着自己说「别抄语料」
  /别抄(?:语料|原句|原文)?|别复读|别照搬|别照抄/,
  /不要自称|别自称/,
];

/* 2026-10-30 复苏：模型把「角色分析 + 自写台词」整段吐进正文。
 * 事故原文（群 200000001 09:43）：
 *   沐·枫逸萧喊我「安全委员溟月姐」，还甩了两个呲牙——这是逗我，带着你只管吓人。我是安全委员，得顺着应一声，语气轻松，带点小傲娇。
 *   「安全委员溟月姐……行吧，这头衔我认了」——再补一句：有事我真管。发个黄脸呲牙也行。
 *   要短，一两条。别抄语料。别复读「吓什么呀」这上一句。注意这人叫沐·枫逸萧（阿枫）。不要自称本鲸（刚用过可考虑）。可以用「本喵」？这一场里还没用，用一次也行，不过也可以不用。
 *   「溟月姐」——群里被喊姐，我的记忆里有一条「被人喊姐我就认下，还顺着论辈分往下压」——那就顺着压一下。
 *   回复：安全委员上
 * 老词表（回一句就好 / 简短点回 / 默认不发）一句都没中：这种思考腔是「角色分析 + 写作指令」，
 * 不是「决定发不发」。所以再补一组「跟自己商量的规划」；单条不算，凑两条才算，免得误杀正文。 */
const PLAN = [
  /要短|短一点|简短点/,
  /一两条|两条差不多/,
  /别抄|别复读|别照搬|别照抄/,
  /注意这人|注意他叫|不要自称|别自称|可以用「|用一次也行|不过也可以不用/,
  /再补一句|补一句[:：]|回复[:：]/,
  /发个(?:黄脸|表情|呲牙|贴图)/,
  /语气(?:轻松|温柔|俏皮|随意|平静)|带点(?:小)?(?:傲娇|调皮|温柔|俏皮)/,
];
const SELF = [
  /(?:这|那)是逗我|在逗我|逗我玩/,
  /得顺着|顺着应一声|那就顺着/,
  /我记忆里|记忆里有一条/,
  /这一场|这一轮|上一句|上一条/,
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
  // 规划/自述：两类加起来 ≥2 条才算（「要短」单说一句可能是正文，配上「别抄语料」就是写给自己看的）
  let plan = 0;
  for (const re of PLAN) if (re.test(t)) plan += 1;
  for (const re of SELF) if (re.test(t)) plan += 1;
  if (plan >= 2) return true;
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
 * 事故原文（群 200000002 11:33:38，模型把 `#翻唱整首美人鱼` 当成工作项跑，
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

  // 2026-10-30：模型自己标了正文（「回复：xxx」）时，前面那些分析一律不要，只留它标出来的那句。
  // 这是最可靠的信号——它写的「回复：」就是它认定该发出去的内容。
  const replyLines = lines
    .map((l) => l.match(/^\s*(?:回复|回答|答)[：:]\s*(.+)$/))
    .filter(Boolean);
  if (replyLines.length) {
    const body = replyLines[replyLines.length - 1][1].trim();
    const dirs = lines.filter((l) => isDirectiveLine(l)).map((l) => l.trim());
    if (body) return [...dirs, body].join('\n');
  }

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
