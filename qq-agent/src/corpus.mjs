// 语料库（persona/corpus.md）按情绪切片，每轮抽几条注入 prompt。
//
// 以前 corpus.md 只在人设里写了一句「要翻的时候用 read 打开」——模型几乎不会真去翻，
// 于是那份 8831 字的底本对说话几乎没有影响。现在改成：按当前情绪档选栏，
// 随机抽几条（避开最近用过的），直接进本轮 prompt。
//
// 注意：抽的是「骨架样本」，不是台词。人设里明确要求换词重写、不许原样搬。
import fs from 'node:fs';

const CACHE = { file: '', mtimeMs: 0, corpus: null };

/** 把 corpus.md 解析成 { I1: {id,title,keys,lines}, ... } */
export function parseCorpus(text) {
  const sections = new Map();
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s+/.test(line)) {
      const m = line.match(/^##\s+(I\d+)\b\s*(.*)$/i);
      if (m) {
        cur = { id: m[1].toUpperCase(), title: (m[2] || '').trim(), keys: [], lines: [] };
        sections.set(cur.id, cur);
      } else {
        cur = null; // 对主人专用 / 雷区反应 / 干完活 这些不按情绪抽
      }
      continue;
    }
    if (!cur || !line) continue;
    const keyMatch = line.match(/^`?检索[：:]\s*(.*?)`?$/);
    if (keyMatch) {
      cur.keys = keyMatch[1].split(/[\s、,，]+/).map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (line.startsWith('#') || line.startsWith('```')) continue;
    const sample = line.replace(/^[-*]\s*/, '').replace(/^["「]|["」]$/g, '').trim();
    if (!sample) continue;
    // 一行里用 ｜ 并排写的多条，拆成独立样本
    for (const part of sample.split(/[｜|]/)) {
      const one = part.trim().replace(/^（[^）]{0,12}）\s*/, '');
      if (one && one.length <= 60) cur.lines.push(one);
    }
  }
  return sections;
}

export function loadCorpus(file) {
  try {
    const st = fs.statSync(file);
    if (CACHE.corpus && CACHE.file === file && CACHE.mtimeMs === st.mtimeMs) return CACHE.corpus;
    const corpus = parseCorpus(fs.readFileSync(file, 'utf8'));
    CACHE.file = file;
    CACHE.mtimeMs = st.mtimeMs;
    CACHE.corpus = corpus;
    return corpus;
  } catch {
    return CACHE.corpus || new Map();
  }
}

/**
 * 情绪档 → 优先栏位（第一个是主栏）。
 * I3「饭」不参与情绪抽栏：那栏的「三碗」连着抽会把讨饭那套话顶回来。
 * 它不是禁句——真饿着、或者这轮就在聊吃的时候，按配额借 2 条（见 FOOD_RE）。
 */
const EMO_SECTIONS = {
  calm: ['I1'],
  happy: ['I6', 'I1'],
  gentle: ['I5', 'I1'],
  soft: ['I11', 'I5'],
  sad: ['I5', 'I11'],
  sleepy: ['I2'],
  confused: ['I13', 'I1'],
  surprised: ['I13', 'I1'],
  encouraging: ['I4', 'I1'],
};

/** 怒气覆盖：生气/赌气优先翻对应栏 */
function angerSections(lv) {
  if (lv >= 3) return ['I10', 'I9'];
  if (lv >= 2) return ['I9'];
  if (lv >= 1) return ['I8'];
  return [];
}

/** 按来话内容临时借栏（不求全，命中一条就加上） */
const TEXT_RULES = [
  { re: /(厉害|好棒|好看|可爱|牛|夸|佩服|优秀)/, ids: ['I6'] },
  { re: /(该睡|早点睡|吃饭|早饭|午饭|晚饭|伞|冷|药|感冒|咳嗽|难受|难过|哭|累)/, ids: ['I5'] },
  { re: /(对不起|我错了|别生气|和好|哄|抱歉)/, ids: ['I11'] },
  { re: /(不懂|啥意思|没听懂|你说什么|什么意思)/, ids: ['I13'] },
];

const pickOne = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

/** 聊到吃的迹象（决定要不要借 I3 那栏） */
const FOOD_RE = /(吃|饭|饿|馋|宵夜|夜宵|零食|白饭|外卖|食堂|喝点|泡面)/;

/**
 * 抽这一轮要注入的语料样本。
 * @returns {{id:string,title:string,lines:string[],from:string[]}|null}
 */
export function pickCorpusSamples(corpus, { emotion = 'calm', text = '', angerLv = 0, hunger = '', count = 8, used = [], rnd = Math.random } = {}) {
  if (!corpus || !corpus.size) return null;
  const order = [];
  for (const id of angerSections(angerLv)) order.push(id);
  for (const id of EMO_SECTIONS[emotion] || EMO_SECTIONS.calm) order.push(id);
  for (const rule of TEXT_RULES) if (rule.re.test(String(text || ''))) order.push(...rule.ids);

  const ids = [...new Set(order)].filter((id) => (corpus.get(id)?.lines?.length || 0) >= 3);
  if (!ids.length) return null;

  // I3「饭」：不是禁句，只给 2 条配额，且只在真饿 / 这轮在聊吃的时候借
  const foodWanted = (hunger === '饿' || hunger === 'hungry' || FOOD_RE.test(String(text || '')))
    && (corpus.get('I3')?.lines?.length || 0) >= 3;
  const foodQuota = 2;
  const baseCount = foodWanted ? Math.max(foodQuota + 2, count - foodQuota) : count;

  const usedSet = new Set(used);
  const primary = corpus.get(ids[0]);
  const out = [];
  const taken = new Set();

  // 主栏给 2/3，其余栏分摊；先把最近用过的、重复的跳过
  const quotas = ids.map((id, i) => ({ id, n: i === 0 ? Math.ceil(baseCount * 0.66) : Math.max(1, Math.floor((baseCount * 0.34) / Math.max(1, ids.length - 1))) }));
  for (const q of quotas) {
    const sec = corpus.get(q.id);
    const pool = sec.lines.filter((l) => !usedSet.has(l) && !taken.has(l));
    for (let k = 0; k < q.n; k++) {
      const fresh = pool.filter((l) => !taken.has(l));
      const src = fresh.length ? fresh : sec.lines.filter((l) => !taken.has(l));
      if (!src.length) break;
      const line = src[Math.floor(rnd() * src.length)];
      taken.add(line);
      out.push(line);
      const pi = pool.indexOf(line);
      if (pi >= 0) pool.splice(pi, 1);
      if (out.length >= baseCount) break;
    }
    if (out.length >= baseCount) break;
  }

  let foodStart = -1;
  if (foodWanted) {
    foodStart = out.length;
    const sec = corpus.get('I3');
    const pool = sec.lines.filter((l) => !usedSet.has(l) && !taken.has(l));
    for (let k = 0; k < foodQuota; k++) {
      const fresh = pool.filter((l) => !taken.has(l));
      const src = fresh.length ? fresh : sec.lines.filter((l) => !taken.has(l));
      if (!src.length) break;
      const line = src[Math.floor(rnd() * src.length)];
      taken.add(line);
      out.push(line);
      const pi = pool.indexOf(line);
      if (pi >= 0) pool.splice(pi, 1);
    }
    ids.push('I3');
  }

  if (!out.length) return null;
  return { id: primary.id, title: primary.title, lines: out, from: ids, foodStart };
}

/** 渲染成注入 prompt 的一段话 */
export function renderCorpusHint(sample, { charName = '' } = {}) {
  if (!sample?.lines?.length) return '';
  return [
    `【语感参考 · ${sample.id} ${sample.title}】下面${charName ? `是${charName}` : '是她'}平时说话的底子，只学节奏、断句、语气松紧——**一句都不许原样搬**，要把意思换成这轮该说的话：`,
    ...sample.lines.map((l, i) => `· ${l}${Number.isInteger(sample.foodStart) && sample.foodStart >= 0 && i >= sample.foodStart ? '（吃）' : ''}`),
    '（这些是骨架不是台词。抄了就是念稿，读起来比她本人假。）',
    Number.isInteger(sample.foodStart) && sample.foodStart >= 0
      ? '（带「吃」的两条只借口吻：真说到吃才用一句，别主动端碗讨饭，更别拿饭谈条件。）'
      : '',
  ].join('\n');
}
