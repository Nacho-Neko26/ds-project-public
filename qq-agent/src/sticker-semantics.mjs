// 表情语义层（2026-10-28 用户要求「表情库添加语义层」）
//
// 之前每张图在目录里只有一句内容描述（「蓝发少女低头笑」这种），挑图全靠模型
// 自己从这句话里猜「这张能不能用来怼人」。猜不着就只能发那张最眼熟的，
// 于是「老是发同一张」的根子其实在这儿。
//
// 这一层不额外烧 token：把已有的描述/文件名/标签喂进一张关键词表，
// 推出「情绪」和「用途」两组语义维度，挂到行上给打分器用（sticker-score
// 本来就读 row.emotion / row.use，只是从来没人填）。
//
// 两个维度分开存，因为它们是正交的：一张「白眼」既是「怼人」也常常被当
// 「看戏」用；一张「困脸」既是「犯困」也能当「无语」。
// 词表是启发式的，够用就行，加词只改这一张表。

/** 情绪维度：这一张图「是什么脸色」 */
const EMOTION_WORDS = {
  开心: ['笑', '哈哈', '嘻嘻', '开心', '乐', '嘿嘿', '高兴', '喜', '耶', '好耶', '庆祝', '干饭', '吃', '花痴', '心动', '星星眼', '放光', '饱', '馋', '香', '兴奋', '哇'],
  得意: ['得意', '叉腰', '哼哼', '骄傲', '神气', '得瑟', '稳了', '拿捏', '瞧我'],
  生气: ['生气', '怒', '气炸', '炸毛', '滚', '发火', '抓狂', '烦', '凶', '骂'],
  怼人: ['白眼', '嫌弃', '无语', '嘲讽', '鄙视', '就这', '摊手', '阴阳', '讽刺', '呕'],
  难过: ['哭', '泪', '委屈', '难过', '伤心', '呜呜', '丧', '失落', '呜呜呜', '抱膝', '崩溃', '加班', '黑眼圈', '垮', '累', '憔悴'],
  娇羞: ['害羞', '脸红', '羞', '害臊', '捂脸', '心跳', '不好意思', '被夸'],
  犯困: ['困', '睡', '哈欠', '困了', 'zz', '懒', '闭眼', '半睁', '疲惫'],
  摸鱼: ['摸鱼', '躺', '咸鱼', '摆烂', '发呆', '划水', '瘫', '放空'],
  害怕: ['害怕', '惊恐', '慌', '救命', '惊', '吓', '抖', '瑟瑟'],
  疑惑: ['问号', '疑惑', '懵逼', '不解', 'what', '皱眉', '纳闷', '？？', '思考', '灵光'],
  吃瓜: ['吃瓜', '瓜', '围观', '看戏', '乐子', '瞧热闹', '看热闹'],
};

/** 用途维度：这一张图「能拿去干什么」 */
const USE_WORDS = {
  打招呼: ['你好', '嗨', 'hi', 'hello', '早', '招手', '打招呼', '在吗'],
  道别: ['再见', '拜拜', '晚安', '走了', 'bye', '下班'],
  答应: ['ok', '好的', '行', '收到', '同意', '点赞', '赞', '比心', '没问题', '可以', '感谢', '谢谢'],
  拒绝: ['不行', '拒绝', '摆手', '不要', '谢绝', '免了'],
  催促: ['催', '快点', '赶紧', '急', '等', '什么时候'],
  安慰: ['抱抱', '安慰', '摸摸头', '拍拍', '别哭', '乖', '没事'],
  夸人: ['牛', '厉害', '强', '绝了', '棒', '优秀', '太强', '膜拜'],
  看戏: ['吃瓜', '看戏', '围观', '乐子', '瞧热闹'],
  接梗: ['搞怪', '搞事', '鬼点子', '梗', '趣味', '整活'],
  撒娇: ['求', '拜托', '可怜', '求求', '嘛', '好不好', '卖萌', '揉脸'],
};

/** 素材目录里的英文目录名/标签（angry、baka…）直接映射到中文维度 */
const EN_TAGS = {
  angry: '生气', rage: '生气',
  happy: '开心', laugh: '开心', joy: '开心', like: '开心', love: '开心',
  baka: '怼人', mock: '怼人', despise: '怼人', speechless: '怼人',
  shy: '娇羞', blush: '娇羞',
  sleep: '犯困', sleepy: '犯困', tired: '犯困',
  cry: '难过', sad: '难过', comfort: '安慰',
  proud: '得意', smug: '得意',
  confused: '疑惑', huh: '疑惑', question: '疑惑',
  ok: '答应', yes: '答应', no: '拒绝',
  bye: '道别', night: '道别', hi: '打招呼', hello: '打招呼',
  fish: '摸鱼', lazy: '摸鱼', work: '摸鱼',
  doge: '看戏', watch: '看戏',
  color: '开心', daily: '开心', eat: '开心', food: '开心',
  cpu: '难过', overtime: '难过', crash: '难过', tired2: '犯困',
  money: '撒娇', givemoney: '撒娇',
};

/** 从一段描述里抽语义标签。返回去重后的标签数组，顺序按命中强度。 */
export function deriveSemantics(...texts) {
  const hay = texts
    .filter(Boolean)
    .map((t) => String(t).toLowerCase())
    .join(' ')
    .replace(/\[|\]|「|」|·/g, ' ');
  if (!hay) return [];
  const hits = [];
  // 目录名/标签先算一遍：目录名是作者打的，比从描述里猜准
  const preset = new Set();
  for (const [en, zh] of Object.entries(EN_TAGS)) {
    if (new RegExp(`(^|[^a-z])${en}([^a-z]|$)`).test(hay)) preset.add(zh);
  }
  for (const zh of preset) {
    hits.push({ label: zh, n: 9, kind: EMOTION_WORDS[zh] ? 'e' : 'u' });
  }
  for (const [label, words] of Object.entries(EMOTION_WORDS)) {
    let n = 0;
    for (const w of words) if (hay.includes(w)) n += 1;
    if (n) hits.push({ label, n, kind: 'e' });
  }
  for (const [label, words] of Object.entries(USE_WORDS)) {
    let n = 0;
    for (const w of words) if (hay.includes(w)) n += 1;
    if (n) hits.push({ label, n, kind: 'u' });
  }
  hits.sort((a, b) => b.n - a.n);
  // 最多两个标签：一个是脸色，一个是场合。太多等于没说。
  const picked = [];
  const seen = new Set();
  for (const h of hits) {
    if (seen.has(h.label)) continue;
    // 同一种维度最多占一个位置，保证「脸色 + 场合」都露出来
    if (picked.some((p) => p.kind === h.kind)) continue;
    seen.add(h.label);
    picked.push(h);
    if (picked.length >= 2) break;
  }
  if (!picked.length) return [];
  return picked.map((p) => p.label);
}

/** 给一行表情补上语义字段（打分器读 emotion / use / tags），返回同一行。 */
export function enrichRow(row, label = '') {
  if (!row || row.__sem) return row;
  // 库里的行两种形态都有：{seg:{data}} 和 {rec:{seg:{data}}}，都要认
  const seg = row.seg?.data ?? row.rec?.seg?.data ?? {};
  const tags = deriveSemantics(
    label,
    seg.summary,
    Array.isArray(row.tags) ? row.tags.join(' ') : row.tags,
    row.tag,
    row.stem,
    row.dir,
    row.name,
    row.text,
    row.emotion,
    row.use,
  );
  // 原行已有值就并进去，别把人工填的覆盖掉
  const e = tags.find((t) => EMOTION_WORDS[t]);
  const u = tags.find((t) => USE_WORDS[t]);
  row.emotion = [row.emotion, e].filter(Boolean).join(' ').trim();
  row.use = [row.use, u].filter(Boolean).join(' ').trim();
  row.tags = Array.from(new Set([...(Array.isArray(row.tags) ? row.tags : []), ...tags]));
  Object.defineProperty(row, '__sem', { value: tags, enumerable: false });
  return row;
}

/** 目录里跟在描述后面的徽章，例如「[得意·看戏]」；抽不出就不加。 */
export function semBadge(row) {
  const tags = row?.__sem?.length ? row.__sem : deriveSemantics(row?.emotion, row?.use);
  return tags.length ? ` [${tags.join('·')}]` : '';
}

/** 给一批行排序用的语义字段（就地补，返回原数组）。 */
export function enrichRows(rows, labelOf = () => '') {
  for (const r of rows) enrichRow(r, labelOf(r));
  return rows;
}

/** 小黄脸只有名字可用，单独走一条。 */
export function faceSemantics(name) {
  return deriveSemantics(name);
}
