/**
 * 知识库自动确认（2026-10-28 用户要求：「把知识库收录黑话改成自动收录无需我审批」）。
 *
 * 背景：知识库插件 dsh-knowledge-canvas 给模型写的每个节点都打 review 标记
 * （节点字段 `change`: added / modified / removed），要在面板里点一下才清掉。
 * 群里聊出来的梗、外号、称呼、关系，写进 group 库就该直接算数，不该等谁审稿。
 *
 * 做法：不碰插件包（改 node_modules 一升级就丢），直接扫库文件把标记抹掉：
 *   - added / modified（以及历史遗留的 edited）→ 删掉 change，条目立即算「已收录」；
 *   - removed → 保留。模型本来没有删节点的能力，真出现删除还挂着标记，人能在面板里撤回；
 *     自动确认一次删除等于把节点永久按下去，不是这次要的东西。
 *
 * 调用点：
 *   1. knowledge-digest 每次整理完（黑话入库的主路径）；
 *   2. index.mjs 每轮接话收尾（兜底——她接话时直接调 knowledge_write_node 写的也能清到）。
 * 文件 mtime 没变就直接返回，不读不写，所以每轮调用几乎不花钱。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 要抹掉的标记。`edited` 是早期版本留下的，面板一样画成待审。 */
const REVIEW_MARKS = new Set(['added', 'modified', 'edited']);

/** 默认只动群库：welcome 是插件自带教程，别的库各归各的用途 */
export const AUTO_REVIEW_BASES = ['group'];

/** 每个文件上次处理过的时间戳，避免同一份内容反复读写 */
const lastMtime = new Map();

function fmtNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 处理一个库文件。
 * @returns {{file: string, cleared: number, skipped?: string}}
 */
export function reviewOneBase(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { file, cleared: 0, skipped: 'missing' };
  }

  const stamp = stat.mtimeMs;
  if (lastMtime.get(file) === stamp) return { file, cleared: 0, skipped: 'unchanged' };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { file, cleared: 0, skipped: 'broken' };
  }

  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  let cleared = 0;
  for (const n of nodes) {
    if (n && typeof n === 'object' && REVIEW_MARKS.has(String(n.change || ''))) {
      delete n.change;
      // 只认过、不算改过：at 往前挪会让别的机器以为这是新节点，同步时又抢一次
      cleared += 1;
    }
  }

  if (cleared > 0) {
    // 写法和插件 saveBase 一致：两空格缩进 + 结尾换行
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { file, cleared: 0, skipped: `write-failed: ${e.message}` };
    }
    try {
      lastMtime.set(file, fs.statSync(file).mtimeMs);
    } catch {
      lastMtime.delete(file);
    }
  } else {
    lastMtime.set(file, stamp);
  }

  return { file, cleared };
}

/**
 * 把指定知识库（默认 group）里所有待审标记确认掉。
 * @returns {{cleared: number, files: Array}}
 */
export function autoReviewKnowledge(cfg, { bases = AUTO_REVIEW_BASES } = {}) {
  const dir = path.join(cfg.agentCwd, '.dsh-knowledge');
  const out = [];
  for (const base of bases) {
    const file = path.join(dir, `${base}.json`);
    const r = reviewOneBase(file);
    if (r.cleared > 0) out.push({ base, cleared: r.cleared });
  }
  const cleared = out.reduce((s, r) => s + r.cleared, 0);
  return { cleared, files: out };
}

export { fmtNow };
