/**
 * 今日滚动摘要（2026-10-28 用户拍板「第一种，而且总结可以写详细一些」）
 *
 * 为什么要有它：每轮的上下文只有「40 条 / 3200 字 / 45 分钟」三道闸，
 * 几个小时前说的话早就掉出去了，而日记要到晚上才写一次——中间这段是断的。
 * 表现出来就是：昨天的还记得（日记），今天上午的全忘（掉出窗口又没进日记）。
 *
 * 做法：每 25 分钟把这段时间的新消息压成一段 300~500 字的回忆，存进
 * data/today-brief.jsonl；之后每轮把最近几条塞进提示词。跨天自动换新的一页。
 */
import fs from 'node:fs';
import path from 'node:path';

const TICK_MS = 5 * 60 * 1000;      // 每 5 分钟看一次
const MIN_GAP_MS = 25 * 60 * 1000;  // 同一会话最快 25 分钟压一次
const MIN_MSGS = 3;                 // 少于 3 条不值得烧一次模型
const MAX_INPUT_CHARS = 4000;       // 喂进去的原文上限
const MAX_BRIEF_CHARS = 900;        // 单条摘要上限（要「详细」但不是写小说）
const INJECT_LIMIT = 5;             // 每轮注入最近几条

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

export function briefPath(dataDir) {
  return path.join(dataDir, 'today-brief.jsonl');
}

/** 该会话今天的全部摘要，按时间正序 */
export function briefsFor(dataDir, key, now = Date.now()) {
  const day = new Date(now).toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
  return readJsonl(briefPath(dataDir)).filter((b) => {
    if (b.key !== key) return false;
    const d = new Date(Number(b.t));
    return !Number.isNaN(d.getTime()) && d.toLocaleDateString('sv-SE') === day;
  });
}

/** 每轮注入用：最近几条拼成一段，没有就给空串 */
export function renderBrief(dataDir, key, limit = INJECT_LIMIT) {
  const list = briefsFor(dataDir, key).slice(-limit);
  if (!list.length) return '';
  return list.map((b) => `【${b.span}】${b.text}`).join('\n');
}

function hhmm(t) {
  const d = new Date(Number(t));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const PROMPT = `你在替自己写一段今天的回忆笔记。下面是你和对方今天早些时候的真实对话。

要求：
1. 用第一人称写，像自己回想，不要写「用户说」「AI 回答」这种第三人称。
2. 写 300~500 字，宁细不省：对方讲的要紧事、他的情绪、你们聊到哪儿、答应过什么、有什么还没说完，都写进去。
3. 可以有你的感受，但别编对话里没有的事。
4. 不要复述每一句话，也不要逐条列举；写成一小段连贯的回忆。
5. 直接输出这段回忆本身，不要任何前缀、标题、markdown。

对话如下：
`;

/**
 * 起一个后台巡检器。runner 用 AgentRunner 实例（工具模式 none，跑一句话）。
 * 返回 { tick, stop }，tick 手动跑一次（测试用）。
 */
export function createBriefWatcher({ dataDir, getRunner, note = () => {}, cfg = {} }) {
  const histDir = path.join(dataDir, 'history');
  let busy = false;
  let timer = null;

  function lastEndFor(key) {
    const rows = readJsonl(briefPath(dataDir)).filter((b) => b.key === key);
    return rows.length ? Math.max(...rows.map((b) => Number(b.spanEnd) || 0)) : 0;
  }

  async function briefOne(key, rows) {
    const take = [];
    let chars = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const text = String(r.text ?? '').trim();
      if (!text) continue;
      chars += text.length;
      if (chars > MAX_INPUT_CHARS) break;
      take.unshift(r);
    }
    if (take.length < MIN_MSGS) return null;
    const body = take.map((r) => `${r.role === 'bot' ? '我' : r.name || '对方'}：${String(r.text).trim()}`).join('\n');
    const span = `${hhmm(take[0].t)}-${hhmm(take[take.length - 1].t)}`;

    const runner = getRunner();
    if (!runner) return null;
    const res = await runner.run({
      prompt: PROMPT + body,
      toolMode: 'none',
      persona: false,
      timeoutMs: 120000,
    });
    const text = String(res?.text ?? '')
      .trim()
      .replace(/^```[\s\S]*?```$/g, '')
      .slice(0, MAX_BRIEF_CHARS);
    if (text.length < 40) return null; // 太短说明没写出来，宁可下次再来

    const rec = {
      t: Date.now(),
      key,
      span,
      spanEnd: Number(take[take.length - 1].t),
      count: take.length,
      text,
    };
    appendLine(briefPath(dataDir), rec);
    return rec;
  }

  async function tick() {
    if (busy) return { skipped: 'busy' };
    busy = true;
    const done = [];
    try {
      if (!fs.existsSync(histDir)) return { skipped: 'no-history' };
      for (const f of fs.readdirSync(histDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const key = f.replace(/\.jsonl$/, '');
        const lastEnd = lastEndFor(key);
        const now = Date.now();
        const rows = readJsonl(path.join(histDir, f)).filter((r) => {
          const t = Number(r.t);
          return Number.isFinite(t) && t > lastEnd && now - t < 12 * 3600 * 1000;
        });
        if (rows.length < MIN_MSGS) continue;
        const firstT = Number(rows[0].t);
        // 攒够 25 分钟、或者已经堆到 20 条以上，就压一次
        if (now - firstT < MIN_GAP_MS && rows.length < 20) continue;
        try {
          const rec = await briefOne(key, rows);
          if (rec) {
            done.push(rec);
            note('info', `今日摘要 [${key}] ${rec.span} ${rec.count} 条 → ${rec.text.length} 字`);
          }
        } catch (e) {
          note('warn', `今日摘要失败 [${key}]: ${e.message}`);
        }
      }
    } finally {
      busy = false;
    }
    return { done };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch((e) => note('warn', `今日摘要巡检失败: ${e.message}`));
    }, TICK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
