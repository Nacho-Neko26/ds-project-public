/**
 * 自我记忆。
 *
 * 她自己在聊天的过程中往记忆里添东西——关于自己的、关于这个群的。
 * 不是人设的复读，是从真实对话里长出来的，会一直累积。
 *
 * 存储：workspace/memory/memories.jsonl，一行一条
 *   { t, scope: 'self' | 'group:<id>', text }
 *
 * 范围：可以记事，但不许记隐私（号码、住址、证件、密码、金额细节）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, readJsonl, ensureDir, safeFileName, hhmm, log } from './util.mjs';
import { guardFor } from './resource-guard.mjs';

export const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  everyMessages: 60,   // 每累计多少条消息尝试记一次
  maxPerScope: 40,     // 每个范围最多保留多少条
  injectChars: 700,    // 注入 prompt 的字数上限
  minMessages: 12,     // 少于这个数不记
};

export function memoryConfig(cfg) {
  return { ...DEFAULT_MEMORY_CONFIG, ...(cfg?.raw?.memory || {}) };
}

function memoryFile(agentCwd) {
  return path.join(ensureDir(path.join(agentCwd, 'memory')), 'memories.jsonl');
}

/** 隐私拦截：这类内容一律不许进记忆 */
const PRIVATE_PATTERNS = [
  /\b1[3-9]\d{9}\b/,                 // 手机号
  /\b\d{17}[\dXx]\b/,                // 身份证
  /(密码|口令|验证码|银行卡|卡号)/,
  /(住在|家庭住址|具体地址|门牌)/,
  /(工资|薪水|月薪|年薪|存款)\s*[\d一二三四五六七八九十百千万]/,
];

export function isPrivate(text) {
  return PRIVATE_PATTERNS.some((re) => re.test(text));
}

/** 读全部记忆 */
export function readAllMemories(agentCwd) {
  return readJsonl(memoryFile(agentCwd), 2000);
}

/**
 * 按范围取记忆，注入用。
 * self + 当前群，从新往旧截断到 injectChars。
 */
export function memoryFor(agentCwd, groupScope) {
  const conf = { ...DEFAULT_MEMORY_CONFIG };
  const rows = readAllMemories(agentCwd);
  const self = rows.filter((r) => r.scope === 'self');
  const group = groupScope ? rows.filter((r) => r.scope === groupScope) : [];

  const pick = (list, cap) => {
    const out = [];
    let chars = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const line = list[i].text;
      if (chars + line.length > cap) break;
      out.unshift(line);
      chars += line.length + 1;
    }
    return out;
  };

  const selfLines = pick(self, Math.floor(conf.injectChars * 0.4));
  const groupLines = pick(group, Math.floor(conf.injectChars * 0.6));
  return { self: selfLines, group: groupLines };
}

/** 渲染成 prompt 段落 */
export function renderMemory(agentCwd, groupScope) {
  const { self, group } = memoryFor(agentCwd, groupScope);
  if (!self.length && !group.length) return '';
  const parts = [];
  if (self.length) parts.push(`关于你自己：\n${self.join('\n')}`);
  if (group.length) parts.push(`关于这个群：\n${group.join('\n')}`);
  return parts.join('\n\n');
}

/** 去重：归一化后比较，避免同一件事反复记 */
function norm(s) {
  return String(s).replace(/[\s，。、！？,.!?~～…]/g, '').toLowerCase();
}

function alreadyKnown(existing, text) {
  const n = norm(text);
  if (!n) return true;
  return existing.some((e) => {
    const m = norm(e.text);
    return m === n || m.includes(n) || n.includes(m);
  });
}

/** 超量时淘汰最旧的（同 scope） */
function pruneScope(agentCwd, scope, max) {
  const file = memoryFile(agentCwd);
  const rows = readJsonl(file, 2000);
  const same = rows.filter((r) => r.scope === scope);
  if (same.length <= max) return;
  const drop = new Set(same.slice(0, same.length - max).map((r) => `${r.t}|${r.text}`));
  const kept = rows.filter((r) => !drop.has(`${r.t}|${r.text}`));
  fs.writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** 最近 N 条聊天渲染 */
function recentMaterial(dataDir, chatKey, limit = 100) {
  const file = path.join(dataDir, 'history', `${safeFileName(chatKey)}.jsonl`);
  const rows = readJsonl(file, limit);
  const lines = rows.map((r) => {
    const who = r.role === 'bot' ? '你' : r.name;
    return `${hhmm(Number(r.t))} 【${who}】${r.text}`;
  });
  return { text: lines.join('\n'), count: rows.length };
}

/**
 * 尝试从最近对话里提炼新记忆并写入。
 * @returns {Promise<string[]>} 新增的记忆行
 */
export async function learnMemories({ runner, cfg, chatKey, chatTitle }) {
  const conf = memoryConfig(cfg);
  if (!conf.enabled) return [];
  if (!chatKey.startsWith('group:')) return []; // 先只从群聊学

  // 服务器紧张时后台整理先让路（2026-10-28 用户要求：先保文本回复）。
  const gate = guardFor(cfg).allow('bg');
  if (!gate.ok) { log('info', `[记忆学习] ${gate.reason}`); return []; }

  const { text, count } = recentMaterial(cfg.dataDir, chatKey, 100);
  if (count < conf.minMessages) return [];

  const all = readAllMemories(cfg.agentCwd);
  const mine = all.filter((r) => r.scope === 'self');
  const theirs = all.filter((r) => r.scope === chatKey);

  const existingText = [
    mine.length ? `关于你自己：\n${mine.map((r) => r.text).join('\n')}` : '',
    theirs.length ? `关于这个群：\n${theirs.map((r) => r.text).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const prompt = [
    `你在给自己记东西，记的是能长期用上的事。`,
    `下面是群聊「${chatTitle || chatKey}」最近的记录（共 ${count} 条）。「你」是你自己。`,
    '',
    text,
    '',
    existingText ? `你已经记下的：\n${existingText}\n` : '',
    '请找出**值得记住的新事情**，一条一行，最多 4 条。每条必须以「自己：」或「群：」开头。',
    '自己：你的喜好、你的习惯、你发现自己怎么说话、你在意什么。',
    '群：这里的人是什么样、有什么梗、什么话题能聊、什么话题会冷。',
    '',
    '规则：',
    '- 只写**新的**，已经记过的不许重复。',
    '- **绝对不许**记：手机号、身份证、住址、密码、验证码、银行卡、工资存款等隐私和数字细节。',
    '- 不写具体八卦流水账，写能长期用上的判断。',
    '- 一条不超过 25 字，除「自己：」「群：」前缀外不要编号、不要 Markdown。',
    '- 如果确实没有值得记的新东西，只输出「无」。',
  ].filter(Boolean).join('\n');

  const r = await runner.run({ prompt });
  if (!r.ok || !r.text) return [];

  const raw = r.text.trim();
  if (raw === '无' || raw.startsWith('无')) return [];

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*·\d.、\s]+/, '').trim())
    .filter(Boolean)
    .filter((l) => l !== '无')
    .slice(0, 6);

  const file = memoryFile(cfg.agentCwd);
  const added = [];
  for (const line of lines) {
    let scope = chatKey;
    let body = line;
    const m = line.match(/^(自己|群)\s*[：:]\s*(.+)$/);
    if (m) {
      scope = m[1] === '自己' ? 'self' : chatKey;
      body = m[2].trim();
    }
    if (body.length < 4) continue;
    if (isPrivate(body)) { log('debug', `记忆跳过（疑似隐私）: ${body}`); continue; }
    if (alreadyKnown(all, body)) continue;

    const rec = { t: Date.now(), scope, text: body };
    appendJsonl(file, rec);
    all.push(rec);
    added.push(body);
    pruneScope(cfg.agentCwd, scope, conf.maxPerScope);
  }

  if (added.length) log('info', `记忆 +${added.length} 条（${chatKey}）`);
  return added;
}


/* ===== 她自己主动记 / 查 / 删 / 清（对应 qq_memory_* 那四个） =====
 * scope: 'self' 关于她自己；'group:<id>' 关于某个群。
 */

/** 主动记一条。一句话，太长或涉隐私都不记。 */
export function appendMemory(agentCwd, scope, text) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return { ok: false, err: '内容为空' };
  if (isPrivate(body)) return { ok: false, err: '这条涉及隐私，不记' };
  if (body.length > 120) return { ok: false, err: '太长了，一句话说完' };
  const rows = readAllMemories(agentCwd);
  const same = rows.filter((r) => r.scope === scope);
  if (alreadyKnown(same, body)) return { ok: false, err: '这条已经记过了' };
  appendJsonl(memoryFile(agentCwd), { t: Date.now(), scope, text: body });
  pruneScope(agentCwd, scope, memoryConfig(null).maxPerScope);
  return { ok: true, text: body };
}

/** 查：关键词模糊匹配；不给关键词就都列出来 */
export function queryMemory(agentCwd, scope, q) {
  const rows = readAllMemories(agentCwd);
  const pool = scope ? rows.filter((r) => r.scope === scope) : rows;
  const kw = norm(q || '');
  const hit = kw ? pool.filter((r) => norm(r.text).includes(kw)) : pool;
  return hit.map((r, i) => ({ idx: i + 1, scope: r.scope, text: r.text, t: r.t }));
}

/** 删一条：给一句能认出它的文本片段 */
export function removeMemory(agentCwd, scope, needle) {
  const file = memoryFile(agentCwd);
  const rows = readAllMemories(agentCwd);
  const kw = norm(needle || '');
  if (!kw) return { ok: false, err: '要说删哪一条' };
  let hit = null;
  const kept = [];
  for (const r of rows) {
    const inScope = !scope || r.scope === scope;
    if (!hit && inScope && norm(r.text).includes(kw)) { hit = r; continue; }
    kept.push(r);
  }
  if (!hit) return { ok: false, err: '没找到这条' };
  fs.writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return { ok: true, removed: hit.text };
}

/** 清空某个范围的全部记忆 */
export function clearMemory(agentCwd, scope) {
  const file = memoryFile(agentCwd);
  const rows = readAllMemories(agentCwd);
  const kept = rows.filter((r) => r.scope !== scope);
  const gone = rows.length - kept.length;
  fs.writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return { ok: true, removed: gone };
}
