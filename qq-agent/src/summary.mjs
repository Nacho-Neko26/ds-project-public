/**
 * 滚动摘要（相当于 dsh-session-switch 那套「聊久了先存下来再接着聊」）。
 *
 * 桥每轮只往 prompt 里塞最近十几条消息，更早的会被时间窗和字数闸切掉。
 * 这里负责把「被切掉的那部分」压成几行存下来，之后再注入回 prompt，
 * 所以聊一整天也不会真的忘光。
 *
 * 落点：workspace/summary/<会话key>.md（人看得见、能直接改）
 * 状态：workspace/summary/<会话key>.json（记到第几条为止已经压缩过）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJsonl, safeFileName, hhmm, log } from './util.mjs';
import { guardFor } from './resource-guard.mjs';

export const DEFAULT_SUMMARY = {
  enabled: true,
  everyMessages: 80,   // 攒够这么多条新消息压一次
  takeMessages: 60,    // 每次压多少条
  maxBlocks: 4,        // 摘要文件里最多留几段
  maxChars: 700,       // 注入上限
};

export function summaryConfig(cfg) {
  return { ...DEFAULT_SUMMARY, ...(cfg?.raw?.summary || {}) };
}

function summaryDir(cfg) {
  return ensureDir(path.join(cfg.agentCwd, 'summary'));
}

function fileOf(cfg, chatKey) {
  return path.join(summaryDir(cfg), `${safeFileName(chatKey)}.md`);
}

function stateOf(cfg, chatKey) {
  return path.join(summaryDir(cfg), `${safeFileName(chatKey)}.json`);
}

function loadState(cfg, chatKey) {
  try { return JSON.parse(fs.readFileSync(stateOf(cfg, chatKey), 'utf8')); } catch { return { covered: 0 }; }
}

function saveState(cfg, chatKey, st) {
  try { fs.writeFileSync(stateOf(cfg, chatKey), JSON.stringify(st), 'utf8'); } catch { /* ignore */ }
}

/** 读出来给 prompt 用（最近几段，按字数截断） */
export function readSummary(cfg, chatKey) {
  const c = summaryConfig(cfg);
  const f = fileOf(cfg, chatKey);
  if (!fs.existsSync(f)) return '';
  const text = fs.readFileSync(f, 'utf8').trim();
  if (!text) return '';
  const blocks = text.split(/\n(?=## )/).filter(Boolean);
  const tail = blocks.slice(-c.maxBlocks).join('\n');
  return tail.length > c.maxChars ? tail.slice(-c.maxChars) : tail;
}

function renderFor(model, rows, chatKey) {
  const lines = rows.map((r) => {
    // 2026-10-27：和主 prompt 一个口径——自己一律【你】，assistant 也算自己
    const who = (r.role === 'bot' || r.role === 'assistant' || r.self === true) ? '你' : r.name;
    return `${hhmm(Number(r.t))} 【${who}】${String(r.text || '').slice(0, 200)}`;
  });
  return [
    `把下面这段${chatKey.startsWith('group:') ? '群聊' : '私聊'}记录压成 2-4 句话。`,
    '只留：聊了什么话题、谁提过什么要紧的事、约定了什么、情绪基调。',
    '不要编、不要评论、不要写「用户说」这种转述腔，直接写发生了什么。',
    '不用 Markdown，不加标题。',
    '（【你】是这段对话的主角本人，【后面跟的名字】是对方）',
    '',
    lines.join('\n'),
  ].join('\n');
}

/**
 * 攒够了就压一次。异步、失败不影响正常对话。
 * @returns {Promise<string|null>} 新写入的那段摘要
 */
export async function maybeSummarize({ cfg, runner, history, chatKey, note = log }) {
  const c = summaryConfig(cfg);
  if (!c.enabled) return null;

  // 服务器紧张时后台整理先让路（2026-10-28 用户要求：先保文本回复）。
  const gate = guardFor(cfg).allow('bg');
  if (!gate.ok) { note('info', `[摘要] ${gate.reason}`); return null; }

  const file = history.file(chatKey);
  if (!fs.existsSync(file)) return null;
  const rows = readJsonl(file, 100000);
  const st = loadState(cfg, chatKey);
  // 换天归档会把 history 清空，旧 covered（覆盖到第几条）就比实际行数还大，
  // 不重置的话 pending 永远为负、摘要从此再也不触发（2026-10-25 修，群 200000002 中招）。
  if (Number(st.covered || 0) > rows.length) {
    st.covered = 0;
    saveState(cfg, chatKey, st);
  }
  const pending = rows.length - (st.covered || 0);
  if (pending < c.everyMessages) return null;

  const from = st.covered || 0;
  const slice = rows.slice(from, from + c.takeMessages);
  if (slice.length < 10) return null;

  const r = await runner.run({ prompt: renderFor(modelSafe(chatKey), slice, chatKey), withTools: false });
  if (!r.ok || !r.text) { note('warn', `摘要生成失败（${chatKey}）`); return null; }

  const body = String(r.text).trim().replace(/^#+\s*/gm, '').slice(0, c.maxChars);
  if (!body) return null;

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const block = `## ${stamp}\n${body}\n`;

  const f = fileOf(cfg, chatKey);
  const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  let blocks = `${prev}${block}`.split(/\n(?=## )/).filter(Boolean);
  if (blocks.length > c.maxBlocks) blocks = blocks.slice(-c.maxBlocks);
  fs.writeFileSync(f, blocks.join('\n').trim() + '\n', 'utf8');

  saveState(cfg, chatKey, { covered: from + slice.length, updatedAt: Date.now() });
  note('info', `[${chatKey}] 已压缩 ${slice.length} 条历史（累计 ${from + slice.length}/${rows.length}）`);
  return body;
}

function modelSafe(s) {
  return s;
}
