/**
 * 群聊知识整理（2026-10-27，用户选的「方案 B」）。
 *
 * 为什么要这个：桥平时接话走的是 toolMode:'none'（chat patch），那一档只禁用
 * bash/fs/web/subagent 这些重工具，知识库与记忆工具是留着的——但接话时不额外引导，
 * 她就只顾着回话，聊到的梗、黑话、称呼转头就忘。所以不占用接话这一步，
 * 等一段聊完，另起一次调用专门整理：把这段里「下次还用得上」的东西写进知识库。
 *
 * 和 summary.mjs 一个套路：攒够条数才跑、异步、失败不影响正常对话。
 * 落点：workspace/summary/digest-<会话key>.json（记到第几条为止整理过）
 *
 * 安全边界：跑整理时 toolMode 仍是 'none'，也就是只有知识库/记忆工具，
 * 没有 shell、没有文件读写，prompt 里也写死了「别碰别的」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJsonl, safeFileName, hhmm, log } from './util.mjs';

export const DEFAULT_DIGEST = {
  enabled: true,
  everyMessages: 30,        // 攒够这么多条新消息整理一次
  takeMessages: 40,         // 每次最多喂多少条
  minGapMs: 30 * 60 * 1000, // 两次整理至少隔 30 分钟（省钱）
  maxPerDay: 8,             // 每个会话一天最多整理几次
  groupsOnly: true,         // 私聊有 memory 那套，先不重复做
  base: 'group',            // 知识库 id
  maxNodes: 3,              // 一次最多写几个节点
};

export function digestConfig(cfg) {
  return { ...DEFAULT_DIGEST, ...(cfg?.raw?.digest || {}) };
}

function stateFile(cfg, chatKey) {
  const dir = ensureDir(path.join(cfg.agentCwd, 'summary'));
  return path.join(dir, `digest-${safeFileName(chatKey)}.json`);
}

function loadState(cfg, chatKey) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(cfg, chatKey), 'utf8'));
  } catch {
    return { covered: 0, lastAt: 0, day: '', dayCount: 0 };
  }
}

function saveState(cfg, chatKey, st) {
  try {
    fs.writeFileSync(stateFile(cfg, chatKey), JSON.stringify(st), 'utf8');
  } catch { /* ignore */ }
}

function dayKeyOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 群库里的「群里的梗」节点 id——黑话统一长在它下面，不再另建话题 */
function findMemesNode(agentCwd, base) {
  try {
    const f = path.join(agentCwd, '.dsh-knowledge', `${base}.json`);
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const hit = (d.nodes || []).find((n) => /梗|黑话|说法/.test(String(n.title || '')));
    return hit ? hit.id : 'root';
  } catch {
    return 'root';
  }
}

function renderPrompt(rows, chatKey, c, memesId = 'root') {
  const lines = rows.map((r) => {
    const who = (r.role === 'bot' || r.role === 'assistant' || r.self === true) ? '你' : r.name;
    return `${hhmm(Number(r.t))} 【${who}】${String(r.text || '').slice(0, 200)}`;
  });

  return [
    '这是一段刚聊完的群聊记录。你只做一件事：把里面「下次聊天还用得上」的东西写进知识库，别的事情一概不做。',
    '',
    '值得写：',
    '- 群里的梗、黑话、缩写、怪说法，以及它到底是什么意思',
    '- 某个人固定被怎么叫（外号、昵称、自称、身份）',
    '- 人和人的关系：谁是谁的什么人、谁和谁熟、谁跟谁不对付',
    '- 约定好的事、反复出现的地点/时间/喜好/禁忌',
    '',
    '不值得写：一次性的闲扯、当时的心情、天气、新闻、客套话、你已经知道的事。',
    '',
    '做法：',
    `1. 先 knowledge_read("${c.base}") 看现有大纲，已有的条目不要重复建。`,
    `2. 新建用 knowledge_write_node，base 填 "${c.base}"，parent 分两种：`,
    `   · 黑话 / 梗 / 缩写 / 怪说法 / 外号的由来 → parent 填 "${memesId}"（群里的梗），`,
    '     title 就写那个词本身（别写成一个句子），body 固定四行：',
    '     意思：一句话说清它在这里指什么',
    '     例句：（把群聊里的原话抄一句，别自己编）',
    '     谁在用：（常见的人名/场合，知道就写，不知道写「大家」）',
    '     什么时候该想起它：（一句话——听到这个说法、或者要接这个梗的时候）',
    `   · 其它知识（称呼、关系、约定、地点、禁忌）→ parent 填 "root"，title 一两句说清这是什么，`,
    '     body 写清楚事实本身；body 最后另起一行写「什么时候该想起它：……」——这一行会进大纲摘要。',
    '3. 已有的条目要补充或修正，就 knowledge_write_node 带 node 参数改它，不要另建一个重复的。',
    `4. 最多写 ${c.maxNodes} 个节点。没有值得写的，就一个节点都别建。`,
    '',
    '不要发消息、不要碰文件、不要跑命令、不要解释你在做什么。',
    '做完只输出一行结论：写了几个就写 `DONE 新建N 更新M`；什么都没写就只输出 `NONE`。',
    '（【你】是这段对话的主角本人，【后面跟的名字】是对方）',
    '',
    lines.join('\n'),
  ].join('\n');
}

/**
 * 攒够了就整理一次。异步、失败不影响正常对话。
 * @returns {Promise<string|null>} 模型的结论行（DONE…/NONE），没跑就 null
 */
export async function maybeDigestKnowledge({ cfg, runner, history, chatKey, note = log }) {
  const c = digestConfig(cfg);
  if (!c.enabled) return null;
  if (c.groupsOnly && !String(chatKey).startsWith('group:')) return null;

  const file = history.file(chatKey);
  if (!fs.existsSync(file)) return null;
  const rows = readJsonl(file, 100000);
  if (!rows.length) return null;

  const st = loadState(cfg, chatKey);
  // 换天归档会把 history 清空，旧 covered 比实际行数还大，不重置就再也不触发
  if (Number(st.covered || 0) > rows.length) {
    st.covered = 0;
    saveState(cfg, chatKey, st);
  }

  const pending = rows.length - (st.covered || 0);
  if (pending < c.everyMessages) return null;

  const now = Date.now();
  if (now - Number(st.lastAt || 0) < c.minGapMs) return null;

  const today = dayKeyOf();
  if (st.day !== today) { st.day = today; st.dayCount = 0; }
  if (Number(st.dayCount || 0) >= c.maxPerDay) return null;

  const from = st.covered || 0;
  // 取最近的一段而不是最旧的一段：整理的是「刚聊完这波」
  const slice = rows.slice(Math.max(0, rows.length - c.takeMessages));
  if (slice.length < 8) return null;

  const memesId = findMemesNode(cfg.agentCwd, c.base);
  const r = await runner.run({ prompt: renderPrompt(slice, chatKey, c, memesId), withTools: false });
  if (!r.ok || !r.text) {
    note('warn', `[${chatKey}] 知识整理失败`);
    return null;
  }

  const verdict = String(r.text).trim().split(/\r?\n/).filter(Boolean).pop() || '';
  st.covered = rows.length;
  st.lastAt = now;
  st.dayCount = Number(st.dayCount || 0) + 1;
  st.lastVerdict = verdict.slice(0, 120);
  saveState(cfg, chatKey, st);

  note('info', `[${chatKey}] 知识整理完成：${verdict.slice(0, 80)}（本次喂 ${slice.length} 条，累计 dayCount=${st.dayCount}）`);
  return verdict;
}
